const pdfFiles = document.getElementById("pdfFiles");
const orderList = document.getElementById("documentOrder");
const groupList = document.getElementById("groupNames");
const previewRows = document.getElementById("previewRows");
const previewBtn = document.getElementById("previewBtn");
const downloadBtn = document.getElementById("downloadBtn");
const clearBtn = document.getElementById("clearBtn");
const status = document.getElementById("status");
let hasPreview = false;
let editableGroups = [];
const ORDER_STORAGE_KEY = "beabots.autoRename.documentOrder.v1";

function currentOrder() {
  return [...orderList.querySelectorAll(".order-item input")].map((input) => input.value.trim());
}

function saveOrder() {
  try {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(currentOrder()));
  } catch (error) {
    setStatus("Could not save document order in this browser.", true);
  }
}

function moveType(item, offset) {
  const items = [...orderList.querySelectorAll(".order-item")];
  const index = items.indexOf(item);
  const target = items[index + offset];
  if (!target) return;
  if (offset < 0) orderList.insertBefore(item, target);
  else orderList.insertBefore(target, item);
  saveOrder();
  renderGroups();
  invalidatePreview();
}

function addDocumentType(value = "") {
  const item = document.createElement("label");
  item.className = "order-item";
  const input = document.createElement("input");
  input.value = value;
  input.maxLength = 24;
  input.placeholder = "TYPE";
  input.setAttribute("aria-label", "Document type");
  input.addEventListener("input", () => { saveOrder(); invalidatePreview(); });
  const up = document.createElement("button");
  up.type = "button";
  up.textContent = "↑";
  up.title = "Move document type up";
  up.setAttribute("aria-label", "Move document type up");
  up.addEventListener("click", () => moveType(item, -1));
  const down = document.createElement("button");
  down.type = "button";
  down.textContent = "↓";
  down.title = "Move document type down";
  down.setAttribute("aria-label", "Move document type down");
  down.addEventListener("click", () => moveType(item, 1));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "×";
  remove.title = "Remove document type";
  remove.addEventListener("click", () => { item.remove(); saveOrder(); renderGroups(); invalidatePreview(); });
  item.append(input, up, down, remove);
  orderList.append(item);
}

function invalidatePreview() {
  hasPreview = false;
  downloadBtn.disabled = true;
}

document.getElementById("addType").addEventListener("click", () => {
  addDocumentType();
  saveOrder();
  invalidatePreview();
});
let savedOrder = null;
try {
  const stored = JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY) || "null");
  if (Array.isArray(stored) && stored.length && stored.length <= 20 && stored.every((value) => typeof value === "string")) savedOrder = stored;
} catch (error) {
  // Start with the standard order if saved preferences are unavailable.
}
(savedOrder || ["CSF", "CF4", "PBEF", "AF"]).forEach((type) => addDocumentType(type));

async function saveGeneratedFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

pdfFiles.addEventListener("change", () => {
  document.getElementById("pdfHint").textContent = `${pdfFiles.files.length} PDF file(s) selected. Files are sorted naturally by filename.`;
  editableGroups = [];
  renderGroups();
  invalidatePreview();
});
orderList.addEventListener("input", () => { renderGroups(); invalidatePreview(); });

document.getElementById("copyNamesToFolders").addEventListener("click", () => {
  editableGroups.forEach((group) => { group.folder = group.name; });
  renderGroups();
  invalidatePreview();
});

document.getElementById("pasteGroupNames").addEventListener("click", async () => {
  if (!editableGroups.length) {
    setStatus("Choose PDFs first so the page can create filename fields.", true);
    return;
  }
  try {
    const clipboardText = await navigator.clipboard.readText();
    const names = clipboardText.replace(/^\uFEFF/, "").split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
    if (names.length !== editableGroups.length) {
      setStatus(`Copied ${names.length} name(s), but there are ${editableGroups.length} group filename field(s). Copy one name per group.`, true);
      return;
    }
    editableGroups.forEach((group, index) => { group.name = names[index]; });
    renderGroups();
    invalidatePreview();
    setStatus(`Pasted ${names.length} name(s) into the group filename fields.`);
  } catch (error) {
    setStatus("Clipboard access was blocked. Allow clipboard permission and try again.", true);
  }
});

function renderGroups() {
  const files = [...pdfFiles.files].sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
  const size = orderList.querySelectorAll("input").length;
  const defaultCount = size ? Math.ceil(files.length / size) : 0;
  if (!editableGroups.length && defaultCount) {
    editableGroups = Array.from({ length: defaultCount }, (_, index) => ({
      name: "", folder: "", start: index * size + 1, end: Math.min((index + 1) * size, files.length),
    }));
  }
  groupList.replaceChildren();
  if (!files.length || !editableGroups.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Choose PDFs to create editable groups.";
    groupList.append(empty);
    return;
  }
  editableGroups.forEach((group, index) => {
    const row = document.createElement("div");
    row.className = "group-row";
    const label = document.createElement("strong");
    label.textContent = `Group ${index + 1}`;
    const range = document.createElement("div");
    range.className = "group-range";
    const start = document.createElement("input");
    start.type = "number";
    start.min = "1";
    start.max = String(files.length);
    start.value = String(group.start);
    start.setAttribute("aria-label", `Group ${index + 1} first PDF number`);
    const separator = document.createElement("span");
    separator.textContent = "to";
    const end = document.createElement("input");
    end.type = "number";
    end.min = "1";
    end.max = String(files.length);
    end.value = String(group.end);
    end.setAttribute("aria-label", `Group ${index + 1} last PDF number`);
    start.addEventListener("input", () => { group.start = start.value; invalidatePreview(); });
    end.addEventListener("input", () => { group.end = end.value; invalidatePreview(); });
    range.append(start, separator, end);
    const name = document.createElement("input");
    name.className = "group-name";
    name.placeholder = "Patient / file name (required)";
    name.setAttribute("aria-label", `Group ${index + 1} filename`);
    name.value = group.name;
    name.addEventListener("input", () => { group.name = name.value; invalidatePreview(); });
    const folder = document.createElement("input");
    folder.className = "group-folder";
    folder.placeholder = "Folder name (optional)";
    folder.setAttribute("aria-label", `Group ${index + 1} folder name`);
    folder.value = group.folder;
    folder.addEventListener("input", () => { group.folder = folder.value; invalidatePreview(); });
    row.append(label, range, name, folder);
    groupList.append(row);
  });
}

