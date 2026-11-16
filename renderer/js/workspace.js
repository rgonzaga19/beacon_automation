const workspaceRoutes = {
  dashboard: "dashboard-home.html",
  soaExcel: "soa-excel.html",
  cf2: "cf2.html",
  uploadSoa: "upload-soa.html",
  cf4: "cf4.html",
  uploadDocuments: "upload-documents.html",
  editClaims: "edit-claims.html",
  runAll: "run-all.html",
  autoRename: "auto-rename.html",
  teamCollab: "team-chat.html",
  settings: "settings.html",
  users: "users.html",
  about: "about.html",
};

const workspaceLabels = {
  dashboard: "Dashboard",
  soaExcel: "SOA Generator",
  cf2: "Claim Form 2",
  uploadSoa: "Upload SOA",
  cf4: "Claim Form 4",
  uploadDocuments: "Upload Documents",
  editClaims: "Edit Claims",
  runAll: "Run Full Workflow",
  autoRename: "PDF Auto Rename",
  teamCollab: "Team Chat",
  settings: "Settings",
  users: "User Management",
  about: "About Beabots",
};

const sidebar = document.getElementById("workspaceSidebar");
const content = document.getElementById("workspaceContent");
const frames = Object.fromEntries(
  [...content.querySelectorAll("[data-workspace-frame]")]
    .map((frame) => [frame.dataset.workspaceFrame, frame])
);
const navLinks = [...sidebar.querySelectorAll("[data-workspace]")];
const groupTriggers = [...sidebar.querySelectorAll("[data-nav-group]")];
const mobileToggle = document.getElementById("workspaceMobileToggle");
const backdrop = document.getElementById("workspaceBackdrop");
const notificationTrigger = document.getElementById("workspaceNotificationTrigger");
const notificationMenu = document.getElementById("workspaceNotificationMenu");
const themeToggle = document.getElementById("workspaceThemeToggle");
const accountTrigger = document.getElementById("workspaceAccountTrigger");
const accountMenu = document.getElementById("workspaceAccountMenu");
let isAdmin = false;
BeabotsIcons.hydrate();

function syncWorkspaceThemeToggle() {
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  themeToggle.setAttribute("aria-checked", String(isLight));
  themeToggle.title = isLight ? "Switch to dark mode" : "Switch to light mode";
  BeabotsIcons.replace(themeToggle.querySelector(".workspace-theme-icon"), isLight ? "toggle-right" : "toggle-left", {
    size: 20,
    className: "workspace-theme-icon",
  });
}

syncWorkspaceThemeToggle();
new MutationObserver(syncWorkspaceThemeToggle).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme"],
});

function closeNotificationMenu() {
  notificationMenu.hidden = true;
  notificationTrigger.setAttribute("aria-expanded", "false");
}

function closeAccountMenu() {
  accountMenu.hidden = true;
  accountTrigger.setAttribute("aria-expanded", "false");
}

function setGroupOpen(trigger, open) {
  const subnav = document.getElementById(trigger.getAttribute("aria-controls"));
  trigger.setAttribute("aria-expanded", String(open));
  if (subnav) subnav.hidden = !open;
  const chevron = trigger.querySelector(".workspace-group-chevron");
  if (chevron) BeabotsIcons.replace(chevron, open ? "minus" : "plus", { size:16, className:"workspace-group-chevron" });
}

function closeGroups(except = null) {
  groupTriggers.forEach((trigger) => {
    if (trigger !== except) setGroupOpen(trigger, false);
  });
}

function closeMobileMenu() {
  sidebar.classList.remove("mobile-open");
  backdrop.hidden = true;
  mobileToggle.setAttribute("aria-expanded", "false");
  mobileToggle.setAttribute("aria-label", "Open workspace menu");
  BeabotsIcons.replace(mobileToggle.querySelector(".workspace-mobile-icon"), "menu", { size:16, className:"workspace-header-icon workspace-mobile-icon" });
}

function openMobileMenu() {
  sidebar.classList.remove("collapsed");
  sidebar.classList.add("mobile-open");
  backdrop.hidden = false;
  mobileToggle.setAttribute("aria-expanded", "true");
  mobileToggle.setAttribute("aria-label", "Close workspace menu");
  BeabotsIcons.replace(mobileToggle.querySelector(".workspace-mobile-icon"), "x", { size:16, className:"workspace-header-icon workspace-mobile-icon" });
}

