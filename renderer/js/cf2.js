/*
 * CF2 browser UI logic.
 * Depends on common.js for shared fetch, modal, clipboard, and navigation helpers.
 */

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ---------------------------------------------------------------------------
// Browser fallback controls
// ---------------------------------------------------------------------------

// Claim Year / Claim Month selects (years 2024-2035, defaults to now)
// ---------------------------------------------------------------------------
const claimYearSelect = document.getElementById("claimYear");
const claimMonthSelect = document.getElementById("claimMonth");

for (let y = 2024; y < 2036; y++) {
  const opt = document.createElement("option");
  opt.value = String(y);
  opt.textContent = String(y);
  claimYearSelect.appendChild(opt);
}
claimYearSelect.value = String(new Date().getFullYear());

MONTH_NAMES.forEach((m) => {
  const opt = document.createElement("option");
  opt.value = m;
  opt.textContent = m;
  claimMonthSelect.appendChild(opt);
});
claimMonthSelect.value = MONTH_NAMES[new Date().getMonth()];

// ---------------------------------------------------------------------------
// New Draft / Existing Draft mode toggle
// ---------------------------------------------------------------------------
let currentMode = "new_draft"; // or "existing_draft"
let hasPatientRecords = false;
let controlsRunning = false;

const workflowUi = {
  new_draft: {
    section: document.querySelector('[data-mode-section="new_draft"]'),
    fileLabel: document.getElementById("fileLabelNew"),
    sheetsLine: document.getElementById("sheetsLineNew"),
    patientsLine: document.getElementById("patientsLineNew"),
  },
  existing_draft: {
    section: document.querySelector('[data-mode-section="existing_draft"]'),
    fileLabel: document.getElementById("fileLabelExisting"),
    sheetsLine: document.getElementById("sheetsLineExisting"),
    patientsLine: document.getElementById("patientsLineExisting"),
  },
};
const uploadButtons = [...document.querySelectorAll(".draft-upload-btn")];
const modeToggleButtons = [...document.querySelectorAll(".mode-btn[data-mode-toggle]")];

function resetWorkflowCards() {
  Object.values(workflowUi).forEach((ui) => {
    ui.fileLabel.textContent = "No workbook selected";
    ui.sheetsLine.textContent = "—";
    ui.patientsLine.textContent = "0";
    ui.section.classList.remove("loaded");
  });
}

const MODE_HINTS = {
  new_draft:
    'Column A is an optional <strong>Draft Title</strong>; Column B is the patient\'s <strong>Member PIN</strong>.',
  existing_draft:
    'Column A of the template is the <strong>Transmittal No.</strong> of a draft that already exists in Beacon — this searches for it instead of creating one.',
};

