const lookupForm = document.getElementById("lookupForm");
const transmittalInput = document.getElementById("transmittalInput");
const lookupButton = document.getElementById("lookupButton");
const summary = document.getElementById("summary");
const claimsBody = document.getElementById("claimsBody");
const claimEditor = document.getElementById("claimEditor");
const claimActionsMenu = document.getElementById("claimActionsMenu");
const editorSubtitle = document.getElementById("editorSubtitle");
const transmitAllButton = document.getElementById("transmitAllButton");
const transmitAllStatus = document.getElementById("transmitAllStatus");
let activeEditClaim = null;
let courseInWardRowIndex = 0;

const EDIT_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const TRANSMIT_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>';
const TRANSMITTED_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const COPY_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    return false;
  }
}

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
  cell.colSpan = 9;
  cell.className = `message${error ? " error" : ""}`;
  cell.textContent = message;
  row.append(cell);
  claimsBody.append(row);
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
  lookupButton.textContent = "SEARCHING...";
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
    result.claims.forEach((claim) => {
      const row = document.createElement("tr");
      row.dataset.claimRow = "";
      row.tabIndex = 0;
      row.setAttribute("aria-selected", "false");
      const actionCell = document.createElement("td");
      if (claim.transmittal_id && claim.claim_id && statusClass(claim.transmittal_status) === "status-draft") {
        const actionButtons = document.createElement("div");
        actionButtons.style.cssText = "display:flex;gap:6px;align-items:center";
        const editButton = document.createElement("button");
        editButton.className = "cyber-btn icon-btn";
        editButton.type = "button";
        editButton.innerHTML = EDIT_ICON_SVG;
        editButton.title = "Edit";
        editButton.dataset.transmittalId = claim.transmittal_id;
        editButton.dataset.claimId = claim.claim_id;
        editButton.dataset.action = "toggle-claim-menu";
        editButton.setAttribute("aria-haspopup", "menu");
        editButton.setAttribute("aria-expanded", "false");
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
      } else {
        actionCell.textContent = "-";
      }
      row.append(actionCell);
      row.dataset.transmittalNumber = claim.transmittal_number || "";
      row.dataset.transmittalStatus = claim.transmittal_status || "";
      [claim.transmittal_number, claim.claim_series, claim.patient_name, claim.member_name, claim.admission_date, claim.discharge_date, claim.status].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value || "-";
        row.append(cell);
      });
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
          const copied = await copyTextToClipboard(claim.transmittal_number);
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
      claimsBody.append(row);
    });
  } catch (error) {
    showMessage(error.message || "Beacon lookup failed. Try again.", true);
  } finally {
    if (progressPoll) window.clearInterval(progressPoll);
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

const editorViewTitles = {
  cf2: "Change Admission and Discharge Time",
  doctor: "Change Doctor",
  cf4: "Add CF4 Vitals",
  hpi: "History of Present Illness",
  pmh: "Pertinent Past Medical History",
  course: "Update Course in the Ward",
  soa: "Generate/Remove SOA Data",
};

function applyEditorView(view) {
  document.querySelector(".editor-content").dataset.view = view;
  document.querySelectorAll(".editor-section[data-editor-section]").forEach((section) => {
    section.hidden = section.dataset.editorSection !== view;
  });
  document.getElementById("editorTitle").textContent = editorViewTitles[view] || "Edit Draft Claim";
  document.querySelectorAll("#editorTabs [data-editor-view]").forEach((button) => {
    const active = button.dataset.editorView === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
}

async function openClaimEditor(transmittalId, claimId, view = "cf2") {
  activeEditClaim = { transmittalId, claimId, view };
  applyEditorView(view);
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
  const transmitButton = event.target.closest('[data-action="transmit-claim"]');
  if (transmitButton) {
    const transmittalId = transmitButton.dataset.transmittalId;
    const transmittalNumber = transmitButton.closest("tr").dataset.transmittalNumber;
    showTransmitClaimConfirm(transmittalNumber, () => {
    transmitButton.disabled = true;
    transmitButton.dataset.state = "transmitting";
    transmitButton.title = "Transmitting...";
    (async () => {
      try {
        const result = await editorRequest(`/api/beacon/finalize-claims/${transmittalId}/transmit`, { method: "POST", body: "{}" });
        const row = transmitButton.closest("tr");
        row.querySelector(".transmittal-status").className = `transmittal-status ${statusClass(result.status)}`;
        row.querySelector(".transmittal-status").lastChild.textContent = result.status || "TRANSMITTED";
        row.dataset.transmittalStatus = result.status || "TRANSMITTED";
        const details = [result.e_ticket_number && `eTicket ${result.e_ticket_number}`, result.control_number && `TCN ${result.control_number}`].filter(Boolean).join(" | ");
        if (details) row.querySelector(".transmittal-status").title = details;
        transmitButton.dataset.state = "transmitted";
        transmitButton.innerHTML = TRANSMITTED_ICON_SVG;
        transmitButton.title = "Transmitted";
        const feedback = document.createElement("div");
        feedback.className = "message";
        feedback.textContent = `Transmitted successfully.${details ? ` ${details}` : ""}`;
        transmitButton.parentElement.after(feedback);
      } catch (error) {
        transmitButton.disabled = false;
        transmitButton.dataset.state = "ready";
        transmitButton.innerHTML = TRANSMIT_ICON_SVG;
        transmitButton.title = error.message || "Transmit";
        const feedback = document.createElement("div");
        feedback.className = "message error";
        feedback.textContent = `Transmit failed: ${error.message}`;
        transmitButton.parentElement.after(feedback);
      }
    })();
    });
    return;
  }
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

function selectClaimRow(row) {
  claimsBody.querySelectorAll("tr[data-claim-row]").forEach((item) => {
    const isSelected = item === row;
    item.classList.toggle("selected", isSelected);
    item.setAttribute("aria-selected", String(isSelected));
  });
}

function toggleClaimRowSelection(row) {
  selectClaimRow(row.classList.contains("selected") ? null : row);
}

claimsBody.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-claim-row]");
  if (!row || event.target.closest("button, a, input, select, textarea, [data-action]")) return;
  toggleClaimRowSelection(row);
});

claimsBody.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("tr[data-claim-row]");
  if (!row) return;
  event.preventDefault();
  toggleClaimRowSelection(row);
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

document.getElementById("editorTabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-editor-view]");
  if (!tab || !activeEditClaim) return;
  activeEditClaim.view = tab.dataset.editorView;
  applyEditorView(activeEditClaim.view);
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

function setTransmitAllStatus(message, error = false) {
  transmitAllStatus.textContent = message;
  transmitAllStatus.classList.toggle("error", error);
}

function waitForRowTransmit(button) {
  const deadline = Date.now() + 120000;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (button.dataset.state === "transmitted") {
        clearInterval(timer);
        resolve(true);
      } else if (!button.disabled || !button.isConnected || Date.now() > deadline) {
        clearInterval(timer);
        resolve(false);
      }
    }, 250);
  });
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
  const button = row.querySelector('[data-action="transmit-claim"]');
  if (button && button.dataset.state !== "transmitted") {
    button.disabled = true;
    button.dataset.state = "transmitted";
    button.innerHTML = TRANSMITTED_ICON_SVG;
    button.title = "Transmitted";
  }
}

