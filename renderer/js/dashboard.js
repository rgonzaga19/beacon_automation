/*
 * Dashboard renderer logic for the collapsible navigation workspace.
 */

// API_BASE, fetchJSON, showModal, and showError all live in common.js (loaded before this file).

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

// ---------------------------------------------------------------------------
// Dashboard charts (Chart.js, bundled in vendor/chart). Colors come from the
// --c-* tokens defined in dashboard-home.html so dark and light are selected,
// not flipped. Every chart degrades to its table when Chart.js is unavailable.
// ---------------------------------------------------------------------------
const chartInstances = {};
const hiddenSeries = new Set();
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
let lastClaimAnalytics = null;
let lastClaimBuckets = [];
let lastRunDays = [];
let selectedBucket = -1;
let lastRunsTotal = null;
const setupState = { metrics: false, claims: false };
const workflowSlots = new Map();

function cssToken(name) {
  const root = document.querySelector(".home-content") || document.documentElement;
  return getComputedStyle(root).getPropertyValue(name).trim() || "#888888";
}
function chartTheme() {
  return {
    text: cssToken("--text-sec"), primary: cssToken("--text-pri"), grid: cssToken("--c-grid"), axis: cssToken("--c-axis"),
    surface: cssToken("--bg-panel"), card: cssToken("--bg-card"), border: cssToken("--border"), accent: cssToken("--accent"),
    draft: cssToken("--c-draft"), transmitted: cssToken("--c-transmitted"), other: cssToken("--c-other"),
  };
}
function withAlpha(hex, alpha) {
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${alpha}` : hex;
}
function destroyChart(key) {
  if (chartInstances[key]) { chartInstances[key].destroy(); delete chartInstances[key]; }
}
function buildChart(key, canvasId, config) {
  destroyChart(key);
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === "undefined") return null;
  config.options = config.options || {};
  config.options.responsive = true;
  config.options.maintainAspectRatio = false;
  if (reducedMotion) config.options.animation = false;
  chartInstances[key] = new Chart(canvas, config);
  return chartInstances[key];
}
function tooltipStyle(theme) {
  return {
    backgroundColor: theme.card, titleColor: theme.primary, bodyColor: theme.primary, footerColor: theme.text,
    borderColor: theme.border, borderWidth: 1, padding: 10, cornerRadius: 8, boxPadding: 4, usePointStyle: true,
  };
}
const crosshairPlugin = {
  id: "crosshair",
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() || [];
    if (!active.length || chart.config.type !== "line") return;
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.strokeStyle = chart.options.plugins.crosshair?.color || "#888";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(active[0].element.x, chartArea.top);
    ctx.lineTo(active[0].element.x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function sparkMarkup(values, colorVar) {
  if (!values || values.length < 2) return "";
  const max = Math.max(...values), min = Math.min(...values), span = max - min || 1;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${24 - ((value - min) / span) * 20}`).join(" ");
  return `<polyline points="${points}" style="stroke:var(${colorVar})" vector-effect="non-scaling-stroke"></polyline>`;
}
function renderSparks() {
  const series = {
    total: [lastClaimBuckets.map((b) => Number(b.total) || 0), "--accent"],
    draft: [lastClaimBuckets.map((b) => Number(b.draft) || 0), "--c-draft"],
    transmitted: [lastClaimBuckets.map((b) => Number(b.transmitted) || 0), "--c-transmitted"],
    runs: [lastRunDays.map((d) => Number(d.count) || 0), "--accent"],
  };
  document.querySelectorAll("[data-spark]").forEach((svg) => {
    const [values, color] = series[svg.dataset.spark] || [[], "--accent"];
    svg.innerHTML = sparkMarkup(values, color);
  });
}