// Keep the segmented toggle in step with currentMode.
function syncModeToggle() {
  modeToggleButtons.forEach((btn) => {
    const active = btn.dataset.modeToggle === currentMode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
}

// hasPatientRecords drives whether Start Automation is available, so every
// change goes through here to keep the button and its hint in sync.
function setHasPatientRecords(value) {
  hasPatientRecords = Boolean(value);
  updateStartState();
}

function setMode(mode) {
  if (!workflowUi[mode]) return;
  if (mode === currentMode) return;
  currentMode = mode;

  Object.entries(workflowUi).forEach(([key, ui]) => {
    const active = key === mode;
    ui.section.classList.toggle("active", active);
    ui.section.setAttribute("aria-current", active ? "step" : "false");
  });
  syncModeToggle();

  // A workbook uploaded for one mode has the wrong meaning in column A
  // for the other (Member PIN vs. Transmittal No.), so switching modes
  // clears whatever was loaded rather than leaving stale/misleading data.
  resetWorkflowCards();
  setHasPatientRecords(false);
  clearLog();
}
Object.entries(workflowUi).forEach(([mode, ui]) => {
  ui.section.classList.toggle("active", mode === currentMode);
  ui.section.setAttribute("aria-current", mode === currentMode ? "step" : "false");
});
syncModeToggle();

// Switching modes throws away the loaded workbook, so ask first when one is
// loaded. (Clear and the upload buttons call setMode directly — no prompt.)
function confirmModeSwitch(next) {
  const root = document.getElementById("modalRoot");
  const label = next === "new_draft" ? "New Draft" : "Existing Draft";
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box">
        <h3>Switch to ${label}?</h3>
        <p>Column A means something different in each workflow (Member PIN vs. Transmittal No.), so the loaded workbook will be cleared. You will need to upload a workbook for ${label}.</p>
        <div class="modal-actions">
          <button class="cyber-btn" id="modeSwitchCancelBtn" type="button">Keep current</button>
          <button class="solid-btn" id="modeSwitchConfirmBtn" type="button">Switch and clear</button>
        </div>
      </div>
    </div>`;
  const cancelBtn = document.getElementById("modeSwitchCancelBtn");
  cancelBtn.addEventListener("click", () => { root.innerHTML = ""; });
  document.getElementById("modeSwitchConfirmBtn").addEventListener("click", () => {
    root.innerHTML = "";
    setMode(next);
  });
  cancelBtn.focus();
}

modeToggleButtons.forEach((btn) => btn.addEventListener("click", () => {
  const next = btn.dataset.modeToggle;
  if (next === currentMode || controlsRunning) return;
  if (hasPatientRecords) {
    confirmModeSwitch(next);
  } else {
    setMode(next);
  }
}));

// ---------------------------------------------------------------------------
// Log panels
// ---------------------------------------------------------------------------
const summaryLogBox = document.getElementById("summaryLogPanel");
const detailsLogBox = document.getElementById("detailsLogPanel");
const logDrawer = document.getElementById("logDrawer");
const logDrawerToggle = document.getElementById("logDrawerToggle");
const logDrawerPreview = document.getElementById("logDrawerPreview");
let logBox = summaryLogBox;
let cf2RunActive = false;
let cf2LogStopTimer = null;
let lastDetailLine = "";
let lastDetailAt = 0;
let batchRecords = [];
let batchStatuses = new Map();
const copyTransmittalsBtn = document.getElementById("copyTransmittalsBtn");
const copyTransmittalsLabel = document.getElementById("copyTransmittalsLabel");
let copyFeedbackTimer = null;

// Collapsible automation-log drawer: the batch table stays visible above it.
function setLogDrawer(open) {
  logDrawer.classList.toggle("open", open);
  logDrawerToggle.setAttribute("aria-expanded", String(open));
  if (open) detailsLogBox.scrollTop = detailsLogBox.scrollHeight;
}
logDrawerToggle.addEventListener("click", () => {
  setLogDrawer(!logDrawer.classList.contains("open"));
});

function getTransmittalNumbers() {
  return batchRecords
    .map((record) => record.generated_transmittal || record.cf2?.transmittal || "")
    .map((value) => String(value).trim())
    .filter(Boolean);
}

function updateCopyTransmittalsButton() {
  copyTransmittalsBtn.disabled = getTransmittalNumbers().length === 0;
}

function log(text, level = "INFO", target = summaryLogBox) {
  const line = document.createElement("div");
  line.className = `log-line ${level}`;
  line.textContent = text;
  target.appendChild(line);
}

function clearLog() {
  summaryLogBox.innerHTML = "";
  detailsLogBox.innerHTML = "";
  logDrawerPreview.textContent = "";
  logDrawer.classList.remove("has-error");
  batchRecords = [];
  batchStatuses = new Map();
  updateCopyTransmittalsButton();
}

function scrollLogToEnd() {
  logBox.scrollTop = logBox.scrollHeight;
}

function detailLog(text, level = "INFO") {
  // Keep local HTTP access records and duplicated logger callbacks out of
  // the operator-facing sequence; they are transport noise, not CF2 steps.
  if (/^(?:127\.0\.0\.1|localhost)\s+-\s+-/.test(text)) return;
  const now = Date.now();
  if (text === lastDetailLine && now - lastDetailAt < 1000) return;
  lastDetailLine = text;
  lastDetailAt = now;
  log(text, level, detailsLogBox);
  detailsLogBox.scrollTop = detailsLogBox.scrollHeight;
  // Latest line stays visible in the drawer header while it is collapsed.
  logDrawerPreview.textContent = text;
  if (level === "ERROR") logDrawer.classList.add("has-error");
}

function statusLabel(status) {
  return {
    waiting: "Waiting",
    running: "Running",
    success: "Success",
    skipped: "Skipped",
    failed: "Failed",
  }[status] || "Waiting";
}

function currentBatchCounts() {
  const counts = { success: 0, skipped: 0, failed: 0 };
  batchStatuses.forEach((item) => {
    if (counts[item.status] !== undefined) counts[item.status] += 1;
  });
  return counts;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function updateBatchHeader(progress = null) {
  const card = document.getElementById("batchStatusCard");
  const title = document.getElementById("batchStatusTitle");
  const subtitle = document.getElementById("batchStatusSubtitle");
  const count = document.getElementById("batchCountPill");
  const totalValue = document.getElementById("cf2TotalValue");
  const successValue = document.getElementById("cf2SuccessValue");
  const warningValue = document.getElementById("cf2WarningValue");
  const errorValue = document.getElementById("cf2ErrorValue");
  if (!card || !title || !subtitle || !count) return;

  const total = batchRecords.length;
  const counts = currentBatchCounts();
  count.textContent = `${counts.success + counts.skipped + counts.failed}/${total} done`;
  if (totalValue) totalValue.textContent = total;
  if (successValue) successValue.textContent = counts.success;
  if (warningValue) warningValue.textContent = counts.skipped;
  if (errorValue) errorValue.textContent = counts.failed;

  if (!total) {
    card.classList.remove("running");
    title.textContent = "No workbook loaded";
    subtitle.textContent = "Upload an Excel file to preview the CF2 batch.";
    return;
  }

  if (progress && progress.status === "running") {
    card.classList.add("running");
    title.textContent = `Running ${progress.current || "-"} of ${progress.total || total}`;
    subtitle.textContent = `${progress.patient_name || "Current patient"} - ${progress.phase || "Processing"}`;
    return;
  }

  card.classList.remove("running");
  title.textContent = "Workbook ready";
  subtitle.textContent = `${total} patient${total === 1 ? "" : "s"} loaded. Start automation when ready.`;
}

function renderBatchTable(records) {
  batchRecords = records || [];
  batchStatuses = new Map(batchRecords.map((record) => [
    String(record.excel_row),
    { status: "waiting", phase: "" },
  ]));
  updateCopyTransmittalsButton();

  if (!batchRecords.length) {
    summaryLogBox.innerHTML = `<div class="batch-empty">Upload an Excel workbook to show the live CF2 batch table.</div>`;
    return;
  }

  const identifierHeader = escapeHtml(batchRecords[0].identifier_label || (currentMode === "existing_draft" ? "Transmittal No." : "Member PIN"));
  const showGeneratedTransmittal = currentMode === "new_draft";
  summaryLogBox.innerHTML = `
    <div class="batch-board">
      <div class="batch-status-card" id="batchStatusCard">
        <span class="batch-status-orb"></span>
        <div>
          <div class="batch-status-title" id="batchStatusTitle">Workbook ready</div>
          <div class="batch-status-subtitle" id="batchStatusSubtitle"></div>
        </div>
        <div class="batch-count-pill" id="batchCountPill">0/${batchRecords.length} done</div>
      </div>
      <div class="cf2-summary-strip">
        <div class="cf2-summary-stat">
          <div class="label">Total</div>
          <div class="value" id="cf2TotalValue">${batchRecords.length}</div>
        </div>
        <div class="cf2-summary-stat success">
          <div class="label">Success</div>
          <div class="value" id="cf2SuccessValue">0</div>
        </div>
        <div class="cf2-summary-stat warning">
          <div class="label">Warnings</div>
          <div class="value" id="cf2WarningValue">0</div>
        </div>
        <div class="cf2-summary-stat error">
          <div class="label">Errors</div>
          <div class="value" id="cf2ErrorValue">0</div>
        </div>
      </div>
      <div class="batch-table-wrap">
        <table class="batch-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>${identifierHeader}</th>
              ${showGeneratedTransmittal ? "<th>Transmittal No.</th>" : ""}
              <th>Patient Name</th>
            </tr>
          </thead>
          <tbody>
            ${batchRecords.map((record) => `
              <tr class="batch-row waiting" data-excel-row="${record.excel_row}">
                <td>
                  <span class="row-status"><span class="row-status-dot"></span><span class="row-status-text">Waiting</span></span>
                  <span class="batch-phase"></span>
                </td>
                <td title="${escapeHtml(record.identifier || "")}">${escapeHtml(record.identifier || "-")}</td>
                ${showGeneratedTransmittal ? `<td class="generated-transmittal" title=""></td>` : ""}
                <td title="${escapeHtml(record.patient_name || "")}">${escapeHtml(record.patient_name || "-")}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
  updateBatchHeader();
}

function updateBatchRow(progress) {
  if (!progress || !progress.excel_row) return;
  const rowKey = String(progress.excel_row);
  const status = progress.status || "waiting";
  batchStatuses.set(rowKey, { status, phase: progress.phase || "" });

  document.querySelectorAll(".batch-row.running").forEach((row) => {
    if (row.dataset.excelRow !== rowKey) row.classList.remove("running");
  });

  const row = summaryLogBox.querySelector(`.batch-row[data-excel-row="${rowKey}"]`);
  if (!row) return;

  row.className = `batch-row ${status}`;
  const statusText = row.querySelector(".row-status-text");
  const phaseText = row.querySelector(".batch-phase");
  const generatedTransmittalCell = row.querySelector(".generated-transmittal");
  if (statusText) statusText.textContent = statusLabel(status);
  if (phaseText) phaseText.textContent = progress.phase || progress.message || "";
  if (generatedTransmittalCell && progress.transmittal) {
    generatedTransmittalCell.textContent = progress.transmittal;
    generatedTransmittalCell.title = progress.transmittal;
  }
  if (progress.transmittal) {
    const record = batchRecords.find(
      (item) => String(item.excel_row) === rowKey
    );
    if (record) record.generated_transmittal = String(progress.transmittal);
    updateCopyTransmittalsButton();
  }
  row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  updateBatchHeader(progress);
}

function resetBatchRowsForRun() {
  batchStatuses = new Map(batchRecords.map((record) => [
    String(record.excel_row),
    { status: "waiting", phase: "" },
  ]));
  summaryLogBox.querySelectorAll(".batch-row").forEach((row) => {
    row.className = "batch-row waiting";
    const statusText = row.querySelector(".row-status-text");
    const phaseText = row.querySelector(".batch-phase");
    if (statusText) statusText.textContent = "Waiting";
    if (phaseText) phaseText.textContent = "";
  });
  updateBatchHeader();
}

// ---------------------------------------------------------------------------
// Optional raw server log hook for compatibility with older shells.
// ---------------------------------------------------------------------------
window.beabots?.onServerLog?.(({ level, line }) => {
  if (!cf2RunActive) return;
  detailLog(line, level === "error" ? "ERROR" : "INFO");
});

// ---------------------------------------------------------------------------
// Upload Excel File (same log format as analyze_workbook())
// ---------------------------------------------------------------------------
const webExcelInput = document.createElement("input");
webExcelInput.type = "file";
webExcelInput.accept = ".xlsx,.xls,.xlsm";
webExcelInput.hidden = true;
document.body.appendChild(webExcelInput);

async function handleWorkbookUpload(fileOrPath) {
  if (!fileOrPath) return;

  const isWebFile = fileOrPath instanceof File;
  const path = isWebFile ? fileOrPath.name : fileOrPath;
  const filename = isWebFile ? fileOrPath.name : path.split(/[\\/]/).pop();
  const activeWorkflow = workflowUi[currentMode];
  activeWorkflow.fileLabel.textContent = `Selected: ${filename}`;
  activeWorkflow.section.classList.remove("loaded");
  clearLog();
  // Nothing is runnable until this workbook has been parsed successfully.
  setHasPatientRecords(false);
  log("=========================================");
  log(" CF2");
  log("=========================================");
  log("");
  log(`Selected File:`);
  log(filename);
  log("");

  let result;
  try {
    if (isWebFile) {
      const formData = new FormData();
      formData.append("file", fileOrPath);
      formData.append("claim_year", claimYearSelect.value);
      formData.append("claim_month", claimMonthSelect.value);
      formData.append("mode", currentMode);
      const res = await fetch(`${API_BASE}/api/cf2/upload`, {
        method: "POST",
        body: formData,
      });
      result = await res.json();
    } else {
      result = await fetchJSON("/api/cf2/upload", {
        method: "POST",
        body: JSON.stringify({
          path,
          claim_year: claimYearSelect.value,
          claim_month: claimMonthSelect.value,
          mode: currentMode,
        }),
      });
    }
  } catch (error) {
    result = { error: `Unable to upload the workbook. ${error.message}` };
  }

  if (result.error) {
    log("");
    log("ERROR:");
    log(result.error);
    summaryLogBox.scrollTop = summaryLogBox.scrollHeight;
    return;
  }

  log("Workbook loaded successfully.");
  log("");
  log("Worksheets found:");
  result.sheets.forEach((s) => log(`   • ${s}`));
  log("");

  result.records.forEach((record, i) => {
    log(`Patient #${i + 1}`);
    log(`${record.identifier_label}: ${record.identifier}`);
    log(`Patient     : ${record.patient_name}`);
    if (currentMode === "new_draft") {
      log(`Draft Title : ${record.draft_title || "(generated from patient name and treatment dates)"}`);
    }
    log(`Doctor      : ${record.doctor}`);
    log(`Accred. No. : ${record.accreditation_no}`);
    log(`Dates       : ${record.treatment_dates_raw}`);
    log(`Time        : ${record.time_range_raw || "12:00 AM - 12:00 PM (default)"}`);
    log(`PX Contact  : ${record.px_contact_no || "Member mobile from CF1 API"}`);
    log(`Parsed Dates:`);
    record.parsed_dates.forEach((d) => log(`   ${d}`));

    if (record.first_treatment) {
      log(`First Date : ${record.first_treatment}`);
      log(`Last Date  : ${record.last_treatment}`);
      log(`Sessions   : ${record.total_sessions}`);
      log("");
      log("CF2 DATA");
      log(`Transmittal : ${record.cf2.transmittal}`);
      log(`Patient     : ${record.cf2.patient_name}`);
      log(`Doctor      : ${record.cf2.doctor}`);
      log(`Accred. No. : ${record.cf2.accreditation_no}`);
      log(`First Date  : ${record.cf2.first_treatment}`);
      log(`Last Date   : ${record.cf2.last_treatment}`);
      log(`Sessions    : ${record.cf2.total_sessions}`);
    }

    log("");
    log("");
    log("");
  });

  log("=========================================");
  log(`Patients Found : ${result.patient_count}`);
  log("=========================================");
  renderBatchTable(result.records);
  scrollLogToEnd();

  activeWorkflow.sheetsLine.textContent = `${result.sheets.length} · ${result.sheets.join(", ")}`;
  activeWorkflow.patientsLine.textContent = String(result.patient_count);
  setHasPatientRecords(result.patient_count > 0);
  // A loaded workbook shrinks the drop zone so Start Automation leads.
  activeWorkflow.section.classList.toggle("loaded", hasPatientRecords);
}

uploadButtons.forEach((uploadBtn) => uploadBtn.addEventListener("click", async () => {
  setMode(uploadBtn.dataset.mode);
  webExcelInput.value = "";
  webExcelInput.click();
}));

webExcelInput.addEventListener("change", async () => {
  await handleWorkbookUpload(webExcelInput.files?.[0]);
});

// Drag and drop onto the drop zone (same path as the file picker).
uploadButtons.forEach((uploadBtn) => {
  ["dragenter", "dragover"].forEach((type) => uploadBtn.addEventListener(type, (event) => {
    if (uploadBtn.disabled) return;
    event.preventDefault();
    uploadBtn.classList.add("dragover");
  }));
  ["dragleave", "dragend"].forEach((type) => uploadBtn.addEventListener(type, () => {
    uploadBtn.classList.remove("dragover");
  }));
  uploadBtn.addEventListener("drop", async (event) => {
    event.preventDefault();
    uploadBtn.classList.remove("dragover");
    if (uploadBtn.disabled) return;
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (!/\.(xlsx|xls|xlsm)$/i.test(file.name)) {
      showModal("Unsupported File", "Please drop an Excel workbook (.xlsx, .xls or .xlsm).");
      return;
    }
    setMode(uploadBtn.dataset.mode);
    await handleWorkbookUpload(file);
  });
});

// A file dropped outside the drop zone should never navigate the app away.
["dragover", "drop"].forEach((type) => window.addEventListener(type, (event) => {
  if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
}));

// ---------------------------------------------------------------------------
// Download Excel Template
// ---------------------------------------------------------------------------
let templateDownloadPending = false;

async function downloadCf2Template(mode = currentMode) {
  if (templateDownloadPending) return;
  templateDownloadPending = true;
  try {
    const url = `${API_BASE}/api/cf2/download-template?mode=${encodeURIComponent(mode)}`;
    window.location.href = url;
  } catch (error) {
    showModal("Error", `Unable to download template.\n\n${error.message}`);
  } finally {
    templateDownloadPending = false;
  }
}

document.querySelectorAll(".template-link[data-mode]").forEach((button) => {
  button.addEventListener("click", () => downloadCf2Template(button.dataset.mode));
});

// ---------------------------------------------------------------------------
// User Guide modal
// ---------------------------------------------------------------------------
const GUIDE_STEP_3 = {
  new_draft:
    "Add Member's pin (if dependent add slash at the end).\n" +
    "Only edit the patient information.\n" +
    "Do not change headers, column names,\n" +
    "column order or file format.\n" +
    "Only modify the data rows.",
  existing_draft:
    "Add the existing Transmittal No. for each patient.\n" +
    "The draft must already exist in Beacon — this template\n" +
    "does not create a new one, it only locates it.\n" +
    "Do not change headers, column names,\n" +
    "column order or file format.\n" +
    "Only modify the data rows.",
};

function buildGuideSteps(mode = currentMode) {
  return [
    [1, "📋", "Prepare the report from AR","The data will be used in the cf2 template \n" +
      "This Automation includes: Draft, CF2, Signatories and CF2 Preview."],
    [2, "⬇", "Download the Excel Template", "Click 'Download Excel Template'.\nUse the provided template."],
    [3, "🗂", "Edit the Template", GUIDE_STEP_3[mode]],
    [4, "⏷", "Use Excel Filters",
      "To speed up encoding, use Excel Filters.\n\n" +
      "• Doctor Name\n" +
      "• Accreditation Number\n\n" +
      "This helps populate multiple records consistently."],
    [5, "💾", "Save the File", "Save the completed workbook.\nRecommended:\nCF2_Claims_2026.xlsx"],
    [6, "⬆", "Upload the Workbook", "Return to this window.\nClick 'Upload Excel File'.\nSelect the saved workbook."],
    [7, "▶", "Start Automation",
      "Verify that the workbook loaded successfully,\n" +
      "patients detected and claims count are correct.\n" +
      "Then click 'Start Automation'."],
  ];
}

function buildCurrentGuideSteps(mode = currentMode) {
  const isNewDraft = mode === "new_draft";
  return [
    {
      title: "Set the claim period",
      description: "Select the correct claim year and month before uploading. These values are used to interpret every treatment date in the workbook.",
      note: "Changing the period requires uploading the workbook again.",
    },
    {
      title: "Choose the workflow mode",
      description: isNewDraft
        ? "Use New Draft when Beacon must create a new claim for each patient."
        : "Use Existing Draft when the claim is already in Beacon and must be located by transmittal number.",
      note: isNewDraft ? "Column A may contain a custom Draft Title; Column B must contain the Member PIN." : "Column A must contain the existing Transmittal No.",
    },
    {
      title: "Download the matching template",
      description: "Download the template from the matching workflow section. New Draft begins with an optional Draft Title; Existing Draft begins with its Transmittal No.",
      note: "Do not use the Existing Draft template for New Draft or vice versa.",
    },
    {
      title: isNewDraft ? "Complete the New Draft template" : "Complete the Existing Draft template",
      description: isNewDraft
        ? "Column A is an optional Draft Title, B is Member PIN, C is patient name, D is doctor, E is accreditation number, and F is treatment dates. Optional time and PX contact fields follow."
        : "Column A is the existing Transmittal No., B is patient name, C is doctor, D is accreditation number, and E is treatment dates. Optional time and PX contact fields follow.",
      note: isNewDraft
        ? "Draft Title is optional and limited to 50 characters. Leave it blank to generate the title from the patient name and treatment dates."
        : "Keep Sheet1, headers, column order, and file format unchanged.",
    },
    {
      title: "Upload and review the workbook",
      description: "Click Upload Excel File. Check the detected patient count, identifiers, doctor details, parsed dates, first and last treatment dates, and session totals in the execution log.",
      note: "Correct the workbook and upload it again if anything is wrong.",
    },
    {
      title: "Run, monitor, and verify",
      description: "Click Start Automation only after the uploaded data is correct. Monitor the execution log and final summary for successful, skipped, or failed records.",
      note: "Always verify the completed draft, CF2, signatories, and preview in Beacon.",
    },
  ];
}

document.querySelectorAll("[data-guide-mode]").forEach((button) => button.addEventListener("click", () => {
  const guideMode = button.dataset.guideMode;
  const stepsHtml = buildCurrentGuideSteps(guideMode).map((step, index) => `
    <div class="guide-step">
      <div class="guide-step-number">${index + 1}</div>
      <div class="step-title">${step.title}</div>
      <div class="step-desc">${step.description}</div>
      <div class="guide-step-note">${step.note}</div>
    </div>`).join("");

  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay guide-modal">
      <div class="modal-box">
        <h2>CF2 WORKFLOW GUIDE</h2>
        <div class="guide-intro">
          <span>Follow the steps for this workflow.</span>
          <span class="guide-mode-pill">${guideMode === "new_draft" ? "NEW DRAFT" : "EXISTING DRAFT"}</span>
        </div>
        <div class="guide-steps-grid">${stepsHtml}</div>
        <div class="modal-actions" style="justify-content: center; margin-top: 10px;">
          <button class="cyber-btn" id="guideOkBtn">OK</button>
        </div>
      </div>
    </div>`;
  document.getElementById("guideOkBtn").addEventListener("click", () => { root.innerHTML = ""; });
}));

// ---------------------------------------------------------------------------
// Start Automation (same worker flow as _run_automation_worker /
// _display_summary, reported over the cf2_done socket event)
// ---------------------------------------------------------------------------
const startBtn = document.getElementById("startBtn");
const startBtnLabel = document.getElementById("startBtnLabel");
const startHint = document.getElementById("startHint");
const clearBtn = document.getElementById("clearBtn");
const accountReceivableBtn = document.getElementById("accountReceivableBtn");
const accountReceivable = { name: "", designation: "", number: "" };
fetchJSON("/api/cf2/account-receivable").then((saved) => {
  accountReceivable.name = saved.name || "";
  accountReceivable.designation = saved.designation || "";
  accountReceivable.number = saved.number || "";
  const summary = document.getElementById("arSummary");
  summary.textContent = accountReceivable.name
    ? `${accountReceivable.name}${accountReceivable.designation ? ` / ${accountReceivable.designation}` : ""}`
    : "No details saved for this session.";
}).catch(() => {});
accountReceivableBtn.addEventListener("click", () => {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-box guide-modal">
        <h3>Account Receivable</h3>
        <div class="field-group"><label for="arName">Name</label><input id="arName" type="text" value="${escapeHtml(accountReceivable.name)}"></div>
        <div class="field-group"><label for="arDesignation">Designation</label><input id="arDesignation" type="text" value="${escapeHtml(accountReceivable.designation)}"></div>
        <div class="field-group"><label for="arNumber">Number</label><input id="arNumber" type="text" value="${escapeHtml(accountReceivable.number)}"></div>
        <div class="modal-actions" style="margin-top:18px">
          <button class="cyber-btn" id="arCancelBtn" type="button">Cancel</button>
          <button class="solid-btn" id="arSaveBtn" type="button">Save</button>
        </div>
      </div>
    </div>`;
  document.getElementById("arCancelBtn").addEventListener("click", () => { root.innerHTML = ""; });
  document.getElementById("arSaveBtn").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const values = {
      name: document.getElementById("arName").value.trim(),
      designation: document.getElementById("arDesignation").value.trim(),
      number: document.getElementById("arNumber").value.trim(),
    };
    try {
      const result = await fetchJSON("/api/cf2/account-receivable", {
        method: "POST",
        body: JSON.stringify(values),
      });
      if (result.error) throw new Error(result.error);
      Object.assign(accountReceivable, values);
    } catch (error) {
      button.disabled = false;
      showModal("Save Failed", `Unable to save account receivable details.\n\n${error.message}`);
      return;
    }
    const summary = document.getElementById("arSummary");
    summary.textContent = accountReceivable.name
      ? `${accountReceivable.name}${accountReceivable.designation ? ` / ${accountReceivable.designation}` : ""}`
      : "No details saved for this session.";
    root.innerHTML = "";
  });
});
let cf2StopRequested = false;

copyTransmittalsBtn.addEventListener("click", async () => {
  const transmittals = getTransmittalNumbers();
  if (!transmittals.length) return;

  try {
    await copyTextToClipboard(transmittals.join("\n"));
    if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
    copyTransmittalsBtn.classList.remove("copied");
    void copyTransmittalsBtn.offsetWidth;
    copyTransmittalsBtn.classList.add("copied");
    copyTransmittalsLabel.textContent = `Copied ${transmittals.length}!`;
    copyFeedbackTimer = setTimeout(() => {
      copyTransmittalsBtn.classList.remove("copied");
      copyTransmittalsLabel.textContent = "Copy Transmittal";
    }, 1600);
  } catch (error) {
    showModal("Copy Failed", "Unable to copy the transmittal numbers to the clipboard.");
  }
});

// Start is disabled until a workbook with patients is loaded, and the hint
// beside it says why (instead of the click silently doing nothing).
function updateStartState() {
  if (controlsRunning) {
    startBtn.disabled = false;
    startHint.textContent = cf2StopRequested
      ? "Stopping…"
      : "Running. Click Stop Automation to cancel.";
    return;
  }
  if (!hasPatientRecords) {
    startBtn.disabled = true;
    startHint.textContent = "Upload a workbook first.";
    return;
  }
  const count = batchRecords.length;
  startBtn.disabled = false;
  startHint.textContent = `${count} patient${count === 1 ? "" : "s"} ready to run.`;
}

function setControlsRunning(running) {
  controlsRunning = running;
  startBtnLabel.textContent = running
    ? (cf2StopRequested ? "Stopping..." : "Stop Automation")
    : "Start Automation";
  startBtn.classList.toggle("running", running);
  uploadButtons.forEach((button) => { button.disabled = running; });
  modeToggleButtons.forEach((button) => { button.disabled = running; });
  claimYearSelect.disabled = running;
  claimMonthSelect.disabled = running;
  clearBtn.disabled = running;
  updateStartState();
}

startBtn.addEventListener("click", async () => {
  if (cf2RunActive) {
    cf2StopRequested = true;
    setControlsRunning(true);
    await fetchJSON("/api/cf2/stop", { method: "POST" });
    return;
  }

  if (!hasPatientRecords) return; // matches: if len(patient_records) == 0: return

  if (cf2LogStopTimer) clearTimeout(cf2LogStopTimer);
  cf2RunActive = true;
  cf2StopRequested = false;
  detailsLogBox.innerHTML = "";
  logDrawerPreview.textContent = "";
  logDrawer.classList.remove("has-error");
  setLogDrawer(true);
  lastDetailLine = "";
  lastDetailAt = 0;
  resetBatchRowsForRun();
  updateBatchHeader({
    status: "running",
    current: 0,
    total: batchRecords.length,
    phase: "Starting automation",
  });
  summaryLogBox.scrollTop = summaryLogBox.scrollHeight;
  setControlsRunning(true);

  const result = await fetchJSON("/api/cf2/start", {
    method: "POST",
    body: JSON.stringify({
      account_receivable_name: accountReceivable.name,
      account_receivable_designation: accountReceivable.designation,
      account_receivable_number: accountReceivable.number,
    }),
  });
  if (result.error) {
    log("");
    log(`ERROR: ${result.error}`);
    if (result.requires_beacon) {
      showBeaconRequired(result.error);
    }
    scrollLogToEnd();
    setControlsRunning(false);
    cf2RunActive = false;
    cf2StopRequested = false;
  }
});

clearBtn.addEventListener("click", () => {
  if (cf2RunActive) return;
  setMode("new_draft");
  resetWorkflowCards();
  claimYearSelect.value = String(new Date().getFullYear());
  claimMonthSelect.value = MONTH_NAMES[new Date().getMonth()];
  clearLog();
  setHasPatientRecords(false);
  setLogDrawer(false);
  updateBatchHeader();
});

// ---------------------------------------------------------------------------
// Socket.IO — live logs during the run, plus the final summary block
// (verbatim format from _display_summary)
// ---------------------------------------------------------------------------
const socket = io(API_BASE);

socket.on("log", (data) => {
  if (!cf2RunActive) return;
  detailLog(data.message, data.level || "INFO");
});

socket.on("cf2_progress", (data) => {
  if (!cf2RunActive) return;
  updateBatchRow(data);
});

socket.on("cf2_done", (data) => {
  const results = data.results || [];

  if (results.length > 0) {
    results.forEach((result, index) => {
      const record = batchRecords[index];
      if (!record) return;
      updateBatchRow({
        excel_row: record.excel_row,
        status: result.status,
        phase: result.status === "success" ? "Completed" : result.message,
        transmittal: result.transmittal,
      });
    });
    updateBatchHeader();

    summaryLogBox.scrollTop = summaryLogBox.scrollHeight;
  }

  if (data?.stopped) {
    detailLog("Automation stopped by user.", "WARNING");
  }

  setControlsRunning(false);
  cf2StopRequested = false;
  // stdout and Socket.IO travel over separate channels. Keep a short grace
  // period so final buffered CF2 lines arrive, then detach this panel from
  // the shared stream before SOA or CF4 starts.
  cf2LogStopTimer = setTimeout(() => {
    cf2RunActive = false;
    cf2LogStopTimer = null;
  }, 1200);
});

async function restoreCf2Status() {
  try {
    const response = await fetchJSON("/api/cf2/status");
    const run = response.run;
    if (!run?.records?.length) return;

    if (run.mode && run.mode !== currentMode) setMode(run.mode);
    renderBatchTable(run.records);
    const progress = Object.values(run.progress || {});
    progress.forEach(updateBatchRow);
    const activeWorkflow = workflowUi[currentMode];
    activeWorkflow.patientsLine.textContent = String(run.records.length);
    activeWorkflow.section.classList.add("loaded");
    setHasPatientRecords(true);
    cf2RunActive = Boolean(run.running);
    setControlsRunning(cf2RunActive);

    if (run.running) {
      setLogDrawer(true);
      updateBatchHeader({
        status: "running",
        current: run.current,
        total: run.total || run.records.length,
        patient_name: progress.find((item) => item.status === "running")?.patient_name,
        phase: progress.find((item) => item.status === "running")?.phase || "Processing",
      });
      detailLog("Reconnected to the running CF2 automation. Earlier detail logs are not retained.", "INFO");
    } else if (run.done) {
      detailLog(run.message || "CF2 automation finished.", run.failed ? "WARNING" : "INFO");
      updateBatchHeader();
    }
  } catch (error) {
    console.error("Could not restore CF2 status.", error);
  }
}

socket.on("connect", restoreCf2Status);
restoreCf2Status();

// Initial state: Start stays disabled until a workbook is loaded.
updateStartState();
