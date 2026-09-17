/*
 * Shared helpers used by every window's renderer JS (dashboard, CF2,
 * Upload SOA, Settings). Keeps the modal/fetch/API-base logic in one
 * place instead of copy-pasted per window.
 */

if (!window.beabots) {
  window.beabots = {
    apiBase: window.location.origin,
    minimize: () => {},
    maximize: () => {},
    close: () => { window.location.href = "/dashboard.html"; },
    goHome: () => { window.location.href = "/dashboard.html"; },
    goToDashboard: () => { window.location.href = "/dashboard.html"; },
    showWorkspaceHome: () => { window.location.href = "/dashboard.html"; },
    openCf2Window: () => { window.location.href = "/cf2.html"; },
    openUploadSoaWindow: () => { window.location.href = "/upload-soa.html"; },
    openCf4Window: () => { window.location.href = "/cf4.html"; },
    openSettingsWindow: () => { window.location.href = "/settings.html"; },
    openAboutWindow: () => { window.location.href = "/about.html"; },
    logout: () => { window.location.href = "/"; },
    setWorkspaceSidebarWidth: () => {},
    focusSelf: () => window.focus(),
    onDashboardEnter: () => {},
    onWorkspaceActive: () => {},
    onServerLog: () => {},
    onUpdateProgress: () => {},
    getVersion: async () => "web",
    checkForUpdates: async () => ({ version: "web" }),
    getSettings: async () => fetchJSON("/api/settings"),
    downloadUpdate: async () => ({ ok: false, error: "Updates are managed by the hosted deployment." }),
    installUpdate: async () => false,
    releaseForceLock: () => {},
    getTheme: async () => localStorage.getItem("beabotsTheme") || "dark",
    setTheme: async (theme) => localStorage.setItem("beabotsTheme", theme),
    onThemeChanged: () => {},
  };
}

const API_BASE = window.beabots.apiBase || window.location.origin;

async function fetchJSON(path, options) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  return res.json();
}

/** Renders a simple OK-dismissable modal (replaces messagebox.showinfo/showerror/showwarning). */
function showModal(title, bodyText, { onOk } = {}) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <h3>${title}</h3>
        <p>${bodyText}</p>
        <div class="modal-actions">
          <button class="cyber-btn" id="modalOkBtn">OK</button>
        </div>
      </div>
    </div>`;
  document.getElementById("modalOkBtn").addEventListener("click", () => {
    root.innerHTML = "";
    if (onOk) onOk();
  });
}

function showError(title, message, opts) {
  showModal(title, message, opts);
}

// ---------------------------------------------------------------------------
// "Back to Home" titlebar button — present on CF2, CF4, and Upload SOA
// (not on the dashboard itself, and not on Settings, which is allowed to
// stay open alongside the dashboard). Wired here once instead of per-window
// so every renderer gets it for free. about.html doesn't load common.js, so
// it wires its own copy of this in about.js.
// ---------------------------------------------------------------------------
document.getElementById("btnHome")?.addEventListener("click", () => {
  window.beabots?.goHome();
});