function renderDailyRunsChart(days = []) {
  lastRunDays = days;
  const empty = document.getElementById("dailyRunsEmpty");
  const canvas = document.getElementById("dailyRunsCanvas");
  const table = document.getElementById("dailyRunsTable");
  table.replaceChildren(...days.map((day) => {
    const row = document.createElement("tr");
    const a = document.createElement("td"); a.textContent = day.date;
    const b = document.createElement("td"); b.textContent = String(Number(day.count) || 0);
    row.append(a, b);
    return row;
  }));
  renderSparks();
  if (!days.some((day) => day.count)) {
    destroyChart("daily");
    canvas.hidden = true;
    empty.hidden = false;
    return;
  }
  canvas.hidden = false;
  empty.hidden = true;
  const theme = chartTheme();
  const labels = days.map((day) => {
    const date = new Date(`${day.date}T12:00:00`);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString([], { weekday: "short" });
  });
  buildChart("daily", "dailyRunsCanvas", {
    type: "line",
    plugins: [crosshairPlugin],
    data: { labels, datasets: [{
      label: "Operations", data: days.map((day) => Number(day.count) || 0),
      borderColor: theme.accent, backgroundColor: withAlpha(theme.accent, "1a"), fill: true, borderWidth: 2, tension: 0.25,
      pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: theme.accent, pointBorderColor: theme.surface, pointBorderWidth: 2, pointHitRadius: 18,
    }] },
    options: {
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { display: false }, border: { color: theme.axis }, ticks: { color: theme.text, font: { size: 10 } } },
        y: { beginAtZero: true, grace: "10%", border: { display: false }, grid: { color: theme.grid }, ticks: { color: theme.text, precision: 0, maxTicksLimit: 4, font: { size: 10 } } },
      },
      plugins: {
        legend: { display: false },
        crosshair: { color: theme.axis },
        tooltip: { ...tooltipStyle(theme), callbacks: {
          title: (items) => days[items[0].dataIndex]?.date || "",
          label: (item) => ` ${item.parsed.y} operation${item.parsed.y === 1 ? "" : "s"}`,
        } },
      },
    },
  });
}

function renderWorkflowChart(workflows = []) {
  const root = document.getElementById("workflowRunsChart");
  if (!workflows.length) {
    root.innerHTML = '<div class="activity-empty">No workflow runs in the last 30 days.</div>';
    return;
  }
  const max = Math.max(1, ...workflows.map((item) => Number(item.count) || 0));
  root.innerHTML = workflows.map((item) => {
    if (!workflowSlots.has(item.workflow)) workflowSlots.set(item.workflow, workflowSlots.size);
    const slot = workflowSlots.get(item.workflow);
    const color = slot < 8 ? `var(--c-s${slot + 1})` : "var(--c-other)";
    const count = Number(item.count) || 0;
    const width = Math.max(count ? 3 : 0, (count / max) * 100);
    return `<div class="workflow-row"><span>${escapeMetricText(item.workflow)}</span><div class="workflow-track"><div class="workflow-fill" style="--lc:${color};width:${width}%"></div></div><strong class="workflow-number">${count}</strong></div>`;
  }).join("");
}

function setSelectedBucket(index) {
  selectedBucket = index === selectedBucket ? -1 : index;
  const chip = document.getElementById("claimSelection");
  const bucket = lastClaimBuckets[selectedBucket];
  chip.hidden = !bucket;
  if (bucket) chip.textContent = `${bucket.label} · ${Number(bucket.total) || 0} claims`;
  highlightSelectedRow();
  chartInstances.claims?.update(reducedMotion ? "none" : undefined);
}
function highlightSelectedRow() {
  [...document.querySelectorAll("#claimAnalyticsTableBody tr")].forEach((row, i) => row.classList.toggle("is-selected", i === selectedBucket));
}

function renderClaimAnalyticsChart(buckets) {
  lastClaimBuckets = buckets;
  const empty = document.getElementById("claimChartEmpty");
  const canvas = document.getElementById("claimPipelineCanvas");
  renderSparks();
  if (!buckets.length) {
    destroyChart("claims");
    canvas.hidden = true;
    empty.hidden = false;
    return;
  }
  canvas.hidden = false;
  empty.hidden = true;
  const theme = chartTheme();
  const names = [["draft", "Draft"], ["transmitted", "Transmitted"], ["other", "Other status"]];
  buildChart("claims", "claimPipelineCanvas", {
    type: "bar",
    data: { labels: buckets.map((b) => b.label), datasets: names.map(([key, label]) => ({
      label, hidden: hiddenSeries.has(key), data: buckets.map((b) => Number(b[key]) || 0),
      backgroundColor: (ctx) => (selectedBucket >= 0 && ctx.dataIndex !== selectedBucket ? withAlpha(theme[key], "55") : theme[key]),
      borderColor: theme.surface, borderWidth: 2, borderRadius: 4, borderSkipped: false, maxBarThickness: 24,
    })) },
    options: {
      interaction: { mode: "index", intersect: false },
      onClick: (event, elements, chart) => {
        const hit = chart.getElementsAtEventForMode(event, "index", { intersect: false }, false);
        if (hit.length) setSelectedBucket(hit[0].index);
      },
      onHover: (event, elements) => { event.native.target.style.cursor = elements.length ? "pointer" : "default"; },
      scales: {
        x: { stacked: true, grid: { display: false }, border: { color: theme.axis }, ticks: { color: theme.text, font: { size: 10 }, maxRotation: 0, autoSkip: true } },
        y: { stacked: true, beginAtZero: true, border: { display: false }, grid: { color: theme.grid }, ticks: { color: theme.text, precision: 0, maxTicksLimit: 5, font: { size: 10 } } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipStyle(theme), callbacks: {
          footer: (items) => `Total ${items.reduce((sum, item) => sum + item.parsed.y, 0)}`,
        } },
      },
    },
  });
}

