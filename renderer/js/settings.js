/* Embedded dashboard settings: Beacon account, theme, and server only. */

const beaconUsernameInput = document.getElementById("beaconUsername");
const beaconPasswordInput = document.getElementById("beaconPassword");
const beaconStatus = document.getElementById("beaconStatus");
const validateBeaconBtn = document.getElementById("validateBeaconBtn");
const saveBtn = document.getElementById("saveBtn");
const saveStatus = document.getElementById("saveStatus");
const themeButtons = [...document.querySelectorAll(".choice-btn[data-theme]")];
const serverButtons = [...document.querySelectorAll(".choice-btn[data-server]")];
let currentTheme = "dark";
let currentServer = "s4";

function selectChoice(buttons, attribute, value) {
  buttons.forEach((button) => {
    const selected = button.dataset[attribute] === value;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

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

async function loadSettings() {
  try {
    const [settings, theme] = await Promise.all([
      fetchJSON("/api/settings"),
      window.beabots?.getTheme(),
    ]);
    beaconUsernameInput.value = settings.username || "";
    beaconPasswordInput.value = settings.password || "";
    currentServer = settings.server === "s2" ? "s2" : "s4";
    currentTheme = theme === "light" ? "light" : "dark";
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
  } catch (error) {
    saveStatus.textContent = "Unable to save settings.";
    saveStatus.className = "save-status error";
  } finally {
    saveBtn.disabled = false;
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
