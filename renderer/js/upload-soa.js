/*
 * Upload SOA browser UI logic.
 * Depends on common.js for shared fetch, modal, and navigation helpers.
 */

// ---------------------------------------------------------------------------
// SOA files (drop zone + picker + selected-file list)
// ---------------------------------------------------------------------------
const browseBtn = document.getElementById("browseBtn");
const soaFilesCard = document.getElementById("soaFilesCard");
const soaFileList = document.getElementById("soaFileList");
const soaFileSummary = document.getElementById("soaFileSummary");
const webSoaInput = document.createElement("input");
webSoaInput.type = "file";
webSoaInput.accept = ".xlsx,.xls";
webSoaInput.multiple = true;
webSoaInput.hidden = true;
document.body.appendChild(webSoaInput);
let selectedSoaFiles = [];
let controlsRunning = false;

const SOA_FILE_ICON = '<span class="icon-flat"><svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg></span>';

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderSoaFiles() {
  const n = selectedSoaFiles.length;
  soaFileSummary.textContent = n
    ? `${n} SOA Excel file${n === 1 ? "" : "s"} selected`
    : "No SOA Excel files selected";
  soaFilesCard.classList.toggle("loaded", n > 0);
  soaFileList.innerHTML = selectedSoaFiles.map((file, index) => `
    <li class="soa-file">
      ${SOA_FILE_ICON}
      <span class="soa-file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      <span class="soa-file-size">${formatFileSize(file.size)}</span>
      <button class="soa-file-remove" type="button" data-index="${index}" aria-label="Remove ${escapeHtml(file.name)}">&times;</button>
    </li>`).join("");
  updateRunState();
}

function updateSoaSelection(files) {
  selectedSoaFiles = files;
  renderSoaFiles();
}

browseBtn.addEventListener("click", () => {
  webSoaInput.value = "";
  webSoaInput.click();
});

webSoaInput.addEventListener("change", () => {
  if (webSoaInput.files?.length) updateSoaSelection([...webSoaInput.files]);
});

// Drag and drop onto the drop zone replaces the selection, same as the picker.
function acceptDroppedSoaFiles(fileList) {
  const all = [...fileList];
  const valid = all.filter((file) => /\.(xlsx|xls)$/i.test(file.name));
  if (!valid.length) {
    showModal("Unsupported Files", "Please drop SOA Excel files (.xlsx or .xls).");
    return;
  }
  updateSoaSelection(valid);
  if (valid.length < all.length) {
    const skipped = all.length - valid.length;
    showModal("Some Files Skipped", `${skipped} item${skipped === 1 ? " was" : "s were"} not an Excel workbook (.xlsx or .xls) and ${skipped === 1 ? "was" : "were"} skipped.`);
  }
}

["dragenter", "dragover"].forEach((type) => browseBtn.addEventListener(type, (event) => {
  if (browseBtn.disabled) return;
  event.preventDefault();
  browseBtn.classList.add("dragover");
}));
["dragleave", "dragend"].forEach((type) => browseBtn.addEventListener(type, () => {
  browseBtn.classList.remove("dragover");
}));
browseBtn.addEventListener("drop", (event) => {
  event.preventDefault();
  browseBtn.classList.remove("dragover");
  if (browseBtn.disabled) return;
  const files = event.dataTransfer?.files;
  if (files?.length) acceptDroppedSoaFiles(files);
});

// A file dropped outside the drop zone should never navigate the app away.
["dragover", "drop"].forEach((type) => window.addEventListener(type, (event) => {
  if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
}));

// Remove a single file from the selection.
soaFileList.addEventListener("click", (event) => {
  const button = event.target.closest(".soa-file-remove");
  if (!button || soaRunActive) return;
  const index = Number(button.dataset.index);
  updateSoaSelection(selectedSoaFiles.filter((_, i) => i !== index));
});

// ---------------------------------------------------------------------------
// Transmittal textarea + count label
// ---------------------------------------------------------------------------
const transmittalsInput = document.getElementById("transmittalsInput");
const countLabel = document.getElementById("countLabel");

function getTransmittals() {
  return transmittalsInput.value.split("\n").map((l) => l.trim()).filter(Boolean);
}

function updateCount() {
  const n = getTransmittals().length;
  countLabel.textContent = `${n} transmittal${n !== 1 ? "s" : ""}`;
}

// While nothing is running, the queue table mirrors the textarea so the
// operator can review the batch before starting. Results from a finished run
// stay on screen until the list of transmittals actually changes.
function previewTransmittals() {
  if (soaRunActive) return;
  const list = getTransmittals();
  const current = soaRows.map((row) => row.transmittal);
  if (current.length === list.length && current.every((value, i) => value === list[i])) return;
  setSoaRows(list);
  soaSummary = { running: false, total: list.length, success: 0, warning: 0, error: 0 };
  renderSummary();
}