function renderClaimMix(analytics) {
  if (!analytics) return;
  const theme = chartTheme();
  const counts = {
    draft: Number(analytics.draft_claims) || 0,
    transmitted: Number(analytics.transmitted_claims) || 0,
    other: Number(analytics.other_claims) || 0,
  };
  document.querySelector('[data-mix="draft"]').textContent = String(counts.draft);
  document.querySelector('[data-mix="transmitted"]').textContent = String(counts.transmitted);
  const keys = ["draft", "transmitted", "other"];
  const shown = keys.map((key) => (hiddenSeries.has(key) ? 0 : counts[key]));
  document.getElementById("mixTotal").textContent = String(shown.reduce((a, b) => a + b, 0));
  buildChart("mix", "claimMixCanvas", {
    type: "doughnut",
    data: { labels: ["Draft", "Transmitted", "Other status"], datasets: [{
      data: shown, backgroundColor: keys.map((key) => theme[key]), borderColor: theme.surface, borderWidth: 2, hoverOffset: 4,
    }] },
    options: {
      cutout: "68%",
      plugins: { legend: { display: false }, tooltip: { ...tooltipStyle(theme), callbacks: { label: (item) => ` ${item.label}: ${item.parsed}` } } },
    },
  });
}

function renderClaimShares(analytics) {
  const total = Number(analytics?.total_claims) || 0;
  for (const key of ["draft", "transmitted"]) {
    const note = document.querySelector(`[data-share="${key}"]`);
    if (note) note.textContent = total ? `${Math.round(((Number(analytics[`${key}_claims`]) || 0) / total) * 100)}% of total` : "";
  }
}

function toggleSeries(name) {
  if (hiddenSeries.has(name)) hiddenSeries.delete(name); else hiddenSeries.add(name);
  document.querySelectorAll(`[data-series="${name}"]`).forEach((el) => el.setAttribute("aria-pressed", String(!hiddenSeries.has(name))));
  if (lastClaimBuckets.length) renderClaimAnalyticsChart(lastClaimBuckets);
  renderClaimMix(lastClaimAnalytics);
}
document.querySelectorAll("button[data-series]:not(:disabled)").forEach((button) => button.addEventListener("click", () => toggleSeries(button.dataset.series)));

function rerenderCharts() {
  renderDailyRunsChart(lastRunDays);
  if (lastClaimBuckets.length) renderClaimAnalyticsChart(lastClaimBuckets);
  renderClaimMix(lastClaimAnalytics);
}
new MutationObserver(rerenderCharts).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

function updateSetupChecklist() {
  const panel = document.getElementById("setupChecklist");
  if (!panel) return;
  let beaconKnown = false, beacon = false;
  try { beaconKnown = Boolean(heartbeatController?.lastConnectionState); beacon = heartbeatController?.lastConnectionState?.connected === true; } catch { /* not ready yet */ }
  const done = { beacon, claims: claimAnalyticsHasData, run: Number(lastRunsTotal) > 0 };
  for (const [step, value] of Object.entries(done)) {
    const el = panel.querySelector(`[data-step="${step}"]`);
    el.classList.toggle("done", value);
    el.querySelector(".check-mark").textContent = value ? "✓" : ({ beacon: "1", claims: "2", run: "3" })[step];
  }
  let dismissed = false;
  try { dismissed = localStorage.getItem("beabots-checklist-dismissed") === "1"; } catch { /* optional */ }
  const ready = beaconKnown && setupState.metrics && setupState.claims;
  panel.hidden = !ready || dismissed || Object.values(done).every(Boolean);
}
document.getElementById("dismissChecklist").addEventListener("click", () => {
  try { localStorage.setItem("beabots-checklist-dismissed", "1"); } catch { /* optional */ }
  updateSetupChecklist();
});
document.getElementById("checklistFetch").addEventListener("click", () => confirmClaimAnalyticsRefresh());
document.getElementById("homeDate").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

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

function updateBeaconDataAccount(settings) {
  const accountName = document.getElementById("beaconDataAccountName");
  const username = String(settings.username || "").trim();
  const server = settings.server === "s2" ? "S2" : "S4";
  const label = username ? `${username} (${server})` : "Not configured";
  if (accountName.textContent !== label) accountName.textContent = label;
}

