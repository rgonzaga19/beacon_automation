const lookupForm = document.getElementById("lookupForm");
const transmittalInput = document.getElementById("transmittalInput");
const lookupButton = document.getElementById("lookupButton");
const summary = document.getElementById("summary");
const claimsBody = document.getElementById("claimsBody");
const claimsSort = document.getElementById("claimsSort");
const selectAllClaims = document.getElementById("selectAllClaims");
const selectedCount = document.getElementById("selectedCount");
const batchActionButtons = Array.from(document.querySelectorAll(".page-toolbar .solid-btn"));
const claimEditor = document.getElementById("claimEditor");
const editorSubtitle = document.getElementById("editorSubtitle");
const transmitAllButton = document.getElementById("transmitAllButton");
const transmitAllStatus = document.getElementById("transmitAllStatus");
const finalizeAllButton = document.getElementById("finalizeAllButton");
let activeEditClaim = null;
let courseInWardRowIndex = 0;
let editorDirty = false;
let editorLoading = false;
let editorLoaded = false;
window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || event.source !== window.parent || event.data?.type !== "workspace-claim-search") return;
  const query = String(event.data.query || "").trim();
  if (!query) return;
  transmittalInput.value = query;
  lookupForm.requestSubmit();
});

function patientSurname(name) {
  const normalized = String(name || "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.includes(",")) return normalized.split(",", 1)[0].trim();
  const parts = normalized.split(" ");
  if (parts.length < 2) return parts[0];
  if (["JR", "JR.", "SR", "SR.", "II", "III", "IV"].includes(parts.at(-1).toUpperCase())) parts.pop();
  return parts.at(-1);
}

function sortClaimRows() {
  const direction = claimsSort.value;
  const rows = Array.from(claimsBody.querySelectorAll("tr[data-claim-row]"));
  if (!direction) {
    rows.sort((a, b) => Number(a.dataset.originalOrder) - Number(b.dataset.originalOrder));
  } else {
    const multiplier = direction === "surname-desc" ? -1 : 1;
    rows.sort((a, b) => multiplier * a.dataset.patientSurname.localeCompare(b.dataset.patientSurname, undefined, { sensitivity: "base" })
      || Number(a.dataset.originalOrder) - Number(b.dataset.originalOrder));
  }
  rows.forEach((row) => claimsBody.append(row));
}

claimsSort.addEventListener("change", sortClaimRows);

function setToolbarLoading(button, loading) {
  button.classList.toggle("is-loading", loading);
  if (loading) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}

function updateSelectionControls() {
  const rows = Array.from(claimsBody.querySelectorAll("tr[data-claim-row]"));
  const selectedRows = rows.filter((row) => row.classList.contains("selected"));
  selectedCount.textContent = String(selectedRows.length);
  selectAllClaims.checked = rows.length > 0 && selectedRows.length === rows.length;
  selectAllClaims.indeterminate = selectedRows.length > 0 && selectedRows.length < rows.length;
  selectAllClaims.disabled = rows.length === 0;
  batchActionButtons.forEach((button) => {
    button.disabled = selectedRows.length === 0;
  });
}

selectAllClaims.addEventListener("change", () => {
  const selected = selectAllClaims.checked;
  claimsBody.querySelectorAll("tr[data-claim-row]").forEach((row) => {
    row.classList.toggle("selected", selected);
    row.setAttribute("aria-selected", String(selected));
    row.querySelector(".selection-checkbox").checked = selected;
  });
  updateSelectionControls();
});

function lockClaimsToolbar(activeButton) {
  const buttons = Array.from(document.querySelectorAll(".page-toolbar button"));
  const previousStates = buttons.map((button) => button.disabled);
  buttons.forEach((button) => { button.disabled = true; });
  activeButton?.setAttribute("aria-busy", "true");
  return () => {
    buttons.forEach((button, index) => { button.disabled = previousStates[index]; });
  };
}

const EDIT_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const TRANSMIT_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>';
const TRANSMITTED_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const COPY_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

function renderCourseInWardRows(entries = []) {
  const container = document.getElementById("courseInWardRows");
  container.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "course-ward-empty";
    empty.textContent = "No Course in the Ward entries found.";
    container.append(empty);
    return;
  }
  entries.forEach((entry) => addCourseInWardRow(entry));
}

function addCourseInWardRow(entry = {}) {
  const container = document.getElementById("courseInWardRows");
  container.querySelector(".course-ward-empty")?.remove();
  const row = document.createElement("div");
  row.className = "course-ward-row";
  const fieldId = ++courseInWardRowIndex;
  const dateField = document.createElement("div");
  dateField.className = "course-ward-field";
  const dateLabel = document.createElement("label");
  dateLabel.textContent = "Date";
  const date = document.createElement("input");
  date.type = "date";
  date.value = entry.date || "";
  date.dataset.courseDate = "";
  dateLabel.htmlFor = `courseDate${fieldId}`;
  date.id = dateLabel.htmlFor;
  dateField.append(dateLabel, date);
  const orderField = document.createElement("div");
  orderField.className = "course-ward-field";
  const orderLabel = document.createElement("label");
  orderLabel.textContent = "Course Entry";
  const order = document.createElement("textarea");
  order.rows = 3;
  order.value = entry.order || "";
  order.placeholder = "Course in the Ward entry";
  order.dataset.courseOrder = "";
  orderLabel.htmlFor = `courseOrder${fieldId}`;
  order.id = orderLabel.htmlFor;
  orderField.append(orderLabel, order);
  const remove = document.createElement("button");
  remove.className = "cyber-btn danger course-ward-remove";
  remove.type = "button";
  remove.textContent = "REMOVE";
  remove.addEventListener("click", () => {
    row.remove();
    if (!container.children.length) renderCourseInWardRows();
  });
  if (entry.id != null) row.dataset.courseId = entry.id;
  row.append(dateField, orderField, remove);
  container.append(row);
}

function readCourseInWardRows() {
  return Array.from(document.querySelectorAll("#courseInWardRows .course-ward-row")).map((row) => ({
    id: row.dataset.courseId || null,
    date: row.querySelector("[data-course-date]").value,
    order: row.querySelector("[data-course-order]").value,
  }));
}

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
  cell.colSpan = 10;
  cell.className = `message${error ? " error" : ""}`;
  cell.textContent = message;
  row.append(cell);
  claimsBody.append(row);
  updateSelectionControls();
}

lookupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const searchValue = transmittalInput.value.trim();
  const admissionFrom = document.getElementById("admissionFrom").value;
  const admissionTo = document.getElementById("admissionTo").value;
  const dateMode = !searchValue && Boolean(admissionFrom || admissionTo);
  if (!searchValue && !dateMode) {
    showMessage("Enter a transmittal number, a patient name, or at least one date filter.", true);
    return;
  }
  const isPatientSearch = !dateMode && /[a-z]/i.test(searchValue);
  const numbers = searchValue.split(/\s+/).filter(Boolean);
  const searchParams = new URLSearchParams(dateMode
    ? {
        ...(admissionFrom ? { admission_from: admissionFrom } : {}),
        ...(admissionTo ? { admission_to: admissionTo } : {}),
      }
    : isPatientSearch
      ? { patient: searchValue }
      : { transmittal: numbers.join(" ") });
  const searchId = dateMode
    ? (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`)
    : "";
  if (searchId) searchParams.set("search_id", searchId);
  let progressPoll = null;

  lookupButton.disabled = true;
  lookupButton.classList.add("is-loading");
  lookupButton.setAttribute("aria-busy", "true");
  claimsSort.disabled = true;
  claimsSort.value = "";
  summary.hidden = true;
  showMessage(dateMode
    ? "Searching Beacon claims by admission date range..."
    : isPatientSearch
      ? `Searching Beacon claims for patient name "${searchValue}"...`
      : `Searching Beacon for ${numbers.length} transmittal${numbers.length === 1 ? "" : "s"}...`);
  if (searchId) {
    progressPoll = window.setInterval(async () => {
      try {
        const progressResponse = await fetch(`${API_BASE}/api/beacon/finalize-claims/progress/${encodeURIComponent(searchId)}`);
        if (!progressResponse.ok) return;
        const progress = await progressResponse.json();
        if (progress.message) showMessage(progress.message);
        if (progress.done) {
          window.clearInterval(progressPoll);
          progressPoll = null;
        }
      } catch (_) {
        // Keep the main lookup request running if a progress poll fails.
      }
    }, 1000);
  }
  try {
    const response = await fetch(`${API_BASE}/api/beacon/finalize-claims?${searchParams}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to look up these transmittals.");
    if (!result.transmittals.length) {
      showMessage(dateMode
        ? "No claims were found in that date range."
        : isPatientSearch
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
    selectAllClaims.checked = false;
    selectAllClaims.indeterminate = false;
    result.claims.forEach((claim) => {
      const row = document.createElement("tr");
      row.dataset.claimRow = "";
      row.dataset.originalOrder = String(claimsBody.children.length);
      row.dataset.patientSurname = patientSurname(claim.patient_name);
      row.tabIndex = 0;
      row.setAttribute("aria-selected", "false");
      const actionCell = document.createElement("td");
      const selectionCheckbox = document.createElement("input");
      selectionCheckbox.className = "selection-checkbox";
      selectionCheckbox.type = "checkbox";
      selectionCheckbox.setAttribute("aria-label", `Select claim ${claim.claim_series || "in transmittal " + claim.transmittal_number}`);
      actionCell.append(selectionCheckbox);
      if (claim.transmittal_id && claim.claim_id && statusClass(claim.transmittal_status) === "status-draft") {
        const actionButtons = document.createElement("div");
        actionButtons.className = "claims-row-actions";
        const editButton = document.createElement("button");
        editButton.className = "cyber-btn icon-btn";
        editButton.type = "button";
        editButton.innerHTML = EDIT_ICON_SVG;
        editButton.title = "Edit";
        editButton.dataset.transmittalId = claim.transmittal_id;
        editButton.dataset.claimId = claim.claim_id;
        editButton.dataset.action = "edit-claim";
        editButton.setAttribute("aria-label", `Edit claim ${claim.claim_series || "in transmittal " + claim.transmittal_number}`);
        const transmitButton = document.createElement("button");
        transmitButton.className = "cyber-btn icon-btn";
        transmitButton.type = "button";
        transmitButton.innerHTML = TRANSMIT_ICON_SVG;
        transmitButton.title = "Transmit";
        transmitButton.dataset.transmittalId = claim.transmittal_id;
        transmitButton.dataset.action = "transmit-claim";
        transmitButton.dataset.state = "ready";
        transmitButton.setAttribute("aria-label", `Transmit ${claim.transmittal_number}`);
        actionButtons.append(editButton, transmitButton);
        actionCell.append(actionButtons);
      }
      row.append(actionCell);
      row.dataset.transmittalNumber = claim.transmittal_number || "";
      row.dataset.transmittalStatus = claim.transmittal_status || "";
      [claim.transmittal_number, claim.claim_series, claim.patient_name, claim.member_name, claim.admission_date, claim.discharge_date, claim.status].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value || "-";
        row.append(cell);
      });
      const claimStatusCell = row.children[7];
      const claimStatus = document.createElement("span");
      claimStatus.className = `claim-status ${statusClass(claim.status)}`;
      const claimStatusDot = document.createElement("i");
      claimStatusDot.className = "status-dot";
      claimStatus.append(claimStatusDot, document.createTextNode(claim.status || "-"));
      claimStatusCell.replaceChildren(claimStatus);
      const transmittalCell = row.children[1];
      if (transmittalCell && claim.transmittal_number) {
        const copyButton = document.createElement("button");
        copyButton.className = "cyber-btn icon-btn cell-copy-btn";
        copyButton.type = "button";
        copyButton.innerHTML = COPY_ICON_SVG;
        copyButton.title = "Copy transmittal";
        copyButton.setAttribute("aria-label", `Copy transmittal ${claim.transmittal_number}`);
        copyButton.addEventListener("click", async (event) => {
          event.stopPropagation();
          let copied = false;
          try {
            await copyTextToClipboard(claim.transmittal_number);
            copied = true;
          } catch (error) {
            copied = false;
          }
          copyButton.innerHTML = copied ? CHECK_ICON_SVG : COPY_ICON_SVG;
          copyButton.title = copied ? "Copied" : "Copy failed";
          setTimeout(() => {
            copyButton.innerHTML = COPY_ICON_SVG;
            copyButton.title = "Copy transmittal";
          }, 1500);
        });
        transmittalCell.append(copyButton);
      }
      const transmittalStatusCell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `transmittal-status ${statusClass(claim.transmittal_status)}`;
      const dot = document.createElement("i");
      dot.className = "status-dot";
      badge.append(dot, document.createTextNode(claim.transmittal_status || "-"));
      transmittalStatusCell.append(badge);
      row.append(transmittalStatusCell);
      const beaconMessageCell = document.createElement("td");
      beaconMessageCell.className = "beacon-message-cell";
      row.append(beaconMessageCell);
      claimsBody.append(row);
    });
    claimsSort.disabled = false;
    updateSelectionControls();
  } catch (error) {
    showMessage(error.message || "Beacon lookup failed. Try again.", true);
  } finally {
    if (progressPoll) window.clearInterval(progressPoll);
    lookupButton.disabled = false;
    lookupButton.classList.remove("is-loading");
    lookupButton.removeAttribute("aria-busy");
  }
});

async function editorRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Beacon request failed.");
  return result;
}

function setEditorMessage(section, message, error = false) {
  const element = document.getElementById(`${section}EditorMessage`);
  element.textContent = message;
  element.classList.toggle("error", error);
}

function setInputValue(id, value) {
  document.getElementById(id).value = value == null ? "" : String(value);
}

function populateDoctorFields() {
  const selected = document.getElementById("editDoctorSelect").selectedOptions[0];
  if (!selected?.dataset.doctorId) {
    setInputValue("editDoctorAccreditation", "");
    setInputValue("editDoctorSignDate", "");
    return;
  }
  setInputValue("editDoctorAccreditation", selected.dataset.accreditation || "");
  setInputValue("editDoctorSignDate", selected.dataset.signDate || "");
}

const editorViewTitles = {
  cf2: "Change Admission and Discharge Time",
  receivable: "Account Receivable",
  doctor: "Change Doctor",
  cf4: "Add CF4 Vitals",
  history: "History of Present Illness & Pertinent Past Medical History",
  course: "Update Course in the Ward",
  soa: "Generate/Remove SOA Data",
};

