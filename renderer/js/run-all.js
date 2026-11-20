const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const form = document.getElementById("runForm");
const startBtn = document.getElementById("startBtn");
const clearFieldsBtn = document.getElementById("clearFieldsBtn");
const stopBtn = document.getElementById("stopBtn");
const statusNode = document.getElementById("status");
const errorNode = document.getElementById("error");
const resultsBody = document.getElementById("resultsBody");
const copyTransmittalsStatus = document.getElementById("copyTransmittalsStatus");
const logNode = document.getElementById("log");
const logDrawer = document.getElementById("logDrawer");
const runProgress = document.getElementById("runProgress");
const rpTrack = document.getElementById("rpTrack");
const rpFill = document.getElementById("rpFill");
let lastProgress = null;
let logLines = 0;
const results = new Map();
let active = false;
let retryRunId = null;
let canRunAll = null;
let accessCheckFailed = false;
let currentRunId = null;
let latestStatusSequence = 0;
let runStatusReady = Promise.resolve();
const runAllAccessReady = fetchJSON("/api/auth/me").then((payload) => {
  if (!payload.authenticated) {
    redirectToLogin();
    canRunAll = false;
    return;
  }
  const user = payload.user || {};
  canRunAll = Boolean(user.is_admin || user.role === "admin" || user.role === "subscriber");
}).catch(() => {
  canRunAll = false;
  accessCheckFailed = true;
});

function showRunAllAccessMessage() {
  errorNode.textContent = accessCheckFailed
    ? "Could not verify your account role. Refresh the page or contact your administrator."
    : "Run All is available to Subscriber and Admin accounts only. Contact your administrator to request Subscriber access.";
  errorNode.style.display = "block";
  statusNode.textContent = "This account cannot start Run All.";
}

startBtn.addEventListener("click", async (event) => {
  if (canRunAll === true) return;
  event.preventDefault();
  if (canRunAll === null) await runAllAccessReady;
  if (canRunAll) form.requestSubmit(startBtn);
  else showRunAllAccessMessage();
});

function updateFileMeta(input, target, emptyTitle, emptyDescription, noun) {
  const files = [...input.files];
  target.classList.toggle("ready", files.length > 0);
  if (!files.length) {
    target.innerHTML = `<strong>${escapeHtml(emptyTitle)}</strong>${escapeHtml(emptyDescription)}`;
    return;
  }
  const title = `${files.length} ${noun}${files.length === 1 ? "" : "s"} selected`;
  const names = files.slice(0, 2).map((file) => escapeHtml(file.name)).join(" · ");
  const more = files.length > 2 ? ` · +${files.length - 2} more` : "";
  target.innerHTML = `<strong>${escapeHtml(title)}</strong>${names}${more}`;
}

document.getElementById("workbook").addEventListener("change", (event) => {
  updateFileMeta(event.currentTarget, document.getElementById("workbookMeta"), "No workbook selected", "Choose the New Draft CF2 workbook.", "workbook");
  updateSummary();
});
document.getElementById("soaFiles").addEventListener("change", (event) => {
  updateFileMeta(event.currentTarget, document.getElementById("soaMeta"), "No SOA files selected", "Names will be checked against the workbook.", "SOA file");
  updateSummary();
});