async function refreshDashboardMetrics() {
  const staleBoxes = [...document.querySelectorAll(".chart-box")];
  staleBoxes.forEach((box) => box.classList.add("is-stale"));
  try {
    const metrics = await fetchJSON("/api/dashboard/metrics");
    dashboardUptimeSeconds = Number(metrics.server_uptime_seconds) || 0;
    dashboardUptimeClock = performance.now();
    document.getElementById("metricOnline").textContent = String(Number(metrics.online_users) || 0);
    renderOnlineUsers(metrics.online_user_list || []);
    document.getElementById("metricRuns").textContent = String(Number(metrics.runs_30_days) || 0);
    document.getElementById("metricSuccess").textContent = metrics.success_rate == null ? "—" : `${metrics.success_rate}%`;
    const rate = Math.max(0, Math.min(100, Number(metrics.success_rate) || 0));
    document.getElementById("successRing").setAttribute("stroke-dasharray", `${(rate / 100) * 113.1} 113.1`);
    document.getElementById("successRing").style.display = metrics.success_rate == null ? "none" : "";
    lastRunsTotal = Number(metrics.runs_30_days) || 0;
    setupState.metrics = true;
    renderDailyRunsChart(metrics.daily_runs || []);
    renderWorkflowChart(metrics.workflow_runs || []);
    await loadRunHistory();
    updateDashboardUptime();
  } catch {
    document.getElementById("recentRunsBody").innerHTML = '<tr><td class="activity-empty" colspan="6">Dashboard metrics could not be loaded. Refresh to try again.</td></tr>';
    document.getElementById("metricUptime").textContent = "Unavailable";
  } finally {
    staleBoxes.forEach((box) => box.classList.remove("is-stale"));
    updateSetupChecklist();
  }
}

function updateDashboardUptime() {
  if (dashboardUptimeSeconds == null) return;
  const elapsed = Math.floor((performance.now() - dashboardUptimeClock) / 1000);
  document.getElementById("metricUptime").textContent = formatUptime(dashboardUptimeSeconds + elapsed);
}

function renderClaimAnalyticsTable(buckets) {
  const body = document.getElementById("claimAnalyticsTableBody");
  if (!buckets.length) {
    body.innerHTML = '<tr><td class="analytics-empty" colspan="5">No admission periods in this date range.</td></tr>';
    return;
  }
  body.innerHTML = buckets.map((bucket) => `<tr><td>${escapeMetricText(bucket.label)}</td><td>${Number(bucket.draft) || 0}</td><td>${Number(bucket.transmitted) || 0}</td><td>${Number(bucket.other) || 0}</td><td><strong>${Number(bucket.total) || 0}</strong></td></tr>`).join("");
  highlightSelectedRow();
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
  document.getElementById("fetchClaimAnalyticsButton").disabled = disabled;
  document.getElementById("claimAnalyticsGroup").disabled = disabled;
  document.getElementById("claimAnalyticsFilterMonth").disabled = disabled;
  document.getElementById("billingScheduleMonth").disabled = disabled;
  document.getElementById("addBillingWeek").disabled = disabled || document.querySelectorAll("#billingWeekRows tr").length >= 6;
  document.getElementById("saveBillingSchedule").disabled = disabled;
  for (const input of document.querySelectorAll(".billing-schedule-table input, .billing-schedule-table button")) input.disabled = disabled;
}

let claimAnalyticsLoading = false;
let claimAnalyticsSyncing = false;
let claimAnalyticsHasData = false;

