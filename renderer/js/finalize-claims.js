const lookupForm = document.getElementById("lookupForm");
const transmittalInput = document.getElementById("transmittalInput");
const lookupButton = document.getElementById("lookupButton");
const summary = document.getElementById("summary");
const claimsBody = document.getElementById("claimsBody");

function statusClass(status) {
  const normalized = String(status || "").trim().toUpperCase();
  return ({
    DRAFT: "status-draft",
    TRANSMITTING: "status-transmitting",
    TRANSMITTED: "status-transmitted",
    "TRANSMIT ERROR": "status-transmit-error",
    COMPLETE: "status-complete",
    "ON QUEUE": "status-on-queue",
  })[normalized] || "";
}

function showMessage(message, error = false) {
  claimsBody.replaceChildren();
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 8;
  cell.className = `message${error ? " error" : ""}`;
  cell.textContent = message;
  row.append(cell);
  claimsBody.append(row);
}

lookupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const searchValue = transmittalInput.value.trim();
  if (!searchValue) return;
  const isPatientSearch = /[a-z]/i.test(searchValue);
  const numbers = searchValue.split(/\s+/).filter(Boolean);
  const searchParams = new URLSearchParams(isPatientSearch
    ? { patient: searchValue }
    : { transmittal: numbers.join(" ") });

  lookupButton.disabled = true;
  lookupButton.textContent = "SEARCHING...";
  summary.hidden = true;
  showMessage(isPatientSearch
    ? `Searching Beacon claims for patient name "${searchValue}"...`
    : `Searching Beacon for ${numbers.length} transmittal${numbers.length === 1 ? "" : "s"}...`);
  try {
    const response = await fetch(`${API_BASE}/api/beacon/finalize-claims?${searchParams}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to look up these transmittals.");
    if (!result.transmittals.length) {
      showMessage(isPatientSearch
        ? `No claims were found for patient name "${searchValue}".`
        : `No matching transmittals were found: ${result.not_found.join(", ")}`);
      return;
    }

    summary.hidden = false;
    summary.replaceChildren();
    [["Transmittals Found", result.transmittals.length], ["Claims", result.claims.length], ...(result.not_found.length ? [["Not Found", result.not_found.join(", ")]] : [])].forEach(([label, value]) => {
      const item = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = `${label}: `;
      item.append(strong, document.createTextNode(String(value)));
      summary.append(item);
    });

    if (!result.claims.length) {
      showMessage("The matching transmittals have no claims.");
      return;
    }
    claimsBody.replaceChildren();
    result.claims.forEach((claim) => {
      const row = document.createElement("tr");
      [claim.transmittal_number, claim.claim_series, claim.patient_name, claim.member_name, claim.status].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value || "-";
        row.append(cell);
      });
      const transmittalStatusCell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `transmittal-status ${statusClass(claim.transmittal_status)}`;
      const dot = document.createElement("i");
      dot.className = "status-dot";
      badge.append(dot, document.createTextNode(claim.transmittal_status || "-"));
      transmittalStatusCell.append(badge);
      row.append(transmittalStatusCell);
      const packageCell = document.createElement("td");
      packageCell.textContent = claim.package || "-";
      row.append(packageCell);

      const actionCell = document.createElement("td");
      if (claim.edit_url && statusClass(claim.transmittal_status) === "status-draft") {
        const editLink = document.createElement("a");
        editLink.className = "cyber-btn";
        editLink.href = claim.edit_url;
        editLink.target = "_blank";
        editLink.rel = "noopener noreferrer";
        editLink.textContent = "EDIT";
        editLink.setAttribute("aria-label", `Edit claim ${claim.claim_series || "in transmittal " + claim.transmittal_number} in Beacon`);
        actionCell.append(editLink);
      } else {
        actionCell.textContent = "-";
      }
      row.append(actionCell);
      claimsBody.append(row);
    });
  } catch (error) {
    showMessage(error.message || "Beacon lookup failed. Try again.", true);
  } finally {
    lookupButton.disabled = false;
    lookupButton.textContent = "LOOK UP";
  }
});
