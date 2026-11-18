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
      window.parent.location.href = `/workspace.html#${workspaceKey}`;
    }
    return;
  }
  window.location.href = `/workspace.html#${workspaceKey}`;
}

if (!window.beabots) {
  window.beabots = {
    apiBase: window.location.origin,
    goHome: () => {
      if (window.parent && window.parent !== window) {
        window.parent.location.href = "/workspace.html";
      } else {
        window.location.href = "/workspace.html";
      }
    },
    goToDashboard: () => { window.location.href = "/workspace.html"; },
    showWorkspaceHome: () => { window.location.href = "/workspace.html"; },
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
    getTheme: async () => window.beabotsTheme?.getTheme() || localStorage.getItem("beabots-theme") || "light",
    setTheme: async (theme) => {
      if (window.beabotsTheme?.setTheme) window.beabotsTheme.setTheme(theme);
      else localStorage.setItem("beabots-theme", theme);
    },
    onThemeChanged: () => {},
  };
}

const API_BASE = window.beabots.apiBase || window.location.origin;

function redirectToLogin() {
  const topWindow = window.top || window;
  if (topWindow.location.pathname === "/login") return;
  const loginUrl = new URL("/login", topWindow.location.origin);
  if (topWindow.location.pathname === "/workspace.html") {
    loginUrl.searchParams.set(
      "next",
      `${topWindow.location.pathname}${topWindow.location.search}${topWindow.location.hash}`,
    );
  }
  topWindow.location.replace(`${loginUrl.pathname}${loginUrl.search}`);
}

async function fetchJSON(path, options) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    ...options,
  });
  if (res.status === 401 && path !== "/api/auth/login" && path !== "/api/auth/register") {
    redirectToLogin();
    throw new Error("Your session has expired. Please sign in again.");
  }
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    const detail = res.status ? ` (${res.status})` : "";
    throw new Error(`The server returned a non-JSON response${detail}. Restart the app server and reload the page.`);
  }
}

const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const SESSION_ACTIVITY_MESSAGE = "beabots-user-activity";
const SESSION_ACTIVITY_EVENT_NAMES = [
  "pointerdown",
  "pointermove",
  "keydown",
  "input",
  "scroll",
  "touchstart",
];

function initializeSessionActivityTracking() {
  const topLevel = window.top === window;
  let recordActivity = () => {};
  let lastEventAt = 0;
  const trackedDocuments = new WeakSet();

  const notifyActivity = () => {
    const now = Date.now();
    if (now - lastEventAt < 500) return;
    lastEventAt = now;
    if (topLevel) {
      recordActivity();
    } else {
      window.top.postMessage({ type: SESSION_ACTIVITY_MESSAGE }, window.location.origin);
    }
  };

  const attachToDocument = (targetDocument) => {
    if (!targetDocument || trackedDocuments.has(targetDocument)) return;
    trackedDocuments.add(targetDocument);
    SESSION_ACTIVITY_EVENT_NAMES.forEach((eventName) => {
      targetDocument.addEventListener(eventName, notifyActivity, { passive: true });
    });
  };

  const attachToWorkspaceFrames = (targetDocument) => {
    targetDocument.querySelectorAll("iframe.workspace-frame").forEach((frame) => {
      const attachFrameDocument = () => attachToDocument(frame.contentDocument);
      frame.addEventListener("load", attachFrameDocument);
      attachFrameDocument();
    });
  };

  attachToDocument(document);
  attachToWorkspaceFrames(document);

  if (!topLevel) return;

  window.addEventListener("message", (event) => {
    if (
      event.origin === window.location.origin
      && event.data?.type === SESSION_ACTIVITY_MESSAGE
    ) {
      recordActivity();
    }
  });

  fetchJSON("/api/auth/me")
    .then((result) => {
      if (!result.authenticated) {
        if (window.location.pathname === "/workspace.html") redirectToLogin();
        return;
      }

      const storageKey = `beabots-last-activity:${result.user.id}`;
      const now = Date.now();
      const serverLastActivity = now - (
        SESSION_IDLE_TIMEOUT_MS - result.expires_in_seconds * 1000
      );
      const sharedLastActivity = Number(localStorage.getItem(storageKey)) || 0;
      let lastActivityAt = Math.max(serverLastActivity, Math.min(sharedLastActivity, now));
      let lastHeartbeatAt = 0;
      let logoutTimer;
      let loggingOut = false;

      const scheduleLogout = () => {
        window.clearTimeout(logoutTimer);
        const remaining = SESSION_IDLE_TIMEOUT_MS - (Date.now() - lastActivityAt);
        logoutTimer = window.setTimeout(() => {
          if (Date.now() - lastActivityAt < SESSION_IDLE_TIMEOUT_MS) {
            scheduleLogout();
            return;
          }
          if (loggingOut) return;
          loggingOut = true;
          fetch(`${API_BASE}/api/auth/logout`, { method: "POST", keepalive: true })
            .catch((error) => console.warn("Could not clear the expired session cookie.", error))
            .finally(redirectToLogin);
        }, Math.max(0, remaining));
      };

      recordActivity = () => {
        if (loggingOut) return;
        const activityTime = Date.now();
        lastActivityAt = activityTime;
        localStorage.setItem(storageKey, String(activityTime));
        scheduleLogout();

        if (activityTime - lastHeartbeatAt < 5000) return;
        lastHeartbeatAt = activityTime;
        fetchJSON("/api/auth/activity", { method: "POST" }).catch((error) => {
          console.error("Could not record account activity.", error);
        });
      };

      window.addEventListener("storage", (event) => {
        if (event.key !== storageKey || !event.newValue) return;
        const sharedActivity = Number(event.newValue);
        if (Number.isFinite(sharedActivity) && sharedActivity > lastActivityAt) {
          lastActivityAt = Math.min(sharedActivity, Date.now());
          scheduleLogout();
        }
      });

      scheduleLogout();
    })
    .catch((error) => {
      console.error("Could not initialize session inactivity monitoring.", error);
    });
}

initializeSessionActivityTracking();

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

function showConfirmModal(title, bodyText, {
  confirmText = "Continue",
  cancelText = "Cancel",
  onConfirm,
} = {}) {
  const root = document.getElementById("modalRoot");
  root.replaceChildren();

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "confirmModalTitle");
  box.setAttribute("aria-describedby", "confirmModalMessage");
  const heading = document.createElement("h3");
  heading.id = "confirmModalTitle";
  heading.textContent = title;
  const message = document.createElement("p");
  message.id = "confirmModalMessage";
  message.textContent = bodyText;
  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "cyber-btn";
  cancel.textContent = cancelText;
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "cyber-btn";
  confirm.textContent = confirmText;
  actions.append(cancel, confirm);
  box.append(heading, message, actions);
  overlay.append(box);
  root.append(overlay);

  const close = () => {
    document.removeEventListener("keydown", onKeyDown);
    root.replaceChildren();
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") close();
  };
  cancel.addEventListener("click", close);
  confirm.addEventListener("click", () => {
    close();
    if (onConfirm) onConfirm();
  });
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKeyDown);
  cancel.focus();
}

function showError(title, message, opts) {
  showModal(title, message, opts);
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
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
    return true;
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