function renderClaimAnalytics(analytics, month, group, filterMonth) {
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
    return `<option value="${escapeMetricText(value)}">${escapeMetricText(label)}</option>`;
  }).join("");
  filter.value = months.includes(selectedFilter) ? selectedFilter : "all";
  showBillingWeeks(analytics.weeks, month, analytics.schedule_source || "automatic");
  document.getElementById("claimAnalyticsBucketHeading").textContent = group === "month" ? "Month" : "Billing week";
  document.getElementById("claimMetricDraft").textContent = String(Number(analytics.draft_claims) || 0);
  document.getElementById("claimMetricTransmitted").textContent = String(Number(analytics.transmitted_claims) || 0);
  document.getElementById("claimMetricOther").textContent = String(Number(analytics.other_claims) || 0);
  document.getElementById("claimMetricTotal").textContent = String(Number(analytics.total_claims) || 0);
  lastClaimAnalytics = analytics;
  selectedBucket = -1;
  document.getElementById("claimSelection").hidden = true;
  renderClaimAnalyticsChart(analytics.buckets || []);
  renderClaimMix(analytics);
  renderClaimShares(analytics);
  const rows = [...(analytics.buckets || [])];
  if (Number(analytics.unassigned?.total) > 0) rows.push(analytics.unassigned);
  renderClaimAnalyticsTable(rows);

  const missing = Number(analytics.missing_admission_dates) || 0;
  const unassigned = Number(analytics.unassigned?.total) || 0;
  const periodLabel = filterMonth === "all"
    ? "Latest 90 days"
    : new Intl.DateTimeFormat([], { month: "long", year: "numeric" }).format(new Date(`${filterMonth}-01T12:00:00`));
  const notes = [`${periodLabel} | Counts are grouped by claim admission date.`];
  if (unassigned) notes.push(`${unassigned} claim${unassigned === 1 ? "" : "s"} fall outside the configured ranges.`);
  if (missing) notes.push(`${missing} candidate claim${missing === 1 ? "" : "s"} had no admission date, so could not be placed in the 90-day window.`);
  notes.push(`Local cache contains ${Number(analytics.cached_claims) || 0} claims; the latest refresh checked ${Number(analytics.transmittals_scanned) || 0} transmittals and fetched ${Number(analytics.claims_scanned) || 0} claim records.`);
  if (Number(analytics.failed_transmittals) > 0) notes.push(`${Number(analytics.failed_transmittals)} transmittal(s) failed; these results may be incomplete.`);
  if (analytics.sync_state === "error") notes.push("Beacon refresh failed; showing the latest cached data. Use Refresh to try again.");
  if (analytics.cache_age_seconds != null && Number.isFinite(Number(analytics.cache_age_seconds))) {
    const ageMinutes = Math.floor(Number(analytics.cache_age_seconds) / 60);
    notes.push(`Local data last refreshed ${ageMinutes < 1 ? "less than a minute" : `${ageMinutes} minute${ageMinutes === 1 ? "" : "s"}`} ago.`);
  }
  document.getElementById("claimAnalyticsCacheStatus").textContent = notes.join(" ");
}

function setClaimAnalyticsView(hasData) {
  claimAnalyticsHasData = hasData;
  document.querySelector(".home-content").classList.toggle("no-claims", !hasData);
  setupState.claims = true;
  updateSetupChecklist();
  document.getElementById("claimAnalyticsControls").hidden = !hasData;
  document.getElementById("claimAnalyticsResults").hidden = !hasData;
  document.getElementById("claimAnalyticsFetchPrompt").hidden = hasData || claimAnalyticsSyncing;
  document.getElementById("refreshClaimAnalytics").hidden = !hasData;
  document.getElementById("editBillingRangesButton").hidden = !hasData || !signedInIsAdmin;
  document.getElementById("billingScheduleEditor").hidden = !hasData || !signedInIsAdmin;
  document.getElementById("billingScheduleMonthControl").hidden = !signedInIsAdmin;
}

async function refreshClaimAnalytics() {
  if (claimAnalyticsLoading || claimAnalyticsSyncing) return;
  claimAnalyticsLoading = true;
  setClaimAnalyticsControlsDisabled(true);
  try {
    const month = document.getElementById("billingScheduleMonth").value;
    const group = document.getElementById("claimAnalyticsGroup").value;
    const filterMonth = document.getElementById("claimAnalyticsFilterMonth").value || "all";
    const params = new URLSearchParams({ month, group, filter_month: filterMonth });
    const analytics = await fetchJSON(`/api/dashboard/claim-analytics?${params}`);
    if (analytics.error) throw new Error(analytics.error);
    const hasData = analytics.sync_state === "ready"
      || analytics.sync_state === "partial"
      || Number(analytics.cached_claims) > 0;
    setClaimAnalyticsView(hasData);
    if (hasData) {
      renderClaimAnalytics(analytics, month, group, filterMonth);
      if (analytics.sync_state === "running") {
        document.getElementById("claimAnalyticsRefreshBanner").hidden = false;
        document.getElementById("claimAnalyticsRefreshBanner").textContent = "A Beacon refresh is active in another dashboard tab. Your cached analytics remain available here.";
      } else {
        document.getElementById("claimAnalyticsRefreshBanner").hidden = true;
      }
    } else {
      document.getElementById("claimAnalyticsRefreshBanner").hidden = true;
      document.getElementById("claimAnalyticsFetchPromptMessage").textContent = analytics.sync_state === "error"
        ? "The previous Beacon refresh did not finish. Start a new fetch when you are ready; it may take several minutes."
        : "Choose when to download transmittal and claim details for the latest 90 days. The first fetch may take several minutes.";
    }
  } catch (error) {
    const message = error && error.message ? error.message : "Unable to load cached claim analytics.";
    document.getElementById("claimAnalyticsFetchPromptMessage").textContent = `Local analytics could not be loaded: ${message}`;
    setClaimAnalyticsView(false);
  } finally {
    claimAnalyticsLoading = false;
    setClaimAnalyticsControlsDisabled(false);
  }
}

