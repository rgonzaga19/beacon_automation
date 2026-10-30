const $ = (id) => document.getElementById(id);
const pdfFiles = $("pdfFiles");
const orderList = $("documentOrder");
const board = $("groupBoard");
const previewRows = $("previewRows");
const previewBtn = $("previewBtn");
const downloadBtn = $("downloadBtn");
const clearBtn = $("clearBtn");
const undoBtn = $("undoBtn");
const status = $("status");
const frame = $("viewerFrame");
const ORDER_STORAGE_KEY = "beabots.autoRename.documentOrder.v1";

let uid = 0;
let archiveModulePromise = null;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_PDF_BYTES = 90 * 1024 * 1024;
const nextId = () => ++uid;
const state = {
  files: [],          // [{ id, file, name, url }] in natural filename order
  groups: [],         // [{ id, name, folder, fileIds: [] }]
  unassigned: [],     // file ids not in any group
  selectedId: null,
  checked: new Set(), // file ids the user confirmed
  preview: null,      // server response
  rowFor: new Map(),  // file id -> server preview row
  dragId: null,
  undo: [],
};

/* ---------- helpers ---------- */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function iconBtn(label, text, handler, disabled = false) {
  const b = el("button", "icon-btn", text);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.disabled = disabled;
  b.addEventListener("click", (e) => { e.stopPropagation(); handler(); });
  return b;
}
const fileById = (id) => state.files.find((f) => f.id === id);
const types = () => [...orderList.querySelectorAll(".order-item input")].map((i) => i.value.trim()).filter(Boolean);
const isOk = (row) => row.status.startsWith("OK");

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function arranged() {
  const list = [];
  state.groups.forEach((g, gi) => g.fileIds.forEach((id, pos) => list.push({ id, gi, pos })));
  state.unassigned.forEach((id) => list.push({ id, gi: -1, pos: -1 }));
  return list;
}
function locate(id) {
  for (let gi = 0; gi < state.groups.length; gi += 1) {
    const pos = state.groups[gi].fileIds.indexOf(id);
    if (pos >= 0) return { gi, pos, group: state.groups[gi] };
  }
  const pos = state.unassigned.indexOf(id);
  return { gi: -1, pos, group: null };
}
function typeFor(gi, pos) {
  if (gi < 0) return "—";
  return types()[pos] || "EXTRA";
}

/* ---------- undo ---------- */
function snapshot() {
  state.undo.push(JSON.stringify({
    groups: state.groups.map((g) => ({ ...g, fileIds: [...g.fileIds] })),
    unassigned: [...state.unassigned],
  }));
  if (state.undo.length > 50) state.undo.shift();
  undoBtn.disabled = false;
}
function undo() {
  const last = state.undo.pop();
  if (!last) return;
  const data = JSON.parse(last);
  state.groups = data.groups;
  state.unassigned = data.unassigned;
  undoBtn.disabled = !state.undo.length;
  invalidate();
  renderBoard();
}
undoBtn.addEventListener("click", undo);

/* ---------- document order chips ---------- */
function currentOrder() {
  return [...orderList.querySelectorAll(".order-item input")].map((input) => input.value.trim());
}
function saveOrder() {
  try { localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(currentOrder())); }
  catch (error) { setStatus("Could not save document order in this browser.", true); }
}
function orderChanged() {
  saveOrder();
  invalidate();
  renderBoard();
}
function moveType(item, offset) {
  const items = [...orderList.querySelectorAll(".order-item")];
  const target = items[items.indexOf(item) + offset];
  if (!target) return;
  if (offset < 0) orderList.insertBefore(item, target);
  else orderList.insertBefore(target, item);
  orderChanged();
}
function addDocumentType(value = "") {
  const item = el("label", "order-item");
  const input = el("input");
  input.value = value;
  input.maxLength = 24;
  input.placeholder = "TYPE";
  input.setAttribute("aria-label", "Document type");
  input.addEventListener("input", orderChanged);
  const up = iconBtn("Move document type earlier", "↑", () => moveType(item, -1));
  const down = iconBtn("Move document type later", "↓", () => moveType(item, 1));
  const remove = iconBtn("Remove document type", "×", () => { item.remove(); orderChanged(); });
  item.append(input, up, down, remove);
  orderList.append(item);
}
$("addType").addEventListener("click", () => { addDocumentType(); orderChanged(); });