function applyEditorView(view) {
  document.querySelector(".editor-content").dataset.view = view;
  const visibleSections = view === "history" ? new Set(["hpi", "pmh"]) : new Set([view]);
  document.querySelectorAll(".editor-section[data-editor-section]").forEach((section) => {
    section.hidden = !visibleSections.has(section.dataset.editorSection);
  });
  document.getElementById("editorTitle").textContent = editorViewTitles[view] || "Edit Draft Claim";
  document.querySelectorAll("#editorTabs [data-editor-view]").forEach((button) => {
    const active = button.dataset.editorView === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
}

async function openClaimEditor(transmittalId, claimId, view = "cf2") {
  if (editorLoading) return;
  editorLoading = true;
  editorLoaded = false;
  activeEditClaim = { transmittalId, claimId, view };
  editorDirty = false;
  updateEditorNextButton();
  applyEditorView(view);
  claimEditor.hidden = false;
  editorSubtitle.textContent = "Loading draft claim...";
  document.getElementById("editorSoaSummary").textContent = "Loading SOA rows...";
  ["cf2", "receivable", "doctor", "cf4", "hpi", "pmh", "course", "soa"].forEach((section) => setEditorMessage(section, ""));
  try {
    const data = await editorRequest(`/api/beacon/finalize-claims/${transmittalId}/${claimId}/edit`);
    editorSubtitle.textContent = `${data.patient_name || "Draft claim"} | ${data.transmittal_number} | ${data.claim_series || "Claim series pending"}`;

    setInputValue("editAdmissionDate", data.cf2.admission_date);
    setInputValue("editAdmissionTime", data.cf2.admission_time);
    setInputValue("editDischargeDate", data.cf2.discharge_date);
    setInputValue("editDischargeTime", data.cf2.discharge_time);
    setInputValue("editReceivableName", data.account_receivable.name);
    setInputValue("editReceivableDesignation", data.account_receivable.designation);
    setInputValue("editReceivableNumber", data.account_receivable.number);
    setInputValue("editReceivableDateSigned", data.account_receivable.date_signed);

    const doctorSelect = document.getElementById("editDoctorSelect");
    doctorSelect.replaceChildren();
    const addOption = (label, doctor = null) => {
      const option = document.createElement("option");
      option.value = doctor?.id ?? "";
      option.textContent = label;
      if (doctor) {
        option.dataset.doctorId = doctor.id;
        option.dataset.accreditation = doctor.accreditation_number;
        option.dataset.signDate = doctor.sign_date;
      }
      doctorSelect.append(option);
    };
    if (data.doctors.length) {
      data.doctors.forEach((doctor) => addOption(`${doctor.fullname || "Doctor"} (${doctor.accreditation_number || "No accreditation number"})`, doctor));
      doctorSelect.selectedIndex = 0;
      populateDoctorFields();
    } else {
      addOption("Add a doctor");
      populateDoctorFields();
    }

    const vitalInputs = {
      vsbpSystolic: "editSystolic", vsbpDiastolic: "editDiastolic", vshr: "editHeartRate",
      vsrr: "editRespiratoryRate", vsTemp: "editTemperature", height: "editHeight", weight: "editWeight",
    };
    Object.entries(vitalInputs).forEach(([key, id]) => setInputValue(id, data.cf4_vitals[key]));
    setInputValue("editHistoryOfPresentIllness", data.cf4_text.history_of_present_illness);
    setInputValue("editPertinentPastMedicalHistory", data.cf4_text.pertinent_past_medical_history);
    renderCourseInWardRows(data.cf4_course_in_ward || []);

    document.getElementById("editorSoaSummary").textContent =
      `MED rows: ${data.soa_counts.med} | XLSO rows: ${data.soa_counts.xlso} | Payment receipts: ${data.soa_counts.payments}`;
    editorLoaded = true;
  } catch (error) {
    editorSubtitle.textContent = error.message || "Unable to load this draft claim.";
  } finally {
    editorLoading = false;
    updateEditorNextButton();
  }
}

function getNextEditableClaimButton() {
  return getAdjacentEditableClaimButton(1);
}

function getPreviousEditableClaimButton() {
  return getAdjacentEditableClaimButton(-1);
}

function getAdjacentEditableClaimButton(direction) {
  if (!activeEditClaim) return null;
  const buttons = Array.from(claimsBody.querySelectorAll('[data-action="edit-claim"]'));
  const currentIndex = buttons.findIndex((button) =>
    String(button.dataset.transmittalId) === String(activeEditClaim.transmittalId)
    && String(button.dataset.claimId) === String(activeEditClaim.claimId));
  return currentIndex >= 0 ? buttons[currentIndex + direction] || null : null;
}

function updateEditorNextButton() {
  const nextButton = document.getElementById("editorNext");
  const previousButton = document.getElementById("editorPrevious");
  const nextClaim = getNextEditableClaimButton();
  const previousClaim = getPreviousEditableClaimButton();
  const navigationUnavailable = editorLoading || !editorLoaded;
  nextButton.disabled = navigationUnavailable || !nextClaim;
  nextButton.title = navigationUnavailable ? "Wait for the claim to finish loading" : nextClaim ? "Open the next draft claim in the table" : "No more draft claims in the table";
  previousButton.disabled = navigationUnavailable || !previousClaim;
  previousButton.title = navigationUnavailable ? "Wait for the claim to finish loading" : previousClaim ? "Open the previous draft claim in the table" : "No previous draft claims in the table";
}

function navigateClaim(direction) {
  if (editorLoading || !editorLoaded) return;
  const targetButton = direction > 0 ? getNextEditableClaimButton() : getPreviousEditableClaimButton();
  if (!targetButton) return;
  if (editorDirty && !window.confirm("You have unsaved changes. Move to another claim and discard them?")) return;
  const row = targetButton.closest("tr[data-claim-row]");
  selectClaimRow(row);
  openClaimEditor(targetButton.dataset.transmittalId, targetButton.dataset.claimId, activeEditClaim.view);
}

document.getElementById("editorNext").addEventListener("click", () => navigateClaim(1));
document.getElementById("editorPrevious").addEventListener("click", () => navigateClaim(-1));

document.querySelector(".editor-content").addEventListener("input", () => { editorDirty = true; });
document.querySelector(".editor-content").addEventListener("change", () => { editorDirty = true; });

async function transmitTransmittal(button) {
  const transmittalId = button.dataset.transmittalId;
  const row = button.closest("tr[data-claim-row]");
  button.disabled = true;
  button.dataset.state = "transmitting";
  button.title = "Transmitting...";
  try {
    const result = await editorRequest(`/api/beacon/finalize-claims/${transmittalId}/transmit`, { method: "POST", body: "{}" });
    const badge = row.querySelector(".transmittal-status");
    if (badge) {
      badge.className = `transmittal-status ${statusClass(result.status)}`;
      badge.lastChild.textContent = result.status || "TRANSMITTED";
      row.dataset.transmittalStatus = result.status || "TRANSMITTED";
      const details = [result.e_ticket_number && `eTicket ${result.e_ticket_number}`, result.control_number && `TCN ${result.control_number}`].filter(Boolean).join(" | ");
      if (details) badge.title = details;
    }
    button.dataset.state = "transmitted";
    button.innerHTML = TRANSMITTED_ICON_SVG;
    button.title = "Transmitted";
    const details = [result.e_ticket_number && `eTicket ${result.e_ticket_number}`, result.control_number && `TCN ${result.control_number}`].filter(Boolean).join(" | ");
    setBeaconMessage(row, `Transmitted successfully.${details ? ` ${details}` : ""}`);
    return result;
  } catch (error) {
    button.disabled = false;
    button.dataset.state = "ready";
    button.innerHTML = TRANSMIT_ICON_SVG;
    button.title = error.message || "Transmit";
    setBeaconMessage(row, `Transmit failed: ${error.message}`, true);
    throw error;
  }
}

function setBeaconMessage(row, message, error = false) {
  const cell = row.querySelector(".beacon-message-cell");
  if (!cell) return;
  cell.className = `beacon-message-cell${message ? (error ? " error" : " success") : ""}`;
  cell.textContent = message;
}

claimsBody.addEventListener("click", (event) => {
  const transmitButton = event.target.closest('[data-action="transmit-claim"]');
  if (transmitButton) {
    const transmittalNumber = transmitButton.closest("tr").dataset.transmittalNumber;
    showTransmitClaimConfirm(transmittalNumber, () => transmitTransmittal(transmitButton).catch(() => {}));
    return;
  }
  const editButton = event.target.closest('[data-action="edit-claim"]');
  if (editButton) {
    selectClaimRow(editButton.closest("tr[data-claim-row]"));
    openClaimEditor(editButton.dataset.transmittalId, editButton.dataset.claimId);
  }
});

function selectClaimRow(row) {
  claimsBody.querySelectorAll("tr[data-claim-row]").forEach((item) => {
    const isSelected = item === row;
    item.classList.toggle("selected", isSelected);
    item.setAttribute("aria-selected", String(isSelected));
    item.querySelector(".selection-checkbox").checked = isSelected;
  });
  updateSelectionControls();
}

function toggleClaimRowSelection(row) {
  const selected = !row.classList.contains("selected");
  row.classList.toggle("selected", selected);
  row.setAttribute("aria-selected", String(selected));
  row.querySelector(".selection-checkbox").checked = selected;
  updateSelectionControls();
}

claimsBody.addEventListener("change", (event) => {
  const checkbox = event.target.closest(".selection-checkbox");
  if (!checkbox || checkbox === selectAllClaims) return;
  const row = checkbox.closest("tr[data-claim-row]");
  if (!row) return;
  row.classList.toggle("selected", checkbox.checked);
  row.setAttribute("aria-selected", String(checkbox.checked));
  updateSelectionControls();
});

claimsBody.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-claim-row]");
  if (!row || event.target.closest("button, a, input, select, textarea, [data-action]")) return;
  toggleClaimRowSelection(row);
});