function setAnalyticsDownloadProgress(progress) {
  const track = document.getElementById("analyticsDownloadTrack");
  const fill = document.getElementById("analyticsDownloadFill");
  const percent = document.getElementById("analyticsProgressPercent");
  const counts = document.getElementById("analyticsProgressCounts");
  const status = document.getElementById("claimAnalyticsStatus");
  const title = document.getElementById("claimAnalyticsLoadingTitle");
  if (progress.message) status.textContent = progress.message;
  if (Number(progress.total) > 0) {
    const current = Math.min(Number(progress.current) || 0, Number(progress.total));
    const value = Math.round((current / Number(progress.total)) * 100);
    track.classList.remove("is-indeterminate");
    track.setAttribute("aria-valuenow", String(value));
    fill.style.width = `${value}%`;
    percent.textContent = `${value}%`;
    counts.textContent = `Transmittal ${current.toLocaleString()} of ${Number(progress.total).toLocaleString()}`;
  } else {
    track.classList.add("is-indeterminate");
    track.removeAttribute("aria-valuenow");
    fill.style.width = "34%";
    percent.textContent = "...";
    counts.textContent = "Connecting to Beacon and loading the transmittal list";
  }
  title.textContent = progress.phase === "transmittals"
    ? "Loading Beacon transmittals"
    : progress.phase === "claims"
      ? "Fetching claim details"
      : progress.phase === "error"
        ? "Refresh stopped"
        : "Refreshing Beacon analytics";
}

async function startClaimAnalyticsRefresh() {
  if (claimAnalyticsLoading || claimAnalyticsSyncing) return;
  claimAnalyticsLoading = true;
  claimAnalyticsSyncing = true;
  const progressId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const loadingPanel = document.getElementById("claimAnalyticsLoadingPanel");
  const fetchPrompt = document.getElementById("claimAnalyticsFetchPrompt");
  const status = document.getElementById("claimAnalyticsStatus");
  loadingPanel.hidden = false;
  fetchPrompt.hidden = true;
  document.getElementById("claimAnalyticsResults").hidden = !claimAnalyticsHasData;
  setAnalyticsDownloadProgress({ phase: "starting", current: 0, total: 0, message: "Connecting to Beacon..." });
  setClaimAnalyticsControlsDisabled(true);
  try {
    const result = await fetchJSON("/api/dashboard/claim-analytics/refresh", {
      method: "POST",
      body: JSON.stringify({ progress_id: progressId }),
    });
    if (result.error) throw new Error(result.error);
    claimAnalyticsLoading = false;
    while (claimAnalyticsSyncing) {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      const progress = await fetchJSON(`/api/dashboard/claim-analytics/progress/${encodeURIComponent(progressId)}`);
      setAnalyticsDownloadProgress(progress);
      if (!progress.done) continue;
      claimAnalyticsSyncing = false;
      break;
    }
    loadingPanel.hidden = true;
    claimAnalyticsLoading = false;
    setClaimAnalyticsControlsDisabled(false);
    await refreshClaimAnalytics();
  } catch (error) {
    claimAnalyticsLoading = false;
    claimAnalyticsSyncing = false;
    loadingPanel.hidden = true;
    setClaimAnalyticsControlsDisabled(false);
    const message = error && error.message ? error.message : "Unable to start Beacon analytics refresh.";
    if (claimAnalyticsHasData) {
      const banner = document.getElementById("claimAnalyticsRefreshBanner");
      banner.hidden = false;
      banner.textContent = `Beacon refresh could not be completed: ${message}`;
    } else {
      fetchPrompt.hidden = false;
      document.getElementById("claimAnalyticsFetchPromptMessage").textContent = `Beacon fetch could not be completed: ${message}`;
    }
    status.textContent = message;
  }
}

function confirmClaimAnalyticsRefresh() {
  showConfirmModal(
    "Fetch Beacon claims analytics",
    "This will fetch transmittal and claim data from Beacon for the latest 90 days and refresh the local analytics cache. It may take several minutes. You can keep using the dashboard while it runs.",
    { confirmText: "Fetch from Beacon", cancelText: "Cancel", onConfirm: startClaimAnalyticsRefresh },
  );
}