let savedOrder = null;
try {
  const stored = JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY) || "null");
  if (Array.isArray(stored) && stored.length && stored.length <= 20 && stored.every((v) => typeof v === "string")) savedOrder = stored;
} catch (error) { /* use defaults */ }
(savedOrder || ["CSF", "CF4", "PBEF", "AF"]).forEach((t) => addDocumentType(t));
$("groupSize").value = String(types().length || 4);

/* ---------- files & groups ---------- */
function loadFiles(fileList) {
  state.files.forEach((f) => URL.revokeObjectURL(f.url));
  state.files = [...fileList]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
    .map((file) => ({ id: nextId(), file, name: file.name, url: URL.createObjectURL(file) }));
  state.checked.clear();
  state.selectedId = null;
  state.undo = [];
  undoBtn.disabled = true;
  frame.removeAttribute("src");
  delete frame.dataset.id;
  $("pdfHint").textContent = state.files.length
    ? `${state.files.length} PDF file(s) selected. Sorted naturally by filename.`
    : "Files are sorted naturally by filename.";
  buildGroups(Number($("groupSize").value) || types().length || 1, false);
}

async function pdfsFromSelection(fileList) {
  const selected = [...fileList];
  const pdfs = selected.filter((file) => /\.pdf$/i.test(file.name));
  const archives = selected.filter((file) => /\.rar$/i.test(file.name));
  const ignored = selected.length - pdfs.length - archives.length;
  let extractedBytes = pdfs.reduce((total, file) => total + file.size, 0);
  if (archives.length && extractedBytes > MAX_EXTRACTED_PDF_BYTES) {
    throw new Error("Selected PDFs and PDFs extracted from RAR archives exceed the 90 MB limit.");
  }

  for (const archiveFile of archives) {
    if (archiveFile.size > MAX_ARCHIVE_BYTES) {
      throw new Error(`${archiveFile.name} exceeds the 100 MB RAR size limit.`);
    }
    if (!archiveModulePromise) {
      const moduleUrl = new URL("vendor/libarchive/libarchive.js", document.baseURI);
      archiveModulePromise = import(moduleUrl.href).then(({ Archive }) => {
        Archive.init({ workerUrl: new URL("./worker-bundle.js", moduleUrl) });
        return Archive;
      });
    }

    const Archive = await archiveModulePromise;
    const reader = await Archive.open(archiveFile);
    try {
      if (await reader.hasEncryptedData()) {
        const password = window.prompt(`Enter the password for ${archiveFile.name}:`);
        if (password === null || password === "") throw new Error(`Password required to open ${archiveFile.name}.`);
        await reader.usePassword(password);
      }
      const entries = await reader.getFilesArray();
      const pdfEntries = entries.filter(({ file }) => file && /\.pdf$/i.test(file.name || ""));
      if (!pdfEntries.length) throw new Error(`No PDF files were found in ${archiveFile.name}.`);

      for (const entry of pdfEntries) {
        const compressed = entry.file;
        if (extractedBytes + compressed.size > MAX_EXTRACTED_PDF_BYTES) {
          throw new Error("Selected PDFs and PDFs extracted from RAR archives exceed the 90 MB limit.");
        }
        const extracted = await compressed.extract();
        extractedBytes += extracted.size;
        const relativeName = `${entry.path || ""}${compressed.name}`.replaceAll("/", " - ").replaceAll("\\", " - ").replace(/\s*-\s*$/, "");
        const archiveLabel = archiveFile.name.replace(/\.rar$/i, "");
        pdfs.push(new File([extracted], `${archiveLabel} - ${relativeName}`, {
          type: "application/pdf",
          lastModified: extracted.lastModified,
        }));
      }
    } finally {
      await reader.close();
    }
  }

  if (!pdfs.length) throw new Error("Choose PDF files or RAR archives containing PDFs.");
  if (ignored) setStatus(`${ignored} unsupported file(s) were skipped.`, true);
  return pdfs;
}

async function handleFileSelection(fileList) {
  try {
    setStatus("Reading selected PDFs and RAR archives...");
    const pdfs = await pdfsFromSelection(fileList);
    loadFiles(pdfs);
    setStatus(`Loaded ${pdfs.length} PDF file(s).`);
  } catch (error) {
    setStatus(error.message || "Could not read the selected archive.", true);
  }
}

