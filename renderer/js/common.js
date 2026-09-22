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
    getVersion: async () => {
      const result = await fetchJSON("/api/app/version");
      return result.version || "web";
    },
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

function showLicenseRequired(message) {
  showModal(
    "License Required",
    message || "Please activate a valid Beabots license in Settings before running automation.",
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

// Sidebar update status remains visible while switching embedded pages.
// Informational only: update scheduling and installation remain automatic.
if (window.parent === window && document.querySelector(".sidebar-bottom")) {
  let updateStrip;
  function sizeUpdateMessage() {
    const viewport = updateStrip.querySelector(".update-message-viewport");
    const message = viewport.firstChild;
    const distance = Math.max(0, message.scrollWidth - viewport.clientWidth);
    message.style.setProperty("--update-scroll-distance", `-${distance}px`);
    message.style.setProperty("--update-scroll-duration", `${Math.max(8, distance / 25 + 4)}s`);
    message.classList.toggle("scrolling", distance > 0);
  }
  async function refreshUpdateStatus() {
    try {
      const response = await fetch(`${API_BASE}/api/update/status`);
      if (!response.ok) return;
      const status = await response.json();
      if (!status.desktop_updates_enabled) return;
      if (!updateStrip) {
        updateStrip = document.createElement("div");
        updateStrip.className = "desktop-update-status";
        updateStrip.setAttribute("role", "status");
        updateStrip.setAttribute("aria-live", "polite");
        const viewport = document.createElement("div");
        viewport.className = "update-message-viewport";
        const message = document.createElement("span");
        viewport.appendChild(message);
        const progress = document.createElement("progress");
        progress.max = 100;
        progress.setAttribute("aria-label", "Update download progress");
        updateStrip.append(viewport, progress);
        document.querySelector(".sidebar-bottom").appendChild(updateStrip);
        new ResizeObserver(sizeUpdateMessage).observe(viewport);
      }
      updateStrip.dataset.phase = status.phase;
      const text = status.message + (status.phase === "downloading" && status.percent != null ? ` ${status.percent}%` : "");
      const message = updateStrip.querySelector(".update-message-viewport span");
      if (message.textContent !== text) {
        message.textContent = text;
        updateStrip.title = text;
        sizeUpdateMessage();
      }
      const progress = updateStrip.lastChild;
      progress.hidden = !["checking", "downloading", "verifying"].includes(status.phase);
      if (status.percent == null) progress.removeAttribute("value");
      else progress.value = status.percent;
    } catch {
      // Keep the last status visible while the desktop server restarts.
    } finally {
      window.setTimeout(refreshUpdateStatus, 1000);
    }
  }
  refreshUpdateStatus();
}