claimsBody.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  if (event.target.closest("button, input, select, textarea, a")) return;
  const row = event.target.closest("tr[data-claim-row]");
  if (!row) return;
  event.preventDefault();
  toggleClaimRowSelection(row);
});

document.getElementById("editDoctorSelect").addEventListener("change", populateDoctorFields);
document.getElementById("editorClose").addEventListener("click", () => {
  claimEditor.hidden = true;
  activeEditClaim = null;
  document.querySelector(".editor-content").removeAttribute("data-view");
});
document.getElementById("editorTabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-editor-view]");
  if (!tab || !activeEditClaim) return;
  activeEditClaim.view = tab.dataset.editorView;
  applyEditorView(activeEditClaim.view);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || claimEditor.hidden) return;
  document.getElementById("editorClose").click();
});

document.querySelectorAll("[data-save-editor]").forEach((button) => {
  button.addEventListener("click", async () => {
    if (!activeEditClaim) return;
    const section = button.dataset.saveEditor;
    const { transmittalId, claimId } = activeEditClaim;
    const route = `/api/beacon/finalize-claims/${transmittalId}/${claimId}`;
    const payloads = {
      cf2: {
        admission_date: document.getElementById("editAdmissionDate").value,
        admission_time: document.getElementById("editAdmissionTime").value,
        discharge_date: document.getElementById("editDischargeDate").value,
        discharge_time: document.getElementById("editDischargeTime").value,
      },
      receivable: {
        name: document.getElementById("editReceivableName").value.trim(),
        designation: document.getElementById("editReceivableDesignation").value.trim(),
        number: document.getElementById("editReceivableNumber").value.trim(),
      },
      doctor: {
        doctor_id: document.getElementById("editDoctorSelect").value,
        accreditation_number: document.getElementById("editDoctorAccreditation").value.trim(),
        sign_date: document.getElementById("editDoctorSignDate").value,
      },
      cf4: {
        vsbpSystolic: document.getElementById("editSystolic").value,
        vsbpDiastolic: document.getElementById("editDiastolic").value,
        vshr: document.getElementById("editHeartRate").value,
        vsrr: document.getElementById("editRespiratoryRate").value,
        vsTemp: document.getElementById("editTemperature").value,
        height: document.getElementById("editHeight").value,
        weight: document.getElementById("editWeight").value,
      },
      hpi: { historyOfPresentIllness: document.getElementById("editHistoryOfPresentIllness").value },
      pmh: { pertinentPastMedicalHistory: document.getElementById("editPertinentPastMedicalHistory").value },
      course: { entries: readCourseInWardRows() },
    };
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "SAVING...";
    setEditorMessage(section, "Saving changes to Beacon...");
    try {
      const endpoint = section === "cf4" ? "cf4-vitals" : ["hpi", "pmh"].includes(section) ? "cf4-text" : section === "course" ? "course-in-ward" : section;
      await editorRequest(`${route}/${endpoint}`, {
        method: "POST",
        body: JSON.stringify(payloads[section]),
      });
      await openClaimEditor(transmittalId, claimId, activeEditClaim.view);
      setEditorMessage(section, "Saved to Beacon.");
    } catch (error) {
      setEditorMessage(section, error.message || "Save failed.", true);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });
});

document.getElementById("removeSoaButton").addEventListener("click", async (event) => {
  if (!activeEditClaim) return;
  const button = event.currentTarget;
  const { transmittalId, claimId } = activeEditClaim;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "REMOVING...";
  setEditorMessage("soa", "Removing the SOA charge rows from Beacon...");
  try {
    const result = await editorRequest(`/api/beacon/finalize-claims/${transmittalId}/${claimId}/soa`, { method: "DELETE" });
    await openClaimEditor(transmittalId, claimId, activeEditClaim.view);
    setEditorMessage("soa", `Removed ${result.med_count} medicine and ${result.xlso_count} other charge rows. No payment receipts were attached.`);
  } catch (error) {
    setEditorMessage("soa", error.message || "Beacon could not remove the SOA data.", true);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});

async function generateEditorFile({ button, section, endpoint, successText }) {
  if (!activeEditClaim) return;
  const { transmittalId, claimId } = activeEditClaim;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "GENERATING...";
  setEditorMessage(section, "Validating and generating in Beacon...");
  try {
    await editorRequest(`/api/beacon/finalize-claims/${transmittalId}/${claimId}/${endpoint}`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    setEditorMessage(section, successText);
  } catch (error) {
    setEditorMessage(section, error.message || "Beacon generation failed.", true);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

document.getElementById("generateSoaButton").addEventListener("click", (event) => {
  generateEditorFile({
    button: event.currentTarget,
    section: "soa",
    endpoint: "soa/generate",
    successText: "SOA validated, generated, and uploaded to Beacon.",
  });
});

document.getElementById("generateCf4Button").addEventListener("click", (event) => {
  generateEditorFile({
    button: event.currentTarget,
    section: "cf4",
    endpoint: "cf4-generate",
    successText: "CF4 generated in Beacon.",
  });
});

document.getElementById("addCourseInWardRow").addEventListener("click", () => addCourseInWardRow());

function setTransmitAllStatus(message, error = false) {
  transmitAllStatus.textContent = message;
  transmitAllStatus.classList.toggle("error", error);
}

function markRowTransmitted(row, sourceRow) {
  const badge = row.querySelector(".transmittal-status");
  const sourceBadge = sourceRow.querySelector(".transmittal-status");
  if (badge && sourceBadge) {
    badge.className = sourceBadge.className;
    badge.lastChild.textContent = sourceBadge.textContent;
    badge.title = sourceBadge.title;
    row.dataset.transmittalStatus = sourceRow.dataset.transmittalStatus;
  }
  const sourceMessage = sourceRow.querySelector(".beacon-message-cell");
  if (sourceMessage) setBeaconMessage(row, sourceMessage.textContent, sourceMessage.classList.contains("error"));
  const button = row.querySelector('[data-action="transmit-claim"]');
  if (button && button.dataset.state !== "transmitted") {
    button.disabled = true;
    button.dataset.state = "transmitted";
    button.innerHTML = TRANSMITTED_ICON_SVG;
    button.title = "Transmitted";
  }
}

function getReadyTransmittalGroups() {
  const rows = Array.from(claimsBody.querySelectorAll("tr[data-claim-row].selected"));
  const groups = new Map();
  rows.forEach((row) => {
    const button = row.querySelector('[data-action="transmit-claim"]');
    if (!button || button.disabled || button.dataset.state !== "ready") return;
    const transmittalId = button.dataset.transmittalId;
    if (!groups.has(transmittalId)) groups.set(transmittalId, []);
    groups.get(transmittalId).push(row);
  });
  return { rows, groups };
}

function closeTransmitAllConfirm(onKey) {
  document.removeEventListener("keydown", onKey);
  document.getElementById("modalRoot").innerHTML = "";
}

function showTransmitClaimConfirm(transmittalNumber, onConfirm) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <h3>Confirm Transmit</h3>
        <p>Transmit transmittal ${String(transmittalNumber || "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]))} to PhilHealth now?\n\nThis action submits the claim for processing and cannot be undone.</p>
        <div class="modal-actions">
          <button class="cyber-btn" id="transmitClaimCancelBtn" type="button">CANCEL</button>
          <button class="cyber-btn danger" id="transmitClaimConfirmBtn" type="button">YES, TRANSMIT</button>
        </div>
      </div>
    </div>`;
  function close() {
    closeTransmitAllConfirm(onKey);
  }
  function onKey(event) {
    if (event.key === "Escape") close();
  }
  document.getElementById("transmitClaimCancelBtn").addEventListener("click", close);
  document.getElementById("transmitClaimConfirmBtn").addEventListener("click", () => {
    close();
    onConfirm();
  });
  root.querySelector(".modal-overlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) close();
  });
  document.addEventListener("keydown", onKey);
  document.getElementById("transmitClaimCancelBtn").focus();
}

function showTransmitAllConfirm(transmittalCount, rowCount, onConfirm) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <h3>Confirm Batch Transmit</h3>
        <p>Transmit ${transmittalCount} draft transmittal${transmittalCount === 1 ? "" : "s"} selected from ${rowCount} selected claim row${rowCount === 1 ? "" : "s"} to PhilHealth now?\n\nBeacon transmits a whole transmittal, so any unselected claims in those transmittals will be included. This action cannot be undone.</p>
        <div class="modal-actions">
          <button class="cyber-btn" id="transmitAllCancelBtn" type="button">CANCEL</button>
          <button class="cyber-btn danger" id="transmitAllConfirmBtn" type="button">YES, TRANSMIT BATCH</button>
        </div>
      </div>
    </div>`;
  function close() {
    closeTransmitAllConfirm(onKey);
  }
  function onKey(event) {
    if (event.key === "Escape") close();
  }
  document.getElementById("transmitAllCancelBtn").addEventListener("click", close);
  document.getElementById("transmitAllConfirmBtn").addEventListener("click", () => {
    close();
    onConfirm();
  });
  root.querySelector(".modal-overlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) close();
  });
  document.addEventListener("keydown", onKey);
  document.getElementById("transmitAllCancelBtn").focus();
}

function getDraftClaimsForSoa() {
  return Array.from(claimsBody.querySelectorAll("tr[data-claim-row].selected"))
    .filter((row) => row.querySelector('[data-action="edit-claim"]')
      && String(row.dataset.transmittalStatus || "").trim().toUpperCase() === "DRAFT");
}

function showDeleteClaimsConfirm(claimCount, onConfirm) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <h3>Confirm Draft Claim Deletion</h3>
        <p>Permanently delete all documents attached to the ${claimCount} selected draft claim${claimCount === 1 ? "" : "s"} (including generated SOA, CF4, CSF, COE, OTH, and HDA documents), then delete the claims? Afterward, any of their DRAFT transmittals that are empty will also be deleted. This cannot be undone; transmittals containing other claims will be kept.</p>
        <div class="modal-actions">
          <button class="cyber-btn" id="deleteClaimsCancelBtn" type="button">CANCEL</button>
          <button class="cyber-btn danger" id="deleteClaimsConfirmBtn" type="button">YES, DELETE DRAFTS</button>
        </div>
      </div>
    </div>`;
  function close() {
    closeTransmitAllConfirm(onKey);
  }
  function onKey(event) {
    if (event.key === "Escape") close();
  }
  document.getElementById("deleteClaimsCancelBtn").addEventListener("click", close);
  document.getElementById("deleteClaimsConfirmBtn").addEventListener("click", () => {
    close();
    onConfirm();
  });
  root.querySelector(".modal-overlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) close();
  });
  document.addEventListener("keydown", onKey);
  document.getElementById("deleteClaimsCancelBtn").focus();
}

async function runDeleteClaims() {
  const rows = getDraftClaimsForSoa();
  if (!rows.length) {
    setTransmitAllStatus("Select at least one draft claim to delete.", true);
    return;
  }

  const button = document.getElementById("deleteClaimsButton");
  const unlockToolbar = lockClaimsToolbar(button);
  let deleted = 0;
  let failed = 0;
  let deletedTransmittals = 0;
  let keptTransmittals = 0;
  const transmittalMessages = [];
  const transmittals = new Map();
  rows.forEach((row) => {
    const claimAction = row.querySelector('[data-action="edit-claim"]');
    const transmittalId = claimAction.dataset.transmittalId;
    if (!transmittals.has(transmittalId)) {
      transmittals.set(transmittalId, {
        number: row.dataset.transmittalNumber,
        failed: false,
      });
    }
  });
  setToolbarLoading(button, true);
  try {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const claimAction = row.querySelector('[data-action="edit-claim"]');
      const { transmittalId, claimId } = claimAction.dataset;
      setTransmitAllStatus(`Deleting claim ${index + 1} of ${rows.length}: ${row.dataset.transmittalNumber}...`);
      try {
        await editorRequest(`/api/beacon/finalize-claims/${transmittalId}/${claimId}`, {
          method: "DELETE",
        });
        row.remove();
        deleted += 1;
      } catch (error) {
        transmittals.get(transmittalId).failed = true;
        setBeaconMessage(row, `Claim deletion failed: ${error.message}`, true);
        failed += 1;
      }
    }

    let transmittalIndex = 0;
    for (const [transmittalId, transmittal] of transmittals) {
      transmittalIndex += 1;
      if (transmittal.failed) {
        keptTransmittals += 1;
        transmittalMessages.push(`${transmittal.number}: claim deletion failed`);
        continue;
      }
      setTransmitAllStatus(`Removing empty DRAFT transmittal ${transmittalIndex} of ${transmittals.size}: ${transmittal.number}...`);
      try {
        await editorRequest(`/api/beacon/finalize-claims/${transmittalId}`, {
          method: "DELETE",
        });
        deletedTransmittals += 1;
      } catch (error) {
        keptTransmittals += 1;
        transmittalMessages.push(`${transmittal.number}: ${error.message}`);
      }
    }

    const remainingRows = claimsBody.querySelectorAll("tr[data-claim-row]");
    const summaryItem = (label) => Array.from(summary.children)
      .find((item) => item.querySelector("strong")?.textContent === `${label}: `);
    const claimSummary = summaryItem("Claims");
    if (claimSummary?.lastChild) claimSummary.lastChild.textContent = String(remainingRows.length);
    const transmittalSummary = summaryItem("Transmittals Found");
    if (transmittalSummary?.lastChild) {
      const currentCount = Number(transmittalSummary.lastChild.textContent);
      if (Number.isFinite(currentCount)) {
        transmittalSummary.lastChild.textContent = String(Math.max(0, currentCount - deletedTransmittals));
      }
    }
    if (!remainingRows.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.className = "message";
      cell.colSpan = 10;
      cell.textContent = "No claims remain in the current lookup.";
      row.append(cell);
      claimsBody.append(row);
    }

    const errors = failed + keptTransmittals;
    setTransmitAllStatus(
      `Deleted ${deleted} claim${deleted === 1 ? "" : "s"} and ${deletedTransmittals} empty DRAFT transmittal${deletedTransmittals === 1 ? "" : "s"}; ${failed} claim${failed === 1 ? "" : "s"} failed and ${keptTransmittals} transmittal${keptTransmittals === 1 ? "" : "s"} kept.`
      + (transmittalMessages.length ? ` ${transmittalMessages.join("; ")}` : ""),
      errors > 0,
    );
  } finally {
    setToolbarLoading(button, false);
    unlockToolbar();
  }
}

function showGenerateCf4AllConfirm(claimCount, onConfirm) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <h3>Confirm Batch CF4 Generation</h3>
        <p>Generate and upload CF4 for ${claimCount} draft claim${claimCount === 1 ? "" : "s"}, one at a time?</p>
        <div class="modal-actions">
          <button class="cyber-btn" id="generateCf4AllCancelBtn" type="button">CANCEL</button>
          <button class="cyber-btn danger" id="generateCf4AllConfirmBtn" type="button">YES, GENERATE BATCH</button>
        </div>
      </div>
    </div>`;
  function close() {
    closeTransmitAllConfirm(onKey);
  }
  function onKey(event) {
    if (event.key === "Escape") close();
  }
  document.getElementById("generateCf4AllCancelBtn").addEventListener("click", close);
  document.getElementById("generateCf4AllConfirmBtn").addEventListener("click", () => {
    close();
    onConfirm();
  });
  root.querySelector(".modal-overlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) close();
  });
  document.addEventListener("keydown", onKey);
  document.getElementById("generateCf4AllCancelBtn").focus();
}

function showGenerateSoaAllConfirm(claimCount, onConfirm) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <h3>Confirm Batch SOA Generation</h3>
        <p>Generate and upload SOA for ${claimCount} draft claim${claimCount === 1 ? "" : "s"}, one at a time?</p>
        <div class="modal-actions">
          <button class="cyber-btn" id="generateSoaAllCancelBtn" type="button">CANCEL</button>
          <button class="cyber-btn danger" id="generateSoaAllConfirmBtn" type="button">YES, GENERATE BATCH</button>
        </div>
      </div>
    </div>`;
  function close() {
    closeTransmitAllConfirm(onKey);
  }
  function onKey(event) {
    if (event.key === "Escape") close();
  }
  document.getElementById("generateSoaAllCancelBtn").addEventListener("click", close);
  document.getElementById("generateSoaAllConfirmBtn").addEventListener("click", () => {
    close();
    onConfirm();
  });
  root.querySelector(".modal-overlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) close();
  });
  document.addEventListener("keydown", onKey);
  document.getElementById("generateSoaAllCancelBtn").focus();
}

async function runGenerateCf4All() {
  const rows = getDraftClaimsForSoa();
  if (!rows.length) {
    setTransmitAllStatus("Select at least one draft claim for CF4 generation.", true);
    return;
  }

  const button = document.getElementById("generateCf4AllButton");
  const unlockToolbar = lockClaimsToolbar(button);
  let generated = 0;
  let failed = 0;
  button.disabled = true;
  document.getElementById("removeSoaAllButton").disabled = true;
  document.getElementById("removeGeneratedSoaAllButton").disabled = true;
  transmitAllButton.disabled = true;
  setToolbarLoading(button, true);
  try {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const claimAction = row.querySelector('[data-action="edit-claim"]');
      const { transmittalId, claimId } = claimAction.dataset;
      setTransmitAllStatus(`Generating CF4 ${index + 1} of ${rows.length}: ${row.dataset.transmittalNumber}...`);
      try {
        await editorRequest(`/api/beacon/finalize-claims/${transmittalId}/${claimId}/cf4-generate`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        setBeaconMessage(row, "CF4 generated in Beacon.");
        generated += 1;
      } catch (error) {
        setBeaconMessage(row, `CF4 generation failed: ${error.message}`, true);
        failed += 1;
      }
    }
    setTransmitAllStatus(failed
      ? `CF4 generated for ${generated} claim${generated === 1 ? "" : "s"}; ${failed} failed. Check Beacon Message for details.`
      : `CF4 generated for all ${generated} draft claim${generated === 1 ? "" : "s"}.`, failed > 0);
  } finally {
    setToolbarLoading(button, false);
    button.disabled = false;
    document.getElementById("removeSoaAllButton").disabled = false;
    document.getElementById("removeGeneratedSoaAllButton").disabled = false;
    transmitAllButton.disabled = false;
    unlockToolbar();
  }
}

async function runGenerateSoaAll() {
  const rows = getDraftClaimsForSoa();
  if (!rows.length) {
    setTransmitAllStatus("Select at least one draft claim for SOA generation.", true);
    return;
  }

  const button = document.getElementById("generateSoaAllButton");
  const unlockToolbar = lockClaimsToolbar(button);
  let generated = 0;
  let failed = 0;
  button.disabled = true;
  document.getElementById("removeSoaAllButton").disabled = true;
  document.getElementById("removeGeneratedSoaAllButton").disabled = true;
  transmitAllButton.disabled = true;
  setToolbarLoading(button, true);
  try {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const claimAction = row.querySelector('[data-action="edit-claim"]');
      const { transmittalId, claimId } = claimAction.dataset;
      setTransmitAllStatus(`Generating SOA ${index + 1} of ${rows.length}: ${row.dataset.transmittalNumber}...`);
      try {
        await editorRequest(`/api/beacon/finalize-claims/${transmittalId}/${claimId}/soa/generate`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        setBeaconMessage(row, "SOA generated in Beacon.");
        generated += 1;
      } catch (error) {
        setBeaconMessage(row, `SOA generation failed: ${error.message}`, true);
        failed += 1;
      }
    }
    setTransmitAllStatus(failed
      ? `SOA generated for ${generated} claim${generated === 1 ? "" : "s"}; ${failed} failed. Check Beacon Message for details.`
      : `SOA generated for all ${generated} draft claim${generated === 1 ? "" : "s"}.`, failed > 0);
  } finally {
    setToolbarLoading(button, false);
    button.disabled = false;
    document.getElementById("removeSoaAllButton").disabled = false;
    document.getElementById("removeGeneratedSoaAllButton").disabled = false;
    transmitAllButton.disabled = false;
    unlockToolbar();
  }
}

function showRemoveSoaAllConfirm(claimCount, onConfirm) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <h3>Confirm Batch SOA Charge Removal</h3>
        <p>Remove SOA charge data from ${claimCount} draft claim${claimCount === 1 ? "" : "s"}, one at a time? Claims with payment receipts will not be changed.</p>
        <div class="modal-actions">
          <button class="cyber-btn" id="removeSoaAllCancelBtn" type="button">CANCEL</button>
          <button class="cyber-btn danger" id="removeSoaAllConfirmBtn" type="button">YES, REMOVE BATCH</button>
        </div>
      </div>
    </div>`;
  function close() {
    closeTransmitAllConfirm(onKey);
  }
  function onKey(event) {
    if (event.key === "Escape") close();
  }
  document.getElementById("removeSoaAllCancelBtn").addEventListener("click", close);
  document.getElementById("removeSoaAllConfirmBtn").addEventListener("click", () => {
    close();
    onConfirm();
  });
  root.querySelector(".modal-overlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) close();
  });
  document.addEventListener("keydown", onKey);
  document.getElementById("removeSoaAllCancelBtn").focus();
}

function showRemoveGeneratedSoaAllConfirm(claimCount, onConfirm) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <h3>Confirm Batch Generated SOA Removal</h3>
        <p>Delete generated eSOA documents from ${claimCount} draft claim${claimCount === 1 ? "" : "s"}, one at a time? SOA charge data will remain.</p>
        <div class="modal-actions">
          <button class="cyber-btn" id="removeGeneratedSoaAllCancelBtn" type="button">CANCEL</button>
          <button class="cyber-btn danger" id="removeGeneratedSoaAllConfirmBtn" type="button">YES, REMOVE BATCH</button>
        </div>
      </div>
    </div>`;
  function close() {
    closeTransmitAllConfirm(onKey);
  }
  function onKey(event) {
    if (event.key === "Escape") close();
  }
  document.getElementById("removeGeneratedSoaAllCancelBtn").addEventListener("click", close);
  document.getElementById("removeGeneratedSoaAllConfirmBtn").addEventListener("click", () => {
    close();
    onConfirm();
  });
  root.querySelector(".modal-overlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) close();
  });
  document.addEventListener("keydown", onKey);
  document.getElementById("removeGeneratedSoaAllCancelBtn").focus();
}

async function runRemoveGeneratedSoaAll() {
  const rows = getDraftClaimsForSoa();
  if (!rows.length) {
    setTransmitAllStatus("Select at least one draft claim for generated SOA removal.", true);
    return;
  }

  const button = document.getElementById("removeGeneratedSoaAllButton");
  const unlockToolbar = lockClaimsToolbar(button);
  const otherControls = [
    transmitAllButton,
    document.getElementById("generateCf4AllButton"),
    document.getElementById("removeSoaAllButton"),
  ];
  let removed = 0;
  let failed = 0;
  button.disabled = true;
  otherControls.forEach((control) => { control.disabled = true; });
  setToolbarLoading(button, true);
  try {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const claimAction = row.querySelector('[data-action="edit-claim"]');
      const { transmittalId, claimId } = claimAction.dataset;
      setTransmitAllStatus(`Removing generated SOA ${index + 1} of ${rows.length}: ${row.dataset.transmittalNumber}...`);
      try {
        const result = await editorRequest(`/api/beacon/finalize-claims/${transmittalId}/${claimId}/soa/generated`, {
          method: "DELETE",
        });
        setBeaconMessage(row, `Generated eSOA document${result.document_count === 1 ? "" : "s"} removed (${result.document_count || 0}).`);
        removed += 1;
      } catch (error) {
        setBeaconMessage(row, `Generated eSOA removal failed: ${error.message}`, true);
        failed += 1;
      }
    }
    setTransmitAllStatus(failed
      ? `Generated eSOA documents removed from ${removed} claim${removed === 1 ? "" : "s"}; ${failed} failed. Check Beacon Message for details.`
      : `Generated eSOA documents removed from all ${removed} draft claim${removed === 1 ? "" : "s"}.`, failed > 0);
  } finally {
    setToolbarLoading(button, false);
    button.disabled = false;
    otherControls.forEach((control) => { control.disabled = false; });
    unlockToolbar();
  }
}

async function runRemoveSoaAll() {
  const rows = getDraftClaimsForSoa();
  if (!rows.length) {
    setTransmitAllStatus("Select at least one draft claim for SOA removal.", true);
    return;
  }

  const button = document.getElementById("removeSoaAllButton");
  const unlockToolbar = lockClaimsToolbar(button);
  const cf4Button = document.getElementById("generateCf4AllButton");
  let removed = 0;
  let failed = 0;
  button.disabled = true;
  cf4Button.disabled = true;
  document.getElementById("removeGeneratedSoaAllButton").disabled = true;
  transmitAllButton.disabled = true;
  setToolbarLoading(button, true);
  try {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const claimAction = row.querySelector('[data-action="edit-claim"]');
      const { transmittalId, claimId } = claimAction.dataset;
      setTransmitAllStatus(`Removing SOA ${index + 1} of ${rows.length}: ${row.dataset.transmittalNumber}...`);
      try {
        const result = await editorRequest(`/api/beacon/finalize-claims/${transmittalId}/${claimId}/soa`, {
          method: "DELETE",
        });
        setBeaconMessage(row, `SOA data removed (${result.med_count || 0} MED, ${result.xlso_count || 0} XLSO rows).`);
        removed += 1;
      } catch (error) {
        setBeaconMessage(row, `SOA removal failed: ${error.message}`, true);
        failed += 1;
      }
    }
    setTransmitAllStatus(failed
      ? `SOA data removed from ${removed} claim${removed === 1 ? "" : "s"}; ${failed} failed. Check Beacon Message for details.`
      : `SOA data removed from all ${removed} draft claim${removed === 1 ? "" : "s"}.`, failed > 0);
  } finally {
    setToolbarLoading(button, false);
    button.disabled = false;
    cf4Button.disabled = false;
    document.getElementById("removeGeneratedSoaAllButton").disabled = false;
    transmitAllButton.disabled = false;
    unlockToolbar();
  }
}

async function runChangeArAll() {
  const rows = getDraftClaimsForSoa();
  if (!rows.length) {
    setTransmitAllStatus("Select at least one draft claim for Account Receivable updates.", true);
    return;
  }

  const button = document.getElementById("changeArAllButton");
  const unlockToolbar = lockClaimsToolbar(button);
  setToolbarLoading(button, true);
  let saved;
  try {
    saved = await editorRequest("/api/cf2/account-receivable");
  } catch (error) {
    setToolbarLoading(button, false);
    unlockToolbar();
    setTransmitAllStatus(error.message || "Could not load Account Receivable details.", true);
    return;
  }
  if (!saved.name && !saved.designation && !saved.number) {
    setToolbarLoading(button, false);
    unlockToolbar();
    setTransmitAllStatus("Save Account Receivable details in CF2 first.", true);
    return;
  }

  const controls = [
    button,
    transmitAllButton,
    document.getElementById("generateCf4AllButton"),
    document.getElementById("removeSoaAllButton"),
    document.getElementById("removeGeneratedSoaAllButton"),
  ];
  controls.forEach((control) => { control.disabled = true; });
  setToolbarLoading(button, true);
  let updated = 0;
  let failed = 0;
  try {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const editButton = row.querySelector('[data-action="edit-claim"]');
      const { transmittalId, claimId } = editButton.dataset;
      setTransmitAllStatus(`Updating Account Receivable ${index + 1} of ${rows.length}: ${row.dataset.transmittalNumber}...`);
      try {
        await editorRequest(`/api/beacon/finalize-claims/${transmittalId}/${claimId}/receivable`, {
          method: "POST",
          body: JSON.stringify(saved),
        });
        setBeaconMessage(row, "Account Receivable and CF2 PDF Date Signed updated.");
        updated += 1;
      } catch (error) {
        setBeaconMessage(row, `Account Receivable update failed: ${error.message}`, true);
        failed += 1;
      }
    }
    setTransmitAllStatus(failed
      ? `Account Receivable updated for ${updated} claim${updated === 1 ? "" : "s"}; ${failed} failed. Check Beacon Message for details.`
      : `Account Receivable updated for all ${updated} draft claim${updated === 1 ? "" : "s"}.`, failed > 0);
  } finally {
    setToolbarLoading(button, false);
    button.disabled = false;
    controls.slice(1).forEach((control) => { control.disabled = false; });
    unlockToolbar();
  }
}

function showChangeArAllConfirm(claimCount, onConfirm) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <h3>Confirm Batch Account Receivable Update</h3>
        <p>Apply the saved CF2 Account Receivable name, designation, and contact number to ${claimCount} draft claim${claimCount === 1 ? "" : "s"}? Each CF2 PDF Date Signed will use that claim's latest treatment date.</p>
        <div class="modal-actions">
          <button class="cyber-btn" id="changeArAllCancelBtn" type="button">CANCEL</button>
          <button class="cyber-btn danger" id="changeArAllConfirmBtn" type="button">YES, UPDATE BATCH</button>
        </div>
      </div>
    </div>`;
  function close() {
    closeTransmitAllConfirm(onKey);
  }
  function onKey(event) {
    if (event.key === "Escape") close();
  }
  document.getElementById("changeArAllCancelBtn").addEventListener("click", close);
  document.getElementById("changeArAllConfirmBtn").addEventListener("click", () => {
    close();
    onConfirm().catch((error) => setTransmitAllStatus(error.message || "Account Receivable update failed.", true));
  });
  root.querySelector(".modal-overlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) close();
  });
  document.addEventListener("keydown", onKey);
  document.getElementById("changeArAllCancelBtn").focus();
}