function buildGroups(size, withUndo = true) {
  if (withUndo) {
    if (state.groups.some((g) => g.name.trim()) && !confirm("Regrouping clears the group names you've entered. Continue?")) return;
    snapshot();
  }
  const n = Math.max(1, Math.floor(size) || 1);
  state.groups = [];
  for (let i = 0; i < state.files.length; i += n) {
    state.groups.push({ id: nextId(), name: "", folder: "", fileIds: state.files.slice(i, i + n).map((f) => f.id) });
  }
  state.unassigned = [];
  invalidate();
  renderBoard();
}

pdfFiles.addEventListener("change", () => { handleFileSelection(pdfFiles.files); });
const dropzone = $("dropzone");
["dragenter", "dragover"].forEach((evt) => dropzone.addEventListener(evt, (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); dropzone.classList.add("over"); }
}));
["dragleave", "drop"].forEach((evt) => dropzone.addEventListener(evt, () => dropzone.classList.remove("over")));
dropzone.addEventListener("drop", (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  handleFileSelection(e.dataTransfer.files);
});

$("autoGroup").addEventListener("click", () => {
  if (!state.files.length) return setStatus("Choose PDFs first.", true);
  buildGroups(Number($("groupSize").value));
});
$("addGroup").addEventListener("click", () => {
  if (!state.files.length) return setStatus("Choose PDFs first.", true);
  snapshot();
  state.groups.push({ id: nextId(), name: "", folder: "", fileIds: [] });
  invalidate();
  renderBoard();
});
$("copyNamesToFolders").addEventListener("click", () => {
  snapshot();
  state.groups.forEach((g) => { g.folder = g.name; });
  invalidate();
  renderBoard();
});
$("pasteGroupNames").addEventListener("click", async () => {
  if (!state.groups.length) return setStatus("Choose PDFs first so the page can create filename fields.", true);
  try {
    const text = await navigator.clipboard.readText();
    const names = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((n) => n.trim()).filter(Boolean);
    if (names.length !== state.groups.length) {
      return setStatus(`Copied ${names.length} name(s), but there are ${state.groups.length} group(s). Copy one name per group.`, true);
    }
    snapshot();
    state.groups.forEach((g, i) => { g.name = names[i]; });
    invalidate();
    renderBoard();
    setStatus(`Pasted ${names.length} name(s) into the groups.`);
  } catch (error) {
    setStatus("Clipboard access was blocked. Allow clipboard permission and try again.", true);
  }
});

/* ---------- moving files ---------- */
function detach(id) {
  state.groups.forEach((g) => { g.fileIds = g.fileIds.filter((x) => x !== id); });
  state.unassigned = state.unassigned.filter((x) => x !== id);
}
// `index` is the position in the target list AFTER the file has been removed from it.
function moveFile(id, target, index) {
  snapshot();
  detach(id);
  const list = target === "pool" ? state.unassigned : state.groups.find((g) => String(g.id) === String(target)).fileIds;
  const at = index == null ? list.length : Math.max(0, Math.min(index, list.length));
  list.splice(at, 0, id);
  invalidate();
  renderBoard();
}
function nudge(id, delta) {
  const loc = locate(id);
  const list = loc.group ? loc.group.fileIds : state.unassigned;
  const to = loc.pos + delta;
  if (to < 0 || to >= list.length) return;
  moveFile(id, loc.group ? loc.group.id : "pool", to);
}
function splitAt(id) {
  const loc = locate(id);
  if (!loc.group || loc.pos < 1) return;
  snapshot();
  const moved = loc.group.fileIds.splice(loc.pos);
  state.groups.splice(loc.gi + 1, 0, { id: nextId(), name: "", folder: "", fileIds: moved });
  invalidate();
  renderBoard();
}
function mergeUp(gi) {
  if (gi < 1) return;
  snapshot();
  state.groups[gi - 1].fileIds.push(...state.groups[gi].fileIds);
  state.groups.splice(gi, 1);
  invalidate();
  renderBoard();
}
function deleteGroup(gi) {
  snapshot();
  state.unassigned.push(...state.groups[gi].fileIds);
  state.groups.splice(gi, 1);
  invalidate();
  renderBoard();
}

/* ---------- board rendering ---------- */
function groupStatus(g) {
  const t = types();
  const n = g.fileIds.length;
  if (!n) return { cls: "warn", text: "Empty" };
  if (n === t.length) return { cls: "ok", text: `${n}/${t.length} complete` };
  if (n < t.length) return { cls: "warn", text: `${n}/${t.length} · missing ${t.slice(n).join(", ")}` };
  return { cls: "warn", text: `${n}/${t.length} · ${n - t.length} extra` };
}