function getReadyTransmittalGroups() {
  const rows = Array.from(claimsBody.querySelectorAll("tr[data-claim-row]"));
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
        <h3>Confirm Transmit All</h3>
        <p>Transmit ${transmittalCount} draft transmittal${transmittalCount === 1 ? "" : "s"} (${rowCount} claim row${rowCount === 1 ? "" : "s"}) to PhilHealth now?\n\nThis action submits the claims for processing and cannot be undone. Rows that are not in DRAFT status are skipped.</p>
        <div class="modal-actions">
          <button class="cyber-btn" id="transmitAllCancelBtn" type="button">CANCEL</button>
          <button class="cyber-btn danger" id="transmitAllConfirmBtn" type="button">YES, TRANSMIT ALL</button>
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

async function runTransmitAll() {
  const { rows, groups } = getReadyTransmittalGroups();
  if (!groups.size) {
    setTransmitAllStatus("No ready rows to transmit. Only rows in a DRAFT transmittal can be transmitted.", true);
    return;
  }

  const entries = Array.from(groups.entries());
  transmitAllButton.disabled = true;
  transmitAllButton.textContent = "TRANSMITTING ALL...";
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
      button.click();
      const success = await waitForRowTransmit(button);
      if (success) {
        transmitted += 1;
        rowTotal += groupRows.length;
        rows.forEach((row) => {
          if (row === primaryRow) return;
          const siblingButton = row.querySelector('[data-action="transmit-claim"]');
          if (siblingButton && siblingButton.dataset.transmittalId === transmittalId) markRowTransmitted(row, primaryRow);
        });
      } else {
        failed += 1;
      }
    }
    if (failed === 0) {
      setTransmitAllStatus(`Transmitted ${transmitted} transmittal${transmitted === 1 ? "" : "s"} (${rowTotal} row${rowTotal === 1 ? "" : "s"}).`);
    } else {
      setTransmitAllStatus(`${transmitted} transmittal${transmitted === 1 ? "" : "s"} transmitted, ${failed} failed. Check the row messages for details.`, true);
    }
  } finally {
    transmitAllButton.disabled = false;
    transmitAllButton.textContent = "AUTO TRANSMIT ALL";
  }
}