// Summary card, file chips, and readiness hint.
function updateSummary() {
  const workbook = document.getElementById("workbook").files[0];
  const soaFiles = [...document.getElementById("soaFiles").files];
  const mark = (id, ok, mark) => {
    const li = document.getElementById(id);
    li.classList.toggle("ok", ok);
    li.querySelector(".sum-mark").textContent = ok ? "✓" : "·";
  };
  document.getElementById("workbookCard").classList.toggle("filled", Boolean(workbook));
  document.getElementById("soaCard").classList.toggle("filled", soaFiles.length > 0);
  document.getElementById("sumWorkbookText").textContent = workbook ? workbook.name : "No workbook yet";
  mark("sumWorkbook", Boolean(workbook));
  document.getElementById("sumSoaText").textContent = soaFiles.length ? `${soaFiles.length} SOA file${soaFiles.length === 1 ? "" : "s"}` : "No SOA files yet";
  mark("sumSoa", soaFiles.length > 0);
  const seen = new Set();
  const dupes = new Set();
  soaFiles.forEach((file) => {
    const key = file.name.trim().toLowerCase();
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  });
  document.getElementById("sumSoaSub").textContent = dupes.size
    ? `${dupes.size} duplicate filename${dupes.size === 1 ? "" : "s"}. Each patient needs a unique SOA.`
    : soaFiles.length ? "Matched to workbook rows when the run starts." : "";
  const chips = document.getElementById("soaChips");
  chips.replaceChildren(...soaFiles.slice(0, 6).map((file) => {
    const chip = document.createElement("span");
    chip.className = `file-chip${dupes.has(file.name.trim().toLowerCase()) ? " dupe" : ""}`;
    chip.textContent = file.name;
    chip.title = file.name;
    return chip;
  }), ...(soaFiles.length > 6 ? [Object.assign(document.createElement("span"), { className: "file-chip", textContent: `+${soaFiles.length - 6} more` })] : []));
  document.getElementById("sumPeriodText").textContent = `${monthSelect.value} ${yearSelect.value}`;
  const hint = document.getElementById("startHint");
  const missing = [!workbook && "the workbook", !soaFiles.length && "the SOA files"].filter(Boolean);
  hint.textContent = active ? "" : missing.length ? `Add ${missing.join(" and ")} to start.` : `Ready: ${soaFiles.length} SOA file${soaFiles.length === 1 ? "" : "s"} for ${monthSelect.value} ${yearSelect.value}.`;
}