function fileRow(id, gi, pos) {
  const f = fileById(id);
  const type = typeFor(gi, pos);
  const li = el("li", "file-row");
  li.draggable = true;
  li.dataset.id = id;
  if (id === state.selectedId) li.classList.add("selected");
  if (state.checked.has(id)) li.classList.add("checked");

  const grip = el("span", "grip", "⋮⋮");
  grip.setAttribute("aria-hidden", "true");
  const badge = el("span", "type-badge" + (type === "EXTRA" ? " extra" : ""), type);
  const name = el("button", "file-name", f.name);
  name.type = "button";
  name.title = `Preview ${f.name}`;
  name.addEventListener("click", () => selectFile(id));

  const tools = el("div", "row-tools");
  const list = gi >= 0 ? state.groups[gi].fileIds : state.unassigned;
  tools.append(
    iconBtn("Move up", "↑", () => nudge(id, -1), pos === 0),
    iconBtn("Move down", "↓", () => nudge(id, 1), pos === list.length - 1),
  );
  if (gi >= 0) tools.append(iconBtn("Start a new group from this file", "✂", () => splitAt(id), pos === 0));
  const sel = el("select", "move-select");
  sel.setAttribute("aria-label", "Move to another group");
  sel.append(new Option("Move…", ""));
  state.groups.forEach((g, i) => {
    if (i !== gi) sel.append(new Option(`Group ${i + 1}${g.name ? ` – ${g.name}` : ""}`, String(g.id)));
  });
  if (gi !== -1) sel.append(new Option("Unassigned", "pool"));
  sel.addEventListener("change", () => { if (sel.value) moveFile(id, sel.value); });
  tools.append(sel);

  li.append(grip, badge, name, tools);
  return li;
}

function groupCard(group, gi) {
  const isPool = !group;
  const card = el("section", "group-card" + (isPool ? " pool" : ""));
  card.dataset.group = isPool ? "pool" : group.id;
  const head = el("div", "gc-head");
  const title = el("strong", "", isPool ? `Unassigned (${state.unassigned.length})` : `Group ${gi + 1}`);
  head.append(title);
  if (!isPool) {
    const st = groupStatus(group);
    head.append(el("span", `pill ${st.cls}`, st.text));
    const acts = el("div", "gc-actions");
    acts.append(
      iconBtn("Merge into previous group", "⤒", () => mergeUp(gi), gi === 0),
      iconBtn("Delete group (files become unassigned)", "✕", () => deleteGroup(gi)),
    );
    head.append(acts);
  }
  card.append(head);

  if (!isPool) {
    const fields = el("div", "gc-fields");
    const name = el("input", "group-name");
    name.placeholder = "Patient / file name (required)";
    name.setAttribute("aria-label", `Group ${gi + 1} filename`);
    name.value = group.name;
    name.addEventListener("input", () => { group.name = name.value; invalidate(); });
    const folder = el("input", "group-folder");
    folder.placeholder = "Folder name (optional)";
    folder.setAttribute("aria-label", `Group ${gi + 1} folder name`);
    folder.value = group.folder;
    folder.addEventListener("input", () => { group.folder = folder.value; invalidate(); });
    fields.append(name, folder);
    card.append(fields);
  } else {
    card.append(el("p", "pool-note", "These PDFs won't be renamed until you drag them into a group."));
  }

  const ids = isPool ? state.unassigned : group.fileIds;
  const ul = el("ul", "file-list");
  ids.forEach((id, pos) => ul.append(fileRow(id, isPool ? -1 : gi, pos)));
  if (!ids.length) ul.append(el("li", "drop-hint", "Drop PDFs here"));
  card.append(ul);
  return card;
}

function renderBoard() {
  board.replaceChildren();
  if (!state.files.length) {
    board.append(el("p", "empty", "Choose PDFs to create groups."));
  } else {
    if (state.unassigned.length) board.append(groupCard(null));
    state.groups.forEach((g, gi) => board.append(groupCard(g, gi)));
  }
  renderCounts();
  updateViewer();
}

function renderCounts() {
  $("statFiles").textContent = state.files.length;
  $("statGroups").textContent = state.groups.length;
  const checkedOk = [...state.checked].filter((id) => state.rowFor.has(id)).length;
  $("statChecked").textContent = state.preview ? `${checkedOk}/${state.preview.rows.filter(isOk).length}` : "0";
}

