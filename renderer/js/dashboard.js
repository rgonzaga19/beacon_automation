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
};

const workspaceColumn = document.getElementById("workspaceColumn");
const dashboardLayout = document.querySelector(".dashboard-layout");
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
  dashboardLayout.classList.remove("claims-mode");
  workspaceColumn.classList.remove("workspace-active");
  Object.values(workspaceFrames).forEach((frame) => frame.classList.remove("active"));
  setWorkspaceActive(null);
  history.replaceState(null, "", "dashboard.html");
}

function openWorkspace(activeKey) {
  const route = workspaceRoutes[activeKey];
  const frame = workspaceFrames[activeKey];
  if (!route || !frame) return;
  dashboardLayout.classList.toggle("claims-mode", activeKey !== "about");
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
    const displayName = user.display_name || user.profile_name || user.email || "Account";
    document.getElementById("accountName").textContent = displayName;
    document.getElementById("accountAvatar").textContent = (displayName.trim()[0] || "B").toUpperCase();
    document.getElementById("homeGreeting").textContent = `Welcome${user.display_name ? `, ${user.display_name}` : " to Beabots"}`;
    document.getElementById("profileNameInput").value = user.profile_name || "";
    document.getElementById("displayNameInput").value = user.display_name || "";
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

const sidebarCopyrightYear = document.getElementById("sidebarCopyrightYear");
const sidebarVersionFull = document.getElementById("sidebarVersionFull");
const sidebarVersionShort = document.getElementById("sidebarVersionShort");
sidebarCopyrightYear.textContent = String(new Date().getFullYear());
fetchJSON("/api/app/version").then((result) => {
  const version = result.version || "web";
  sidebarVersionFull.textContent = `Version ${version}`;
  sidebarVersionShort.textContent = `v${version}`;
}).catch(() => {
  sidebarVersionFull.textContent = "Version web";
  sidebarVersionShort.textContent = "vweb";
});

window.openBeabotsWorkspace = openWorkspace;

window.beabots?.onWorkspaceActive(setWorkspaceActive);

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
const initialWorkspace = window.location.hash.replace("#", "");
if (workspaceRoutes[initialWorkspace]) {
  if (["about", "settings"].includes(initialWorkspace)) setTopNavigation(initialWorkspace === "about" ? "siteAbout" : "siteHome");
  else setTopNavigation("siteClaims");
  openWorkspace(initialWorkspace);
} else {
  setTopNavigation("siteHome");
}