// "input" also catches paste and drag-text, which keyup alone would miss.
transmittalsInput.addEventListener("input", () => {
  updateCount();
  previewTransmittals();
  updateRunState();
});

// ---------------------------------------------------------------------------
// Log box — colored by explicit level, same as upload_soa_window.py's
// log_to_ui(message, level): tag = level if level in LOG_LEVEL_COLORS else None
// ---------------------------------------------------------------------------
const summaryLogPanel = document.getElementById("summaryLogPanel");
const automationLogPanel = document.getElementById("automationLogPanel");
const logDrawer = document.getElementById("logDrawer");
const logDrawerToggle = document.getElementById("logDrawerToggle");
const logDrawerPreview = document.getElementById("logDrawerPreview");
const KNOWN_LEVELS = ["SUCCESS", "WARNING", "ERROR", "INFO"];
let soaSummary = {
  running: false,
  total: 0,
  success: 0,
  warning: 0,
  error: 0,
};
let soaRows = [];
let currentProcessingIndex = 0;
let soaRunActive = false;

// Collapsible automation-log drawer: the queue table stays visible above it.
function setLogDrawer(open) {
  logDrawer.classList.toggle("open", open);
  logDrawerToggle.setAttribute("aria-expanded", String(open));
  if (open) automationLogPanel.scrollTop = automationLogPanel.scrollHeight;
}
logDrawerToggle.addEventListener("click", () => {
  setLogDrawer(!logDrawer.classList.contains("open"));
});