/* ---------- drag & drop ---------- */
function clearDropMarks() {
  board.querySelectorAll(".drop-target,.drop-before,.drop-end").forEach((n) => n.classList.remove("drop-target", "drop-before", "drop-end"));
}
function dropIndex(card, y) {
  const rows = [...card.querySelectorAll(".file-row:not(.dragging)")];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) return { index: i, ref: rows[i] };
  }
  return { index: rows.length, ref: null };
}
board.addEventListener("dragstart", (e) => {
  const row = e.target.closest(".file-row");
  if (!row) return;
  state.dragId = Number(row.dataset.id);
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", row.dataset.id);
  requestAnimationFrame(() => row.classList.add("dragging"));
});
board.addEventListener("dragend", () => {
  state.dragId = null;
  clearDropMarks();
  board.querySelectorAll(".dragging").forEach((r) => r.classList.remove("dragging"));
});
board.addEventListener("dragover", (e) => {
  if (state.dragId == null) return;
  const card = e.target.closest(".group-card");
  if (!card) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  clearDropMarks();
  card.classList.add("drop-target");
  const { ref } = dropIndex(card, e.clientY);
  if (ref) ref.classList.add("drop-before");
  else card.querySelector(".file-list").classList.add("drop-end");
});
board.addEventListener("drop", (e) => {
  if (state.dragId == null) return;
  const card = e.target.closest(".group-card");
  if (!card) return;
  e.preventDefault();
  const { index } = dropIndex(card, e.clientY);
  const id = state.dragId;
  state.dragId = null;
  moveFile(id, card.dataset.group, index);
});

/* ---------- viewer ---------- */
function selectFile(id, opts = {}) {
  state.selectedId = id;
  document.querySelectorAll(".file-row, #previewRows tr[data-id]").forEach((n) => n.classList.toggle("selected", Number(n.dataset.id) === id));
  if (opts.reveal) {
    const row = board.querySelector(`.file-row[data-id="${id}"]`);
    if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const trow = previewRows.querySelector(`tr[data-id="${id}"]`);
    if (trow) trow.scrollIntoView({ block: "nearest" });
  }
  updateViewer();
  if (window.matchMedia("(max-width: 1100px)").matches) $("viewer").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function updateViewer() {
  const f = fileById(state.selectedId);
  const info = $("viewerInfo");
  const chk = $("viewerChecked");
  if (!f) {
    frame.hidden = true;
    $("viewerEmpty").hidden = false;
    info.hidden = true;
    chk.disabled = true;
    chk.checked = false;
    $("viewerPos").textContent = "Select a PDF to preview it.";
    return;
  }
  if (frame.dataset.id !== String(f.id)) {
    frame.src = `${f.url}#toolbar=1&navpanes=0&view=FitH`;
    frame.dataset.id = f.id;
  }
  frame.hidden = false;
  $("viewerEmpty").hidden = true;
  info.hidden = false;
  const loc = locate(f.id);
  const type = typeFor(loc.gi, loc.pos);
  const row = state.rowFor.get(f.id);
  $("viName").textContent = f.name;
  const badge = $("viType");
  badge.textContent = type;
  badge.classList.toggle("extra", type === "EXTRA");
  $("viGroup").textContent = loc.group ? `Group ${loc.gi + 1}${loc.group.name ? ` – ${loc.group.name}` : ""}` : "Unassigned";
  $("viNew").textContent = row ? (row.new || "— (no rename)") : "Run Analyze and preview to see the new name.";
  $("viNew").classList.toggle("muted", !row);
  chk.disabled = !row || !isOk(row);
  chk.checked = state.checked.has(f.id);
  const list = arranged();
  $("viewerPos").textContent = `File ${list.findIndex((x) => x.id === f.id) + 1} of ${list.length}`;
}

function step(delta) {
  const list = arranged();
  if (!list.length) return;
  const idx = list.findIndex((x) => x.id === state.selectedId);
  const next = idx < 0 ? list[0] : list[(idx + delta + list.length) % list.length];
  selectFile(next.id, { reveal: true });
}
$("prevFile").addEventListener("click", () => step(-1));
$("nextFile").addEventListener("click", () => step(1));
const expandViewerBtn = $("expandViewer");
function setViewerExpanded(expanded) {
  $("viewer").classList.toggle("expanded", expanded);
  expandViewerBtn.setAttribute("aria-expanded", String(expanded));
  expandViewerBtn.setAttribute("aria-label", expanded ? "Restore document preview size" : "Expand document preview");
  expandViewerBtn.textContent = expanded ? "Shrink" : "Expand";
}
expandViewerBtn.addEventListener("click", () => setViewerExpanded(!$("viewer").classList.contains("expanded")));
$("viewerChecked").addEventListener("change", (e) => setChecked(state.selectedId, e.target.checked));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("viewer").classList.contains("expanded")) {
    setViewerExpanded(false);
    expandViewerBtn.focus();
    return;
  }
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === "ArrowLeft") { step(-1); e.preventDefault(); }
  else if (e.key === "ArrowRight") { step(1); e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { undo(); e.preventDefault(); }
});

