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
  window.beabots?.setWorkspaceSidebarWidth(collapsed ? 68 : 232);
});

document.querySelectorAll("[data-sidebar-group]").forEach((toggle) => {
  toggle.addEventListener("click", () => {
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
  teamChat: document.getElementById("btnTeamChat"),
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
  teamChat: "team-chat.html",
  about: "about.html",
  agreement: "agreement.html",
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
  dashboardLayout.classList.toggle("claims-mode", !["about", "agreement"].includes(activeKey));
  workspaceColumn.classList.add("workspace-active");
  Object.entries(workspaceFrames).forEach(([key, item]) => {
    item.classList.toggle("active", key === activeKey);
  });
  if (!frame.getAttribute("src")) {
    frame.src = route;
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
document.getElementById("siteContact").addEventListener("click", () => {
  setTopNavigation("siteContact");
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
      openWorkspace("agreement");
    } else if (pendingAgreementEmail) {
      sessionStorage.removeItem("beabots-agreement-pending");
    }
    const displayName = user.display_name || user.profile_name || user.email || "Account";
    document.getElementById("accountName").textContent = displayName;
    document.getElementById("accountAvatar").textContent = (displayName.trim()[0] || "B").toUpperCase();
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
document.getElementById("btnTeamChat").addEventListener("click", () => {
  openWorkspace("teamChat");
});
document.getElementById("siteUsers").addEventListener("click", () => {
  setTopNavigation("siteUsers");
  openWorkspace("users");
});
document.getElementById("btnSettings").addEventListener("click", () => {
  openWorkspace("settings");
});
// Initial state
// ---------------------------------------------------------------------------
const initialWorkspace = window.location.hash.replace("#", "");
if (workspaceRoutes[initialWorkspace]) {
  if (["about", "agreement", "settings"].includes(initialWorkspace)) setTopNavigation(["about", "agreement"].includes(initialWorkspace) ? "siteAbout" : "siteHome");
  else if (initialWorkspace === "users") setTopNavigation("siteUsers");
  else setTopNavigation("siteClaims");
  openWorkspace(initialWorkspace);
} else {
  setTopNavigation("siteHome");
}
