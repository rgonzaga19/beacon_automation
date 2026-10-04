/*
 * Dashboard renderer logic for the collapsible navigation workspace.
 */

// API_BASE, fetchJSON, showModal, and showError all live in common.js (loaded before this file).

if (window.parent && window.parent !== window) {
  window.parent.location.href = window.location.href;
}

// ---------------------------------------------------------------------------
// Title bar controls
// ---------------------------------------------------------------------------
document.getElementById("btnMinimize").addEventListener("click", () => {
  window.beabots?.minimize();
});
document.getElementById("btnMaximize").addEventListener("click", () => {
  window.beabots?.maximize();
});
document.getElementById("btnClose").addEventListener("click", () => {
  window.beabots?.close();
});

// ---------------------------------------------------------------------------
// Toolbar navigation
// ---------------------------------------------------------------------------
const sidebar = document.getElementById("dashboardSidebar");
const sidebarToggle = document.getElementById("btnSidebarToggle");
const sidebarToggleIcon = sidebarToggle.querySelector(".side-icon");

sidebarToggle.addEventListener("click", () => {
  const collapsed = sidebar.classList.toggle("collapsed");
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  sidebarToggle.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  sidebarToggleIcon.textContent = collapsed ? "\u203a" : "\u2039";
  window.beabots?.setWorkspaceSidebarWidth(collapsed ? 68 : 232);
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
  uploadSoa: document.getElementById("btnUploadSoa"),
  cf4: document.getElementById("btnCf4"),
  finalizeClaims: document.getElementById("btnFinalizeClaims"),
  soaExcel: document.getElementById("btnSoaExcel"),
  autoRename: document.getElementById("btnAutoRename"),
  pdfSplitter: document.getElementById("btnPdfSplitter"),
  settings: document.getElementById("btnSettings"),
  about: document.getElementById("btnAbout"),
};

const workspaceColumn = document.getElementById("workspaceColumn");
const workspaceRoutes = {
  cf2: "cf2.html",
  uploadSoa: "upload-soa.html",
  cf4: "cf4.html",
  finalizeClaims: "edit-claims.html",
  soaExcel: "soa-excel.html",
  autoRename: "auto-rename.html",
  pdfSplitter: "https://rgonzaga19.github.io/pdfsplitter/",
  settings: "settings.html",
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
  workspaceColumn.classList.remove("workspace-active");
  Object.values(workspaceFrames).forEach((frame) => frame.classList.remove("active"));
  setWorkspaceActive(null);
  history.replaceState(null, "", "dashboard.html");
}

function openWorkspace(activeKey) {
  const route = workspaceRoutes[activeKey];
  const frame = workspaceFrames[activeKey];
  if (!route || !frame) return;
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

window.openBeabotsWorkspace = openWorkspace;

window.beabots?.onWorkspaceActive(setWorkspaceActive);

document.getElementById("btnDashboardHome").addEventListener("click", () => {
  showWorkspaceHome();
});

document.getElementById("btnCf2").addEventListener("click", () => {
  openWorkspace("cf2");
});
document.getElementById("btnUploadSoa").addEventListener("click", () => {
  openWorkspace("uploadSoa");
});
document.getElementById("btnCf4").addEventListener("click", () => {
  openWorkspace("cf4");
});
document.getElementById("btnFinalizeClaims").addEventListener("click", () => {
  openWorkspace("finalizeClaims");
});
document.getElementById("btnSoaExcel").addEventListener("click", () => {
  openWorkspace("soaExcel");
});
document.getElementById("btnAutoRename").addEventListener("click", () => {
  openWorkspace("autoRename");
});
document.getElementById("btnPdfSplitter").addEventListener("click", () => {
  openWorkspace("pdfSplitter");
});
document.getElementById("btnSettings").addEventListener("click", () => {
  openWorkspace("settings");
});
document.getElementById("btnLogout").addEventListener("click", () => {
  window.beabots?.logout();
});
document.getElementById("btnAbout").addEventListener("click", () => {
  openWorkspace("about");
});

// ---------------------------------------------------------------------------
// PDF Splitter loading indicator
// ---------------------------------------------------------------------------
// The embedded PDF Splitter is a hosted page that can take a moment to appear;
// keep a loader visible while its frame is active and still loading.
const pdfSplitterFrame = document.querySelector('[data-workspace-frame="pdfSplitter"]');
const pdfSplitterLoader = document.getElementById("pdfSplitterLoader");

if (pdfSplitterFrame && pdfSplitterLoader) {
  let pdfSplitterLoaded = false;
  const syncPdfSplitterLoader = () => {
    const active = pdfSplitterFrame.classList.contains("active");
    pdfSplitterLoader.hidden = pdfSplitterLoaded || !active;
  };
  new MutationObserver(syncPdfSplitterLoader).observe(pdfSplitterFrame, {
    attributes: true,
    attributeFilter: ["src", "class"],
  });
  pdfSplitterFrame.addEventListener("load", () => {
    pdfSplitterLoaded = true;
    syncPdfSplitterLoader();
  });
  syncPdfSplitterLoader();
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------
const appVersionLabel = document.getElementById("appVersion");

async function loadVersion() {
  const currentVersion = await window.beabots.getVersion();
  appVersionLabel.textContent = `v${currentVersion}`;
}

loadVersion();

const initialWorkspace = window.location.hash.replace("#", "");
if (workspaceRoutes[initialWorkspace]) {
  openWorkspace(initialWorkspace);
}
