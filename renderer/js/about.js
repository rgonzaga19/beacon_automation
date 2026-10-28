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

const agreementDialog = document.getElementById("agreementDialog");
const agreementClose = document.getElementById("agreementClose");
const agreementAcknowledge = document.getElementById("agreementAcknowledge");
const agreementStatus = document.getElementById("agreementStatus");
const agreementSections = agreementDialog?.querySelector(".agreement-sections");
let agreementRequired = false;
let agreementAtBottom = false;

function notifyAgreementOpenState(isOpen) {
  if (window.parent !== window) {
    window.parent.postMessage({ type: "agreement-open-state", open: isOpen }, location.origin);
  }
}

function updateAgreementScrollState() {
  if (!agreementSections) return;
  agreementAtBottom = agreementSections.scrollTop + agreementSections.clientHeight >= agreementSections.scrollHeight - 2;
  agreementAcknowledge.disabled = !agreementAtBottom;
  agreementClose.disabled = agreementRequired || !agreementAtBottom;
}

function openAgreement({ required = false } = {}) {
  if (!agreementDialog) return;
  agreementRequired = required;
  agreementAtBottom = false;
  agreementDialog.classList.toggle("agreement-required", required);
  agreementStatus.textContent = "";
  agreementAcknowledge.disabled = true;
  agreementClose.disabled = true;
  agreementSections.scrollTop = 0;
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
agreementClose?.addEventListener("click", () => {
  if (!agreementRequired && agreementAtBottom) agreementDialog.close();
});
agreementDialog?.addEventListener("cancel", (event) => {
  if (agreementRequired || !agreementAtBottom) event.preventDefault();
});

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data?.type !== "open-agreement") return;
  openAgreement({ required: Boolean(event.data.required) });
});

if (location.hash === "#agreement") openAgreement();

agreementAcknowledge?.addEventListener("click", async () => {
  if (!agreementAtBottom) return;
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
    agreementAcknowledge.disabled = false;
  }
});
