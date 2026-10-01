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
  cell.colSpan = 7;
  cell.className = `message${error ? " error" : ""}`;
  cell.textContent = message;
  row.append(cell);
  claimsBody.append(row);
}

lookupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const number = transmittalInput.value.trim();
  if (!number) return;

  lookupButton.disabled = true;
  lookupButton.textContent = "SEARCHING...";
  summary.hidden = true;
  showMessage("Searching Beacon for this transmittal...");
  try {
    const response = await fetch(`${API_BASE}/api/beacon/finalize-claims?transmittal=${encodeURIComponent(number)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to look up this transmittal.");
    if (!result.transmittal) {
      showMessage("No matching transmittal was found.");
      return;
    }

    summary.hidden = false;
    summary.replaceChildren();
    [["Transmittal", result.transmittal.number], ["Status", result.transmittal.status || "—"], ["Claims", result.claims.length]].forEach(([label, value]) => {
      const item = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = `${label}: `;
      item.append(strong, document.createTextNode(String(value)));
      summary.append(item);
    });

    if (!result.claims.length) {
      showMessage("This transmittal has no claims.");
      return;
    }
    claimsBody.replaceChildren();
    result.claims.forEach((claim) => {
      const row = document.createElement("tr");
      [claim.claim_series, claim.patient_name, claim.member_name, claim.status].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value || "-";
        row.append(cell);
      });
      const transmittalStatusCell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `transmittal-status ${statusClass(result.transmittal.status)}`;
      const dot = document.createElement("i");
      dot.className = "status-dot";
      badge.append(dot, document.createTextNode(result.transmittal.status || "-"));
      transmittalStatusCell.append(badge);
      row.append(transmittalStatusCell);
      [claim.package, claim.is_final ? "Yes" : "No"].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value || "-";
        row.append(cell);
      });
      claimsBody.append(row);
    });
  } catch (error) {
    showMessage(error.message || "Beacon lookup failed. Try again.", true);
  } finally {
    lookupButton.disabled = false;
    lookupButton.textContent = "LOOK UP";
  }
});