async function runTransmitAll() {
  const { rows, groups } = getReadyTransmittalGroups();
  if (!groups.size) {
    setTransmitAllStatus("Select at least one ready claim in a DRAFT transmittal to transmit.", true);
    return;
  }

  const entries = Array.from(groups.entries());
  const unlockToolbar = lockClaimsToolbar(transmitAllButton);
  transmitAllButton.disabled = true;
  document.getElementById("generateCf4AllButton").disabled = true;
  document.getElementById("removeSoaAllButton").disabled = true;
  document.getElementById("removeGeneratedSoaAllButton").disabled = true;
  setToolbarLoading(transmitAllButton, true);
  let transmitted = 0;
  let failed = 0;
  let rowTotal = 0;
  try {
    for (let index = 0; index < entries.length; index += 1) {
      const [transmittalId, groupRows] = entries[index];
      const primaryRow = groupRows[0];
      const button = primaryRow.querySelector('[data-action="transmit-claim"]');
      const transmittalNumber = primaryRow.dataset.transmittalNumber;
      setTransmitAllStatus(`Transmitting ${index + 1} of ${entries.length}: ${transmittalNumber}...`);
      if (!button || button.disabled || button.dataset.state !== "ready") continue;
      try {
        await transmitTransmittal(button);
        transmitted += 1;
        rowTotal += groupRows.length;
        claimsBody.querySelectorAll("tr[data-claim-row]").forEach((row) => {
          if (row === primaryRow) return;
          const siblingButton = row.querySelector('[data-action="transmit-claim"]');
          if (siblingButton && siblingButton.dataset.transmittalId === transmittalId) markRowTransmitted(row, primaryRow);
        });
      } catch (error) {
        failed += 1;
      }
    }
    if (failed === 0) {
      setTransmitAllStatus(`Transmitted ${transmitted} transmittal${transmitted === 1 ? "" : "s"} (${rowTotal} row${rowTotal === 1 ? "" : "s"}).`);
    } else {
      setTransmitAllStatus(`${transmitted} transmittal${transmitted === 1 ? "" : "s"} transmitted, ${failed} failed. Check the row messages for details.`, true);
    }
  } finally {
    setToolbarLoading(transmitAllButton, false);
    transmitAllButton.disabled = false;
    document.getElementById("generateCf4AllButton").disabled = false;
    document.getElementById("removeSoaAllButton").disabled = false;
    document.getElementById("removeGeneratedSoaAllButton").disabled = false;
    unlockToolbar();
  }
}