/* ---------- checks ---------- */
function setChecked(id, value) {
  if (value) state.checked.add(id); else state.checked.delete(id);
  const box = previewRows.querySelector(`tr[data-id="${id}"] input[type=checkbox]`);
  if (box) box.checked = value;
  board.querySelector(`.file-row[data-id="${id}"]`)?.classList.toggle("checked", value);
  if (id === state.selectedId) $("viewerChecked").checked = value;
  renderCounts();
  updateSummary();
}
$("checkAllBtn").addEventListener("click", () => {
  if (!state.preview) return;
  state.rowFor.forEach((row, id) => { if (isOk(row)) setChecked(id, true); });
});

/* ---------- preview (server) ---------- */
function invalidate() {
  if (state.preview) {
    state.preview = null;
    state.rowFor = new Map();
    state.checked.clear();
    $("stepReview").classList.add("stale");
    $("orderBanner").hidden = true;
    $("summary").textContent = "Arrangement changed — run Analyze and preview again.";
    $("checkAllBtn").disabled = true;
    renderReviewRows();
    renderCounts();
    updateViewer();
  }
  downloadBtn.disabled = true;
}

function updateSummary() {
  if (!state.preview) return;
  const rows = state.preview.rows;
  const safe = rows.filter(isOk).length;
  const checked = [...state.checked].filter((id) => state.rowFor.get(id) && isOk(state.rowFor.get(id))).length;
  $("summary").textContent = `${state.preview.pdf_count} PDF(s) · ${state.preview.group_count} group(s) · ${safe} safe rename(s) · ${checked}/${safe} checked`;
}

function renderReviewRows() {
  previewRows.replaceChildren();
  if (!state.preview) {
    const tr = el("tr");
    const td = el("td", "empty", $("stepReview").classList.contains("stale")
      ? "Arrangement changed. Run Analyze and preview again."
      : "Run Analyze and preview to see the proposed file names.");
    td.colSpan = 6;
    tr.append(td);
    previewRows.append(tr);
    return;
  }
  const fileForRow = new Map([...state.rowFor.entries()].map(([id, row]) => [row, id]));
  state.preview.rows.forEach((row, index) => {
    const tr = el("tr");
    const id = fileForRow.get(row);
    if (id != null) { tr.dataset.id = id; tr.classList.add("clickable"); }
    if (!isOk(row)) tr.classList.add("row-warning");
    if (id === state.selectedId) tr.classList.add("selected");
    const cb = el("td");
    const box = el("input");
    box.type = "checkbox";
    box.disabled = id == null || !isOk(row);
    box.checked = id != null && state.checked.has(id);
    box.setAttribute("aria-label", `Mark ${row.old} as checked`);
    box.addEventListener("click", (e) => e.stopPropagation());
    box.addEventListener("change", () => setChecked(id, box.checked));
    cb.append(box);
    tr.append(cb);
    [String(index + 1), row.old, row.group, row.new || "—", row.status].forEach((v) => tr.append(el("td", "", v)));
    if (id != null) tr.addEventListener("click", () => selectFile(id, { reveal: false }));
    previewRows.append(tr);
  });
}

