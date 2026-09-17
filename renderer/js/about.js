const versionEl = document.getElementById("version");
const btnTitlebarClose = document.getElementById("btnTitlebarClose");
const btnThemeToggle = document.getElementById("btnThemeToggle");

async function loadAbout() {
  const version = await window.beabots?.getVersion?.();
  versionEl.textContent = `Version ${version || "web"}`;
}

document.getElementById("btnHome")?.addEventListener("click", () => {
  window.beabots?.goHome();
});

btnThemeToggle?.addEventListener("click", async () => {
  const current = await window.beabots?.getTheme?.();
  const nextTheme = current === "light" ? "dark" : "light";
  await window.beabots?.setTheme?.(nextTheme);
  window.beabotsTheme?.setTheme(nextTheme);
});

btnTitlebarClose?.addEventListener("click", () => {
  window.beabots?.goHome();
});

loadAbout();
