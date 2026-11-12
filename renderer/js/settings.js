/* Embedded dashboard settings: Beacon account, theme, and server only. */

const beaconUsernameInput = document.getElementById("beaconUsername");
const beaconPasswordInput = document.getElementById("beaconPassword");
const beaconStatus = document.getElementById("beaconStatus");
const validateBeaconBtn = document.getElementById("validateBeaconBtn");
const saveBtn = document.getElementById("saveBtn");
const saveStatus = document.getElementById("saveStatus");
const profileForm = document.getElementById("profileForm");
const displayNameInput = document.getElementById("displayNameInput");
const avatarButtons = [...document.querySelectorAll(".avatar-choice")];
let selectedAvatar = "avatar-penguin";
const profileStatus = document.getElementById("profileStatus");
const profileSaveButton = profileForm.querySelector('[type="submit"]');
const upgradeAccountButton = document.getElementById("upgradeAccountButton");
const themeButtons = [...document.querySelectorAll(".choice-btn[data-theme]")];
const serverButtons = [...document.querySelectorAll(".choice-btn[data-server]")];
let currentTheme = "light";
let currentServer = "s4";

function selectChoice(buttons, attribute, value) {
  buttons.forEach((button) => {
    const selected = button.dataset[attribute] === value;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function selectAvatar(value) {
  selectedAvatar = avatarButtons.some((button) => button.dataset.avatar === value) ? value : "avatar-penguin";
  avatarButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.avatar === selectedAvatar));
  });
}

avatarButtons.forEach((button) => button.addEventListener("click", () => selectAvatar(button.dataset.avatar)));

themeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    currentTheme = button.dataset.theme;
    selectChoice(themeButtons, "theme", currentTheme);
    window.beabotsTheme?.setTheme(currentTheme);
  });
});

serverButtons.forEach((button) => {
  button.addEventListener("click", () => {
    currentServer = button.dataset.server;
    selectChoice(serverButtons, "server", currentServer);
  });
});

document.getElementById("toggleBeaconPassword").addEventListener("click", (event) => {
  const showing = beaconPasswordInput.type === "text";
  beaconPasswordInput.type = showing ? "password" : "text";
  event.currentTarget.textContent = showing ? "Show" : "Hide";
});

function renderBeaconStatus(settings) {
  if (settings.beacon_connected) {
    const validatedAt = settings.beacon_validated_at
      ? new Date(settings.beacon_validated_at).toLocaleString()
      : "recently";
    beaconStatus.textContent = `Beacon connected. Last validated: ${validatedAt}.`;
    beaconStatus.style.color = "var(--success)";
  } else {
    beaconStatus.textContent = "Beacon must be validated before automation can run.";
    beaconStatus.style.color = "var(--warning)";
  }
}

async function loadProfile() {
  try {
    const result = await fetchJSON("/api/auth/me");
    if (!result.authenticated || !result.user) {
      throw new Error("Your session has expired. Sign in again to edit your profile.");
    }
    const user = result.user;
    displayNameInput.value = user.display_name || user.profile_name || "";
    selectAvatar(user.avatar || "avatar-penguin");
    if (user.is_admin || user.role === "subscriber") {
      upgradeAccountButton.hidden = true;
    } else if (user.upgrade_request_status === "pending") {
      upgradeAccountButton.textContent = "Request pending";
      upgradeAccountButton.disabled = true;
    }
  } catch (error) {
    profileStatus.textContent = error.message || "Unable to load your profile.";
    profileStatus.className = "profile-status error";
  }
}

async function loadSettings() {
  try {
    const [settings, theme] = await Promise.all([
      fetchJSON("/api/settings"),
      window.beabots?.getTheme(),
    ]);
    beaconUsernameInput.value = settings.username || "";
    beaconPasswordInput.value = settings.password || "";
    currentServer = settings.server === "s2" ? "s2" : "s4";
    currentTheme = theme === "dark" ? "dark" : "light";
    selectChoice(serverButtons, "server", currentServer);
    selectChoice(themeButtons, "theme", currentTheme);
    renderBeaconStatus(settings);
  } catch (error) {
    saveStatus.textContent = "Unable to load settings.";
    saveStatus.className = "save-status error";
  }
}

saveBtn.addEventListener("click", async () => {
  saveBtn.disabled = true;
  saveStatus.textContent = "Saving...";
  saveStatus.className = "save-status";
  try {
    const settings = await fetchJSON("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        username: beaconUsernameInput.value.trim(),
        password: beaconPasswordInput.value,
        server: currentServer,
      }),
    });
    saveStatus.textContent = "Settings saved.";
    saveStatus.className = "save-status success";
    beaconPasswordInput.value = settings.password || "";
    renderBeaconStatus(settings);
    window.parent.postMessage({ type: "settings-beacon-updated" }, location.origin);
  } catch (error) {
    saveStatus.textContent = "Unable to save settings.";
    saveStatus.className = "save-status error";
  } finally {
    saveBtn.disabled = false;
  }
});

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  profileSaveButton.disabled = true;
  profileStatus.textContent = "Saving…";
  profileStatus.className = "profile-status";
  try {
    const result = await fetchJSON("/api/auth/profile", {
      method: "PATCH",
      body: JSON.stringify({
        display_name: displayNameInput.value,
        avatar: selectedAvatar,
      }),
    });
    if (!result.user) throw new Error(result.error || "Could not save your profile.");
    displayNameInput.value = result.user.display_name || "";
    selectAvatar(result.user.avatar || "avatar-penguin");
    profileStatus.textContent = "Profile saved.";
    profileStatus.className = "profile-status success";
    window.parent.postMessage({ type: "settings-profile-updated", user: result.user }, location.origin);
  } catch (error) {
    profileStatus.textContent = error.message || "Could not save your profile.";
    profileStatus.className = "profile-status error";
  } finally {
    profileSaveButton.disabled = false;
  }
});

upgradeAccountButton.addEventListener("click", () => {
  window.parent.postMessage({ type: "settings-upgrade-request" }, location.origin);
});

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin) return;
  if (event.data?.type === "settings-upgrade-request-pending") {
    upgradeAccountButton.textContent = "Request pending";
    upgradeAccountButton.disabled = true;
  }
});

validateBeaconBtn.addEventListener("click", async () => {
  validateBeaconBtn.disabled = true;
  saveBtn.disabled = true;
  saveStatus.textContent = "Validating Beacon credentials...";
  saveStatus.className = "save-status";
  try {
    const payload = {
      username: beaconUsernameInput.value.trim(),
      server: currentServer,
    };
    if (beaconPasswordInput.value && beaconPasswordInput.value !== "********") {
      payload.password = beaconPasswordInput.value;
    }

    const result = await fetchJSON("/api/beacon/validate", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (!result.valid) {
      throw new Error(result.error || "Beacon validation failed.");
    }

    saveStatus.textContent = "Beacon account validated.";
    saveStatus.className = "save-status success";
    renderBeaconStatus({
      beacon_connected: true,
      beacon_validated_at: result.beacon_validated_at,
    });
    beaconPasswordInput.value = "********";
    window.parent.postMessage({ type: "settings-beacon-updated" }, location.origin);
  } catch (error) {
    saveStatus.textContent = error.message || "Unable to validate Beacon credentials.";
    saveStatus.className = "save-status error";
    renderBeaconStatus({ beacon_connected: false });
  } finally {
    validateBeaconBtn.disabled = false;
    saveBtn.disabled = false;
  }
});

window.beabots?.onThemeChanged((theme) => {
  currentTheme = theme;
  selectChoice(themeButtons, "theme", currentTheme);
});

loadSettings();
loadProfile();