function makeForm() {
  if (!state.files.length) throw new Error("Choose at least one PDF file.");
  const order = types();
  const inputs = orderList.querySelectorAll(".order-item input");
  if (!order.length || order.length !== inputs.length) throw new Error("Enter a document type in each order item.");
  if (new Set(order.map((v) => v.toUpperCase())).size !== order.length) throw new Error("Document types must be unique.");
  if (state.unassigned.length) throw new Error(`${state.unassigned.length} PDF(s) are unassigned. Drag them into a group first.`);
  state.groups.forEach((g, i) => { if (!g.fileIds.length) throw new Error(`Group ${i + 1} is empty. Add files or delete the group.`); });
  if (state.groups.some((g) => !g.name.trim())) throw new Error("Enter a name for every PDF group.");

  // Files are sent in the arranged order so every group is a contiguous range.
  const flat = arranged();
  const form = new FormData();
  flat.forEach(({ id }) => { const f = fileById(id); form.append("pdfs", f.file, f.name); });
  form.append("document_order", order.join(","));
  let cursor = 1;
  const groups = state.groups.map((g) => {
    const start = cursor;
    cursor += g.fileIds.length;
    return { name: g.name, folder: g.folder, start, end: cursor - 1 };
  });
  const assignments = [];
  state.groups.forEach((g, gi) => g.fileIds.forEach(() => assignments.push(gi)));
  form.append("groups", JSON.stringify(groups));
  form.append("assignments", JSON.stringify(assignments));
  form.append("sequence", JSON.stringify(flat.map(({ id }) => fileById(id).name)));
  return form;
}

previewBtn.addEventListener("click", async () => {
  saveOrder();
  invalidate();
  previewBtn.disabled = true;
  setStatus("Analyzing PDFs and group names...");
  try {
    const flat = arranged();
    const form = makeForm();
    const response = await fetch("/api/auto-rename/preview", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Preview failed.");

    const sameLength = data.rows.length === flat.length;
    const reordered = sameLength && data.rows.some((r, i) => r.old !== fileById(flat[i].id).name);
    state.preview = data;
    state.rowFor = new Map();
    data.rows.forEach((row, i) => {
      const f = sameLength && !reordered ? fileById(flat[i].id) : state.files.find((x) => x.name === row.old);
      if (f) state.rowFor.set(f.id, row);
    });
    const banner = $("orderBanner");
    banner.hidden = !reordered;
    if (reordered) banner.textContent = "The server processed the PDFs in a different order than the one you arranged, so renames may not follow your groups. Check the Group column carefully before downloading.";

    $("stepReview").classList.remove("stale");
    renderReviewRows();
    updateSummary();
    renderCounts();
    updateViewer();
    const safeCount = data.rows.filter(isOk).length;
    downloadBtn.disabled = safeCount === 0;
    $("checkAllBtn").disabled = safeCount === 0;
    setStatus(safeCount ? "Preview ready. Click rows to view each PDF and tick it once the new name is right." : "No safe rename candidates. Resolve the preview warnings first.", !safeCount);
    $("stepReview").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    previewBtn.disabled = false;
  }
});

/* ---------- clear / download ---------- */
function clearAll() {
  state.files.forEach((f) => URL.revokeObjectURL(f.url));
  pdfFiles.value = "";
  Object.assign(state, { files: [], groups: [], unassigned: [], selectedId: null, preview: null, rowFor: new Map(), undo: [] });
  state.checked.clear();
  undoBtn.disabled = true;
  frame.removeAttribute("src");
  delete frame.dataset.id;
  $("pdfHint").textContent = "Files are sorted naturally by filename.";
  $("stepReview").classList.remove("stale");
  $("orderBanner").hidden = true;
  $("summary").textContent = "Your proposed filenames will appear here.";
  $("checkAllBtn").disabled = true;
  downloadBtn.disabled = true;
  renderReviewRows();
  renderBoard();
  setStatus("Choose files to get started.");
}
clearBtn.addEventListener("click", clearAll);

function saveGeneratedFile(blob, filename) {
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

downloadBtn.addEventListener("click", async () => {
  if (!state.preview) return;
  const unchecked = [...state.rowFor.entries()].filter(([id, row]) => isOk(row) && !state.checked.has(id)).length;
  if (unchecked && !confirm(`${unchecked} rename(s) haven't been marked as checked. Download anyway?`)) return;
  downloadBtn.disabled = true;
  setStatus("Creating renamed PDF archive...");
  try {
    const response = await fetch("/api/auto-rename/run", { method: "POST", body: makeForm() });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Could not create the renamed archive.");
    }
    const saved = saveGeneratedFile(await response.blob(), "Renamed_PDFs.zip");
    setStatus(`ZIP saved: ${saved}. The selected originals remain unchanged.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    downloadBtn.disabled = !state.preview;
  }
});

renderBoard();