async function saveClaimBillingSchedule() {
  if (claimAnalyticsLoading || claimAnalyticsSyncing) return;
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
    document.getElementById("billingScheduleModal").close();
    saved = true;
  } catch (error) {
    const message = error && error.message ? error.message : "Unable to save billing periods.";
    status.textContent = `Billing periods could not be saved: ${message}`;
  } finally {
    claimAnalyticsLoading = false;
    setClaimAnalyticsControlsDisabled(claimAnalyticsSyncing);
  }
  if (saved) refreshClaimAnalytics();
}

document.getElementById("billingScheduleMonth").value = currentPhilippineMonth();
const billingScheduleModal = document.getElementById("billingScheduleModal");
document.getElementById("editBillingRangesButton").addEventListener("click", () => {
  if (!billingScheduleModal.open) billingScheduleModal.showModal();
});
document.getElementById("closeBillingScheduleModal").addEventListener("click", () => billingScheduleModal.close());
document.getElementById("fetchClaimAnalyticsButton").addEventListener("click", confirmClaimAnalyticsRefresh);
document.getElementById("refreshClaimAnalytics").addEventListener("click", confirmClaimAnalyticsRefresh);
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

loadRunHistory();
refreshDashboardMetrics();
setInterval(updateDashboardUptime, 30000);

const dashboardColumns = document.getElementById("dashboardColumns");
const dashboardLayoutButtons = [...document.querySelectorAll("[data-dashboard-layout]")];
const dashboardLayouts = ["overview", "claims", "operations"];
function setDashboardLayout(layout, persist = false) {
  if (!dashboardLayouts.includes(layout)) layout = "overview";
  dashboardColumns.dataset.layout = layout;
  dashboardLayoutButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.dashboardLayout === layout));
  });
  Object.values(chartInstances).forEach((chart) => chart.resize());
  if (persist) {
    try { localStorage.setItem("beabots-dashboard-layout", layout); }
    catch { /* The dashboard works without a saved layout preference. */ }
  }
}
dashboardLayoutButtons.forEach((button) => {
  button.addEventListener("click", () => setDashboardLayout(button.dataset.dashboardLayout, true));
});
try {
  const savedLayout = localStorage.getItem("beabots-dashboard-layout");
  // Older builds stored "workflow" (claims analytics) or "split".
  setDashboardLayout(savedLayout === "workflow" ? "claims" : savedLayout, false);
}
catch { setDashboardLayout("overview"); }

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
  document.getElementById("notificationTeamChatUnread").hidden = !teamUnread;
  const unreadCount = Number(teamUnread);
  const indicator = document.getElementById("notificationUnreadIndicator");
  indicator.hidden = unreadCount === 0;
  indicator.textContent = String(unreadCount);
  indicator.setAttribute("aria-label", `${unreadCount} chat${unreadCount === 1 ? "" : "s"} with unread messages`);
  document.getElementById("notificationTrigger").setAttribute(
    "aria-label",
    `Notifications${unreadCount ? `, ${unreadCount} unread chat${unreadCount === 1 ? "" : "s"}` : ""}`
  );
  if (window.parent !== window) {
    window.parent.postMessage({ type: "chat-unread-update", count: unreadCount }, location.origin);
  }
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
  dashboard: document.getElementById("btnSidebarDashboard"),
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
  settings: document.getElementById("btnSettings"),
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
  if (window.parent !== window && typeof window.parent.openBeabotsWorkspace === "function") {
    window.parent.openBeabotsWorkspace("dashboard");
    return;
  }
  activeWorkspaceKey = null;
  closeMobileSidebar();
  dashboardLayout.classList.remove("claims-mode");
  workspaceColumn.classList.remove("workspace-active");
  Object.values(workspaceFrames).forEach((frame) => frame.classList.remove("active"));
  setWorkspaceActive("dashboard");
  history.replaceState(null, "", "workspace.html");
}