function statusLabel(status) {
  return {
    waiting: "Waiting",
    running: "Running",
    success: "Success",
    skipped: "Skipped",
    failed: "Failed",
  }[status] || "Waiting";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function writeLog(message, level) {
  const line = document.createElement("div");
  line.className = KNOWN_LEVELS.includes(level) ? `log-line ${level}` : "log-line";
  line.textContent = message;
  automationLogPanel.appendChild(line);
  automationLogPanel.scrollTop = automationLogPanel.scrollHeight;
  // Latest line stays visible in the drawer header while it is collapsed.
  if (String(message || "").trim()) logDrawerPreview.textContent = message;
  if (level === "ERROR") logDrawer.classList.add("has-error");
  updateSummaryFromLog(message, level);
}

function clearLog() {
  automationLogPanel.innerHTML = "";
  logDrawerPreview.textContent = "";
  logDrawer.classList.remove("has-error");
  soaSummary = {
    running: false,
    total: 0,
    success: 0,
    warning: 0,
    error: 0,
  };
  currentProcessingIndex = 0;
  renderSummary();
}

const SOA_EMPTY_STATE = `
  <div class="soa-empty">
    <span class="es-icon icon-flat"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M9 10v10"/></svg></span>
    <div class="es-title">No transmittals queued</div>
    <p class="es-sub">Each transmittal gets its own row here so you can follow the upload one by one.</p>
    <ol class="es-steps">
      <li><span>1</span>Add the SOA Excel files</li>
      <li><span>2</span>Paste the transmittal numbers</li>
      <li><span>3</span>Start the upload</li>
    </ol>
  </div>`;

function renderSummary() {
  if (!soaRows.length && !soaSummary.total && !soaSummary.running) {
    summaryLogPanel.innerHTML = SOA_EMPTY_STATE;
    return;
  }
  const status = soaSummary.running ? "SOA upload is running." : "SOA upload is ready.";
  const done = soaSummary.success + soaSummary.warning + soaSummary.error;
  const detail = soaSummary.total
    ? (done || soaSummary.running
      ? `${done}/${soaSummary.total} result line${done === 1 ? "" : "s"} captured.`
      : `${soaSummary.total} transmittal${soaSummary.total === 1 ? "" : "s"} queued.`)
    : "Enter transmittals and start automation.";
  const rows = soaRows.map((row, index) => `
    <tr class="soa-status-row ${row.status}" data-index="${index}">
      <td class="soa-idx">${index + 1}</td>
      <td>
        <span class="soa-row-status">
          <span class="soa-row-dot"></span>
          <span>${statusLabel(row.status)}</span>
        </span>
      </td>
      <td title="${escapeHtml(row.transmittal)}">${escapeHtml(row.transmittal)}</td>
    </tr>
  `).join("");
  summaryLogPanel.innerHTML = `
    <div class="soa-summary">
      <div class="soa-summary-strip">
        <div class="soa-summary-stat">
          <div class="label">Total</div>
          <div class="value">${soaSummary.total}</div>
        </div>
        <div class="soa-summary-stat success">
          <div class="label">Success</div>
          <div class="value">${soaSummary.success}</div>
        </div>
        <div class="soa-summary-stat warning">
          <div class="label">Warnings</div>
          <div class="value">${soaSummary.warning}</div>
        </div>
        <div class="soa-summary-stat error">
          <div class="label">Errors</div>
          <div class="value">${soaSummary.error}</div>
        </div>
      </div>
      <div class="soa-summary-status">${status} ${detail}</div>
      <div class="soa-status-table-wrap">
        <table class="soa-status-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Status</th>
              <th>Transmittal</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr class="soa-status-row waiting"><td class="soa-idx">-</td><td><span class="soa-row-status"><span class="soa-row-dot"></span><span>Ready</span></span></td><td>No transmittals loaded.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;
  summaryLogPanel.scrollTop = summaryLogPanel.scrollHeight;
}

function setSoaRows(transmittals) {
  soaRows = transmittals.map((transmittal) => ({
    transmittal,
    status: "waiting",
  }));
  currentProcessingIndex = 0;
}

function updateSoaRow(index, status) {
  if (index < 0 || index >= soaRows.length) return;
  soaRows.forEach((row, rowIndex) => {
    if (row.status === "running" && rowIndex !== index) {
      row.status = "waiting";
    }
  });
  soaRows[index].status = status;
  renderSummary();
  const row = summaryLogPanel.querySelector(`.soa-status-row[data-index="${index}"]`);
  if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderFinalSummary(results) {
  const normalized = (results || []).map((item) => ({
    transmittal: item.transmittal || "-",
    status: String(item.status || "failed").toLowerCase(),
    message: item.message || "",
  }));
  const resultByTransmittal = new Map(normalized.map((item) => [String(item.transmittal), item.status]));
  soaRows = soaRows.map((row) => ({
    ...row,
    status: resultByTransmittal.get(String(row.transmittal)) || row.status,
  }));
  soaSummary.running = false;
  soaSummary.total = normalized.length || soaSummary.total;
  soaSummary.success = normalized.filter((item) => item.status === "success").length;
  soaSummary.warning = normalized.filter((item) => item.status === "skipped").length;
  soaSummary.error = normalized.filter((item) => item.status === "failed").length;
  renderSummary();
}

function updateSummaryFromLog(message, level = "INFO") {
  const text = String(message || "");
  const processingMatch = text.match(/PROCESSING TRANSMITTAL\s+(\d+)\/(\d+)/i);

  if (processingMatch) {
    currentProcessingIndex = Number(processingMatch[1]) - 1;
    updateSoaRow(currentProcessingIndex, "running");
    return;
  }

  const successMatch = text.match(/TRANSMITTAL SUCCESS:\s*'([^']+)'/i);
  const skippedMatch = text.match(/Transmittal\s+'([^']+)'\s+was skipped\./i);
  const failedMatch = text.match(/Transmittal\s+'([^']+)'\s+FAILED\s+after/i);
  const terminalMatch = successMatch || skippedMatch || failedMatch;
  if (!terminalMatch) return;

  const transmittal = terminalMatch[1];
  const rowIndex = soaRows.findIndex(
    (row) => String(row.transmittal) === String(transmittal)
  );
  if (rowIndex < 0) return;

  soaRows[rowIndex].status = successMatch
    ? "success"
    : skippedMatch
      ? "skipped"
      : "failed";
  soaSummary.success = soaRows.filter((row) => row.status === "success").length;
  soaSummary.warning = soaRows.filter((row) => row.status === "skipped").length;
  soaSummary.error = soaRows.filter((row) => row.status === "failed").length;
  renderSummary();
}

// ---------------------------------------------------------------------------
// Automate Upload button — same validation order as start_soa_automation()
// ---------------------------------------------------------------------------
const automateBtn = document.getElementById("automateBtn");
const automateBtnLabel = document.getElementById("automateBtnLabel");
const automateHint = document.getElementById("automateHint");
const clearBtn = document.getElementById("clearBtn");
let soaStopRequested = false;

// The button stays disabled until both inputs exist, and the hint beside it
// says what is missing (the click handler keeps its own validation as well).
function updateRunState() {
  if (controlsRunning) {
    automateBtn.disabled = false;
    automateHint.textContent = soaStopRequested
      ? "Stopping…"
      : "Running. Click Stop Automation to cancel.";
    return;
  }
  const fileCount = selectedSoaFiles.length;
  const transmittalCount = getTransmittals().length;
  if (!fileCount && !transmittalCount) {
    automateBtn.disabled = true;
    automateHint.textContent = "Add SOA files and transmittal numbers to begin.";
  } else if (!fileCount) {
    automateBtn.disabled = true;
    automateHint.textContent = "Add the SOA Excel files.";
  } else if (!transmittalCount) {
    automateBtn.disabled = true;
    automateHint.textContent = "Enter at least one transmittal number.";
  } else {
    automateBtn.disabled = false;
    automateHint.textContent = `${fileCount} file${fileCount === 1 ? "" : "s"} · ${transmittalCount} transmittal${transmittalCount === 1 ? "" : "s"} ready.`;
  }
}

function setControlsRunning(running) {
  controlsRunning = running;
  transmittalsInput.disabled = running;
  automateBtn.classList.toggle("running", running);
  automateBtnLabel.textContent = running
    ? (soaStopRequested ? "Stopping..." : "Stop Automation")
    : "Upload & Generate";
  browseBtn.disabled = running;
  soaFileList.classList.toggle("locked", running);
  clearBtn.disabled = running;
  updateRunState();
}

automateBtn.addEventListener("click", async () => {
  if (soaRunActive) {
    soaStopRequested = true;
    setControlsRunning(true);
    await fetchJSON("/api/soa/stop", { method: "POST" });
    return;
  }

  const transmittals = getTransmittals();

  if (transmittals.length === 0) {
    showModal("No Transmittals", "Please enter at least one transmittal number.");
    return;
  }

  if (selectedSoaFiles.length === 0) {
    showModal("No SOA Files", "Please upload the SOA Excel files for this batch.");
    return;
  }

  setControlsRunning(true);
  clearLog();
  setSoaRows(transmittals);
  soaRunActive = true;
  soaStopRequested = false;
  soaSummary.running = true;
  soaSummary.total = transmittals.length;
  renderSummary();
  setLogDrawer(true);
  writeLog(`Starting SOA upload for ${transmittals.length} transmittal(s)...`);

  const formData = new FormData();
  formData.append("transmittals", transmittals.join("\n"));
  selectedSoaFiles.forEach((file) => formData.append("soa_files", file));
  let result;
  try {
    const res = await fetch(`${API_BASE}/api/soa/start`, { method: "POST", body: formData });
    result = await res.json();
  } catch (error) {
    result = { error: `Unable to start the SOA upload. ${error.message}` };
  }

  if (result.error) {
    if (result.requires_beacon) {
      showBeaconRequired(result.error);
    } else {
      showModal("Error", result.error);
    }
    soaRunActive = false;
    soaStopRequested = false;
    soaSummary.running = false;
    renderSummary();
    setControlsRunning(false);
  }
});

clearBtn.addEventListener("click", () => {
  if (soaRunActive) return;
  transmittalsInput.value = "";
  selectedSoaFiles = [];
  webSoaInput.value = "";
  setSoaRows([]);
  clearLog();
  updateCount();
  renderSoaFiles();
  setLogDrawer(false);
});

// ---------------------------------------------------------------------------
// Socket.IO — live log stream + completion
// ---------------------------------------------------------------------------
const socket = io(API_BASE);

socket.on("log", (data) => {
  if (!soaRunActive) return;
  writeLog(data.message, data.level);
});

socket.on("soa_done", (data) => {
  renderFinalSummary(data?.results || []);
  if (data?.stopped) {
    writeLog("Automation stopped by user.", "WARNING");
  }
  soaRunActive = false;
  soaStopRequested = false;
  setControlsRunning(false);
});

function applySoaProgress(progress) {
  const suggestedIndex = Number(progress?.current) - 1;
  const index = soaRows[suggestedIndex]
    && String(soaRows[suggestedIndex].transmittal) === String(progress?.transmittal)
    ? suggestedIndex
    : soaRows.findIndex((row) => String(row.transmittal) === String(progress?.transmittal));
  if (index < 0) return;
  currentProcessingIndex = Math.max(0, Number(progress.current) - 1);
  updateSoaRow(index, progress.status || "waiting");
}

async function restoreSoaStatus() {
  try {
    const response = await fetchJSON("/api/soa/status");
    const run = response.run;
    if (!run?.transmittals?.length) return;

    transmittalsInput.value = run.transmittals.join("\n");
    updateCount();
    setSoaRows(run.transmittals);
    soaSummary.running = Boolean(run.running);
    soaSummary.total = run.total || run.transmittals.length;
    Object.values(run.progress || {}).forEach(applySoaProgress);
    soaSummary.success = soaRows.filter((row) => row.status === "success").length;
    soaSummary.warning = soaRows.filter((row) => row.status === "skipped").length;
    soaSummary.error = soaRows.filter((row) => row.status === "failed").length;
    soaRunActive = Boolean(run.running);
    setControlsRunning(soaRunActive);
    renderSummary();

    if (run.running) {
      setLogDrawer(true);
      writeLog("Reconnected to the running SOA upload. Earlier detail logs are not retained.", "INFO");
    } else if (run.done) {
      writeLog(run.message || "SOA upload finished.", run.failed ? "WARNING" : "INFO");
    }
  } catch (error) {
    console.error("Could not restore SOA status.", error);
  }
}

socket.on("soa_progress", applySoaProgress);
socket.on("connect", restoreSoaStatus);

// Initial state
renderSummary();
updateCount();
renderSoaFiles();
restoreSoaStatus();
