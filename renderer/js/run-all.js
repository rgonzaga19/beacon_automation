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
const results = new Map();
let active = false;
let retryRunId = null;
let canRunAll = null;
let accessCheckFailed = false;
const runAllAccessReady = fetchJSON("/api/auth/me").then((payload) => {
  if (!payload.authenticated) {
    window.location.replace("/login");
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
});
document.getElementById("soaFiles").addEventListener("change", (event) => {
  updateFileMeta(event.currentTarget, document.getElementById("soaMeta"), "No SOA files selected", "Names will be checked against the workbook.", "SOA files");
});

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

function renderResults() {
  if (!results.size) return;
  resultsBody.innerHTML = [...results.values()].map((item) => {
    const isRunning = [item.cf2, item.soa, item.esoa, item.cf4].includes("running");
    const isSuccessful = completedSuccessfully(item);
    const transmittal = item.transmittal
      ? `${escapeHtml(item.transmittal)}${isSuccessful ? `<button class="flat-copy-option transmittal-copy" type="button" data-transmittal="${escapeHtml(item.transmittal)}" title="Copy transmittal ${escapeHtml(item.transmittal)}" aria-label="Copy transmittal ${escapeHtml(item.transmittal)}">Copy</button>` : ""}`
      : "—";
    return `
    <tr class="${isRunning ? "row-running" : ""}" aria-busy="${isRunning}">
      <td>${escapeHtml(item.patient_name)}</td>
      <td>${transmittal}</td>
      <td><span class="stage ${escapeHtml(item.cf2)}">${escapeHtml(item.cf2)}</span></td>
      <td><span class="stage ${escapeHtml(item.soa)}">${escapeHtml(item.soa)}</span></td>
      <td><span class="stage ${escapeHtml(item.esoa || "skipped")}">${escapeHtml(item.esoa || "skipped")}</span></td>
      <td><span class="stage ${escapeHtml(item.cf4)}">${escapeHtml(item.cf4)}</span></td>
      <td>${escapeHtml(item.message || "—")}${retryRunId && item.cf2 === "success" && (item.soa !== "success" || !["success", "skipped"].includes(item.esoa) || item.cf4 !== "success") ? `<div style="margin-top:7px"><button class="cyber-btn retry-stage" type="button" data-member-pin="${escapeHtml(item.member_pin)}" ${active ? "disabled" : ""}>Retry remaining stages</button></div>` : ""}</td>
    </tr>`;
  }).join("");
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
  const line = document.createElement("div");
  line.className = "log-line";
  const formattedMessage = String(message);
  const includesTimestampAndLevel = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[[A-Z]+\]/.test(formattedMessage);
  line.textContent = includesTimestampAndLevel
    ? formattedMessage
    : `[${level}] ${formattedMessage}`;
  logNode.appendChild(line);
  logNode.scrollTop = logNode.scrollHeight;
}

function setActive(value) {
  active = value;
  startBtn.disabled = value;
  clearFieldsBtn.disabled = value;
  stopBtn.classList.toggle("visible", value);
  statusNode.textContent = value ? "Running one patient at a time…" : statusNode.textContent;
  renderResults();
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
    "SOA files"
  );
  errorNode.textContent = "";
  errorNode.style.display = "none";
  statusNode.textContent = "Fields cleared. Ready when you are.";
});

const socket = io(API_BASE);
socket.on("log", (entry) => appendLog(entry?.message, entry?.level));
socket.on("run_all_progress", (event) => {
  const item = event?.result;
  if (!item) return;
  results.set(item.member_pin, item);
  renderResults();
  statusNode.textContent = `Patient ${event.index} of ${event.total}: ${item.patient_name} — ${event.stage === "esoa" ? "SOA generation" : event.stage.toUpperCase()}`;
});
socket.on("run_all_done", (event) => {
  setActive(false);
  retryRunId = event?.retry_run_id || null;
  if (event?.results) {
    event.results.forEach((item) => results.set(item.member_pin, item));
    renderResults();
  }
  const complete = [...results.values()].filter((item) => item.cf2 === "success" && item.soa === "success" && ["success", "skipped"].includes(item.esoa) && item.cf4 === "success").length;
  statusNode.textContent = event?.stopped
    ? `Stopped safely. ${complete} patient${complete === 1 ? "" : "s"} completed all stages.`
    : `Run complete. ${complete} of ${results.size} patient${results.size === 1 ? "" : "s"} completed all stages.`;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
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
  retryRunId = null;
  resultsBody.innerHTML = "<tr><td colspan=\"7\" class=\"help\">Checking files…</td></tr>";
  logNode.replaceChildren();
  const payload = new FormData(form);
  try {
    setActive(true);
    statusNode.textContent = "Validating workbook and SOA filenames…";
    const response = await fetch(`${API_BASE}/api/run-all/start`, { method: "POST", body: payload });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not start the combined automation.");
    statusNode.textContent = `Started. ${result.patient_count} patient${result.patient_count === 1 ? "" : "s"} queued.`;
    appendLog(`Preflight passed for ${result.patient_count} patient(s).`);
  } catch (error) {
    setActive(false);
    resultsBody.innerHTML = "<tr><td colspan=\"7\" class=\"help\">No run started.</td></tr>";
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