function makeForm() {
  const files = [...pdfFiles.files].sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
  if (!files.length) throw new Error("Choose at least one PDF file.");
  const order = [...orderList.querySelectorAll("input")].map((input) => input.value.trim()).filter(Boolean);
  if (!order.length || order.length !== orderList.querySelectorAll("input").length) throw new Error("Enter a document type in each order item.");
  if (new Set(order.map((value) => value.toUpperCase())).size !== order.length) throw new Error("Document types must be unique.");
  const form = new FormData();
  files.forEach((file) => form.append("pdfs", file, file.name));
  form.append("document_order", order.join(","));
  if (editableGroups.some((group) => !group.name.trim())) throw new Error("Enter a name for every PDF group.");
  const assignments = Array(files.length).fill(-1);
  editableGroups.forEach((group, groupIndex) => {
    const first = Number(group.start);
    const last = Number(group.end);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > files.length) {
      throw new Error(`Enter a valid PDF range for Group ${groupIndex + 1}.`);
    }
    for (let pdfIndex = first - 1; pdfIndex < last; pdfIndex += 1) {
      if (assignments[pdfIndex] !== -1) throw new Error(`PDF ${pdfIndex + 1} is included in more than one group.`);
      assignments[pdfIndex] = groupIndex;
    }
  });
  if (assignments.some((groupIndex) => groupIndex === -1)) throw new Error("PDF ranges must cover every selected PDF.");
  form.append("groups", JSON.stringify(editableGroups));
  form.append("assignments", JSON.stringify(assignments));
  return form;
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

previewBtn.addEventListener("click", async () => {
  saveOrder();
  invalidatePreview();
  previewBtn.disabled = true;
  setStatus("Analyzing PDFs and group names...");
  try {
    const response = await fetch("/api/auto-rename/preview", { method: "POST", body: makeForm() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Preview failed.");
    previewRows.replaceChildren();
    data.rows.forEach((row, index) => {
      const tr = document.createElement("tr");
      if (!row.status.startsWith("OK")) tr.className = "row-warning";
      [String(index + 1), row.old, row.group, row.new || "—", row.status].forEach((value) => {
        const td = document.createElement("td"); td.textContent = value; tr.append(td);
      });
      previewRows.append(tr);
    });
    document.getElementById("summary").textContent = `${data.pdf_count} PDF(s) · ${data.group_count} group(s) · ${data.rows.filter((row) => row.status.startsWith("OK")).length} safe rename(s)`;
    const safeCount = data.rows.filter((row) => row.status.startsWith("OK")).length;
    hasPreview = safeCount > 0;
    downloadBtn.disabled = !hasPreview;
    setStatus(hasPreview ? "Preview ready. Review all warnings before creating the ZIP." : "No safe rename candidates. Resolve the preview warnings first.", !hasPreview);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    previewBtn.disabled = false;
  }
});

function clearAll() {
  pdfFiles.value = "";
  editableGroups = [];
  document.getElementById("pdfHint").textContent = "Choose the PDFs to rename. Files are sorted naturally by filename.";
  renderGroups();
  groupList.replaceChildren();
  const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "Choose PDFs to create editable groups."; groupList.append(empty);
  previewRows.replaceChildren();
  const emptyRow = document.createElement("tr");
  const emptyCell = document.createElement("td");
  emptyCell.colSpan = 5;
  emptyCell.className = "empty";
  emptyCell.textContent = "Run Analyze and preview to see the proposed file names.";
  emptyRow.append(emptyCell);
  previewRows.append(emptyRow);
  document.getElementById("summary").textContent = "Your proposed filenames will appear here.";
  hasPreview = false;
  downloadBtn.disabled = true;
  setStatus("Choose files to get started.");
}

clearBtn.addEventListener("click", clearAll);

downloadBtn.addEventListener("click", async () => {
  if (!hasPreview) return;
  downloadBtn.disabled = true;
  setStatus("Creating renamed PDF archive...");
  try {
    const response = await fetch("/api/auto-rename/run", { method: "POST", body: makeForm() });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Could not create the renamed archive.");
    }
    const savedPath = await saveGeneratedFile(await response.blob(), "Renamed_PDFs.zip");
    setStatus(savedPath === null ? "Save cancelled." : `ZIP saved: ${savedPath}. The selected originals remain unchanged.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    downloadBtn.disabled = false;
  }
});
