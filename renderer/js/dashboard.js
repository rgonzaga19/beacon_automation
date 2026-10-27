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
  cf2: document.getElementById("btnCf2"),
  runAll: document.getElementById("btnRunAll"),
  uploadSoa: document.getElementById("btnUploadSoa"),
  uploadDocuments: document.getElementById("btnUploadDocuments"),
  cf4: document.getElementById("btnCf4"),
  finalizeClaims: document.getElementById("btnFinalizeClaims"),
  soaExcelIndividual: document.getElementById("btnSoaIndividual"),
  soaExcelBatch: document.getElementById("btnSoaBatch"),
  autoRename: document.getElementById("btnAutoRename"),
  settings: document.getElementById("btnSettings"),
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
  finalizeClaims: "edit-claims.html",
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
  setWorkspaceActive(null);
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
accountTrigger.addEventListener("click", () => {
  const expanded = accountTrigger.getAttribute("aria-expanded") !== "true";
  accountTrigger.setAttribute("aria-expanded", String(expanded));
  accountMenu.hidden = !expanded;
});
document.getElementById("editProfileButton").addEventListener("click", () => {
  accountMenu.hidden = true;
  setTopNavigation("siteHome");
  showWorkspaceHome();
  requestAnimationFrame(() => {
    document.getElementById("profileCard").scrollIntoView({ behavior: "smooth", block: "center" });
    document.getElementById("profileNameInput").focus({ preventScroll: true });
  });
});
document.getElementById("accountSettings").addEventListener("click", () => openWorkspace("settings"));
document.getElementById("accountTeamChat").addEventListener("click", () => {
  accountMenu.hidden = true;
  accountTrigger.setAttribute("aria-expanded", "false");
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
    const displayName = user.display_name || user.profile_name || user.email || "Account";
    document.getElementById("accountName").textContent = displayName;
    document.getElementById("accountAvatar").textContent = (displayName.trim()[0] || "B").toUpperCase();
    updateChatUnreadIndicator();
    document.getElementById("homeGreeting").textContent = `Welcome${user.display_name ? `, ${user.display_name}` : " to Beabots"}`;
    document.getElementById("profileNameInput").value = user.profile_name || "";
    document.getElementById("displayNameInput").value = user.display_name || "";
    document.getElementById("upgradeAccountName").textContent = displayName;
    document.getElementById("upgradeAccountEmail").textContent = user.email || "";
    const upgradeButton = document.getElementById("upgradeAccountButton");
    if (user.is_admin || user.role === "subscriber") {
      upgradeButton.hidden = true;
    } else if (user.upgrade_request_status === "pending") {
      upgradeButton.textContent = "Request pending";
      upgradeButton.disabled = true;
    }
  } catch {
    window.location.replace("/login");
  }
}

document.getElementById("profileForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.getElementById("profileStatus");
  status.textContent = "Saving…";
  try {
    const result = await fetchJSON("/api/auth/profile", {
      method: "PATCH",
      body: JSON.stringify({
        profile_name: document.getElementById("profileNameInput").value,
        display_name: document.getElementById("displayNameInput").value,
      }),
    });
    const user = result.user;
    const name = user.display_name || user.profile_name || user.email || "Account";
    document.getElementById("accountName").textContent = name;
    document.getElementById("accountAvatar").textContent = (name.trim()[0] || "B").toUpperCase();
    document.getElementById("homeGreeting").textContent = `Welcome${user.display_name ? `, ${user.display_name}` : " to Beabots"}`;
    status.textContent = "Profile saved.";
  } catch (error) {
    status.textContent = error.message || "Could not save your profile.";
  }
});
loadSignedInProfile();
window.setInterval(refreshChatUnread, 30000);

const upgradeDialog = document.getElementById("upgradeDialog");
const upgradeRequestForm = document.getElementById("upgradeRequestForm");
document.getElementById("upgradeAccountButton").addEventListener("click", () => {
  document.getElementById("upgradeRequestMessage").value = "";
  document.getElementById("upgradeRequestStatus").textContent = "";
  upgradeDialog.showModal();
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
    const upgradeButton = document.getElementById("upgradeAccountButton");
    upgradeButton.textContent = "Request pending";
    upgradeButton.disabled = true;
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
document.getElementById("btnFinalizeClaims").addEventListener("click", () => {
  openWorkspace("finalizeClaims");
});
document.getElementById("btnAutoRename").addEventListener("click", () => {
  openWorkspace("autoRename");
});
document.getElementById("btnCollaborationChat").addEventListener("click", () => {
  openWorkspace("teamCollab");
});
document.getElementById("siteUsers").addEventListener("click", () => {
  accountMenu.hidden = true;
  accountTrigger.setAttribute("aria-expanded", "false");
  openWorkspace("users");
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
    });
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
}
