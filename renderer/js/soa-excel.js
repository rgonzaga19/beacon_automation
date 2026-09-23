const claims = document.getElementById("claims");
const summary = document.getElementById("summary");
const pageTitle = document.getElementById("pageTitle");
const systemStatus = document.getElementById("systemStatus");
const batchStatus = document.getElementById("batchStatus");
const batchButton = document.getElementById("batchGenerate");
const batchFile = document.getElementById("batchFile");
const downloadTemplateButton = document.getElementById("downloadTemplate");
const claimCount = document.getElementById("claimCount");

let claimState = [newClaim()];

const tabButtons = {
  individual: document.getElementById("tabIndividual"),
  batch: document.getElementById("tabBatch"),
};
const tabPages = {
  individual: document.getElementById("individualPage"),
  batch: document.getElementById("batchPage"),
};

function newClaim() {
  return { renderDate: "", hasEpo: false, epoQty: 1, epoType: "alfa", hasLab: false };
}

function openSubtab(activeKey) {
  Object.entries(tabButtons).forEach(([key, button]) => {
    const active = key === activeKey;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  Object.entries(tabPages).forEach(([key, page]) => {
    page.classList.toggle("active", key === activeKey);
    page.toggleAttribute("hidden", key !== activeKey);
  });
  pageTitle.textContent = activeKey === "batch" ? "Batch Generate" : "Individual Claims";
}

function selectedValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`).value;
}

function setStatus(message, type = "ready") {
  systemStatus.className = `status-card ${type}`;
  systemStatus.innerHTML = `<span class="status-dot"></span><span>${message}</span>`;
}

function renderClaims() {
  const today = new Date().toISOString().slice(0, 10);
  claims.innerHTML = claimState.map((claim, index) => `
    <section class="claim ${claimState.length > 1 ? "can-remove" : ""}" data-index="${index}">
      <div class="claim-head">
        <h2 class="claim-title">Claim #${index + 1}</h2>
        <button class="quiet-btn remove" type="button">Remove</button>
      </div>
      <div class="claim-grid">
        <label class="claim-field">Render Date
          <input data-field="renderDate" type="date" value="${claim.renderDate}" min="2020-01-01" max="${today}">
        </label>
        <label class="claim-field">Has EPO
          <span class="check-pill"><input data-field="hasEpo" type="checkbox" ${claim.hasEpo ? "checked" : ""}><span>${claim.hasEpo ? "Yes" : "No"}</span></span>
        </label>
        <label class="claim-field">Include Laboratory
          <span class="check-pill"><input data-field="hasLab" type="checkbox" ${claim.hasLab ? "checked" : ""}><span>${claim.hasLab ? "Yes" : "No"}</span></span>
        </label>
        <label class="claim-field compact">EPO Type
          <select data-field="epoType" ${claim.hasEpo ? "" : "disabled"}>
            <option value="alfa" ${claim.epoType === "alfa" ? "selected" : ""}>Alfa</option>
            <option value="beta" ${claim.epoType === "beta" ? "selected" : ""}>Beta</option>
          </select>
        </label>
        <label class="claim-field compact">EPO Quantity
          <input data-field="epoQty" type="number" min="1" max="${claim.epoType === "beta" ? "1" : "2"}" value="${claim.epoQty}" ${claim.hasEpo ? "" : "disabled"}>
        </label>
      </div>
    </section>`).join("");

  claims.querySelectorAll(".claim").forEach((row, index) => {
    row.querySelectorAll("[data-field]").forEach((input) => input.addEventListener("change", () => {
      const field = input.dataset.field;
      claimState[index][field] = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value;
      if (field === "hasEpo" && !input.checked) {
        claimState[index].epoQty = 1;
        claimState[index].epoType = "alfa";
      }
      if (field === "epoType" && input.value === "beta") claimState[index].epoQty = 1;
      if (field === "epoQty") {
        const max = claimState[index].epoType === "beta" ? 1 : 2;
        claimState[index].epoQty = Math.max(1, Math.min(Number(input.value) || 1, max));
      }
      renderClaims();
    }));
    row.querySelectorAll('input[type="date"]').forEach((input) => {
      input.addEventListener("click", () => {
        try {
          input.showPicker?.();
        } catch (error) {
          input.focus();
        }
      });
    });
    row.querySelector(".remove").addEventListener("click", () => {
      if (claimState.length <= 1) return;
      claimState.splice(index, 1);
      claimCount.value = claimState.length;
      renderClaims();
    });
  });

  renderSummary();
}

function renderSummary() {
  const labIndex = claimState.findIndex((claim) => claim.hasLab);
  const claimDetails = claimState.map((claim, index) => `
    <div class="summary-claim">
      <strong>Claim ${index + 1}</strong>
      <span>Date: ${claim.renderDate || "-"}<br>EPO: ${claim.hasEpo ? `${claim.epoType.toUpperCase()} x${claim.epoQty}` : "None"}${claim.hasLab ? "<br>LAB: Yes" : ""}</span>
    </div>`).join("");

  summary.innerHTML = `
    <div class="summary-row"><strong>Access:</strong><span>${selectedValue("accessType")}</span></div>
    <div class="summary-row"><strong>Dialyzer:</strong><span>${selectedValue("fluxType")}</span></div>
    <div class="summary-row"><strong>Claims:</strong><span>${claimState.length}</span></div>
    <div class="summary-row"><strong>Laboratory:</strong><span>${labIndex === -1 ? "None" : `Claim #${labIndex + 1}`}</span></div>
    <div class="summary-claims">${claimDetails}</div>`;
}

function syncClaimCount() {
  let count = Number(claimCount.value) || 1;
  count = Math.max(1, Math.min(count, 7));
  claimCount.value = count;
  while (claimState.length < count) claimState.push(newClaim());
  while (claimState.length > count) claimState.pop();
  renderClaims();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Unable to read generated file."));
    reader.readAsDataURL(blob);
  });
}

function getDesktopApi() {
  for (const candidate of [window, window.parent, window.top]) {
    try {
      if (candidate?.pywebview?.api?.save_generated_file) {
        return candidate.pywebview.api;
      }
    } catch (error) {
      // Cross-frame access can throw in browsers; ignore and use normal download.
    }
  }
  return null;
}

function isDesktopRuntime() {
  return [window, window.parent, window.top].some((candidate) => {
    try {
      return Boolean(candidate?.pywebview);
    } catch (error) {
      return false;
    }
  });
}

async function waitForDesktopApi() {
  const api = getDesktopApi();
  if (api) return api;

  await new Promise((resolve) => setTimeout(resolve, 150));
  return getDesktopApi();
}

async function download(blob, filename) {
  const desktopApi = await waitForDesktopApi();
  const dataUrl = isDesktopRuntime() || desktopApi ? await blobToDataUrl(blob) : null;

  if (desktopApi) {
    const result = await desktopApi.save_generated_file(filename, dataUrl);
    if (result?.cancelled) return null;
    if (!result?.ok) throw new Error(result?.error || "Unable to save generated file.");
    return result.path || filename;
  }

  if (dataUrl) {
    const response = await fetch("/api/soa-excel/save-generated", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, data_url: dataUrl }),
    });
    const result = await response.json().catch(() => ({}));
    if (result?.cancelled) return null;
    if (!response.ok || !result?.ok) {
      throw new Error(result.error || "Unable to save generated file.");
    }
    return result.path || filename;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return filename;
}

async function generateIndividual() {
  const missing = claimState.some((claim) => !claim.renderDate);
  if (missing) {
    setStatus("Enter all render dates", "error");
    alert("Enter a render date for every claim.");
    return;
  }

  const generateButton = document.getElementById("generate");
  generateButton.disabled = true;
  setStatus("Generating Excel...", "running");
  const body = { accessType: selectedValue("accessType"), fluxType: selectedValue("fluxType"), claims: claimState };
  try {
    const response = await fetch("/api/soa-excel/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Generation failed.");
    }
    const savedPath = await download(await response.blob(), "generated.xlsx");
    if (savedPath === null) {
      setStatus("Save cancelled.");
      return;
    }
    setStatus(`Excel generated: ${savedPath}`, "done");
  } catch (error) {
    setStatus(error.message, "error");
    alert(error.message);
  } finally {
    generateButton.disabled = false;
  }
}

async function downloadBatchTemplate() {
  downloadTemplateButton.disabled = true;
  batchStatus.className = "status-text";
  batchStatus.textContent = "Preparing template...";
  try {
    const response = await fetch("/api/soa-excel/download-template");
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Template download failed.");
    }
    const savedPath = await download(await response.blob(), "SOA_Batch_Template.xlsx");
    batchStatus.textContent = savedPath === null ? "Save cancelled." : `Template saved: ${savedPath}`;
  } catch (error) {
    batchStatus.className = "status-text error";
    batchStatus.textContent = error.message;
  } finally {
    downloadTemplateButton.disabled = false;
  }
}

function initBatchPeriod() {
  const now = new Date();
  const month = document.getElementById("batchMonth");
  month.innerHTML = "";
  for (let index = 1; index <= 12; index += 1) {
    month.add(new Option(new Date(2000, index - 1, 1).toLocaleString("en", { month: "long" }), index));
  }
  month.value = now.getMonth() + 1;
  document.getElementById("batchYear").value = now.getFullYear();
}

function clearIndividual() {
  claimState = [newClaim()];
  claimCount.value = 1;
  document.querySelector('input[name="accessType"][value="fistula"]').checked = true;
  document.querySelector('input[name="fluxType"][value="high"]').checked = true;
  setStatus("System Ready");
  renderClaims();
}

function clearBatch() {
  batchFile.value = "";
  batchButton.disabled = true;
  batchStatus.className = "status-text";
  batchStatus.textContent = "";
  initBatchPeriod();
}

document.querySelectorAll('input[name="accessType"], input[name="fluxType"]').forEach((input) => input.addEventListener("change", renderSummary));
claimCount.addEventListener("change", syncClaimCount);
document.getElementById("clearBtn").addEventListener("click", clearIndividual);
document.getElementById("generate").addEventListener("click", generateIndividual);
batchFile.addEventListener("change", (event) => {
  batchButton.disabled = !event.target.files.length;
  batchStatus.className = "status-text";
  batchStatus.textContent = event.target.files.length ? "Workbook ready." : "";
});
downloadTemplateButton.addEventListener("click", downloadBatchTemplate);
document.getElementById("batchClearBtn").addEventListener("click", clearBatch);
tabButtons.individual.addEventListener("click", () => openSubtab("individual"));
tabButtons.batch.addEventListener("click", () => openSubtab("batch"));
batchButton.addEventListener("click", async () => {
  const file = batchFile.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  form.append("month", document.getElementById("batchMonth").value);
  form.append("year", document.getElementById("batchYear").value);
  batchButton.disabled = true;
  batchStatus.className = "status-text";
  batchStatus.textContent = "Generating batch...";
  try {
    const response = await fetch("/api/soa-excel/batch", { method: "POST", body: form });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Batch generation failed.");
    }
    const savedPath = await download(await response.blob(), `SOA_Batch_${new Date().toISOString().slice(0, 10)}.zip`);
    batchStatus.textContent = savedPath === null ? "Save cancelled." : `Batch ZIP saved: ${savedPath}`;
  } catch (error) {
    batchStatus.className = "status-text error";
    batchStatus.textContent = error.message;
  } finally {
    batchButton.disabled = !batchFile.files.length;
  }
});

initBatchPeriod();
renderClaims();
openSubtab("individual");