async function runFinalizeAll() {
  const rows = getDraftClaimsForSoa();
  if (!rows.length) {
    setTransmitAllStatus("Select at least one draft claim to finalize.", true);
    return;
  }
  let finalized = 0;
  let skipped = 0;
  let failed = 0;
  const unlockToolbar = lockClaimsToolbar(finalizeAllButton);
  const controls = [
    finalizeAllButton,
    transmitAllButton,
    document.getElementById("generateCf4AllButton"),
    document.getElementById("removeSoaAllButton"),
    document.getElementById("removeGeneratedSoaAllButton"),
    document.getElementById("changeArAllButton"),
  ];
  controls.forEach((control) => { control.disabled = true; });
  setToolbarLoading(finalizeAllButton, true);
  try {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const editButton = row.querySelector('[data-action="edit-claim"]');
      const { transmittalId, claimId } = editButton.dataset;
      setTransmitAllStatus(`Finalizing selected claim ${index + 1} of ${rows.length}: ${row.dataset.transmittalNumber}...`);
      try {
        const result = await editorRequest(`/api/beacon/finalize-claims/${transmittalId}/${claimId}/finalize`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        if (result.skipped) {
          setBeaconMessage(row, "Already finalized; no changes made.");
          skipped += 1;
        } else {
          setBeaconMessage(row, `Final PBEF generated and saved (${result.tracking_number}).`);
          finalized += 1;
        }
      } catch (error) {
        setBeaconMessage(row, `Finalization failed: ${error.message}`, true);
        failed += 1;
      }
    }
    const parts = [`Finalized ${finalized}`, `${skipped} already finalized`, `${failed} failed`];
    setTransmitAllStatus(`${parts.join("; ")}.${failed ? " Check Beacon Message for details." : ""}`, failed > 0);
  } finally {
    setToolbarLoading(finalizeAllButton, false);
    controls.forEach((control) => { control.disabled = false; });
    unlockToolbar();
  }
}

