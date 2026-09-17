/*
 * Shared helpers used by every window's renderer JS (dashboard, CF2,
 * Upload SOA, Settings). Keeps the modal/fetch/API-base logic in one
 * place instead of copy-pasted per window.
 */

function openDashboardWorkspace(workspaceKey) {
  if (window.parent && window.parent !== window) {
    if (typeof window.parent.openBeabotsWorkspace === "function") {
      window.parent.openBeabotsWorkspace(workspaceKey);
    } else {
      window.parent.location.href = `/dashboard.html#${workspaceKey}`;
    }
    return;
  }
  window.location.href = `/dashboard.html#${workspaceKey}`;
}

if (!window.beabots) {
  window.beabots = {
    apiBase: window.location.origin,
    minimize: () => {},
    maximize: () => {},
    close: () => { window.location.href = "/dashboard.html"; },
    goHome: () => {
      if (window.parent && window.parent !== window) {
        window.parent.location.href = "/dashboard.html";
      } else {
        window.location.href = "/dashboard.html";
      }
    },
    goToDashboard: () => { window.location.href = "/dashboard.html"; },
    showWorkspaceHome: () => { window.location.href = "/dashboard.html"; },
    openCf2Window: () => openDashboardWorkspace("cf2"),
    openUploadSoaWindow: () => openDashboardWorkspace("uploadSoa"),
    openCf4Window: () => openDashboardWorkspace("cf4"),
    openSettingsWindow: () => openDashboardWorkspace("settings"),
    openAboutWindow: () => openDashboardWorkspace("about"),
    logout: async () => {
      try {
        await fetch(`${window.location.origin}/api/auth/logout`, { method: "POST" });
      } finally {
        window.location.href = "/";
      }
    },
    setWorkspaceSidebarWidth: () => {},
    focusSelf: () => window.focus(),
    onDashboardEnter: () => {},
    onWorkspaceActive: () => {},
    onServerLog: () => {},
    getVersion: async () => "web",
    getSettings: async () => fetchJSON("/api/settings"),
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

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);

  const selection = document.getSelection();
  const selectedRange = selection && selection.rangeCount > 0
    ? selection.getRangeAt(0)
    : null;

  textarea.focus();
  textarea.select();

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("Copy command was rejected.");
    }
  } finally {
    document.body.removeChild(textarea);
    if (selectedRange && selection) {
      selection.removeAllRanges();
      selection.addRange(selectedRange);
    }
  }
}

function showBeaconRequired(message) {
  showModal(
    "Beacon Account Required",
    message || "Please connect and validate your Beacon account in Settings before running automation.",
    { onOk: () => window.beabots?.openSettingsWindow?.() },
  );
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
