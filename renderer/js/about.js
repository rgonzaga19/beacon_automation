if (window.parent && window.parent !== window) {
  document.body.classList.add("embedded-page");
}

function syncAboutNavigation() {
  const current = window.location.hash.slice(1) || "about";
  document.querySelectorAll(".about-nav a[data-section]").forEach((link) => {
    const active = link.dataset.section === current;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
}

window.addEventListener("hashchange", syncAboutNavigation);
syncAboutNavigation();

fetch("/api/auth/me")
  .then((response) => response.json())
  .then((data) => {
    if (!data.authenticated) return;
    const accountLink = document.getElementById("accountLink");
    if (!accountLink) return;
    accountLink.textContent = "Open workspace";
    accountLink.href = "/dashboard.html";
  })
  .catch(() => {});

const agreementDialog = document.getElementById("agreementDialog");
const agreementClose = document.getElementById("agreementClose");
const agreementAcknowledge = document.getElementById("agreementAcknowledge");
const agreementDecline = document.getElementById("agreementDecline");
const agreementStatus = document.getElementById("agreementStatus");
const agreementSections = agreementDialog?.querySelector(".agreement-sections");
const agreementChoice = document.getElementById("agreementChoice");
const agreementChoices = document.querySelectorAll('input[name="agreementDecision"]');
let agreementRequired = false;
let agreementSaving = false;
let agreementAtBottom = false;

function notifyAgreementOpenState(isOpen) {
  if (window.parent !== window) {
    window.parent.postMessage({ type: "agreement-open-state", open: isOpen }, location.origin);
  }
}

function updateAgreementDecision() {
  const decision = document.querySelector('input[name="agreementDecision"]:checked')?.value;
  const agreed = decision === "agree";
  agreementAcknowledge.disabled = !agreed || agreementSaving;
  agreementDecline.hidden = !agreementRequired || decision !== "disagree";
  agreementDecline.disabled = agreementSaving;
}

function updateAgreementScrollState() {
  if (!agreementSections) return;
  agreementAtBottom = agreementSections.scrollTop + agreementSections.clientHeight >= agreementSections.scrollHeight - 2;
  agreementChoice.hidden = !agreementAtBottom;
  if (!agreementAtBottom) {
    agreementChoices.forEach((choice) => { choice.checked = false; });
    updateAgreementDecision();
  }
}

function openAgreement({ required = false } = {}) {
  if (!agreementDialog) return;
  agreementRequired = required;
  agreementDialog.classList.toggle("agreement-required", required);
  agreementStatus.textContent = "";
  agreementChoices.forEach((choice) => { choice.checked = false; });
  agreementChoice.hidden = true;
  agreementDecline.hidden = true;
  agreementAtBottom = false;
  agreementAcknowledge.disabled = true;
  agreementClose.disabled = required;
  if (agreementSections) agreementSections.scrollTop = 0;
  if (!agreementDialog.open) agreementDialog.showModal();
  notifyAgreementOpenState(true);
  requestAnimationFrame(updateAgreementScrollState);
}

agreementDialog?.addEventListener("close", () => notifyAgreementOpenState(false));

document.querySelectorAll("[data-open-agreement]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    history.replaceState(null, "", `${location.pathname}${location.search}#agreement`);
    openAgreement();
  });
});

agreementSections?.addEventListener("scroll", updateAgreementScrollState);
agreementChoices.forEach((choice) => choice.addEventListener("change", updateAgreementDecision));
agreementClose?.addEventListener("click", () => {
  if (!agreementRequired) agreementDialog.close();
});
agreementDialog?.addEventListener("cancel", (event) => {
  if (agreementRequired) event.preventDefault();
});

agreementDecline?.addEventListener("click", async () => {
  if (!agreementRequired || document.querySelector('input[name="agreementDecision"]:checked')?.value !== "disagree" || agreementSaving) return;
  agreementSaving = true;
  agreementDecline.disabled = true;
  agreementStatus.textContent = "Signing out…";
  sessionStorage.removeItem("beabots-agreement-pending");
  try {
    const response = await fetch("/api/auth/logout", { method: "POST" });
    if (!response.ok) throw new Error("Sign out request failed.");
  } catch {
    agreementSaving = false;
    agreementDecline.disabled = false;
    agreementStatus.textContent = "Could not sign out. Please try again.";
    return;
  }
  if (window.parent !== window) window.parent.location.assign("/");
  else window.location.assign("/");
});

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data?.type !== "open-agreement") return;
  openAgreement({ required: Boolean(event.data.required) });
});

if (location.hash === "#agreement") openAgreement();

agreementAcknowledge?.addEventListener("click", async () => {
  if (document.querySelector('input[name="agreementDecision"]:checked')?.value !== "agree" || agreementSaving) return;
  agreementSaving = true;
  agreementAcknowledge.disabled = true;
  agreementStatus.textContent = "Saving acknowledgment…";
  try {
    const pendingEmail = sessionStorage.getItem("beabots-agreement-pending");
    const response = await fetch("/api/auth/me");
    const result = await response.json();
    const email = pendingEmail || result.user?.email;
    if (result.authenticated && email) {
      localStorage.setItem(`beabots-agreement-ack:${encodeURIComponent(email)}`, "v1");
      sessionStorage.removeItem("beabots-agreement-pending");
    } else if (agreementRequired) {
      throw new Error("Sign in to acknowledge this notice.");
    }
    agreementDialog.close();
    agreementRequired = false;
  } catch (error) {
    agreementStatus.textContent = error.message || "Could not save acknowledgment. Try again.";
  } finally {
    agreementSaving = false;
    updateAgreementDecision();
  }
});
