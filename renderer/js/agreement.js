const acknowledgeButton = document.getElementById("agreementAcknowledge");

acknowledgeButton?.addEventListener("click", async () => {
  acknowledgeButton.disabled = true;
  acknowledgeButton.textContent = "Saving…";
  try {
    const pendingEmail = sessionStorage.getItem("beabots-agreement-pending");
    const response = await fetch("/api/auth/me");
    const result = await response.json();
    const email = pendingEmail || result.user?.email;
    if (!result.authenticated || !email) throw new Error("Sign in to acknowledge this notice.");

    localStorage.setItem(`beabots-agreement-ack:${encodeURIComponent(email)}`, "v1");
    sessionStorage.removeItem("beabots-agreement-pending");
    if (window.parent && window.parent !== window) window.parent.location.href = "/dashboard.html";
    else window.location.href = "/dashboard.html";
  } catch (error) {
    acknowledgeButton.disabled = false;
    acknowledgeButton.textContent = error.message || "Could not save acknowledgment. Try again.";
  }
});