function setActiveNavigation(key, tab = "individual", aboutSection = "about") {
  navLinks.forEach((link) => {
    const subitemMatches = link.dataset.soaTab
      ? link.dataset.soaTab === tab
      : link.dataset.aboutSection
        ? link.dataset.aboutSection === aboutSection
        : true;
    const matches = link.dataset.workspace === key && subitemMatches;
    link.classList.toggle("active", matches);
    if (matches) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  groupTriggers.forEach((trigger) => {
    const workspaceKey = trigger.dataset.collapsedWorkspace;
    const groupActive = workspaceKey === key
      || (trigger.dataset.navGroup === "automation" && ["uploadSoa", "cf4", "uploadDocuments"].includes(key));
    trigger.classList.toggle("active", groupActive);
    if (groupActive) trigger.setAttribute("aria-current", "page");
    else trigger.removeAttribute("aria-current");
  });
}

function postSoaTab(frame, tab) {
  const send = () => frame.contentWindow?.postMessage({ type: "soa-excel-tab", tab }, location.origin);
  if (frame.getAttribute("src") === workspaceRoutes.soaExcel && frame.contentDocument?.readyState === "complete") send();
  else frame.addEventListener("load", send, { once: true });
}

function activateWorkspace(requestedKey, { soaTab = "individual", aboutSection = "", settingsSection = "" } = {}) {
  let key = requestedKey;
  if (key === "soaExcelBatch") {
    key = "soaExcel";
    soaTab = "batch";
  }
  if (!workspaceRoutes[key] || (key === "users" && !isAdmin)) return;

  closeGroups();
  closeMobileMenu();
  const frame = frames[key];
  if (!frame) return;

  Object.entries(frames).forEach(([frameKey, item]) => {
    item.classList.toggle("active", frameKey === key);
  });
  setActiveNavigation(key, soaTab, aboutSection || "about");
  document.getElementById("workspacePageTitle").textContent = workspaceLabels[key] || "Workspace";

  const frameHasSource = Boolean(frame.getAttribute("src"));
  if (!frameHasSource) {
    if (key === "soaExcel") postSoaTab(frame, soaTab);
    const section = key === "about" ? aboutSection : key === "settings" ? settingsSection : "";
    frame.src = section ? `${workspaceRoutes[key]}#${section}` : workspaceRoutes[key];
  } else if (key === "about" && aboutSection) {
    try { frame.contentWindow.location.hash = aboutSection; } catch { /* The about frame may still be loading. */ }
  } else if (key === "settings" && settingsSection) {
    try { frame.contentWindow.location.hash = settingsSection; } catch { /* The settings frame may still be loading. */ }
  }
  if (key === "soaExcel" && frameHasSource) postSoaTab(frame, soaTab);
  if (key === "teamCollab") frame.contentWindow?.postMessage({ type: "chat-active" }, location.origin);

  const hash = key === "soaExcel" && soaTab === "batch" ? "soaExcelBatch" : key;
  history.replaceState(null, "", `/workspace.html#${hash}`);
}

window.openBeabotsWorkspace = (key) => activateWorkspace(key);
window.openBeabotsAgreement = (required = false) => {
  activateWorkspace("about", { aboutSection: "agreement" });
  const frame = frames.about;
  const show = () => frame.contentWindow?.postMessage({ type: "open-agreement", required }, location.origin);
  if (frame.contentDocument?.readyState === "complete" && frame.contentWindow.location.pathname.endsWith("/about.html")) show();
  else frame.addEventListener("load", show, { once: true });
};

groupTriggers.forEach((trigger) => {
  trigger.addEventListener("click", () => {
    if (sidebar.classList.contains("collapsed") && window.innerWidth > 760) {
      activateWorkspace(trigger.dataset.collapsedWorkspace, {
        soaTab: trigger.dataset.collapsedSoaTab || "individual",
      });
      return;
    }
    const isOpen = trigger.getAttribute("aria-expanded") === "true";
    closeGroups(trigger);
    setGroupOpen(trigger, !isOpen);
  });
});

navLinks.forEach((link) => {
  link.addEventListener("click", () => activateWorkspace(link.dataset.workspace, {
    soaTab: link.dataset.soaTab || "individual",
    aboutSection: link.dataset.aboutSection || "",
  }));
});

const workspaceSearchForm = document.getElementById("workspaceSearchForm");
const workspaceSearchInput = document.getElementById("workspaceSearchInput");
const searchableWorkspaceTools = [
  { terms: ["dashboard", "home"], key: "dashboard" },
  { terms: ["soa generator", "soa"], key: "soaExcel" },
  { terms: ["claim form 2", "cf2"], key: "cf2" },
  { terms: ["upload soa"], key: "uploadSoa" },
  { terms: ["claim form 4", "cf4"], key: "cf4" },
  { terms: ["upload documents", "document upload"], key: "uploadDocuments" },
  { terms: ["edit claims", "claims editor"], key: "editClaims" },
  { terms: ["run full workflow", "full workflow"], key: "runAll" },
  { terms: ["pdf auto rename", "auto rename"], key: "autoRename" },
  { terms: ["team chat", "chat"], key: "teamCollab" },
  { terms: ["settings", "profile settings"], key: "settings" },
  { terms: ["user management", "users"], key: "users" },
  { terms: ["about beabots", "about"], key: "about" },
];
const externalWorkspaceTools = [
  { terms: ["pdf splitter", "splitter"], url: "https://rgonzaga19.github.io/pdfsplitter/" },
  { terms: ["pdf editor", "editor"], url: "https://rgonzaga19.github.io/pdfeditor/" },
  { terms: ["dtr generator", "dtr"], url: "https://rgonzaga19.github.io/nephro_dtrgenerator/" },
];

function findToolMatch(value, tools) {
  const normalized = value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  return tools.find((tool) => tool.terms.some((term) => term === normalized));
}

function sendClaimSearch(frame, query) {
  const send = () => frame.contentWindow?.postMessage({ type: "workspace-claim-search", query }, location.origin);
  let ready = false;
  try { ready = frame.contentDocument?.readyState === "complete" && frame.contentWindow.location.pathname.endsWith("/edit-claims.html"); } catch { /* Wait for the editor frame to load. */ }
  if (ready) send();
  else frame.addEventListener("load", send, { once: true });
}

workspaceSearchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = workspaceSearchInput.value.trim();
  if (!query) return;
  const tool = findToolMatch(query, searchableWorkspaceTools);
  if (tool) {
    activateWorkspace(tool.key);
    workspaceSearchInput.blur();
    return;
  }
  const externalTool = findToolMatch(query, externalWorkspaceTools);
  if (externalTool) {
    window.open(externalTool.url, "_blank", "noopener,noreferrer");
    workspaceSearchInput.blur();
    return;
  }
  activateWorkspace("editClaims");
  sendClaimSearch(frames.editClaims, query);
  workspaceSearchInput.blur();
});
const sidebarCollapse = document.getElementById("workspaceSidebarCollapse");
sidebarCollapse.addEventListener("click", () => {
  const collapsed = sidebar.classList.toggle("collapsed");
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  sidebarCollapse.setAttribute("aria-label", label);
  sidebarCollapse.setAttribute("title", label);
  sidebarCollapse.setAttribute("aria-expanded", String(!collapsed));
  BeabotsIcons.replace(sidebarCollapse.querySelector(".workspace-sidebar-collapse-icon"), collapsed ? "chevron-right" : "chevron-left", { size:16, className:"workspace-sidebar-collapse-icon" });
});
mobileToggle.addEventListener("click", () => {
  if (sidebar.classList.contains("mobile-open")) closeMobileMenu();
  else openMobileMenu();
});
backdrop.addEventListener("click", closeMobileMenu);
notificationTrigger.addEventListener("click", () => {
  const open = notificationTrigger.getAttribute("aria-expanded") !== "true";
  if (open) closeAccountMenu();
  notificationMenu.hidden = !open;
  notificationTrigger.setAttribute("aria-expanded", String(open));
});
themeToggle.addEventListener("click", () => window.beabotsTheme.toggleTheme());
accountTrigger.addEventListener("click", () => {
  const open = accountTrigger.getAttribute("aria-expanded") !== "true";
  if (open) closeNotificationMenu();
  accountMenu.hidden = !open;
  accountTrigger.setAttribute("aria-expanded", String(open));
});
document.getElementById("workspaceProfileSettings").addEventListener("click", () => {
  closeAccountMenu();
  activateWorkspace("settings", { settingsSection: "profileSettings" });
});
document.getElementById("workspaceNotificationChat").addEventListener("click", () => {
  closeNotificationMenu();
  activateWorkspace("teamCollab");
});
document.addEventListener("click", (event) => {
  if (!notificationMenu.hidden && !notificationMenu.contains(event.target) && !notificationTrigger.contains(event.target)) closeNotificationMenu();
  if (!accountMenu.hidden && !accountMenu.contains(event.target) && !accountTrigger.contains(event.target)) closeAccountMenu();
});
window.addEventListener("blur", () => {
  closeNotificationMenu();
  closeAccountMenu();
});
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || !event.data) return;
  if (event.source === frames.dashboard.contentWindow && event.data.type === "beacon-heartbeat-update") {
    const status = document.getElementById("workspaceBeaconStatus");
    const heartbeat = document.getElementById("workspaceBeaconHeartbeat");
    const state = event.data.checking
      ? "checking"
      : !event.data.connected
        ? "disconnected"
        : event.data.active
          ? "active"
          : event.data.slow ? "slow" : "connected";
    const stateClass = state === "checking" ? "heartbeat-slow" : `heartbeat-${state}`;
    status.classList.remove("heartbeat-connected", "heartbeat-active", "heartbeat-slow", "heartbeat-disconnected");
    heartbeat.classList.remove("heartbeat-connected", "heartbeat-active", "heartbeat-slow", "heartbeat-disconnected");
    status.classList.add(stateClass);
    heartbeat.classList.add(stateClass);
    const path = heartbeat.querySelector("path");
    if (path) path.setAttribute("d", event.data.connected ? "M2 13h23l7-1 5-7 8 15 8-12 5 5h10l4-1h26" : "M2 13h96");
    const labels = { checking: "Checking", disconnected: "Offline", active: "Active", slow: "Slow", connected: "Connected" };
    const description = `Beacon ${labels[state].toLocaleLowerCase()}`;
    status.setAttribute("aria-label", description);
    status.title = description;
  } else if (event.source === frames.settings.contentWindow && event.data.type === "settings-beacon-updated") {
    frames.dashboard.contentWindow?.postMessage({ type: "beacon-status-refresh" }, location.origin);
  } else if (event.source === frames.about.contentWindow && event.data.type === "agreement-open-state") {
    document.querySelector(".workspace-header").inert = Boolean(event.data.open);
    sidebar.inert = Boolean(event.data.open);
  } else if (event.source === frames.dashboard.contentWindow && event.data.type === "chat-unread-update") {
    const count = Math.max(0, Number(event.data.count) || 0);
    const badge = document.getElementById("workspaceUnreadBadge");
    const chatUnread = document.getElementById("workspaceChatUnread");
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? "99+" : String(count);
    chatUnread.hidden = count === 0;
    notificationTrigger.setAttribute("aria-label", `Notifications${count ? `, ${count} unread chat${count === 1 ? "" : "s"}` : ""}`);
  } else if (event.source === frames.teamCollab.contentWindow && event.data.type === "chat-read") {
    frames.dashboard.contentWindow?.postMessage(event.data, location.origin);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeGroups();
    closeMobileMenu();
    if (!notificationMenu.hidden) {
      closeNotificationMenu();
      notificationTrigger.focus();
    }
    if (!accountMenu.hidden) {
      closeAccountMenu();
      accountTrigger.focus();
    }
  }
});

