const lookupForm = document.getElementById("lookupForm");
const transmittalInput = document.getElementById("transmittalInput");
const lookupButton = document.getElementById("lookupButton");
const summary = document.getElementById("summary");
const claimsBody = document.getElementById("claimsBody");
const claimEditor = document.getElementById("claimEditor");
const claimActionsMenu = document.getElementById("claimActionsMenu");
const editorSubtitle = document.getElementById("editorSubtitle");
let activeEditClaim = null;
let courseInWardRowIndex = 0;

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
      if (claim.transmittal_id && claim.claim_id && statusClass(claim.transmittal_status) === "status-draft") {
        const editButton = document.createElement("button");
        editButton.className = "cyber-btn";
        editButton.type = "button";
        editButton.textContent = "EDIT";
        editButton.dataset.transmittalId = claim.transmittal_id;
        editButton.dataset.claimId = claim.claim_id;
        editButton.dataset.action = "toggle-claim-menu";
        editButton.setAttribute("aria-haspopup", "menu");
        editButton.setAttribute("aria-expanded", "false");
        editButton.setAttribute("aria-label", `Edit claim ${claim.claim_series || "in transmittal " + claim.transmittal_number}`);
        actionCell.append(editButton);
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

async function openClaimEditor(transmittalId, claimId, view = "cf2") {
  activeEditClaim = { transmittalId, claimId, view };
  const editorContent = document.querySelector(".editor-content");
  editorContent.dataset.view = view;
  document.querySelectorAll(".editor-section[data-editor-section]").forEach((section) => {
    section.hidden = section.dataset.editorSection !== view;
  });
  document.getElementById("editorTitle").textContent = ({
    cf2: "Change Admission and Discharge Time",
    doctor: "Change Doctor",
    cf4: "Add CF4 Vitals",
    hpi: "History of Present Illness",
    pmh: "Pertinent Past Medical History",
    course: "Update Course in the Ward",
    soa: "Generate/Remove SOA Data",
  })[view] || "Edit Draft Claim";
  claimEditor.hidden = false;
  editorSubtitle.textContent = "Loading draft claim...";
  document.getElementById("editorSoaSummary").textContent = "Loading SOA rows...";
  ["cf2", "doctor", "cf4", "hpi", "pmh", "course", "soa"].forEach((section) => setEditorMessage(section, ""));
  try {
    const data = await editorRequest(`/api/beacon/finalize-claims/${transmittalId}/${claimId}/edit`);
    editorSubtitle.textContent = `${data.patient_name || "Draft claim"} | ${data.transmittal_number} | ${data.claim_series || "Claim series pending"}`;

    setInputValue("editAdmissionDate", data.cf2.admission_date);
    setInputValue("editAdmissionTime", data.cf2.admission_time);
    setInputValue("editDischargeDate", data.cf2.discharge_date);
    setInputValue("editDischargeTime", data.cf2.discharge_time);

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
  } catch (error) {
    editorSubtitle.textContent = error.message || "Unable to load this draft claim.";
  }
}

claimsBody.addEventListener("click", (event) => {
  const toggle = event.target.closest('[data-action="toggle-claim-menu"]');
  if (toggle) {
    const shouldOpen = claimActionsMenu.hidden || claimActionsMenu.dataset.claimId !== toggle.dataset.claimId;
    closeClaimActionsMenu();
    if (shouldOpen) {
      claimActionsMenu.dataset.transmittalId = toggle.dataset.transmittalId;
      claimActionsMenu.dataset.claimId = toggle.dataset.claimId;
      claimActionsMenu.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      const rect = toggle.getBoundingClientRect();
      const menuWidth = claimActionsMenu.offsetWidth;
      const menuHeight = claimActionsMenu.offsetHeight;
      const left = rect.right + menuWidth + 8 <= window.innerWidth ? rect.right + 6 : Math.max(8, rect.left - menuWidth - 6);
      const top = Math.min(Math.max(8, rect.top), window.innerHeight - menuHeight - 8);
      claimActionsMenu.style.left = `${left}px`;
      claimActionsMenu.style.top = `${top}px`;
    }
  }
});

function closeClaimActionsMenu() {
  claimActionsMenu.hidden = true;
  claimsBody.querySelectorAll('[data-action="toggle-claim-menu"]').forEach((button) => button.setAttribute("aria-expanded", "false"));
}

claimActionsMenu.addEventListener("click", (event) => {
  const option = event.target.closest("[data-editor-view]");
  if (!option) return;
  const { transmittalId, claimId } = claimActionsMenu.dataset;
  closeClaimActionsMenu();
  openClaimEditor(transmittalId, claimId, option.dataset.editorView);
});

document.addEventListener("click", (event) => {
  if (!claimActionsMenu.hidden && !claimActionsMenu.contains(event.target) && !event.target.closest('[data-action="toggle-claim-menu"]')) {
    closeClaimActionsMenu();
  }
});
window.addEventListener("scroll", () => {
  if (!claimActionsMenu.hidden) closeClaimActionsMenu();
}, true);
window.addEventListener("resize", closeClaimActionsMenu);

document.getElementById("editDoctorSelect").addEventListener("change", populateDoctorFields);
document.getElementById("editorClose").addEventListener("click", () => {
  claimEditor.hidden = true;
  activeEditClaim = null;
  document.querySelector(".editor-content").removeAttribute("data-view");
});
claimEditor.addEventListener("click", (event) => {
  if (event.target === claimEditor) document.getElementById("editorClose").click();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!claimActionsMenu.hidden) closeClaimActionsMenu();
  else if (!claimEditor.hidden) document.getElementById("editorClose").click();
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