function showFinalizeAllConfirm(claimCount, onConfirm) {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <h3>Confirm Batch Auto Finalize</h3>
        <p>Generate a final PBEF and save eligibility data for ${claimCount} draft claim${claimCount === 1 ? "" : "s"}, one at a time? Claims already finalized will be skipped.</p>
        <div class="modal-actions">
          <button class="cyber-btn" id="finalizeAllCancelBtn" type="button">CANCEL</button>
          <button class="cyber-btn danger" id="finalizeAllConfirmBtn" type="button">YES, FINALIZE BATCH</button>
        </div>
      </div>
    </div>`;
  function close() { closeTransmitAllConfirm(onKey); }
  function onKey(event) { if (event.key === "Escape") close(); }
  document.getElementById("finalizeAllCancelBtn").addEventListener("click", close);
  document.getElementById("finalizeAllConfirmBtn").addEventListener("click", () => {
    close();
    onConfirm();
  });
  root.querySelector(".modal-overlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) close();
  });
  document.addEventListener("keydown", onKey);
  document.getElementById("finalizeAllCancelBtn").focus();
}

finalizeAllButton.addEventListener("click", () => {
  const rows = getDraftClaimsForSoa();
  if (!rows.length) {
    setTransmitAllStatus("Select at least one draft claim to finalize.", true);
    return;
  }
  showFinalizeAllConfirm(rows.length, runFinalizeAll);
});

document.getElementById("copyTransmittalsButton").addEventListener("click", async () => {
  const numbers = [];
  claimsBody.querySelectorAll("tr[data-claim-row].selected").forEach((row) => {
    const value = row.dataset.transmittalNumber;
    if (!value || numbers.includes(value)) return;
    numbers.push(value);
  });
  if (!numbers.length) {
    setTransmitAllStatus("No transmittals to copy. Run a lookup first.", true);
    return;
  }
  const copied = await copyTextToClipboard(numbers.join("\n"));
  setTransmitAllStatus(copied
    ? `Copied ${numbers.length} transmittal number${numbers.length === 1 ? "" : "s"}.`
    : "Copy failed. Your browser blocked clipboard access.", !copied);
});

transmitAllButton.addEventListener("click", () => {
  const { groups } = getReadyTransmittalGroups();
  if (!groups.size) {
    setTransmitAllStatus("Select at least one ready claim in a DRAFT transmittal to transmit.", true);
    return;
  }
  const transmittalCount = groups.size;
  const rowCount = Array.from(groups.values()).reduce((total, groupRows) => total + groupRows.length, 0);
  showTransmitAllConfirm(transmittalCount, rowCount, runTransmitAll);
});

document.getElementById("generateCf4AllButton").addEventListener("click", () => {
  const rows = getDraftClaimsForSoa();
  if (!rows.length) {
    setTransmitAllStatus("Select at least one draft claim for CF4 generation.", true);
    return;
  }
  showGenerateCf4AllConfirm(rows.length, runGenerateCf4All);
});

document.getElementById("generateSoaAllButton").addEventListener("click", () => {
  const rows = getDraftClaimsForSoa();
  if (!rows.length) {
    setTransmitAllStatus("Select at least one draft claim for SOA generation.", true);
    return;
  }
  showGenerateSoaAllConfirm(rows.length, runGenerateSoaAll);
});

document.getElementById("changeArAllButton").addEventListener("click", () => {
  const rows = getDraftClaimsForSoa();
  if (!rows.length) {
    setTransmitAllStatus("Select at least one draft claim for Account Receivable updates.", true);
    return;
  }
  showChangeArAllConfirm(rows.length, runChangeArAll);
});

document.getElementById("removeSoaAllButton").addEventListener("click", () => {
  const rows = getDraftClaimsForSoa();
  if (!rows.length) {
    setTransmitAllStatus("Select at least one draft claim for SOA removal.", true);
    return;
  }
  showRemoveSoaAllConfirm(rows.length, runRemoveSoaAll);
});

document.getElementById("removeGeneratedSoaAllButton").addEventListener("click", () => {
  const rows = getDraftClaimsForSoa();
  if (!rows.length) {
    setTransmitAllStatus("Select at least one draft claim for generated SOA removal.", true);
    return;
  }
  showRemoveGeneratedSoaAllConfirm(rows.length, runRemoveGeneratedSoaAll);
});

document.getElementById("deleteClaimsButton").addEventListener("click", () => {
  const rows = getDraftClaimsForSoa();
  if (!rows.length) {
    setTransmitAllStatus("Select at least one draft claim to delete.", true);
    return;
  }
  showDeleteClaimsConfirm(rows.length, runDeleteClaims);
});
