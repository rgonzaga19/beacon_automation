const picker = document.getElementById("folderPicker");
const folderPath = document.getElementById("folderPath");
const transmittals = document.getElementById("transmittals");
const logs = document.getElementById("logs");
const startButton = document.getElementById("startUpload");
const startLabel = document.getElementById("startLabel");
const logDrawer = document.getElementById("logDrawer");
const logToggle = document.getElementById("logToggle");
const logPreview = document.getElementById("logPreview");
const queueBox = document.getElementById("queueBox");
let selectedFiles = [];
let running = false;
let starting = false;
const queue = new Map(); // transmittal -> { status, detail }

// ---- Log: one-line ticker in the action bar + drawer over the table ----
function setLogDrawer(open) {
  logDrawer.classList.toggle("open", open);
  logToggle.setAttribute("aria-expanded", String(open));
  if (open) logs.scrollTop = logs.scrollHeight;
}
logToggle.addEventListener("click", () => setLogDrawer(!logDrawer.classList.contains("open")));
document.getElementById("logPopClose").addEventListener("click", () => { setLogDrawer(false); logToggle.focus(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && logDrawer.classList.contains("open")) setLogDrawer(false);
});
function clearLogUi() {
  logs.innerHTML = "";
  logPreview.textContent = "";
  logDrawer.classList.remove("has-lines", "has-error");
}

// ---- Queue table (one row per transmittal) ----
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
function normalizeStatus(value) {
  const status = String(value || "").toLowerCase();
  return ["running", "success", "failed", "skipped"].includes(status) ? status : "waiting";
}
function setQueueStatus(transmittal, status, detail = "") {
  queue.set(String(transmittal), { status: normalizeStatus(status), detail });
}
const STATUS_LABEL = { waiting: "Waiting", running: "Running", success: "Uploaded", skipped: "Skipped", failed: "Failed" };
const QUEUE_EMPTY = `
  <div class="queue-empty">
    <span class="es-icon icon-flat"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M9 10v10"/></svg></span>
    <div class="es-title">No transmittals queued</div>
    <p class="es-sub">Each transmittal gets its own row here so you can follow the upload one by one.</p>
    <ol class="es-steps"><li><span>1</span>Choose the patient folder</li><li><span>2</span>Paste the transmittal numbers</li><li><span>3</span>Start the upload</li></ol>
  </div>`;
function renderQueue() {
  const list = transmittalList();
  if (!list.length) { queueBox.innerHTML = QUEUE_EMPTY; return; }
  const rows = list.map((number) => ({ number, ...(queue.get(number) || { status: "waiting", detail: "" }) }));
  const count = (status) => rows.filter((row) => row.status === status).length;
  const done = rows.filter((row) => ["success", "skipped", "failed"].includes(row.status)).length;
  const statusText = running
    ? `Upload is running. ${done}/${rows.length} transmittal${rows.length === 1 ? "" : "s"} processed.`
    : done === 0
      ? `${rows.length} transmittal${rows.length === 1 ? "" : "s"} queued. Start the upload when ready.`
      : `Upload ${done === rows.length ? "finished" : "stopped"}. ${done}/${rows.length} transmittal${rows.length === 1 ? "" : "s"} processed.`;
  queueBox.innerHTML = `
    <div class="queue">
      <div class="queue-strip">
        <div class="queue-stat"><div class="label">Total</div><div class="value">${rows.length}</div></div>
        <div class="queue-stat success"><div class="label">Uploaded</div><div class="value">${count("success")}</div></div>
        <div class="queue-stat warning"><div class="label">Skipped</div><div class="value">${count("skipped")}</div></div>
        <div class="queue-stat error"><div class="label">Failed</div><div class="value">${count("failed")}</div></div>
      </div>
      <div class="queue-status">${statusText}</div>
      <div class="queue-table-wrap"><table class="queue-table">
        <thead><tr><th>Status</th><th>Transmittal</th><th>Details</th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr class="queue-row ${row.status}">
            <td><span class="row-status"><span class="row-dot"></span><span>${STATUS_LABEL[row.status]}</span></span></td>
            <td title="${escapeHtml(row.number)}">${escapeHtml(row.number)}</td>
            <td class="detail" title="${escapeHtml(row.detail)}">${escapeHtml(row.detail)}</td>
          </tr>`).join("")}</tbody>
      </table></div>
    </div>`;
  queueBox.querySelector(".queue-row.running")?.scrollIntoView({ block: "nearest" });
}

// ---- Ticker idle hint: says what is missing before a run ----
function updateReadyHint() {
  const hint = document.getElementById("readyHint");
  const count = transmittalList().length;
  document.getElementById("folderBox").classList.toggle("filled", selectedFiles.length > 0);
  document.getElementById("browseLabel").textContent = selectedFiles.length ? "Change folder" : "Choose parent folder";
  if (!selectedFiles.length && !count) hint.textContent = "Choose the patient folder and enter transmittal numbers.";
  else if (!selectedFiles.length) hint.textContent = "Choose the patient document folder.";
  else if (!count) hint.textContent = "Enter at least one transmittal number.";
  else hint.textContent = `${count} transmittal${count === 1 ? "" : "s"} · ${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"} ready.`;
}

function log(message, level = "INFO") {
  const line = document.createElement("div");
  line.className = level;
  line.textContent = message;
  logs.appendChild(line);
  logs.scrollTop = logs.scrollHeight;
  // Latest line stays visible in the ticker while the drawer is closed.
  if (String(message || "").trim()) {
    logPreview.textContent = message;
    logDrawer.classList.add("has-lines");
  }
  if (level === "ERROR") logDrawer.classList.add("has-error");
}

