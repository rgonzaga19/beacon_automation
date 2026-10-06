"""Web service helpers for the PDF auto rename workspace."""

import re
import zipfile
from io import BytesIO
from pathlib import Path

from openpyxl import Workbook


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


def create_preview(pdf_files, groups, assignments, document_order):
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
    group_size = len(order)
    if not isinstance(groups, list) or not groups or len(groups) > len(pdfs):
        raise ValueError("Choose between one group and one group per PDF.")
    if not isinstance(assignments, list) or len(assignments) != len(pdfs):
        raise ValueError("Assign every PDF to a group.")
    members = [[] for _ in groups]
    for pdf, group_index in zip(pdfs, assignments):
        if not isinstance(group_index, int) or isinstance(group_index, bool) or not 0 <= group_index < len(groups):
            raise ValueError("A PDF has an invalid group assignment.")
        members[group_index].append(pdf)
    if any(not group for group in members):
        raise ValueError("Each group must contain at least one PDF.")
    result = []
    for group, block in enumerate(members):
        group_data = groups[group] if isinstance(groups[group], dict) else {}
        name = safe_component(group_data.get("name", ""))
        folder = safe_component(group_data.get("folder", "")) or name
        group_status = "OK — named group" if name else "WARNING — blank group name"
        if len(block) != group_size:
            group_status = f"WARNING — group has {len(block)} PDF(s); expected {group_size}"
        for index, pdf in enumerate(block):
            doc_type = order[index] if index < group_size else "EXTRA"
            new_name = f"{name} - {doc_type}.pdf" if name else ""
            target = f"RENAMED/{folder}/{new_name}" if new_name and folder else ""
            row_status = group_status if index < group_size else "WARNING — too many PDFs in group"
            result.append({
                "old": Path(pdf.filename).name, "group": name, "new": new_name,
                "status": row_status, "group_no": group + 1, "doc_type": doc_type,
                "excel_row": "", "target": target,
            })
    targets = [row["target"].lower() for row in result if row["status"].startswith("OK") and row["target"]]
    if len(targets) != len(set(targets)):
        raise ValueError("The preview creates duplicate output filenames. Check the group names and folder names.")
    return pdfs, result, len(groups)


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
