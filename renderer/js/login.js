/* SaaS account login/register. Beacon credentials are configured separately. */

document.getElementById("btnMinimize").addEventListener("click", () => window.beabots?.minimize());
document.getElementById("btnMaximize").addEventListener("click", () => window.beabots?.maximize());
document.getElementById("btnClose").addEventListener("click", () => window.beabots?.close());

const loginForm = document.getElementById("loginForm");
const loginBtn = document.getElementById("loginBtn");
const loginStatus = document.getElementById("loginStatus");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const showPasswordBtn = document.getElementById("showPassword");
const toggleAuthModeBtn = document.getElementById("toggleAuthMode");
const sessionNote = document.getElementById("sessionNote");

let authMode = "login";

function resetLoginButton() {
  document.body.classList.remove("login-success-transition");
  loginBtn.disabled = false;
  loginBtn.textContent = authMode === "login" ? "LOG IN" : "CREATE ACCOUNT";
  loginStatus.textContent = "";
  loginStatus.className = "login-status";
}

function setAuthMode(mode) {
  authMode = mode;
  loginBtn.textContent = mode === "login" ? "LOG IN" : "CREATE ACCOUNT";
  toggleAuthModeBtn.textContent = mode === "login" ? "Create Account" : "Use Existing Account";
  sessionNote.textContent = mode === "login"
    ? "Use your Beabots account. This is not your Beacon login."
    : "Create a Beabots account first. Beacon credentials are connected after sign in.";
  loginStatus.textContent = "";
  loginStatus.className = "login-status";
}

window.addEventListener("focus", resetLoginButton);

showPasswordBtn.addEventListener("click", () => {
  const showing = passwordInput.type === "text";
  passwordInput.type = showing ? "password" : "text";
  showPasswordBtn.textContent = showing ? "Show" : "Hide";
});

toggleAuthModeBtn.addEventListener("click", () => {
  setAuthMode(authMode === "login" ? "register" : "login");
});

(async function redirectIfLoggedIn() {
  try {
    const sessionInfo = await fetchJSON("/api/auth/me");
    if (sessionInfo.authenticated) {
      window.beabots?.goToDashboard();
    }
  } catch {
    // Stay on the login page if the auth endpoint is unavailable.
  }
})();

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = usernameInput.value.trim().toLowerCase();
  const password = passwordInput.value;

  if (!email) {
    loginStatus.textContent = "Email is required.";
    loginStatus.className = "login-status error";
    usernameInput.focus();
    return;
  }

  if (password.length < 8) {
    loginStatus.textContent = "Password must be at least 8 characters.";
    loginStatus.className = "login-status error";
    passwordInput.focus();
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = authMode === "login" ? "LOGGING IN..." : "CREATING ACCOUNT...";
  loginStatus.textContent = authMode === "login" ? "Signing in..." : "Creating your Beabots account...";
  loginStatus.className = "login-status";

  try {
    const result = await fetchJSON(`/api/auth/${authMode}`, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });

    if (result.error) {
      throw new Error(result.error);
    }

    loginBtn.textContent = authMode === "login" ? "LOGGED IN" : "ACCOUNT CREATED";
    loginStatus.textContent = authMode === "login"
      ? "Signed in."
      : "Account created. Connect Beacon credentials in settings next.";
    loginStatus.className = "login-status success";
    document.body.classList.add("login-success-transition");
    const transitionDelay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 180 : 840;
    setTimeout(() => window.beabots?.goToDashboard(), transitionDelay);
  } catch (error) {
    loginBtn.disabled = false;
    loginBtn.textContent = authMode === "login" ? "LOG IN" : "CREATE ACCOUNT";
    loginStatus.textContent = error.message || "Authentication failed.";
    loginStatus.className = "login-status error";
  }
});

setAuthMode("login");
