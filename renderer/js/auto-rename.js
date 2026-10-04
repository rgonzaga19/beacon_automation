const pdfFiles = document.getElementById("pdfFiles");
const workbookFile = document.getElementById("workbookFile");
const orderList = document.getElementById("documentOrder");
const previewRows = document.getElementById("previewRows");
const previewBtn = document.getElementById("previewBtn");
const downloadBtn = document.getElementById("downloadBtn");
const status = document.getElementById("status");
let hasPreview = false;

function addDocumentType(value = "") {
  const item = document.createElement("label");
  item.className = "order-item";
  const input = document.createElement("input");
  input.value = value;
  input.maxLength = 24;
  input.placeholder = "TYPE";
  input.setAttribute("aria-label", "Document type");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "×";
  remove.title = "Remove document type";
  remove.addEventListener("click", () => { item.remove(); invalidatePreview(); });
  input.addEventListener("input", invalidatePreview);
  item.append(input, remove);
  orderList.append(item);
}

function invalidatePreview() {
  hasPreview = false;
  downloadBtn.disabled = true;
}

document.getElementById("addType").addEventListener("click", () => addDocumentType());
document.getElementById("templateBtn").addEventListener("click", () => {
  const count = orderList.querySelectorAll("input").length || 4;
  window.location.href = `/api/auto-rename/template?group_size=${count}`;
});
addDocumentType("CSF"); addDocumentType("CF4"); addDocumentType("PBEF"); addDocumentType("AF");

pdfFiles.addEventListener("change", () => {
  document.getElementById("pdfHint").textContent = `${pdfFiles.files.length} PDF file(s) selected. Files are sorted naturally by filename.`;
  invalidatePreview();
});
workbookFile.addEventListener("change", invalidatePreview);

function makeForm() {
  const files = [...pdfFiles.files];
  if (!files.length) throw new Error("Choose at least one PDF file.");
  if (!workbookFile.files[0]) throw new Error("Choose an Excel workbook.");
  const order = [...orderList.querySelectorAll("input")].map((input) => input.value.trim()).filter(Boolean);
  if (!order.length || order.length !== orderList.querySelectorAll("input").length) throw new Error("Enter a document type in each order item.");
  if (new Set(order.map((value) => value.toUpperCase())).size !== order.length) throw new Error("Document types must be unique.");
  const form = new FormData();
  files.forEach((file) => form.append("pdfs", file, file.name));
  form.append("workbook", workbookFile.files[0]);
  form.append("document_order", order.join(","));
  return form;
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

previewBtn.addEventListener("click", async () => {
  invalidatePreview();
  previewBtn.disabled = true;
  setStatus("Analyzing PDFs and workbook...");
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
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url; link.download = "Renamed_PDFs.zip"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("ZIP downloaded. The selected originals remain unchanged.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    downloadBtn.disabled = false;
  }
});
