const picker = document.getElementById("folderPicker");
const folderPath = document.getElementById("folderPath");
const transmittals = document.getElementById("transmittals");
const logs = document.getElementById("logs");
const startButton = document.getElementById("startUpload");
let selectedFiles = [];
let running = false;

function log(message, level = "INFO") {
  if (logs.textContent === "Ready.") logs.textContent = "";
  const line = document.createElement("div");
  line.className = level;
  line.textContent = message;
  logs.appendChild(line);
  logs.scrollTop = logs.scrollHeight;
}

function transmittalList() {
  return [...new Set(transmittals.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
}

function setRunning(value) {
  running = value;
  startButton.textContent = value ? "Stop Upload" : "Start Upload";
  document.getElementById("browseFolder").disabled = value;
  document.getElementById("clear").disabled = value;
  transmittals.disabled = value;
}

document.getElementById("browseFolder").addEventListener("click", () => picker.click());
picker.addEventListener("change", () => {
  selectedFiles = [...picker.files].filter((file) => file.webkitRelativePath);
  const rootName = selectedFiles[0]?.webkitRelativePath.split("/")[0] || "";
  folderPath.value = selectedFiles.length ? `${rootName} (${selectedFiles.length} files)` : "";
  folderPath.title = rootName;
});
transmittals.addEventListener("input", () => {
  const count = transmittalList().length;
  document.getElementById("count").textContent = `${count} transmittal${count === 1 ? "" : "s"}`;
});

startButton.addEventListener("click", async () => {
  if (running) {
    await fetchJSON("/api/documents/stop", { method: "POST" });
    startButton.textContent = "Stopping...";
    startButton.disabled = true;
    return;
  }
  const numbers = transmittalList();
  if (!numbers.length) return showModal("No Transmittals", "Enter at least one transmittal number.");
  if (!selectedFiles.length) return showModal("No Folder", "Choose the parent folder containing the patient folders.");
  const supported = selectedFiles.filter((file) => /\.(pdf|jpe?g|png|tiff?)$/i.test(file.name));
  if (!supported.length) return showModal("No Documents", "The selected folder contains no PDF or image documents.");
  if (supported.some((file) => file.size > 2 * 1024 * 1024)) return showModal("Document Too Large", "Beacon allows a maximum of 2 MB per document.");

  logs.textContent = "";
  log(`Starting upload for ${numbers.length} transmittal(s) and ${supported.length} supported file(s)...`);
  setRunning(true);
  const form = new FormData();
  form.append("transmittals", numbers.join("\n"));
  form.append("relative_paths", JSON.stringify(supported.map((file) => file.webkitRelativePath)));
  supported.forEach((file) => form.append("documents", file, file.name));
  try {
    const response = await fetch(`${API_BASE}/api/documents/start`, { method: "POST", body: form });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || "Could not start document upload.");
  } catch (error) {
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
  logs.textContent = "Ready.";
  fetchJSON("/api/documents/status", { method: "DELETE" }).catch(() => {});
});

const socket = io(API_BASE);
socket.on("documents_log", (data) => log(data.message || "", data.level || "INFO"));
function applyDocumentProgress(progress) {
  if (!progress?.transmittal) return;
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
    logs.textContent = "";
    Object.values(run.progress || {}).forEach(applyDocumentProgress);
    running = Boolean(run.running);
    setRunning(running);
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
  const total = data?.results?.length || 0;
  const success = (data?.results || []).filter((item) => item.status === "success").length;
  log(`Finished: ${success}/${total} transmittal(s) uploaded.${data?.stopped ? " Stopped by user." : ""}`, data?.stopped ? "WARNING" : "INFO");
  setRunning(false);
  startButton.disabled = false;
});

socket.on("connect", restoreDocumentStatus);
restoreDocumentStatus();
