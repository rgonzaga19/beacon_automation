/*
 * Dashboard renderer logic for the collapsible navigation workspace.
 */

// API_BASE, fetchJSON, showModal, and showError all live in common.js (loaded before this file).

if (window.parent && window.parent !== window) {
  window.parent.location.href = window.location.href;
}

// ---------------------------------------------------------------------------
// Toolbar navigation
// ---------------------------------------------------------------------------
const sidebar = document.getElementById("dashboardSidebar");
const sidebarToggle = document.getElementById("btnSidebarToggle");
const sidebarToggleIcon = sidebarToggle.querySelector(".side-icon");
const dashboardLayout = document.querySelector(".dashboard-layout");
const mobileMenuButton = document.getElementById("mobileMenuButton");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");
let activeWorkspaceKey = null;
let signedInIsAdmin = false;
let chatReadStateKey = null;
let latestChatState = null;
let dashboardUptimeSeconds = null;
let dashboardUptimeClock = 0;
let runHistoryCursorStack = [null];
let runHistoryLoading = false;

function formatUptime(totalSeconds) {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function metricDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function escapeMetricText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function renderDailyRunsChart(days = []) {
  const root = document.getElementById("dailyRunsChart");
  if (!days.some((day) => day.count)) {
    root.innerHTML = '<div class="activity-empty">Operation history will appear here after your next activity.</div>';
    return;
  }
  const values = days.map((day) => Number(day.count) || 0);
  const max = Math.max(1, ...values);
  const width = 600, height = 150, left = 30, right = 14, top = 10, bottom = 30;
  const chartHeight = height - top - bottom;
  const points = values.map((value, index) => ({
    x: left + index * ((width - left - right) / Math.max(1, values.length - 1)),
    y: top + chartHeight - (value / max) * chartHeight,
  }));
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `${left},${top + chartHeight} ${line} ${points.at(-1).x},${top + chartHeight}`;
  const grid = [0, 1, 2].map((step) => {
    const y = top + step * (chartHeight / 2);
    const label = Math.ceil(max * (1 - step / 2));
    return `<line class="gridline" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text x="0" y="${y + 3}">${label}</text>`;
  }).join("");
  const dates = days.map((day, index) => {
    const point = points[index];
    const date = new Date(`${day.date}T12:00:00`);
    const label = Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString([], { weekday: "short" });
    return `<circle class="dot" cx="${point.x}" cy="${point.y}" r="4"><title>${day.count} run${day.count === 1 ? "" : "s"} · ${escapeMetricText(day.date)}</title></circle><text text-anchor="middle" x="${point.x}" y="${height - 5}">${label}</text>`;
  }).join("");
  root.innerHTML = `<svg class="runs-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${grid}<polygon class="area" points="${area}"/><polyline class="line" points="${line}"/>${dates}</svg>`;
}

function renderWorkflowChart(workflows = []) {
  const root = document.getElementById("workflowRunsChart");
  if (!workflows.length) {
    root.innerHTML = '<div class="activity-empty">No workflow runs in the last 30 days.</div>';
    return;
  }
  const max = Math.max(1, ...workflows.map((item) => Number(item.count) || 0));
  root.innerHTML = workflows.map((item) => {
    const count = Number(item.count) || 0;
    const width = Math.max(count ? 3 : 0, (count / max) * 100);
    return `<div class="workflow-row"><span>${escapeMetricText(item.workflow)}</span><div class="workflow-track"><div class="workflow-fill" style="width:${width}%"></div></div><strong class="workflow-number">${count}</strong></div>`;
  }).join("");
}

function renderRecentRuns(runs = []) {
  const body = document.getElementById("recentRunsBody");
  if (!runs.length) {
    body.innerHTML = '<tr><td class="activity-empty" colspan="6">No recorded operations yet. Activity will appear here as you use the workspace.</td></tr>';
    return;
  }
  body.innerHTML = runs.map((run) => {
    const status = ["completed", "partial", "stopped", "failed"].includes(run.status) ? run.status : "failed";
    return `<tr><td>${escapeMetricText(run.workflow)}</td><td>${escapeMetricText(run.runner_name || "Unknown")}</td><td><span class="run-status ${status}">${status}</span></td><td>${Number(run.item_count) || 0}</td><td>${formatDuration(run.duration_seconds)}</td><td>${metricDate(run.finished_at)}</td></tr>`;
  }).join("");
}

async function loadRunHistory() {
  if (runHistoryLoading) return;
  runHistoryLoading = true;
  const previous = document.getElementById("runHistoryPrevious");
  const next = document.getElementById("runHistoryNext");
  previous.disabled = true;
  next.disabled = true;
  const cursor = runHistoryCursorStack.at(-1);
  const params = new URLSearchParams();
  if (cursor) {
    params.set("before_at", cursor.finished_at);
    params.set("before_id", String(cursor.id));
  }
  try {
    const query = params.toString();
    const result = await fetchJSON(`/api/dashboard/runs${query ? `?${query}` : ""}`);
    renderRecentRuns(result.runs || []);
    document.getElementById("runHistoryPage").textContent = `Page ${runHistoryCursorStack.length}`;
    previous.disabled = runHistoryCursorStack.length <= 1;
    next.disabled = !result.has_more;
    next.dataset.cursor = result.next_cursor ? JSON.stringify(result.next_cursor) : "";
  } catch {
    document.getElementById("recentRunsBody").innerHTML = '<tr><td class="activity-empty" colspan="6">Run history could not be loaded. Try refreshing.</td></tr>';
  } finally {
    runHistoryLoading = false;
  }
}

document.getElementById("runHistoryPrevious").addEventListener("click", () => {
  if (runHistoryCursorStack.length <= 1 || runHistoryLoading) return;
  runHistoryCursorStack.pop();
  loadRunHistory();
});
document.getElementById("runHistoryNext").addEventListener("click", () => {
  if (runHistoryLoading) return;
  const cursor = document.getElementById("runHistoryNext").dataset.cursor;
  if (!cursor) return;
  runHistoryCursorStack.push(JSON.parse(cursor));
  loadRunHistory();
});

function renderOnlineUsers(users = []) {
  const root = document.getElementById("onlineUsersList");
  if (!users.length) {
    root.innerHTML = '<span class="online-empty">No users are currently online.</span>';
    return;
  }
  root.innerHTML = users.map((user) => `<span class="online-user">${escapeMetricText(user.name)}</span>`).join("");
}

async function refreshDashboardMetrics() {
  try {
    const metrics = await fetchJSON("/api/dashboard/metrics");
    dashboardUptimeSeconds = Number(metrics.server_uptime_seconds) || 0;
    dashboardUptimeClock = performance.now();
    document.getElementById("metricOnline").textContent = String(Number(metrics.online_users) || 0);
    renderOnlineUsers(metrics.online_user_list || []);
    document.getElementById("metricRuns").textContent = String(Number(metrics.runs_30_days) || 0);
    document.getElementById("metricSuccess").textContent = metrics.success_rate == null ? "—" : `${metrics.success_rate}%`;
    renderDailyRunsChart(metrics.daily_runs || []);
    renderWorkflowChart(metrics.workflow_runs || []);
    await loadRunHistory();
    updateDashboardUptime();
  } catch {
    document.getElementById("recentRunsBody").innerHTML = '<tr><td class="activity-empty" colspan="6">Dashboard metrics could not be loaded. Refresh to try again.</td></tr>';
    document.getElementById("metricUptime").textContent = "Unavailable";
  }
}

function updateDashboardUptime() {
  if (dashboardUptimeSeconds == null) return;
  const elapsed = Math.floor((performance.now() - dashboardUptimeClock) / 1000);
  document.getElementById("metricUptime").textContent = formatUptime(dashboardUptimeSeconds + elapsed);
}

function renderClaimAnalyticsChart(buckets) {
  const root = document.getElementById("claimAnalyticsChart");
  if (!buckets.length) {
    root.innerHTML = '<div class="activity-empty">No periods in the selected date range.</div>';
    return;
  }
  const maxTotal = Math.max(1, ...buckets.map((bucket) => Number(bucket.total) || 0));
  root.innerHTML = buckets.map((bucket) => {
    const total = Number(bucket.total) || 0;
    const segment = (name) => {
      const count = Number(bucket[name]) || 0;
      const width = total ? (count / total) * 100 : 0;
      return `<span class="analytics-bar-${name}" style="width:${width}%" title="${count} ${name}"></span>`;
    };
    return `<div class="analytics-chart-row"><span class="analytics-chart-label">${escapeMetricText(bucket.label)}</span><div class="analytics-bar-track" role="img" aria-label="${escapeMetricText(bucket.label)}: ${total} claims"><div class="analytics-bar" style="width:${(total / maxTotal) * 100}%">${segment("draft")}${segment("transmitted")}${segment("other")}</div></div><strong>${total}</strong></div>`;
  }).join("");
}

function renderClaimAnalyticsTable(buckets) {
  const body = document.getElementById("claimAnalyticsTableBody");
  if (!buckets.length) {
    body.innerHTML = '<tr><td class="analytics-empty" colspan="5">No admission periods in this date range.</td></tr>';
    return;
  }
  body.innerHTML = buckets.map((bucket) => `<tr><td>${escapeMetricText(bucket.label)}</td><td>${Number(bucket.draft) || 0}</td><td>${Number(bucket.transmitted) || 0}</td><td>${Number(bucket.other) || 0}</td><td><strong>${Number(bucket.total) || 0}</strong></td></tr>`).join("");
}

function currentPhilippineMonth() {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year").value;
  const month = parts.find((part) => part.type === "month").value;
  return `${year}-${month}`;
}

function billingWeekInputs() {
  return [...document.querySelectorAll("#billingWeekRows tr")].map((row, index) => {
    return {
      week: index + 1,
      start: row.querySelector("[data-week-start]").value,
      end: row.querySelector("[data-week-end]").value,
    };
  });
}

function showBillingWeeks(weeks, month, source) {
  const monthStart = `${month}-01`;
  const monthEndDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const monthEnd = `${month}-${String(monthEndDay).padStart(2, "0")}`;
  const rows = document.getElementById("billingWeekRows");
  rows.innerHTML = weeks.map((week, index) => `<tr>
    <td>Week ${index + 1}</td>
    <td><input type="date" data-week-start aria-label="Week ${index + 1} start date" min="${monthStart}" max="${monthEnd}" value="${escapeMetricText(week.start)}"></td>
    <td><input type="date" data-week-end aria-label="Week ${index + 1} end date" min="${monthStart}" max="${monthEnd}" value="${escapeMetricText(week.end)}"></td>
    <td><button type="button" data-remove-week aria-label="Remove week ${index + 1}" ${weeks.length <= 1 ? "disabled" : ""}>Remove</button></td>
  </tr>`).join("");
  const badge = document.getElementById("billingScheduleBadge");
  const status = document.getElementById("billingScheduleStatus");
  badge.textContent = source === "saved" ? "Saved · workspace" : source === "sample" ? "Sample ranges" : "Automatic";
  status.textContent = source === "saved"
    ? "Workspace billing periods loaded."
    : source === "sample"
      ? "Using your supplied sample ranges. Save after edits to share the schedule."
      : "Automatically grouped Monday through Saturday, skipping Sundays. Save edits to set shared billing ranges.";
  document.getElementById("addBillingWeek").disabled = weeks.length >= 6;
}

function setClaimAnalyticsControlsDisabled(disabled) {
  document.getElementById("refreshClaimAnalytics").disabled = disabled;
  document.getElementById("claimAnalyticsGroup").disabled = disabled;
  document.getElementById("claimAnalyticsFilterMonth").disabled = disabled;
  document.getElementById("billingScheduleMonth").disabled = disabled;
  document.getElementById("addBillingWeek").disabled = disabled || document.querySelectorAll("#billingWeekRows tr").length >= 6;
  document.getElementById("saveBillingSchedule").disabled = disabled;
  for (const input of document.querySelectorAll(".billing-schedule-table input, .billing-schedule-table button")) input.disabled = disabled;
}

let claimAnalyticsLoading = false;
async function refreshClaimAnalytics(forceRefresh = false) {
  if (claimAnalyticsLoading) return;
  claimAnalyticsLoading = true;
  const month = document.getElementById("billingScheduleMonth").value;
  const group = document.getElementById("claimAnalyticsGroup").value;
  const filterMonth = document.getElementById("claimAnalyticsFilterMonth").value || "all";
  const status = document.getElementById("claimAnalyticsStatus");
  setClaimAnalyticsControlsDisabled(true);
  status.textContent = "Loading Beacon claims…";
  try {
    const params = new URLSearchParams({ month, group, filter_month: filterMonth });
    if (forceRefresh) params.set("refresh", "1");
    const analytics = await fetchJSON(`/api/dashboard/claim-analytics?${params}`);
    if (analytics.error) throw new Error(analytics.error);
    if (!Array.isArray(analytics.buckets) || !Array.isArray(analytics.weeks) || analytics.weeks.length < 1 || analytics.weeks.length > 6) {
      throw new Error("The server returned an invalid analytics response. Restart the app server and reload the page.");
    }
    const filter = document.getElementById("claimAnalyticsFilterMonth");
    const selectedFilter = filterMonth;
    const months = [];
    const cursor = new Date(`${analytics.date_from}T12:00:00`);
    const last = new Date(`${analytics.date_to}T12:00:00`);
    cursor.setDate(1);
    while (cursor <= last) {
      months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`);
      cursor.setMonth(cursor.getMonth() + 1);
    }
    filter.innerHTML = '<option value="all">All last 90 days</option>' + months.map((value) => {
      const label = new Intl.DateTimeFormat([], { month: "long", year: "numeric" }).format(new Date(`${value}-01T12:00:00`));
      return `<option value="${value}">${escapeMetricText(label)}</option>`;
    }).join("");
    filter.value = months.includes(selectedFilter) ? selectedFilter : "all";
    showBillingWeeks(analytics.weeks, month, analytics.schedule_source || "automatic");
    document.getElementById("claimAnalyticsBucketHeading").textContent = group === "month" ? "Month" : "Billing week";
    document.getElementById("claimMetricDraft").textContent = String(Number(analytics.draft_claims) || 0);
    document.getElementById("claimMetricTransmitted").textContent = String(Number(analytics.transmitted_claims) || 0);
    document.getElementById("claimMetricOther").textContent = String(Number(analytics.other_claims) || 0);
    document.getElementById("claimMetricTotal").textContent = String(Number(analytics.total_claims) || 0);
    renderClaimAnalyticsChart(analytics.buckets || []);
    const rows = [...(analytics.buckets || [])];
    if (Number(analytics.unassigned?.total) > 0) rows.push(analytics.unassigned);
    renderClaimAnalyticsTable(rows);
    const missing = Number(analytics.missing_admission_dates) || 0;
    const unassigned = Number(analytics.unassigned?.total) || 0;
    const periodLabel = filterMonth === "all"
      ? "Latest 90 days"
      : new Intl.DateTimeFormat([], { month: "long", year: "numeric" }).format(new Date(`${filterMonth}-01T12:00:00`));
    const notes = [`${periodLabel} · Counts are grouped by claim admission date.`];
    if (unassigned) notes.push(`${unassigned} claim${unassigned === 1 ? "" : "s"} fall outside the configured ranges.`);
    if (missing) notes.push(`${missing} candidate claim${missing === 1 ? "" : "s"} had no admission date, so could not be placed in the 90-day window.`);
    notes.push(`Beacon checked ${Number(analytics.transmittals_scanned) || 0} transmittals and ${Number(analytics.claims_scanned) || 0} claims for admission dates from ${analytics.date_from} through ${analytics.date_to}.`);
    status.textContent = notes.join(" ");
  } catch (error) {
    const message = error && error.message ? error.message : "Unable to load Beacon claim analytics.";
    status.textContent = `Claim analytics could not be loaded: ${message}`;
    document.getElementById("billingScheduleStatus").textContent = message;
    document.getElementById("claimAnalyticsTableBody").innerHTML = `<tr><td class="analytics-empty" colspan="5">${escapeMetricText(message)}</td></tr>`;
  } finally {
    claimAnalyticsLoading = false;
    setClaimAnalyticsControlsDisabled(false);
  }
}

async function saveClaimBillingSchedule() {
  if (claimAnalyticsLoading) return;
  const month = document.getElementById("billingScheduleMonth").value;
  const status = document.getElementById("billingScheduleStatus");
  let saved = false;
  claimAnalyticsLoading = true;
  setClaimAnalyticsControlsDisabled(true);
  status.textContent = "Saving workspace billing periods…";
  try {
    const result = await fetchJSON("/api/dashboard/claim-billing-schedule", {
      method: "POST",
      body: JSON.stringify({ month, weeks: billingWeekInputs() }),
    });
    if (result.error) throw new Error(result.error);
    if (!Array.isArray(result.weeks) || result.weeks.length < 1 || result.weeks.length > 6) {
      throw new Error("The server returned an invalid billing schedule response. Restart the app server and reload the page.");
    }
    showBillingWeeks(result.weeks, month, "saved");
    status.textContent = "Billing periods saved for the workspace.";
    saved = true;
  } catch (error) {
    const message = error && error.message ? error.message : "Unable to save billing periods.";
    status.textContent = `Billing periods could not be saved: ${message}`;
  } finally {
    claimAnalyticsLoading = false;
    setClaimAnalyticsControlsDisabled(false);
  }
  if (saved) refreshClaimAnalytics();
}

document.getElementById("billingScheduleMonth").value = currentPhilippineMonth();
document.getElementById("refreshClaimAnalytics").addEventListener("click", () => refreshClaimAnalytics(true));
document.getElementById("claimAnalyticsGroup").addEventListener("change", () => refreshClaimAnalytics());
document.getElementById("claimAnalyticsFilterMonth").addEventListener("change", () => refreshClaimAnalytics());
document.getElementById("billingScheduleMonth").addEventListener("change", () => refreshClaimAnalytics());
document.getElementById("saveBillingSchedule").addEventListener("click", saveClaimBillingSchedule);
document.getElementById("addBillingWeek").addEventListener("click", () => {
  const weeks = billingWeekInputs();
  if (weeks.length >= 6) return;
  weeks.push({ week: weeks.length + 1, start: "", end: "" });
  showBillingWeeks(weeks, document.getElementById("billingScheduleMonth").value, "saved");
  document.getElementById("billingScheduleBadge").textContent = "Unsaved edits";
  document.getElementById("billingScheduleStatus").textContent = "Billing ranges changed. Save to apply them for the workspace.";
});
document.getElementById("billingWeekRows").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-week]");
  if (!button) return;
  const weeks = billingWeekInputs();
  weeks.splice([...button.closest("tbody").rows].indexOf(button.closest("tr")), 1);
  showBillingWeeks(weeks, document.getElementById("billingScheduleMonth").value, "saved");
  document.getElementById("billingScheduleBadge").textContent = "Unsaved edits";
  document.getElementById("billingScheduleStatus").textContent = "Billing ranges changed. Save to apply them for the workspace.";
});
document.getElementById("billingWeekRows").addEventListener("input", () => {
  document.getElementById("billingScheduleBadge").textContent = "Unsaved edits";
  document.getElementById("billingScheduleStatus").textContent = "Billing ranges changed. Save to apply them for the workspace.";
});
refreshClaimAnalytics();

document.getElementById("refreshMetrics").addEventListener("click", refreshDashboardMetrics);
loadRunHistory();
refreshDashboardMetrics();
setInterval(updateDashboardUptime, 30000);

const dashboardColumns = document.getElementById("dashboardColumns");
const dashboardLayoutButtons = [...document.querySelectorAll("[data-dashboard-layout]")];
function setDashboardLayout(layout, persist = false) {
  if (!["workflow", "operations"].includes(layout)) layout = "workflow";
  dashboardColumns.dataset.layout = layout;
  dashboardLayoutButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.dashboardLayout === layout));
  });
  if (persist) {
    try { localStorage.setItem("beabots-dashboard-layout", layout); }
    catch { /* The dashboard works without a saved layout preference. */ }
  }
}
dashboardLayoutButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const selectedLayout = button.dataset.dashboardLayout;
    setDashboardLayout(selectedLayout, true);
  });
});
try {
  const savedLayout = localStorage.getItem("beabots-dashboard-layout");
  const layout = savedLayout === "operations" ? "operations" : "workflow";
  setDashboardLayout(layout, savedLayout === "split" || !savedLayout);
}
catch { setDashboardLayout("workflow"); }

function readChatCursors() {
  if (!chatReadStateKey) return null;
  try { return JSON.parse(localStorage.getItem(chatReadStateKey) || "null"); }
  catch { return null; }
}

function writeChatCursors(cursors) {
  if (!chatReadStateKey) return;
  try { localStorage.setItem(chatReadStateKey, JSON.stringify(cursors)); }
  catch { /* Unread indicators are optional when browser storage is unavailable. */ }
}

function updateChatUnreadIndicator() {
  if (!latestChatState || !chatReadStateKey) return;
  const cursors = readChatCursors() || { team: latestChatState.team };
  const teamUnread = Number(latestChatState.team || 0) > Number(cursors.team || 0);
  document.getElementById("teamChatUnread").hidden = !teamUnread;
  const unreadCount = Number(teamUnread);
  const indicator = document.getElementById("chatUnreadIndicator");
  indicator.hidden = unreadCount === 0;
  indicator.textContent = String(unreadCount);
  indicator.setAttribute("aria-label", `${unreadCount} chat${unreadCount === 1 ? "" : "s"} with unread messages`);
  document.getElementById("accountTrigger").setAttribute(
    "aria-label",
    `${document.getElementById("accountName").textContent || "Account"}${unreadCount ? ", unread team chat messages" : ""}`
  );
}

async function refreshChatUnread() {
  try {
    const result = await fetchJSON("/api/chat/latest");
    if (result.error || !chatReadStateKey) return;
    latestChatState = result;
    let cursors = readChatCursors();
    if (!cursors) {
      // Start from the current head so existing history does not appear unread on first use.
      cursors = { team: result.team || 0 };
      writeChatCursors(cursors);
    }
    updateChatUnreadIndicator();
  } catch { /* Keep the last known indicator while the network is unavailable. */ }
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || !event.data || event.data.type !== "chat-read") return;
  const cursors = readChatCursors() || { team: 0 };
  const messageId = Number(event.data.messageId || 0);
  if (event.data.channel === "team") cursors.team = Math.max(Number(cursors.team || 0), messageId);
  writeChatCursors(cursors);
  updateChatUnreadIndicator();
});

function closeMobileSidebar() {
  sidebar.classList.remove("mobile-open");
  dashboardLayout.classList.remove("mobile-menu-open");
  sidebarBackdrop.hidden = true;
  mobileMenuButton.setAttribute("aria-expanded", "false");
  mobileMenuButton.setAttribute("aria-label", "Open workspace menu");
  if (!activeWorkspaceKey || activeWorkspaceKey === "about") {
    dashboardLayout.classList.remove("claims-mode");
  }
}

function openMobileSidebar() {
  sidebar.classList.remove("collapsed");
  sidebarToggle.setAttribute("aria-expanded", "true");
  sidebarToggle.setAttribute("aria-label", "Collapse sidebar");
  sidebarToggleIcon.textContent = "\u2039";
  dashboardLayout.classList.add("claims-mode", "mobile-menu-open");
  sidebar.classList.add("mobile-open");
  sidebarBackdrop.hidden = false;
  mobileMenuButton.setAttribute("aria-expanded", "true");
  mobileMenuButton.setAttribute("aria-label", "Close workspace menu");
}

mobileMenuButton.addEventListener("click", () => {
  if (dashboardLayout.classList.contains("mobile-menu-open")) closeMobileSidebar();
  else openMobileSidebar();
});
sidebarBackdrop.addEventListener("click", closeMobileSidebar);
window.addEventListener("resize", () => {
  if (window.innerWidth > 760) closeMobileSidebar();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && dashboardLayout.classList.contains("mobile-menu-open")) {
    closeMobileSidebar();
    mobileMenuButton.focus();
  }
});

sidebarToggle.addEventListener("click", () => {
  const collapsed = sidebar.classList.toggle("collapsed");
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  sidebarToggle.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  sidebarToggleIcon.textContent = collapsed ? "\u203a" : "\u2039";
  if (collapsed) {
    document.querySelectorAll("[data-sidebar-group]").forEach((toggle) => {
      toggle.setAttribute("aria-expanded", "false");
      document.getElementById(toggle.getAttribute("aria-controls")).hidden = true;
    });
  }
  window.beabots?.setWorkspaceSidebarWidth(collapsed ? 68 : 232);
});

document.querySelectorAll("[data-sidebar-group]").forEach((toggle) => {
  toggle.addEventListener("click", () => {
    if (sidebar.classList.contains("collapsed")) {
      sidebar.classList.remove("collapsed");
      sidebarToggle.setAttribute("aria-expanded", "true");
      sidebarToggle.setAttribute("aria-label", "Collapse sidebar");
      sidebarToggleIcon.textContent = "\u2039";
      window.beabots?.setWorkspaceSidebarWidth(232);
      toggle.setAttribute("aria-expanded", "true");
      document.getElementById(toggle.getAttribute("aria-controls")).hidden = false;
      return;
    }
    const expanded = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(expanded));
    document.getElementById(toggle.getAttribute("aria-controls")).hidden = !expanded;
  });
});

function playDashboardEntrance() {
  const shell = document.getElementById("dashboardShell");
  shell.classList.remove("dashboard-entering");
  void shell.offsetWidth;
  shell.classList.add("dashboard-entering");
  setTimeout(() => shell.classList.remove("dashboard-entering"), 1000);
}

window.beabots?.onDashboardEnter(playDashboardEntrance);

const workspaceButtons = {
  dashboard: document.getElementById("btnDashboard"),
  cf2: document.getElementById("btnCf2"),
  runAll: document.getElementById("btnRunAll"),
  uploadSoa: document.getElementById("btnUploadSoa"),
  uploadDocuments: document.getElementById("btnUploadDocuments"),
  cf4: document.getElementById("btnCf4"),
  editClaims: document.getElementById("btnEditClaims"),
  soaExcelIndividual: document.getElementById("btnSoaIndividual"),
  soaExcelBatch: document.getElementById("btnSoaBatch"),
  autoRename: document.getElementById("btnAutoRename"),
  users: document.getElementById("siteUsers"),
  teamCollab: document.getElementById("btnCollaborationChat"),
};

const workspaceColumn = document.getElementById("workspaceColumn");
const workspaceRoutes = {
  cf2: "cf2.html",
  runAll: "run-all.html",
  uploadSoa: "upload-soa.html",
  uploadDocuments: "upload-documents.html",
  cf4: "cf4.html",
  editClaims: "edit-claims.html",
  soaExcel: "soa-excel.html",
  autoRename: "auto-rename.html",
  settings: "settings.html",
  users: "users.html",
  teamCollab: "team-chat.html",
  about: "about.html",
};
const workspaceFrames = Object.fromEntries(
  [...document.querySelectorAll("[data-workspace-frame]")]
    .map((frame) => [frame.dataset.workspaceFrame, frame])
);

const siteHeader = document.querySelector(".site-header");
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin
      || event.source !== workspaceFrames.about?.contentWindow
      || event.data?.type !== "agreement-open-state") return;
  const isOpen = Boolean(event.data.open);
  siteHeader.inert = isOpen;
  siteHeader.classList.toggle("agreement-blocked", isOpen);
});

function setWorkspaceActive(activeKey) {
  Object.entries(workspaceButtons).forEach(([key, button]) => {
    button.classList.toggle("active", key === activeKey);
    button.setAttribute("aria-current", key === activeKey ? "page" : "false");
  });
}

function showWorkspaceHome() {
  activeWorkspaceKey = null;
  closeMobileSidebar();
  dashboardLayout.classList.remove("claims-mode");
  workspaceColumn.classList.remove("workspace-active");
  Object.values(workspaceFrames).forEach((frame) => frame.classList.remove("active"));
  setWorkspaceActive("dashboard");
  history.replaceState(null, "", "dashboard.html");
}

function openWorkspace(activeKey) {
  if (activeKey === "users" && !signedInIsAdmin) return;
  const route = workspaceRoutes[activeKey];
  const frame = workspaceFrames[activeKey];
  if (!route || !frame) return;
  activeWorkspaceKey = activeKey;
  closeMobileSidebar();
  dashboardLayout.classList.toggle("claims-mode", activeKey !== "about");
  workspaceColumn.classList.add("workspace-active");
  Object.entries(workspaceFrames).forEach(([key, item]) => {
    item.classList.toggle("active", key === activeKey);
  });
  if (!frame.getAttribute("src")) {
    frame.src = route;
  }
  if (activeKey === "teamCollab") {
    frame.contentWindow?.postMessage({ type: "chat-active" }, location.origin);
  }
  setWorkspaceActive(activeKey);
  history.replaceState(null, "", `dashboard.html#${activeKey}`);
}

function openSoaExcelSubtab(subtab) {
  setTopNavigation("siteClaims");
  const frame = workspaceFrames.soaExcel;
  const frameWasLoaded = frame.getAttribute("src") === workspaceRoutes.soaExcel
    && frame.contentDocument?.readyState === "complete";
  openWorkspace("soaExcel");
  const selectTab = () => frame.contentWindow?.postMessage({ type: "soa-excel-tab", tab: subtab }, location.origin);
  if (frameWasLoaded) selectTab();
  else frame.addEventListener("load", selectTab, { once: true });
  setWorkspaceActive(subtab === "batch" ? "soaExcelBatch" : "soaExcelIndividual");
}

document.getElementById("btnSoaIndividual").addEventListener("click", () => openSoaExcelSubtab("individual"));
document.getElementById("btnSoaBatch").addEventListener("click", () => openSoaExcelSubtab("batch"));

function setTopNavigation(active) {
  document.querySelectorAll(".site-nav button").forEach((button) => {
    const selected = button.id === active;
    button.classList.toggle("active", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

document.getElementById("siteHome").addEventListener("click", () => {
  setTopNavigation("siteHome");
  showWorkspaceHome();
});
document.getElementById("btnDashboard").addEventListener("click", () => {
  setTopNavigation("siteHome");
  showWorkspaceHome();
});
document.getElementById("siteBrand").addEventListener("click", (event) => {
  event.preventDefault();
  document.getElementById("siteHome").click();
});
document.getElementById("siteClaims").addEventListener("click", () => {
  setTopNavigation("siteClaims");
  openWorkspace("soaExcel");
});
document.getElementById("siteAbout").addEventListener("click", () => {
  setTopNavigation("siteAbout");
  openWorkspace("about");
  focusAboutSection("about");
});
document.getElementById("siteContact").addEventListener("click", () => {
  setTopNavigation("siteContact");
  openWorkspace("about");
  focusAboutSection("contact");
});
document.getElementById("sidebarHelpButton").addEventListener("click", () => {
  setTopNavigation("siteAbout");
  openWorkspace("about");
  focusAboutSection("contact");
});
function focusAboutSection(section) {
  const frame = workspaceFrames.about;
  const focus = () => {
    try { frame.contentWindow.location.hash = section; } catch { /* The about document may still be navigating. */ }
  };
  if (frame.contentDocument?.readyState === "complete" && frame.contentWindow.location.pathname.endsWith("/about.html")) focus();
  else frame.addEventListener("load", focus, { once: true });
}

function openAboutAgreement({ required = false } = {}) {
  openWorkspace("about");
  const frame = workspaceFrames.about;
  const show = () => frame.contentWindow?.postMessage({ type: "open-agreement", required }, location.origin);
  if (frame.contentDocument?.readyState === "complete" && frame.contentWindow.location.pathname.endsWith("/about.html")) show();
  else frame.addEventListener("load", show, { once: true });
}
document.querySelectorAll("[data-open-tool]").forEach((button) => button.addEventListener("click", () => {
  setTopNavigation("siteClaims");
  openWorkspace(button.dataset.openTool);
}));

const accountTrigger = document.getElementById("accountTrigger");
const accountMenu = document.getElementById("accountMenu");
function closeAccountMenu() {
  accountMenu.hidden = true;
  accountTrigger.setAttribute("aria-expanded", "false");
}
accountTrigger.addEventListener("click", () => {
  const expanded = accountTrigger.getAttribute("aria-expanded") !== "true";
  accountTrigger.setAttribute("aria-expanded", String(expanded));
  accountMenu.hidden = !expanded;
});
document.addEventListener("click", (event) => {
  if (accountMenu.hidden) return;
  if (accountTrigger.contains(event.target) || accountMenu.contains(event.target)) return;
  closeAccountMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || accountMenu.hidden) return;
  closeAccountMenu();
  accountTrigger.focus();
});
// Clicks inside a workspace iframe do not bubble here, but they blur this window.
window.addEventListener("blur", closeAccountMenu);
document.getElementById("editProfileButton").addEventListener("click", () => {
  closeAccountMenu();
  openWorkspace("settings");
  const frame = workspaceFrames.settings;
  const focusProfile = () => frame.contentWindow?.postMessage({ type: "settings-focus-profile" }, location.origin);
  if (frame.getAttribute("src") === workspaceRoutes.settings
      && frame.contentDocument?.readyState === "complete"
      && frame.contentWindow.location.pathname.endsWith("/settings.html")) focusProfile();
  else frame.addEventListener("load", focusProfile, { once: true });
});
document.getElementById("accountSettings").addEventListener("click", () => {
  closeAccountMenu();
  openWorkspace("settings");
});

document.getElementById("accountTeamChat").addEventListener("click", () => {
  closeAccountMenu();
  openWorkspace("teamCollab");
});
document.getElementById("accountLogout").addEventListener("click", () => window.beabots?.logout());

async function loadSignedInProfile() {
  try {
    const result = await fetchJSON("/api/auth/me");
    if (!result.authenticated) {
      window.location.replace("/login");
      return;
    }
    const user = result.user || {};
    signedInIsAdmin = Boolean(user.is_admin);
    document.getElementById("billingScheduleEditor").hidden = !signedInIsAdmin;
    document.getElementById("billingScheduleMonthControl").hidden = !signedInIsAdmin;
    chatReadStateKey = `beabots-chat-read:v1:${user.id}`;
    await refreshChatUnread();
    document.getElementById("siteUsers").hidden = !signedInIsAdmin;
    if (signedInIsAdmin) {
      if (activeWorkspaceKey !== "users" && window.location.hash.replace("#", "") === "users") openWorkspace("users");
    } else if (window.location.hash.replace("#", "") === "users") {
      // The users workspace is admin-only; fall back to Home if reached directly.
      showWorkspaceHome();
      setTopNavigation("siteHome");
    }
    const pendingAgreementEmail = sessionStorage.getItem("beabots-agreement-pending");
    const pendingAgreementKey = pendingAgreementEmail && `beabots-agreement-ack:${encodeURIComponent(pendingAgreementEmail)}`;
    if (pendingAgreementEmail && localStorage.getItem(pendingAgreementKey) !== "v1") {
      setTopNavigation("siteAbout");
      openAboutAgreement({ required: true });
    } else if (pendingAgreementEmail) {
      sessionStorage.removeItem("beabots-agreement-pending");
    }
    updateDashboardProfile(user);
    updateChatUnreadIndicator();
  } catch {
    window.location.replace("/login");
  }
}

function updateDashboardProfile(user) {
  const displayName = user.display_name || user.profile_name || user.email || "Account";
  document.getElementById("accountName").textContent = displayName;
  document.getElementById("accountAvatar").textContent = (displayName.trim()[0] || "B").toUpperCase();
  document.getElementById("homeGreeting").textContent = `Welcome${user.display_name ? `, ${user.display_name}` : " to Beabots"}`;
  document.getElementById("upgradeAccountName").textContent = displayName;
  document.getElementById("upgradeAccountEmail").textContent = user.email || "";
}

loadSignedInProfile();
window.setInterval(refreshChatUnread, 30000);

const upgradeDialog = document.getElementById("upgradeDialog");
const upgradeRequestForm = document.getElementById("upgradeRequestForm");
let upgradeRequestFrame = null;
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== workspaceFrames.settings?.contentWindow) return;
  if (event.data?.type === "settings-profile-updated" && event.data.user) {
    updateDashboardProfile(event.data.user);
    return;
  }
  if (event.data?.type === "settings-upgrade-request") {
    upgradeRequestFrame = event.source;
    document.getElementById("upgradeRequestMessage").value = "";
    document.getElementById("upgradeRequestStatus").textContent = "";
    upgradeDialog.showModal();
  }
});
document.getElementById("cancelUpgradeRequest").addEventListener("click", () => upgradeDialog.close());
upgradeRequestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = document.getElementById("submitUpgradeRequest");
  const status = document.getElementById("upgradeRequestStatus");
  submit.disabled = true;
  status.textContent = "Sending request…";
  try {
    await fetchJSON("/api/auth/upgrade-request", {
      method: "POST",
      body: JSON.stringify({ message: document.getElementById("upgradeRequestMessage").value }),
    });
    status.textContent = "Request sent. An administrator will review it.";
    upgradeRequestFrame?.postMessage({ type: "settings-upgrade-request-pending" }, location.origin);
    setTimeout(() => upgradeDialog.close(), 1100);
  } catch (error) {
    status.textContent = error.message || "Could not send your request.";
    submit.disabled = false;
  }
});

window.openBeabotsWorkspace = openWorkspace;

window.beabots?.onWorkspaceActive(setWorkspaceActive);

document.getElementById("btnCf2").addEventListener("click", () => {
  openWorkspace("cf2");
});
document.getElementById("btnRunAll").addEventListener("click", () => {
  openWorkspace("runAll");
});
document.getElementById("btnUploadSoa").addEventListener("click", () => {
  openWorkspace("uploadSoa");
});
document.getElementById("btnUploadDocuments").addEventListener("click", () => {
  openWorkspace("uploadDocuments");
});
document.getElementById("btnCf4").addEventListener("click", () => {
  openWorkspace("cf4");
});
document.getElementById("btnEditClaims").addEventListener("click", () => {
  openWorkspace("editClaims");
});
document.getElementById("btnAutoRename").addEventListener("click", () => {
  openWorkspace("autoRename");
});
document.getElementById("btnCollaborationChat").addEventListener("click", () => {
  openWorkspace("teamCollab");
});
document.getElementById("siteUsers").addEventListener("click", () => {
  closeAccountMenu();
  openWorkspace("users");
});
// ---------------------------------------------------------------------------
// Heartbeat Controller - monitors Beacon connection and automation activity
// ---------------------------------------------------------------------------
class HeartbeatController {
  constructor() {
    this.heartbeatEl = document.querySelector(".workspace-heartbeat");
    this.pollInterval = null;
    this.pollIntervalMs = 15000; // 15 seconds
    this.slowThresholdMs = 5000; // 5 seconds = slow
    this.activeAutomations = new Set();
    this.socket = null;
    this.isPolling = false;
    this.lastConnectionState = null; // { connected: boolean, slow: boolean }
    this.init();
  }

  init() {
    if (!this.heartbeatEl) return;
    this.connectSocket();
    this.updateHeartbeat();
    this.startPolling();
    this.handleVisibilityChange();
  }

  connectSocket() {
    if (typeof io === "undefined") return;
    this.socket = io(window.location.origin, {
      transports: ["websocket", "polling"],
      autoConnect: true,
    });
    // Server automatically joins user room on connect via Flask session
    this.socket.on("connect", () => {
      // Connection established, room joined automatically by server
      refreshDashboardMetrics();
    });
    this.socket.on("dashboard_presence_update", (payload) => {
      document.getElementById("metricOnline").textContent = String(Number(payload?.online_users) || 0);
    });
    this.socket.on("dashboard_online_users", (payload) => renderOnlineUsers(payload?.users || []));
    this.socket.on("disconnect", () => {
      // Socket disconnected, will reconnect automatically
    });

    // Automation progress events that indicate active runs
    const progressEvents = [
      "cf2_progress",
      "soa_progress",
      "beacon_progress",
      "documents_progress",
      "run_all_progress",
    ];
    const doneEvents = [
      "cf2_done",
      "soa_done",
      "beacon_done",
      "documents_done",
      "run_all_done",
    ];

    progressEvents.forEach((event) => {
      const key = event.replace(/_progress$/, "");
      this.socket.on(event, () => this.setAutomationActive(key, true));
    });
    doneEvents.forEach((event) => {
      const key = event.replace(/_done$/, "");
      this.socket.on(event, () => this.setAutomationActive(key, false));
    });
  }

  setAutomationActive(key, active) {
    if (active) this.activeAutomations.add(key);
    else this.activeAutomations.delete(key);
    this.updateHeartbeat();
  }

  async pollConnectionStatus() {
    if (this.isPolling) return;
    this.isPolling = true;
    const start = performance.now();
    const slowTimer = setTimeout(() => {
      if (this.lastConnectionState?.connected) {
        this.lastConnectionState = { ...this.lastConnectionState, slow: true };
        this.updateHeartbeat();
      }
    }, this.slowThresholdMs);
    try {
      const settings = await fetchJSON("/api/settings");
      const responseTime = performance.now() - start;
      const connected = settings.beacon_connected === true;
      const slow = responseTime > this.slowThresholdMs;
      this.lastConnectionState = { connected, slow, responseTime };
      this.updateHeartbeat();
    } catch (error) {
      this.lastConnectionState = { connected: false, slow: false, responseTime: null };
      this.updateHeartbeat();
    } finally {
      clearTimeout(slowTimer);
      this.isPolling = false;
    }
  }

  startPolling() {
    if (this.pollInterval) return;
    // Initial poll
    this.pollConnectionStatus();
    // Recurring polls
    this.pollInterval = setInterval(() => this.pollConnectionStatus(), this.pollIntervalMs);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  handleVisibilityChange() {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.stopPolling();
      } else {
        this.startPolling();
      }
    });
  }

  updateHeartbeat() {
    if (!this.heartbeatEl) return;

    const { connected = false, slow = false } = this.lastConnectionState || {};
    const automationActive = this.activeAutomations.size > 0;

    // Remove all state classes
    this.heartbeatEl.classList.remove(
      "heartbeat-connected",
      "heartbeat-active",
      "heartbeat-slow",
      "heartbeat-disconnected"
    );

    const path = this.heartbeatEl.querySelector("path");
    if (path) {
      path.setAttribute(
        "d",
        connected
          ? "M2 13h23l7-1 5-7 8 15 8-12 5 5h10l4-1h26"
          : "M2 13h96"
      );
    }

    if (!connected) {
      this.heartbeatEl.classList.add("heartbeat-disconnected");
    } else if (automationActive) {
      this.heartbeatEl.classList.add("heartbeat-active");
    } else if (slow) {
      this.heartbeatEl.classList.add("heartbeat-slow");
    } else {
      this.heartbeatEl.classList.add("heartbeat-connected");
    }
  }

  destroy() {
    this.stopPolling();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }
}

// Initialize heartbeat controller after DOM is ready
let heartbeatController = null;
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    heartbeatController = new HeartbeatController();
  });
} else {
  heartbeatController = new HeartbeatController();
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------
const initialWorkspace = window.location.hash.replace("#", "");
if (workspaceRoutes[initialWorkspace] || initialWorkspace === "agreement") {
  if (["about", "agreement", "settings"].includes(initialWorkspace)) setTopNavigation(["about", "agreement"].includes(initialWorkspace) ? "siteAbout" : "siteHome");
  else if (initialWorkspace === "users") setTopNavigation("siteUsers");
  else setTopNavigation("siteClaims");
  if (initialWorkspace === "agreement") openAboutAgreement();
  else openWorkspace(initialWorkspace);
} else {
  setTopNavigation("siteHome");
  setWorkspaceActive("dashboard");
}