function openWorkspace(activeKey) {
  if (window.parent !== window && typeof window.parent.openBeabotsWorkspace === "function") {
    window.parent.openBeabotsWorkspace(activeKey);
    return;
  }
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
  history.replaceState(null, "", `workspace.html#${activeKey}`);
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
document.getElementById("btnSidebarDashboard").addEventListener("click", () => {
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
  if (window.parent !== window && typeof window.parent.openBeabotsAgreement === "function") {
    window.parent.openBeabotsAgreement(required);
    return;
  }
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
const notificationTrigger = document.getElementById("notificationTrigger");
const notificationMenu = document.getElementById("notificationMenu");

function closeAccountMenu() {
  accountMenu.hidden = true;
  accountTrigger.setAttribute("aria-expanded", "false");
}
function closeNotificationMenu() {
  notificationMenu.hidden = true;
  notificationTrigger.setAttribute("aria-expanded", "false");
}
function closeAllMenus() {
  closeAccountMenu();
  closeNotificationMenu();
}

accountTrigger.addEventListener("click", () => {
  const expanded = accountTrigger.getAttribute("aria-expanded") !== "true";
  if (expanded) closeNotificationMenu();
  accountTrigger.setAttribute("aria-expanded", String(expanded));
  accountMenu.hidden = !expanded;
});
notificationTrigger.addEventListener("click", () => {
  const expanded = notificationTrigger.getAttribute("aria-expanded") !== "true";
  if (expanded) closeAccountMenu();
  notificationTrigger.setAttribute("aria-expanded", String(expanded));
  notificationMenu.hidden = !expanded;
});
document.addEventListener("click", (event) => {
  if (accountMenu.hidden && notificationMenu.hidden) return;
  if (accountTrigger.contains(event.target) || accountMenu.contains(event.target)) return;
  if (notificationTrigger.contains(event.target) || notificationMenu.contains(event.target)) return;
  closeAllMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || (accountMenu.hidden && notificationMenu.hidden)) return;
  closeAllMenus();
  if (!accountMenu.hidden) accountTrigger.focus();
  else if (!notificationMenu.hidden) notificationTrigger.focus();
});
// Clicks inside a workspace iframe do not bubble here, but they blur this window.
window.addEventListener("blur", closeAllMenus);
document.getElementById("accountSettings").addEventListener("click", () => {
  closeAccountMenu();
  openWorkspace("settings");
});

document.getElementById("notificationTeamChat").addEventListener("click", () => {
  closeNotificationMenu();
  openWorkspace("teamCollab");
});
document.getElementById("siteUsers").addEventListener("click", () => {
  closeAccountMenu();
  openWorkspace("users");
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
    document.getElementById("billingScheduleEditor").hidden = !signedInIsAdmin || !claimAnalyticsHasData;
    document.getElementById("billingScheduleMonthControl").hidden = !signedInIsAdmin;
    document.getElementById("editBillingRangesButton").hidden = !signedInIsAdmin || !claimAnalyticsHasData;
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
    if (pendingAgreementEmail && localStorage.getItem(pendingAgreementKey) !== "v2") {
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
  const avatars = {
    "avatar-bunny": "avatar-bunny.svg",
    "avatar-cat": "avatar-cat.svg",
    "avatar-dog": "avatar-dog.svg",
    "avatar-fox": "avatar-fox.svg",
    "avatar-panda": "avatar-panda.svg",
    "avatar-penguin": "avatar-penguin.svg",
  };
  const avatarNode = document.getElementById("accountAvatar");
  const avatarImage = document.createElement("img");
  avatarImage.src = `assets/avatar/${avatars[user.avatar] || avatars["avatar-penguin"]}`;
  avatarImage.alt = "";
  document.getElementById("accountName").textContent = displayName;
  avatarNode.replaceChildren(avatarImage);
  avatarNode.setAttribute("aria-label", `${displayName} avatar`);
  document.getElementById("homeGreeting").textContent = `Welcome${user.display_name || user.profile_name ? `, ${displayName}` : " to Beabots"}`;
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
  if (event.data?.type === "settings-beacon-updated") {
    refreshClaimAnalytics();
    heartbeatController?.pollConnectionStatus();
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
document.getElementById("btnSettings").addEventListener("click", () => {
  openWorkspace("settings");
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
    this.connectSocket();
    this.updateHeartbeat();
    this.startPolling();
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
      updateBeaconDataAccount(settings);
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
    const { connected = false, slow = false } = this.lastConnectionState || {};
    const automationActive = this.activeAutomations.size > 0;
    const chip = document.getElementById("beaconChip");
    if (chip) {
      const state = !this.lastConnectionState ? "checking" : !connected ? "disconnected" : slow ? "slow" : "connected";
      chip.dataset.state = state;
      document.getElementById("beaconChipText").textContent = ({
        checking: "Checking Beacon…",
        disconnected: "Beacon disconnected",
        slow: "Beacon connected · slow",
        connected: automationActive ? "Beacon connected · automation running" : "Beacon connected",
      })[state];
    }
    updateSetupChecklist();
    if (window.parent !== window) {
      window.parent.postMessage({
        type: "beacon-heartbeat-update",
        connected,
        slow,
        active: automationActive,
        checking: !this.lastConnectionState,
      }, window.location.origin);
    }
    if (!this.heartbeatEl) return;

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
window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || event.source !== window.parent || event.data?.type !== "beacon-status-refresh") return;
  heartbeatController?.pollConnectionStatus();
});

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