document.getElementById("copyTransmittalsButton").addEventListener("click", async () => {
  const numbers = [];
  claimsBody.querySelectorAll("tr[data-claim-row]").forEach((row) => {
    const value = row.dataset.transmittalNumber;
    if (value && !numbers.includes(value)) numbers.push(value);
  });
  if (!numbers.length) {
    setTransmitAllStatus("No transmittal numbers to copy. Run a lookup first.", true);
    return;
  }
  const copied = await copyTextToClipboard(numbers.join("\n"));
  setTransmitAllStatus(copied
    ? `Copied ${numbers.length} transmittal number${numbers.length === 1 ? "" : "s"}.`
    : "Copy failed. Your browser blocked clipboard access.", !copied);
});

document.getElementById("copyDraftTransmittalsButton").addEventListener("click", async () => {
  const numbers = [];
  claimsBody.querySelectorAll("tr[data-claim-row]").forEach((row) => {
    const value = row.dataset.transmittalNumber;
    if (!value || numbers.includes(value)) return;
    if (String(row.dataset.transmittalStatus || "").trim().toUpperCase() === "DRAFT") numbers.push(value);
  });
  if (!numbers.length) {
    setTransmitAllStatus("No DRAFT transmittals to copy. Run a lookup first.", true);
    return;
  }
  const copied = await copyTextToClipboard(numbers.join("\n"));
  setTransmitAllStatus(copied
    ? `Copied ${numbers.length} DRAFT transmittal number${numbers.length === 1 ? "" : "s"}.`
    : "Copy failed. Your browser blocked clipboard access.", !copied);
});

transmitAllButton.addEventListener("click", () => {
  const { groups } = getReadyTransmittalGroups();
  if (!groups.size) {
    setTransmitAllStatus("No ready rows to transmit. Only rows in a DRAFT transmittal can be transmitted.", true);
    return;
  }
  const transmittalCount = groups.size;
  const rowCount = Array.from(groups.values()).reduce((total, groupRows) => total + groupRows.length, 0);
  showTransmitAllConfirm(transmittalCount, rowCount, runTransmitAll);
});