// Drag and drop onto the file boxes.
function wireDrop(cardId, inputId, multiple) {
  const card = document.getElementById(cardId);
  const input = document.getElementById(inputId);
  ["dragenter", "dragover"].forEach((name) => card.addEventListener(name, (event) => { event.preventDefault(); if (!active) card.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((name) => card.addEventListener(name, () => card.classList.remove("dragging")));
  card.addEventListener("drop", (event) => {
    event.preventDefault();
    if (active || !event.dataTransfer?.files?.length) return;
    const transfer = new DataTransfer();
    const accepted = [...event.dataTransfer.files].filter((file) => /\.(xlsx|xlsm|xls)$/i.test(file.name) && (inputId === "workbook" || !/\.xlsm$/i.test(file.name)));
    (multiple ? accepted : accepted.slice(0, 1)).forEach((file) => transfer.items.add(file));
    if (!transfer.files.length) return;
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
wireDrop("workbookCard", "workbook", false);
wireDrop("soaCard", "soaFiles", true);

const monthSelect = document.getElementById("claimMonth");
monthNames.forEach((name, index) => {
  const option = document.createElement("option");
  option.value = name;
  option.textContent = name;
  option.selected = index === new Date().getMonth();
  monthSelect.appendChild(option);
});
const yearSelect = document.getElementById("claimYear");
for (let year = 2024; year <= 2035; year += 1) {
  const option = document.createElement("option");
  option.value = String(year);
  option.textContent = String(year);
  option.selected = year === new Date().getFullYear();
  yearSelect.appendChild(option);
}

monthSelect.addEventListener("change", () => updateSummary());
yearSelect.addEventListener("change", () => updateSummary());

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function completedSuccessfully(item) {
  return item.cf2 === "success"
    && item.soa === "success"
    && ["success", "skipped"].includes(item.esoa)
    && item.cf4 === "success";
}

function getSuccessfulTransmittals() {
  return [...new Set([...results.values()]
    .filter((item) => completedSuccessfully(item) && item.transmittal)
    .map((item) => String(item.transmittal).trim())
    .filter(Boolean))];
}

function setCopyTransmittalsStatus(message, error = false) {
  copyTransmittalsStatus.textContent = message;
  copyTransmittalsStatus.classList.toggle("error", error);
}

const STAGES = [["cf2", "CF2"], ["soa", "SOA"], ["esoa", "eSOA"], ["cf4", "CF4"]];
const STAGE_GLYPH = { success: "✓", skipped: "–", failed: "!", running: "", blocked: "", pending: "" };

function stageState(value) {
  return ["success", "skipped", "failed", "running", "blocked"].includes(value) ? value : "pending";
}

function pipelineMarkup(item) {
  return `<ol class="pipe" aria-label="Workflow stages">${STAGES.map(([key, label]) => {
    const state = stageState(key === "esoa" ? (item.esoa || (item.cf2 ? "skipped" : "pending")) : item[key]);
    return `<li class="${state}" title="${label}: ${state}"><span class="dot" aria-hidden="true">${STAGE_GLYPH[state]}</span>${label}<span class="sr-state" style="position:absolute;width:1px;height:1px;overflow:hidden">${state}</span></li>`;
  }).join("")}</ol>`;
}

function renderEmptyResults() {
  resultsBody.innerHTML = `<tr class="ghost-row"><td><span class="ghost-bar"></span></td><td><span class="ghost-bar" style="width:70px"></span></td><td>${pipelineMarkup({})}</td><td class="stage-msg">Each patient moves through CF2 draft, SOA upload, eSOA generation, then CF4. Results appear here as the run progresses.</td></tr>`;
  updateTally();
}

function updateTally() {
  const items = [...results.values()];
  const failed = (item) => [item.cf2, item.soa, item.esoa, item.cf4].includes("failed");
  const running = (item) => [item.cf2, item.soa, item.esoa, item.cf4].includes("running");
  document.getElementById("tDone").textContent = String(items.filter(completedSuccessfully).length);
  document.getElementById("tRun").textContent = String(items.filter(running).length);
  document.getElementById("tFail").textContent = String(items.filter(failed).length);
}

function updateRunProgress() {
  if (!lastProgress) return;
  const total = Number(lastProgress.total) || results.size || 1;
  const finished = [...results.values()].filter((item) => completedSuccessfully(item) || [item.cf2, item.soa, item.esoa, item.cf4].includes("failed")).length;
  rpTrack.classList.remove("indeterminate");
  const value = Math.min(100, Math.round((finished / total) * 100));
  rpFill.style.width = `${value}%`;
  rpTrack.setAttribute("aria-valuenow", String(value));
  document.getElementById("rpTitle").firstChild.textContent = active
    ? `Patient ${Math.min(lastProgress.index || finished + 1, total)} of ${total} · ${lastProgress.name || ""}`
    : `Run finished · ${finished} of ${total} patient${total === 1 ? "" : "s"} processed`;
  document.getElementById("rpSub").textContent = active ? `Stage: ${lastProgress.stage || "starting"}` : "";
}

function renderResults() {
  if (!results.size) return;
  resultsBody.innerHTML = [...results.values()].map((item) => {
    const states = [item.cf2, item.soa, item.esoa, item.cf4];
    const isRunning = states.includes("running");
    const isFailed = states.includes("failed");
    const isSuccessful = completedSuccessfully(item);
    const transmittal = item.transmittal
      ? `${escapeHtml(item.transmittal)}${isSuccessful ? `<button class="flat-copy-option transmittal-copy" type="button" data-transmittal="${escapeHtml(item.transmittal)}" title="Copy transmittal ${escapeHtml(item.transmittal)}" aria-label="Copy transmittal ${escapeHtml(item.transmittal)}">Copy</button>` : ""}`
      : "—";
    const retry = retryRunId && item.cf2 === "success" && (item.soa !== "success" || !["success", "skipped"].includes(item.esoa) || item.cf4 !== "success")
      ? `<div style="margin-top:7px"><button class="cyber-btn retry-stage" type="button" data-member-pin="${escapeHtml(item.member_pin)}" ${active ? "disabled" : ""}>Retry remaining stages</button></div>` : "";
    return `
    <tr class="${isRunning ? "row-running" : isFailed ? "row-failed" : ""}" aria-busy="${isRunning}">
      <td>${escapeHtml(item.patient_name)}</td>
      <td>${transmittal}</td>
      <td>${pipelineMarkup(item)}</td>
      <td class="stage-msg">${escapeHtml(item.message || "—")}${retry}</td>
    </tr>`;
  }).join("");
  updateTally();
  updateRunProgress();
}

document.getElementById("copySuccessfulTransmittals").addEventListener("click", async () => {
  const numbers = getSuccessfulTransmittals();
  if (!numbers.length) {
    setCopyTransmittalsStatus("No successful transmittals to copy yet.", true);
    return;
  }
  try {
    const copied = await copyTextToClipboard(numbers.join("\n"));
    setCopyTransmittalsStatus(copied
      ? `Copied ${numbers.length} successful transmittal${numbers.length === 1 ? "" : "s"}.`
      : "Copy failed. Your browser blocked clipboard access.", !copied);
  } catch (error) {
    setCopyTransmittalsStatus(error.message || "Copy failed. Your browser blocked clipboard access.", true);
  }
});

function appendLog(message, level = "INFO") {
  if (!message) return;
  logNode.querySelector(".log-empty")?.remove();
  const line = document.createElement("div");
  line.className = "log-line";
  const formattedMessage = String(message);
  const includesTimestampAndLevel = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[[A-Z]+\]/.test(formattedMessage);
  line.textContent = includesTimestampAndLevel
    ? formattedMessage
    : `[${level}] ${formattedMessage}`;
  const isError = String(level).toUpperCase() === "ERROR" || /^\[[^\]]*\] \[ERROR\]/.test(formattedMessage);
  if (isError) line.classList.add("err");
  logNode.appendChild(line);
  logNode.scrollTop = logNode.scrollHeight;
  logLines += 1;
  logDrawer.classList.add("has-lines");
  document.getElementById("logCount").textContent = `${logLines} line${logLines === 1 ? "" : "s"}`;
  document.getElementById("logPreview").textContent = line.textContent;
  if (isError) {
    logDrawer.classList.add("has-error");
    setLogOpen(true);
  }
}

function setLogOpen(open) {
  logDrawer.classList.toggle("open", open);
  document.getElementById("logToggle").setAttribute("aria-expanded", String(open));
}
document.getElementById("logToggle").addEventListener("click", () => setLogOpen(!logDrawer.classList.contains("open")));

function setActive(value) {
  active = value;
  startBtn.disabled = value;
  clearFieldsBtn.disabled = value;
  stopBtn.classList.toggle("visible", value);
  statusNode.textContent = value ? "Running one patient at a time…" : statusNode.textContent;
  runProgress.hidden = !value && !lastProgress;
  if (value && !lastProgress) {
    rpTrack.classList.add("indeterminate");
    document.getElementById("rpTitle").firstChild.textContent = "Starting run…";
  }
  updateSummary();
  renderResults();
}

function finishedRunMessage(state) {
  const complete = [...results.values()].filter((item) => item.cf2 === "success"
    && item.soa === "success"
    && ["success", "skipped"].includes(item.esoa)
    && item.cf4 === "success").length;
  if (state.stopped) {
    return `Stopped safely. ${complete} patient${complete === 1 ? "" : "s"} completed all stages.`;
  }
  if (state.failed) {
    return `Run ended with issues. ${complete} patient${complete === 1 ? "" : "s"} completed all stages.`;
  }
  return `Run complete. ${complete} of ${results.size} patient${results.size === 1 ? "" : "s"} completed all stages.`;
}

function applyRunSnapshot(state) {
  if (!state?.run_id) return;
  const sequence = Number(state.sequence) || 0;
  const sameRun = state.run_id === currentRunId;

  if (currentRunId && !sameRun && sequence < latestStatusSequence) return;
  if (sameRun && sequence < latestStatusSequence) {
    (state.results || []).forEach((item) => {
      if (!results.has(item.member_pin)) results.set(item.member_pin, item);
    });
    renderResults();
    return;
  }

  if (!sameRun) lastProgress = null;
  results.clear();
  currentRunId = state.run_id;
  latestStatusSequence = sequence;
  (state.results || []).forEach((item) => results.set(item.member_pin, item));
  retryRunId = state.retry_run_id || null;

  const index = Number(state.index) || 0;
  const total = Number(state.total) || results.size;
  const currentItem = (state.results || [])[index - 1];
  const stageLabel = state.stage === "esoa"
    ? "SOA generation"
    : String(state.stage || "").toUpperCase();
  lastProgress = index && currentItem
    ? {
      index,
      total,
      name: currentItem.patient_name,
      stage: stageLabel,
    }
    : null;

  setActive(Boolean(state.running));
  statusNode.textContent = state.running
    ? (currentItem
      ? `Patient ${index} of ${total}: ${currentItem.patient_name} — ${stageLabel}`
      : (state.message || "Run in progress."))
    : state.done
      ? finishedRunMessage(state)
      : (state.message || "Ready to run.");
  if (!state.running && lastProgress) updateRunProgress();
}

function applyRunProgress(event) {
  if (!event?.run_id || !event.result) return;
  const sequence = Number(event.sequence) || 0;
  if (currentRunId && event.run_id !== currentRunId && sequence <= latestStatusSequence) return;
  if (event.run_id !== currentRunId) {
    results.clear();
    lastProgress = null;
    retryRunId = null;
    currentRunId = event.run_id;
  }
  if (sequence && sequence < latestStatusSequence) return;
  latestStatusSequence = Math.max(latestStatusSequence, sequence);

  const item = event.result;
  results.set(item.member_pin, item);
  lastProgress = {
    index: event.index,
    total: event.total,
    name: item.patient_name,
    stage: event.stage === "esoa" ? "SOA generation" : String(event.stage || "").toUpperCase(),
  };
  setActive(event.running !== false);
  statusNode.textContent = `Patient ${event.index} of ${event.total}: ${item.patient_name} — ${event.stage === "esoa" ? "SOA generation" : event.stage.toUpperCase()}`;
}

async function restoreRunAllStatus() {
  await runAllAccessReady;
  if (!canRunAll) return;
  try {
    const result = await fetchJSON("/api/run-all/status");
    if (result.run) applyRunSnapshot(result.run);
  } catch (error) {
    console.error("Could not restore the latest Run All status.", error);
  }
}

clearFieldsBtn.addEventListener("click", () => {
  if (active) return;
  form.reset();
  monthSelect.value = monthNames[new Date().getMonth()];
  yearSelect.value = String(new Date().getFullYear());
  updateFileMeta(
    document.getElementById("workbook"),
    document.getElementById("workbookMeta"),
    "No workbook selected",
    "Choose the New Draft CF2 workbook.",
    "workbook"
  );
  updateFileMeta(
    document.getElementById("soaFiles"),
    document.getElementById("soaMeta"),
    "No SOA files selected",
    "Names will be checked against the workbook.",
    "SOA file"
  );
  errorNode.textContent = "";
  errorNode.style.display = "none";
  results.clear();
  currentRunId = null;
  latestStatusSequence = 0;
  retryRunId = null;
  lastProgress = null;
  runProgress.hidden = true;
  rpTrack.classList.add("indeterminate");
  rpFill.style.width = "0%";
  rpTrack.removeAttribute("aria-valuenow");
  setCopyTransmittalsStatus("");
  renderEmptyResults();
  logLines = 0;
  logDrawer.classList.remove("has-lines", "has-error");
  document.getElementById("logCount").textContent = "0 lines";
  document.getElementById("logPreview").textContent = "";
  logNode.replaceChildren(Object.assign(document.createElement("div"), {
    className: "log-empty",
    textContent: "Waiting for workflow activity…",
  }));
  statusNode.textContent = "Fields cleared. Ready when you are.";
  updateSummary();
});

const socket = io(API_BASE);
socket.on("log", (entry) => appendLog(entry?.message, entry?.level));
socket.on("run_all_progress", applyRunProgress);
socket.on("run_all_done", (event) => {
  applyRunSnapshot(event);
});
socket.on("connect", () => {
  runStatusReady = restoreRunAllStatus();
});
runStatusReady = restoreRunAllStatus();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await runStatusReady;
  if (active) return;
  if (canRunAll === null) await runAllAccessReady;
  if (!canRunAll) {
    showRunAllAccessMessage();
    return;
  }
  errorNode.style.display = "none";
  errorNode.textContent = "";
  setCopyTransmittalsStatus("");
  results.clear();
  currentRunId = null;
  latestStatusSequence = 0;
  retryRunId = null;
  lastProgress = null;
  logLines = 0;
  logDrawer.classList.remove("has-lines", "has-error");
  document.getElementById("logCount").textContent = "0 lines";
  document.getElementById("logPreview").textContent = "";
  resultsBody.innerHTML = "<tr><td colspan=\"4\" class=\"help empty-note\">Checking files…</td></tr>";
  logNode.replaceChildren(Object.assign(document.createElement("div"), {
    className: "log-empty",
    textContent: "Waiting for workflow activity…",
  }));
  const payload = new FormData(form);
  try {
    setActive(true);
    statusNode.textContent = "Validating workbook and SOA filenames…";
    const response = await fetch(`${API_BASE}/api/run-all/start`, { method: "POST", body: payload });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not start the combined automation.");
    currentRunId = result.run_id || currentRunId;
    statusNode.textContent = `Started. ${result.patient_count} patient${result.patient_count === 1 ? "" : "s"} queued.`;
    appendLog(`Preflight passed for ${result.patient_count} patient(s).`);
  } catch (error) {
    setActive(false);
    runProgress.hidden = true;
    renderEmptyResults();
    errorNode.textContent = error.message || String(error);
    errorNode.style.display = "block";
    statusNode.textContent = "Could not start the run.";
  }
});

resultsBody.addEventListener("click", async (event) => {
  const copyButton = event.target.closest(".transmittal-copy");
  if (copyButton) {
    try {
      const copied = await copyTextToClipboard(copyButton.dataset.transmittal);
      if (!copied) throw new Error("Your browser blocked clipboard access.");
      setCopyTransmittalsStatus(`Copied transmittal ${copyButton.dataset.transmittal}.`);
    } catch (error) {
      setCopyTransmittalsStatus(error.message || "Copy failed. Your browser blocked clipboard access.", true);
    }
    return;
  }
  const button = event.target.closest(".retry-stage");
  if (!button || !retryRunId || active) return;
  try {
    setActive(true);
    statusNode.textContent = "Retrying from the last incomplete stage; CF2 will not be recreated…";
    const response = await fetch(`${API_BASE}/api/run-all/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: retryRunId, member_pin: button.dataset.memberPin }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not retry the incomplete stage.");
    currentRunId = result.run_id || currentRunId;
    appendLog(`Retry started at ${result.stage.toUpperCase()} for this existing draft.`);
  } catch (error) {
    setActive(false);
    errorNode.textContent = error.message || String(error);
    errorNode.style.display = "block";
    statusNode.textContent = "Could not retry this claim.";
  }
});

stopBtn.addEventListener("click", async () => {
  if (!active) return;
  stopBtn.disabled = true;
  statusNode.textContent = "Stop requested. Finishing the current safe stage…";
  try {
    await fetch(`${API_BASE}/api/run-all/stop`, { method: "POST" });
  } catch (error) {
    appendLog(error.message || "Could not send stop request.", "ERROR");
  } finally {
    stopBtn.disabled = false;
  }
});

renderEmptyResults();
updateSummary();