function transmittalList() {
  return [...new Set(transmittals.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
}

function setRunning(value) {
  running = value;
  startLabel.textContent = value ? "Stop upload" : "Start upload";
  startButton.disabled = starting;
  document.getElementById("browseFolder").disabled = value;
  document.getElementById("clear").disabled = value;
  transmittals.disabled = value;
  renderQueue();
}

document.getElementById("browseFolder").addEventListener("click", () => picker.click());
picker.addEventListener("change", () => {
  selectedFiles = [...picker.files].filter((file) => file.webkitRelativePath);
  const rootName = selectedFiles[0]?.webkitRelativePath.split("/")[0] || "";
  folderPath.value = selectedFiles.length ? `${rootName} (${selectedFiles.length} files)` : "";
  folderPath.title = rootName;
  updateReadyHint();
});
transmittals.addEventListener("input", () => {
  const count = transmittalList().length;
  document.getElementById("count").textContent = `${count} transmittal${count === 1 ? "" : "s"}`;
  renderQueue();
  updateReadyHint();
});

startButton.addEventListener("click", async () => {
  if (running) {
    try {
      const result = await fetchJSON("/api/documents/stop", { method: "POST" });
      if (result.stopped) {
        log("Stop requested. Finishing the active Beacon request, then stopping.", "WARNING");
        startLabel.textContent = "Stopping...";
        startButton.disabled = true;
      } else {
        log("No active document upload was found to stop.", "WARNING");
        setRunning(false);
      }
    } catch (error) {
      log(`Stop request failed: ${error.message}`, "ERROR");
    }
    return;
  }
  const numbers = transmittalList();
  if (!numbers.length) return showModal("No Transmittals", "Enter at least one transmittal number.");
  if (!selectedFiles.length) return showModal("No Folder", "Choose the parent folder containing the patient folders.");
  const supported = selectedFiles.filter((file) => /\.(pdf|jpe?g|png|tiff?)$/i.test(file.name));
  if (!supported.length) return showModal("No Documents", "The selected folder contains no PDF or image documents.");
  if (supported.some((file) => file.size > 2 * 1024 * 1024)) return showModal("Document Too Large", "Beacon allows a maximum of 2 MB per document.");

  clearLogUi();
  queue.clear();
  log(`Starting upload for ${numbers.length} transmittal(s) and ${supported.length} supported file(s)...`);
  starting = true;
  setRunning(true);
  const form = new FormData();
  form.append("transmittals", numbers.join("\n"));
  form.append("relative_paths", JSON.stringify(supported.map((file) => file.webkitRelativePath)));
  supported.forEach((file) => form.append("documents", file, file.name));
  try {
    const response = await fetch(`${API_BASE}/api/documents/start`, { method: "POST", body: form });
    const result = await response.json();
    if (!response.ok || result.error) {
      if (result.existing_documents?.length) {
        showModal("Documents Already Uploaded", result.error);
      }
      throw new Error(result.error || "Could not start document upload.");
    }
    starting = false;
    startButton.disabled = false;
  } catch (error) {
    starting = false;
    log(error.message, "ERROR");
    setRunning(false);
  }
});

document.getElementById("clear").addEventListener("click", () => {
  if (running) return;
  selectedFiles = [];
  picker.value = "";
  folderPath.value = "";
  transmittals.value = "";
  document.getElementById("count").textContent = "0 transmittals";
  clearLogUi();
  queue.clear();
  setLogDrawer(false);
  renderQueue();
  updateReadyHint();
  fetchJSON("/api/documents/status", { method: "DELETE" }).catch(() => {});
});

const socket = io(API_BASE);
socket.on("documents_log", (data) => log(data.message || "", data.level || "INFO"));
function applyDocumentProgress(progress) {
  if (!progress?.transmittal) return;
  setQueueStatus(progress.transmittal, progress.status, progress.message || (progress.current && progress.total ? `${progress.current} of ${progress.total}` : ""));
  renderQueue();
  const label = progress.status === "running" ? "Processing" : String(progress.status || "").toUpperCase();
  log(`${progress.transmittal}: ${label}${progress.current && progress.total ? ` (${progress.current}/${progress.total})` : ""}.`, progress.status === "failed" ? "ERROR" : "INFO");
}

async function restoreDocumentStatus() {
  try {
    const response = await fetchJSON("/api/documents/status");
    const run = response.run;
    if (!run?.transmittals?.length) return;
    transmittals.value = run.transmittals.join("\n");
    document.getElementById("count").textContent = `${run.transmittals.length} transmittal${run.transmittals.length === 1 ? "" : "s"}`;
    clearLogUi();
    Object.values(run.progress || {}).forEach(applyDocumentProgress);
    running = Boolean(run.running);
    setRunning(running);
    updateReadyHint();
    if (running) {
      log("Reconnected to the running document upload. Earlier detail logs and selected files are not restored.");
    } else if (run.done) {
      log(run.message || "Document upload finished.", run.failed ? "ERROR" : "INFO");
    }
  } catch (error) {
    console.error("Could not restore document upload status.", error);
  }
}

socket.on("documents_progress", (progress) => {
  if (progress?.transmittal) applyDocumentProgress(progress);
});
socket.on("documents_done", (data) => {
  (data?.results || []).forEach((item) => setQueueStatus(item.transmittal, item.status, item.message || ""));
  const total = data?.results?.length || 0;
  const success = (data?.results || []).filter((item) => item.status === "success").length;
  log(`Finished: ${success}/${total} transmittal(s) uploaded.${data?.stopped ? " Stopped by user." : ""}`, data?.stopped ? "WARNING" : "INFO");
  setRunning(false);
  startButton.disabled = false;
});

socket.on("connect", restoreDocumentStatus);
restoreDocumentStatus();

renderQueue();
updateReadyHint();