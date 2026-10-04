"""Web service helpers for the PDF auto rename workspace."""

import re
import zipfile
from io import BytesIO
from pathlib import Path

from openpyxl import Workbook, load_workbook


def safe_component(value):
    value = re.sub(r"\s+", " ", str(value or "")).strip()
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", value).rstrip(" .")
    return value


def natural_key(filename):
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", filename)]


def build_template(group_size=4, num_groups=10):
    group_size = max(1, min(20, int(group_size)))
    num_groups = max(1, min(500, int(num_groups)))
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Filename Mapping"
    sheet.append(["Group", "File Name", "Folder Name (Optional)"])
    for group in range(num_groups):
        sheet.append([f"{group * group_size + 1}-{(group + 1) * group_size}", "", ""])
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    sheet.column_dimensions["A"].width = 18
    sheet.column_dimensions["B"].width = 34
    sheet.column_dimensions["C"].width = 34
    instructions = workbook.create_sheet("Instructions")
    instructions.append(["PDF AUTO-RENAME GROUP TEMPLATE"])
    instructions.append([f"Use one row for each group of {group_size} PDFs."])
    instructions.append(["Enter the filename in File Name. Do not include .pdf."])
    instructions.append(["Folder Name is optional; blank values use File Name."])
    instructions.column_dimensions["A"].width = 90
    return workbook


def create_preview(pdf_files, workbook_file, document_order):
    order = [safe_component(item).upper() for item in document_order if safe_component(item)]
    if not order or len(order) > 20 or len(set(order)) != len(order):
        raise ValueError("Choose between 1 and 20 unique document types in the document order.")
    pdfs = sorted(
        [item for item in pdf_files if item.filename and Path(item.filename).suffix.lower() == ".pdf"],
        key=lambda item: natural_key(Path(item.filename).name),
    )
    if not pdfs:
        raise ValueError("Choose at least one PDF file.")
    basenames = [Path(item.filename).name.casefold() for item in pdfs]
    if len(basenames) != len(set(basenames)):
        raise ValueError("PDF filenames must be unique so each selected file can be matched safely.")
    if not workbook_file or not workbook_file.filename or Path(workbook_file.filename).suffix.lower() not in {".xlsx", ".xlsm"}:
        raise ValueError("Choose an Excel workbook (.xlsx or .xlsm).")

    workbook_file.stream.seek(0)
    workbook = load_workbook(workbook_file.stream, read_only=True, data_only=True)
    try:
        values = list(workbook.active.iter_rows(values_only=True))
    finally:
        workbook.close()
    if not values:
        raise ValueError("The Excel file is empty.")
    headers = [re.sub(r"\s+", " ", str(value or "")).strip() or f"Column {i + 1}" for i, value in enumerate(values[0])]
    rows = [list(row) for row in values[1:]]
    if not rows:
        raise ValueError("The Excel file has no data rows.")
    name_index = next((i for i, header in enumerate(headers) if header.strip().upper() in {
        "FILE NAME", "FILENAME", "LAST NAME", "LASTNAME", "SURNAME", "PATIENT NAME", "NAME"
    }), 0)
    group_index = next((i for i, header in enumerate(headers) if header.strip().upper() in {
        "GROUP", "GROUP #", "GROUP NO", "GROUP NUMBER"
    }), None)
    folder_index = next((i for i, header in enumerate(headers) if header.strip().upper() in {
        "FOLDER NAME", "FOLDER", "FOLDER NAME (OPTIONAL)", "OUTPUT FOLDER", "GROUP FOLDER", "FOLDER FILENAME"
    }), None)

    group_size = len(order)
    group_count = (len(pdfs) + group_size - 1) // group_size
    result = []
    for group in range(group_count):
        block = pdfs[group * group_size:(group + 1) * group_size]
        excel_row = rows[group] if group < len(rows) else []
        name = safe_component(excel_row[name_index] if name_index < len(excel_row) else "")
        folder = safe_component(excel_row[folder_index] if folder_index is not None and folder_index < len(excel_row) else "") or name
        first, last = group * group_size + 1, (group + 1) * group_size
        group_status = "OK — Excel group" if name else "WARNING — blank Excel filename"
        if group_index is not None and group < len(rows):
            match = re.fullmatch(r"\s*(\d+)\s*[-–—]\s*(\d+)\s*", str(excel_row[group_index] or ""))
            if not match or (int(match.group(1)), int(match.group(2))) != (first, last):
                group_status = f"WARNING — expected Group {first}-{last}"
        if len(block) < group_size:
            group_status = "WARNING — incomplete PDF group"
        for index, pdf in enumerate(block):
            doc_type = order[index]
            new_name = f"{name} - {doc_type}.pdf" if name else ""
            target = f"RENAMED/{folder}/{new_name}" if new_name and folder else ""
            result.append({
                "old": Path(pdf.filename).name, "group": name, "new": new_name,
                "status": group_status, "group_no": group + 1, "doc_type": doc_type,
                "excel_row": group + 2, "target": target,
            })
    if len(rows) < group_count:
        result.append({"old": "", "group": "", "new": "", "status": f"WARNING — {group_count - len(rows)} PDF group(s) have no Excel row", "group_no": "", "doc_type": "", "excel_row": "", "target": ""})
    targets = [row["target"].lower() for row in result if row["status"].startswith("OK") and row["target"]]
    if len(targets) != len(set(targets)):
        raise ValueError("The preview creates duplicate output filenames. Check the Excel filename values.")
    return pdfs, result, group_count


def build_renamed_archive(pdfs, rows):
    by_name = {Path(item.filename).name: item for item in pdfs}
    archive = BytesIO()
    included = 0
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
        for row in rows:
            if not row["status"].startswith("OK") or not row["target"]:
                continue
            source = by_name.get(row["old"])
            if source is None:
                continue
            source.stream.seek(0)
            output.writestr(row["target"], source.stream.read())
            included += 1
    if not included:
        raise ValueError("There are no safe files to rename. Resolve the preview warnings first.")
    archive.seek(0)
    return archive, included
