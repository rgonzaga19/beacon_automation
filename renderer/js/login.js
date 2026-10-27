/* Beabots account access. Beacon credentials are connected separately. */


const loginForm = document.getElementById("loginForm");
const loginNavButton = document.getElementById("loginNavButton");
const usernameInput = document.getElementById("username");
const loginBtn = document.getElementById("loginBtn");
const submitLabel = document.getElementById("submitLabel");
const loginStatus = document.getElementById("loginStatus");
const passwordInput = document.getElementById("password");
const confirmPasswordInput = document.getElementById("confirmPassword");
const confirmField = document.getElementById("confirmField");
const passwordRequirement = document.getElementById("passwordRequirement");
const showPasswordBtn = document.getElementById("showPassword");
const signInTab = document.getElementById("signInTab");
const createAccountTab = document.getElementById("createAccountTab");
const authTitle = document.getElementById("authTitle");
const authIntro = document.getElementById("authIntro");
const formEyebrow = document.getElementById("formEyebrow");
const sessionNote = document.getElementById("sessionNote");

let authMode = "login";

loginNavButton?.addEventListener("click", (event) => {
  event.preventDefault();
  usernameInput?.scrollIntoView({ behavior: "smooth", block: "center" });
  usernameInput?.focus({ preventScroll: true });
});
let requestInProgress = false;

function clearStatus() {
  loginStatus.textContent = "";
  loginStatus.className = "login-status";
}

function setAuthMode(mode, { focusTab = false } = {}) {
  authMode = mode === "register" ? "register" : "login";
  const registering = authMode === "register";

  document.body.dataset.authMode = authMode;
  document.title = registering ? "Beabots · Create account" : "Beabots · Sign in";
  authTitle.textContent = registering ? "Create your account" : "Welcome back";
  authIntro.textContent = registering
    ? "Set up your Beabots account to get started."
    : "Sign in to continue to your Beabots workspace.";
  formEyebrow.textContent = registering ? "NEW WORKSPACE" : "YOUR WORKSPACE";
  submitLabel.textContent = registering ? "Create account" : "Sign in";
  sessionNote.innerHTML = registering
    ? '<span class="note-lock" aria-hidden="true">●</span> Beacon credentials are connected separately after you create your account.'
    : '<span class="note-lock" aria-hidden="true">●</span> This is your Beabots account, not your Beacon login.';

  signInTab.classList.toggle("active", !registering);
  createAccountTab.classList.toggle("active", registering);
  signInTab.setAttribute("aria-selected", String(!registering));
  createAccountTab.setAttribute("aria-selected", String(registering));
  signInTab.tabIndex = registering ? -1 : 0;
  createAccountTab.tabIndex = registering ? 0 : -1;

  confirmField.hidden = !registering;
  confirmPasswordInput.required = registering;
  passwordRequirement.hidden = !registering;
  passwordInput.autocomplete = registering ? "new-password" : "current-password";
  showPasswordBtn.textContent = "Show";
  showPasswordBtn.setAttribute("aria-label", "Show password");
  showPasswordBtn.setAttribute("aria-pressed", "false");
  passwordInput.type = "password";
  clearStatus();

  if (focusTab) (registering ? createAccountTab : signInTab).focus();
}

function setBusy(busy) {
  requestInProgress = busy;
  loginBtn.disabled = busy;
  signInTab.disabled = busy;
  createAccountTab.disabled = busy;
  loginBtn.classList.toggle("is-loading", busy);
  if (busy) submitLabel.textContent = authMode === "register" ? "Creating account…" : "Signing in…";
}

function showError(message, focusTarget) {
  loginStatus.textContent = message;
  loginStatus.className = "login-status error";
  focusTarget?.focus();
}

signInTab.addEventListener("click", () => setAuthMode("login"));
createAccountTab.addEventListener("click", () => setAuthMode("register"));

for (const tab of [signInTab, createAccountTab]) {
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setAuthMode(authMode === "login" ? "register" : "login", { focusTab: true });
  });
}

showPasswordBtn.addEventListener("click", () => {
  const showing = passwordInput.type === "text";
  passwordInput.type = showing ? "password" : "text";
  showPasswordBtn.textContent = showing ? "Show" : "Hide";
  showPasswordBtn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
  showPasswordBtn.setAttribute("aria-pressed", String(!showing));
});

(async function redirectIfLoggedIn() {
  try {
    const sessionInfo = await fetchJSON("/api/auth/me");
    if (sessionInfo.authenticated) window.beabots?.goToDashboard();
  } catch {
    // Stay on the login page if the authentication endpoint is unavailable.
  }
})();

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (requestInProgress) return;

  const email = usernameInput.value.trim().toLowerCase();
  const password = passwordInput.value;
  const registering = authMode === "register";

  if (!email || !usernameInput.validity.valid) {
    showError("Enter a valid email address.", usernameInput);
    return;
  }
  if (!password) {
    showError("Enter your password.", passwordInput);
    return;
  }
  if (registering && password.length < 8) {
    showError("Use a password with at least 8 characters.", passwordInput);
    return;
  }
  if (registering && password !== confirmPasswordInput.value) {
    showError("The passwords don’t match.", confirmPasswordInput);
    return;
  }

  clearStatus();
  setBusy(true);
  loginStatus.textContent = registering ? "Creating your Beabots account…" : "Checking your sign-in details…";

  try {
    const result = await fetchJSON(`/api/auth/${authMode}`, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });

    if (result.error) throw new Error(result.error);

    const agreementKey = `beabots-agreement-ack:${encodeURIComponent(email)}`;
    if (localStorage.getItem(agreementKey) !== "v1") {
      sessionStorage.setItem("beabots-agreement-pending", email);
    } else {
      sessionStorage.removeItem("beabots-agreement-pending");
    }

    submitLabel.textContent = registering ? "Account created" : "Signed in";
    loginStatus.textContent = registering
      ? "Your account is ready. Opening your workspace…"
      : "Welcome back. Opening your workspace…";
    loginStatus.className = "login-status success";
    document.body.classList.add("login-success-transition");
    const transitionDelay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 180 : 820;
    setTimeout(() => window.beabots?.goToDashboard(), transitionDelay);
  } catch (error) {
    setBusy(false);
    submitLabel.textContent = registering ? "Create account" : "Sign in";
    loginStatus.textContent = error.message || (registering ? "Could not create your account." : "Could not sign in.");
    loginStatus.className = "login-status error";
  }
});

setAuthMode("login");