document.getElementById("workspaceSignOut").addEventListener("click", async () => {
  closeAccountMenu();
  try { await fetch("/api/auth/logout", { method: "POST" }); }
  finally { window.location.replace("/"); }
});

const avatarFiles = {
  "avatar-bunny": "avatar-bunny.svg",
  "avatar-cat": "avatar-cat.svg",
  "avatar-dog": "avatar-dog.svg",
  "avatar-fox": "avatar-fox.svg",
  "avatar-panda": "avatar-panda.svg",
  "avatar-penguin": "avatar-penguin.svg",
};

(async function initializeWorkspace() {
  try {
    const response = await fetch("/api/auth/me", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.authenticated) {
      window.location.replace("/login");
      return;
    }

    const user = data.user || {};
    isAdmin = Boolean(user.is_admin);
    document.getElementById("workspaceUserName").textContent = user.display_name || user.profile_name || user.email || "Workspace";
    document.querySelector("#workspaceUserAvatar img").src = `assets/avatar/${avatarFiles[user.avatar] || avatarFiles["avatar-penguin"]}`;
    accountTrigger.setAttribute("aria-label", `Account settings for ${user.display_name || user.profile_name || user.email || "Workspace"}`);
    document.getElementById("workspaceUsersLink").hidden = !isAdmin;

    const initialKey = location.hash.slice(1) || "dashboard";
    if (initialKey === "aboutContact") activateWorkspace("about", { aboutSection: "contact" });
    else activateWorkspace(initialKey);
  } catch {
    window.location.replace("/login");
  }
})();
