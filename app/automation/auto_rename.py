# PDF Auto Rename
# Modern Windows GUI + Excel-driven grouping and configurable document order.
import os, re, sys, threading, zipfile, csv, shutil, json
from pathlib import Path
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog

import fitz
import pytesseract
from PIL import Image
from openpyxl import Workbook, load_workbook

APP_TITLE = "PDF Auto Rename"
BASE_DOCS = ("CSF", "CF4", "PBEF", "AF")
FIVE_DOCS = ("CSF", "CF4", "PBEF", "AF", "DTR")

BG = "#f4f6f8"
CARD = "#ffffff"
TEXT = "#1f2937"
MUTED = "#6b7280"
PRIMARY = "#0b6b57"
PRIMARY_DARK = "#075244"
BORDER = "#dfe5e8"
GOOD = "#13795b"
WARN = "#a15c00"
BAD = "#b42318"

LIGHT_THEME = {
    "BG": "#f4f6f8", "CARD": "#ffffff", "TEXT": "#1f2937", "MUTED": "#6b7280",
    "PRIMARY": "#0b6b57", "PRIMARY_DARK": "#075244", "BORDER": "#dfe5e8",
    "GOOD": "#13795b", "WARN": "#a15c00", "BAD": "#b42318",
    "SOFT": "#eef2f3", "ENTRY": "#f7f9fa", "PROGRESS": "#e8edef",
    "SELECT": "#dcefe9", "HEADER_TEXT": "#c5e6de", "HEADER_SUB": "#d7eee8",
}
DARK_THEME = {
    "BG": "#171a1c", "CARD": "#23272a", "TEXT": "#f3f4f6", "MUTED": "#a9b0b6",
    "PRIMARY": "#16806b", "PRIMARY_DARK": "#0e5d4e", "BORDER": "#3a4247",
    "GOOD": "#5fc49d", "WARN": "#e0a35a", "BAD": "#ef8b84",
    "SOFT": "#30363a", "ENTRY": "#2b3034", "PROGRESS": "#3a4247",
    "SELECT": "#244d43", "HEADER_TEXT": "#d4eee7", "HEADER_SUB": "#c4e5dd",
}

def apply_theme_constants(theme):
    globals().update({k: v for k, v in theme.items() if k in {
        "BG","CARD","TEXT","MUTED","PRIMARY","PRIMARY_DARK","BORDER","GOOD","WARN","BAD",
        "SOFT","ENTRY","PROGRESS","SELECT","HEADER_TEXT","HEADER_SUB"
    }})


def resource_path(*parts):
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return base.joinpath(*parts)


def find_tesseract():
    candidates = [
        resource_path("Tesseract-OCR", "tesseract.exe"),
        Path(__file__).resolve().parent / "Tesseract-OCR" / "tesseract.exe",
        Path(os.environ.get("ProgramFiles", r"C:\\Program Files")) / "Tesseract-OCR" / "tesseract.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Tesseract-OCR" / "tesseract.exe",
    ]
    for p in candidates:
        if p.exists():
            return str(p)
    return shutil.which("tesseract") or ""

TESSERACT = find_tesseract()
if TESSERACT:
    pytesseract.pytesseract.tesseract_cmd = TESSERACT


def normalize(s):
    return re.sub(r"\s+", " ", (s or "").replace("\x00", " ")).strip()


def natural_key(path):
    return [int(x) if x.isdigit() else x.lower() for x in re.split(r"(\d+)", path.name)]


def detect_form(text, filename=""):
    t = normalize(text).upper()
    f = filename.upper()
    for typ in ("CSF", "CF4", "PBEF", "AF", "DTR"):
        if re.search(rf"(?<![A-Z0-9]){typ}(?![A-Z0-9])", f):
            return typ
    checks = [
        ("CSF", [r"CLAIM\s+SIGNATURE\s+FORM", r"5\.\s*NAME\s+OF\s+PATIENT", r"NAME\s+OF\s+PATIENT"]),
        ("CF4", [r"\bCF\s*4\b", r"CLINICAL\s+CASE\s+SUMMARY", r"CLAIM\s+FORM\s*4"]),
        ("PBEF", [r"\bPBEF\b", r"PROOF\s+OF\s+BENEFIT\s+ELIGIBILITY"]),
        ("AF", [r"AGREEMENT\s+FORM", r"ANNEX\s*-?\s*F", r"AUTHORIZATION\s+FORM"]),
    ]
    for typ, patterns in checks:
        if any(re.search(p, t, re.I) for p in patterns):
            return typ
    return "UNKNOWN"


def safe_name(s):
    s = normalize(s).upper()
    s = re.sub(r'[^A-Z0-9 .\'-]', '', s)
    s = re.sub(r'\s+', ' ', s).strip(" .-")
    return s


def extract_text_first_pages(path, max_pages=2):
    """Very fast path: read embedded PDF text without OCR."""
    texts=[]
    doc=fitz.open(path)
    try:
        for i in range(min(len(doc), max_pages)):
            texts.append(normalize(doc[i].get_text("text")))
    finally:
        doc.close()
    return "\n".join(t for t in texts if t)


def ocr_page_data(path, page_index=0, dpi=150):
    """OCR one page once and return word boxes. This is the only expensive step."""
    doc=fitz.open(path)
    try:
        if page_index >= len(doc):
            return []
        page=doc[page_index]
        scale=dpi/72.0
        pix=page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        img=Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
    finally:
        doc.close()
    try:
        data=pytesseract.image_to_data(img, config="--psm 11", output_type=pytesseract.Output.DICT)
    except Exception:
        return []
    words=[]
    n=len(data.get("text", []))
    for i in range(n):
        w=normalize(data["text"][i]).upper()
        if not w:
            continue
        try:
            x,y,ww,hh,conf=(int(data[k][i]) for k in ("left","top","width","height","conf"))
        except Exception:
            continue
        words.append({"w":w,"x":x,"y":y,"ww":ww,"hh":hh,"conf":conf})
    return words


def _is_name_word(w):
    """Accept normal surname words while rejecting common form labels."""
    w = normalize(w).upper().replace("’", "'").replace("–", "-")
    if not re.fullmatch(r"[A-Z][A-Z'’-]{1,35}", w):
        return False
    return w not in {
        "LAST", "NAME", "FIRST", "MIDDLE", "RELATIONSHIP", "MEMBER",
        "PATIENT", "OF", "SEX", "AGE", "DATE", "BIRTH", "ADDRESS",
        "HOSPITAL", "NUMBER", "PHILHEALTH", "SIGNATURE",
        "FIRSTNAME", "FIRST", "MIDDLE", "MIDDLENAME", "SURNAME",
        "RELATIONSHIP", "MEMBER", "DEPENDENT", "SUFFIX", "PREFIX",
        "LASTNAME", "LAST-NAME", "LAST_NAME"
    }


def _surname_from_field_text(raw):
    """Extract a real Last Name value from embedded PDF text.

    PhilHealth forms often contain the field captions themselves (for example
    ``LAST NAME FIRSTNAME MIDDLENAME``) in the PDF text layer.  Those captions
    are NOT patient data, so never treat them as a surname.  Prefer an explicit
    ``LAST NAME: value`` pattern; otherwise leave the job to OCR/coordinates.
    """
    raw = (raw or "").replace("\x00", " ")
    lines = [normalize(x).upper() for x in raw.splitlines() if normalize(x)]

    for line in lines:
        # Strong form: LAST NAME: DELA CRUZ
        m = re.search(
            r"\bLAST\s*[-_ ]?\s*NAME\b\s*[:#=]+\s*"
            r"([A-Z][A-Z'’-]*(?:\s+[A-Z][A-Z'’-]*){0,3})",
            line, re.I
        )
        if m:
            candidate = safe_name(m.group(1))
            words = candidate.split()
            # Do not accept form captions/placeholders as patient data.
            if words and all(_is_name_word(w) for w in words):
                return candidate

        # Some generated PDFs use LAST NAME - DELA CRUZ.
        m = re.search(
            r"\bLAST\s*[-_ ]?\s*NAME\b\s*[-–—]\s*"
            r"([A-Z][A-Z'’-]*(?:\s+[A-Z][A-Z'’-]*){0,3})",
            line, re.I
        )
        if m:
            candidate = safe_name(m.group(1))
            words = candidate.split()
            if words and all(_is_name_word(w) for w in words):
                return candidate

    # Deliberately do NOT infer a surname merely because words appear near the
    # LAST NAME caption.  The text layer of the CSF can contain the labels for
    # LAST NAME / FIRST NAME / MIDDLE NAME on the same line. OCR handles the
    # actual filled-in field using coordinates below.
    return ""


def _group_words_on_line(words, target_y, y_tol):
    selected = [
        w for w in words
        if _is_name_word(w["w"]) and abs((w["y"] + w["hh"] / 2) - target_y) <= y_tol
    ]
    return sorted(selected, key=lambda w: w["x"])


def csf_last_name_from_words(words):
    """Read the actual value printed in the CSF Last Name field.

    The PhilHealth CSF has the value ABOVE the small "Last Name" caption.
    The three name fields are side-by-side, so the OCR search must stay inside
    the horizontal column belonging to the Last Name field.  This prevents
    values such as FIRSTNAME/LOLITA from being accidentally included.
    """
    if not words:
        return ""

    labels = []
    for i, a in enumerate(words):
        if a["w"] == "LAST":
            for j in range(i + 1, min(i + 7, len(words))):
                b = words[j]
                if b["w"] == "NAME" and abs(a["y"] - b["y"]) <= max(45, a["hh"] * 2):
                    labels.append((a, b))
                    break
        elif a["w"] in {"LASTNAME", "LAST-NAME", "LAST_NAME"}:
            labels.append((a, a))

    # These are common words printed on the CSF itself, never patient data.
    blocked = {
        "LAST", "NAME", "FIRST", "MIDDLE", "FIRSTNAME", "MIDDLENAME",
        "LASTNAME", "SURNAME", "MEMBER", "PATIENT", "OF", "DATE",
        "BIRTH", "RELATIONSHIP", "SIGNATURE", "PHILHEALTH"
    }

    for a, b in labels:
        left = min(a["x"], b["x"])
        right = max(a["x"] + a["ww"], b["x"] + b["ww"])
        cx = (left + right) / 2
        label_top = min(a["y"], b["y"])
        label_h = max(a["hh"], b["hh"])

        # On the standard CSF, the filled value is directly above the caption.
        # Keep a deliberately narrow horizontal window so FIRST NAME / MIDDLE
        # NAME cannot leak into the Last Name result.
        field_left = left - 105
        field_right = right + 105
        candidates = []
        for w in words:
            token = w["w"]
            if token in blocked or not _is_name_word(token):
                continue
            center = w["x"] + w["ww"] / 2
            if not (field_left <= center <= field_right):
                continue
            bottom = w["y"] + w["hh"]
            gap = label_top - bottom
            if gap < 0 or gap > 65:
                continue
            candidates.append(w)

        if not candidates:
            continue

        # Cluster words that are on the same OCR line. Compound surnames such
        # as DELA CRUZ therefore stay together.
        lines = []
        for w in sorted(candidates, key=lambda q: (q["y"], q["x"])):
            yc = w["y"] + w["hh"] / 2
            placed = False
            for line in lines:
                if abs(line["y"] - yc) <= max(10, w["hh"]):
                    line["words"].append(w)
                    line["y"] = sum(q["y"] + q["hh"] / 2 for q in line["words"]) / len(line["words"])
                    placed = True
                    break
            if not placed:
                lines.append({"y": yc, "words": [w]})

        ranked = []
        for line in lines:
            ws = sorted(line["words"], key=lambda q: q["x"])
            # Reject a line that is actually far from the field center.
            center = sum(q["x"] + q["ww"] / 2 for q in ws) / len(ws)
            gap = label_top - max(q["y"] + q["hh"] for q in ws)
            score = gap + abs(center - cx) * 0.10
            ranked.append((score, ws))

        ranked.sort(key=lambda item: (item[0], -sum(float(q["conf"]) for q in item[1])))
        if ranked:
            value = safe_name(" ".join(q["w"] for q in ranked[0][1]))
            if value and all(_is_name_word(q) for q in value.split()):
                return value

    return ""

def extract_csf_last_name(path, status_cb=None):
    """Read the surname from the CSF only; support compound surnames."""
    text = extract_text_first_pages(path, max_pages=2)
    if text:
        value = _surname_from_field_text(text)
        if value:
            return value, "CSF Last Name field (PDF text)"

        # Some CSFs expose only PATIENT NAME in the text layer. If it contains
        # an actual filled-in name, infer the surname conservatively.
        lines = [normalize(x).upper() for x in text.splitlines() if normalize(x)]
        for line in lines:
            m = re.search(
                r"\bPATIENT\s+NAME\b\s*[:#=-]\s*"
                r"([A-Z][A-Z'’-]*(?:\s+[A-Z][A-Z'’-]*){1,5})",
                line, re.I
            )
            if not m:
                continue
            full = safe_name(m.group(1))
            parts = [w for w in full.split() if _is_name_word(w)]
            if len(parts) < 2:
                continue
            particles = {
                "DELA", "DE", "DEL", "LA", "VAN", "VON", "SAN", "SANTA",
                "ST", "STA", "DOS", "DAS"
            }
            if len(parts) >= 2 and parts[-2] in particles:
                return " ".join(parts[-2:]), "CSF Patient Name fallback"
            return parts[-1], "CSF Patient Name fallback"

    if status_cb:
        status_cb("Reading CSF Last Name (fast OCR)…")
    words = ocr_page_data(path, 0, dpi=150)
    value = csf_last_name_from_words(words)
    if value:
        return value, "CSF Last Name field (OCR)"

    words = ocr_page_data(path, 1, dpi=150)
    value = csf_last_name_from_words(words)
    if value:
        return value, "CSF Last Name field (OCR page 2)"

    return "", ""

def detect_form_fast(path):
    """Optional lightweight validation based on filename/text; never used for grouping."""
    text=extract_text_first_pages(path,1)
    return detect_form(text,path.name)


def build_group_template(group_size=4, num_groups=10):
    """Create the simple Excel template used by the app.

    One Excel row represents one patient/group.  The Group column contains the
    PDF number range (for example 1-4, 5-8, 9-12) and File Name contains the
    single filename base for that whole group.  The range is generated from
    the current Document Order count selected in the app.
    """
    group_size = max(1, int(group_size))
    num_groups = max(1, int(num_groups))

    wb = Workbook()
    ws = wb.active
    ws.title = "Filename Mapping"
    ws.append(["Group", "File Name", "Folder Name (Optional)"])
    for g in range(num_groups):
        first = g * group_size + 1
        last = (g + 1) * group_size
        ws.append([f"{first}-{last}", ""])

    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    ws.column_dimensions["A"].width = 16
    ws.column_dimensions["B"].width = 34
    ws.column_dimensions["C"].width = 34

    ins = wb.create_sheet("Instructions")
    ins.append(["PHILHEALTH AUTO-RENAME — EXCEL GROUP TEMPLATE"])
    ins.append([f"Current Document Order: {group_size} document(s) per patient/group."])
    ins.append(["Enter ONE filename only for each group in the File Name column."])
    ins.append(["Optional: enter a custom folder name in Folder Name (Optional). If left blank, the File Name is used as the folder name."])
    ins.append([f"Example: Group 1-{group_size} = DELA CRUZ; next group = CRUZ."])
    ins.append(["The app uses the Group range and expands it across the PDF upload/order sequence."])
    ins.append(["Do not type .pdf. The app adds the document type and .pdf automatically."])
    ins.column_dimensions["A"].width = 110
    return wb


def group_ranges_from_count(group_size, num_groups):
    group_size = max(1, int(group_size))
    return [f"{g * group_size + 1}-{(g + 1) * group_size}" for g in range(max(1, int(num_groups)))]


def load_last_name_mapping(path):
    """Load an Excel mapping. Preferred columns are CSF Filename + Last Name.
    Group # + Last Name is also supported for convenience.
    """
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    if not rows:
        raise ValueError("The Excel file is empty.")
    headers = [normalize(str(x or "")).upper() for x in rows[0]]
    def col(*names):
        for name in names:
            if name in headers:
                return headers.index(name)
        return None
    last_i = col("LAST NAME", "LASTNAME", "SURNAME")
    csf_i = col("CSF FILENAME", "CSF", "ORIGINAL PDF", "FILENAME")
    group_i = col("GROUP #", "GROUP", "GROUP NO", "GROUP NUMBER")
    if last_i is None:
        raise ValueError("Excel must have a 'Last Name' column.")
    if csf_i is None and group_i is None:
        raise ValueError("Excel must have either 'CSF Filename' or 'Group #' column.")

    by_csf = {}
    by_group = {}
    for row in rows[1:]:
        if not row:
            continue
        last = safe_name(str(row[last_i] or "")) if last_i < len(row) else ""
        if not last:
            continue
        if csf_i is not None and csf_i < len(row) and row[csf_i]:
            key = Path(str(row[csf_i]).strip()).name.upper()
            by_csf[key] = last
        if group_i is not None and group_i < len(row) and row[group_i] not in (None, ""):
            try:
                by_group[int(float(row[group_i]))] = last
            except Exception:
                pass
    return by_csf, by_group




def excel_filename_value(value):
    """Convert an Excel cell into a Windows-safe filename base without
    changing its capitalization or spelling. The Excel cell is the source
    of truth; only characters forbidden by Windows filenames are removed.
    """
    s = normalize(str(value or ""))
    s = re.sub(r'[<>:"/\\|?*]', '', s)
    s = re.sub(r'[\. ]+$', '', s).strip()
    return s


def read_excel_filename_source(path):
    """Read the first worksheet and return (headers, data_rows)."""
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    if not rows:
        return [], []
    raw_headers = list(rows[0])
    headers = []
    seen = {}
    for i, value in enumerate(raw_headers):
        h = normalize(str(value or "")).strip() or f"Column {i+1}"
        if h in seen:
            seen[h] += 1
            h = f"{h} ({seen[h]})"
        else:
            seen[h] = 1
        headers.append(h)
    data = [list(r) for r in rows[1:]]
    return headers, data


def find_optional_folder_column(headers):
    """Find an optional Excel column used to override the group folder name."""
    aliases = {
        "FOLDER NAME", "FOLDER", "FOLDER NAME (OPTIONAL)",
        "OUTPUT FOLDER", "GROUP FOLDER", "FOLDER FILENAME"
    }
    for i, h in enumerate(headers):
        if h.strip().upper() in aliases:
            return i
    return None

class App:
    def __init__(self, root):
        self.root = root
        self.root.title(APP_TITLE)
        self.root.geometry("1280x760")
        self.root.minsize(900, 600)
        self.root.configure(bg=BG)
        self.folder = ""
        self.excel_path = ""
        self.excel_headers = []
        self.excel_names = []
        self.excel_rows = []
        self.rows = []
        self.busy = False

        # User-configurable document order. This is intentionally independent
        # from the contents of the PDFs: the order is simply numeric/page order.
        self.settings_path = Path(os.environ.get("APPDATA", str(Path.home()))) / "PhilHealthAutoRename" / "settings.json"
        display = self._load_display_settings()
        self.theme_name = display.get("theme", "Light")
        self.ui_scale = float(display.get("ui_scale", 0.88))
        self.font_size = int(display.get("font_size", 10))
        apply_theme_constants(DARK_THEME if self.theme_name == "Dark" else LIGHT_THEME)
        try:
            self.root.tk.call("tk", "scaling", self.ui_scale)
        except Exception:
            pass
        self.doc_types = self._load_doc_types()
        self.doc_count_var = tk.IntVar(value=4)
        self.doc_vars = []
        self.doc_combos = []
        self.column_var = tk.StringVar(value="")
        self.template_preview_var = tk.StringVar(value="Excel template groups: 1-4, 5-8, 9-12...")

        self._build_style()
        self._build_ui()
        self._rebuild_document_order()

    def _load_display_settings(self):
        defaults = {"theme": "Light", "ui_scale": 0.88, "font_size": 10}
        try:
            if self.settings_path.exists():
                data = json.loads(self.settings_path.read_text(encoding="utf-8"))
                saved = data.get("display", {})
                if isinstance(saved, dict):
                    defaults.update(saved)
        except Exception:
            pass
        if defaults.get("theme") not in ("Light", "Dark"):
            defaults["theme"] = "Light"
        try:
            defaults["ui_scale"] = min(1.25, max(0.70, float(defaults["ui_scale"])))
        except Exception:
            defaults["ui_scale"] = 0.88
        try:
            defaults["font_size"] = min(16, max(8, int(defaults["font_size"])))
        except Exception:
            defaults["font_size"] = 10
        return defaults

    def _save_display_settings(self):
        try:
            self.settings_path.parent.mkdir(parents=True, exist_ok=True)
            data = {}
            if self.settings_path.exists():
                try:
                    data = json.loads(self.settings_path.read_text(encoding="utf-8"))
                except Exception:
                    data = {}
            data["display"] = {
                "theme": self.theme_name,
                "ui_scale": self.ui_scale,
                "font_size": self.font_size,
            }
            data["document_types"] = self.doc_types
            self.settings_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except Exception as e:
            messagebox.showwarning(APP_TITLE, f"Could not save display settings:\n{e}")

    def _open_instructions(self):
        win = tk.Toplevel(self.root)
        win.title("How to Use — PDF Auto Rename")
        win.geometry("760x680")
        win.minsize(620, 520)
        win.configure(bg=BG)
        win.transient(self.root)

        header = tk.Frame(win, bg=PRIMARY, height=76)
        header.pack(fill="x")
        header.pack_propagate(False)
        tk.Label(header, text="How to Use PDF Auto Rename", bg=PRIMARY, fg=HEADER_TEXT,
                 font=("Segoe UI Semibold", self.font_size+4)).pack(anchor="w", padx=22, pady=(12,0))
        tk.Label(header, text="Step-by-step procedure", bg=PRIMARY, fg=HEADER_TEXT,
                 font=("Segoe UI", max(8, self.font_size-1))).pack(anchor="w", padx=22)

        outer = tk.Frame(win, bg=BG)
        outer.pack(fill="both", expand=True, padx=14, pady=14)
        canvas = tk.Canvas(outer, bg=BG, highlightthickness=0)
        scroll = ttk.Scrollbar(outer, orient="vertical", command=canvas.yview)
        body = tk.Frame(canvas, bg=BG)
        body.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.create_window((0,0), window=body, anchor="nw", tags="body")
        canvas.bind("<Configure>", lambda e: canvas.itemconfigure("body", width=e.width))
        canvas.configure(yscrollcommand=scroll.set)
        canvas.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")

        steps = [
            ("1", "Prepare your PDF files", "Put all PDF documents for processing in one folder. The app uses the numeric/file order in that folder to create groups."),
            ("2", "Choose PDF Folder", "Click 01 PDF Folder → Browse and select the folder containing the PDFs you want to rename."),
            ("3", "Prepare or download the Excel template", "Click Download Excel Template. The Group ranges are based on the number of PDFs in the selected folder and the Documents setting. For example, with 8 PDFs and Documents = 4, the template uses Group 1-4 and Group 5-8."),
            ("4", "Enter the group names in Excel", "Put one filename/patient value per group row. Example: Group 1-4 = DELA CRUZ; Group 5-8 = CRUZ. The Excel File Name value is used as the destination folder name by default. You may optionally fill in Folder Name (Optional) to use a different folder name for that group."),
            ("5", "Select the Excel file", "Click 02 Excel Filename Source → Browse Excel, then select your completed Excel file. Choose the column containing the names/filename values."),
            ("6", "Set Documents per Group", "In 03 Document Order, choose how many documents belong to one group, such as 4 or 5. The group ranges are automatically recalculated."),
            ("7", "Set the Document Order", "Choose the document type for each position. Example for 4 documents: 1 = CSF, 2 = PBEF, 3 = AF, 4 = CF4. The order is based on PDF order, not PDF content."),
            ("8", "Customize document types (optional)", "Click Manage Document Types to add, edit, delete, or reorder document labels. Changes are saved and reused the next time you open the app."),
            ("9", "Analyze / Preview", "Click Analyze / Preview. Review the old filename, Group, new filename, and status before making any changes."),
            ("10", "Rename and organize", "Click Rename All and confirm. The app creates a RENAMED folder beside the original PDF folder, then creates ONE folder per Excel group. By default the folder uses File Name; if Folder Name (Optional) is filled in, that value is used instead."),
            ("11", "Understand the output", "Example: Group 1-4 = DELA CRUZ creates RENAMED\DELA CRUZ\ by default. If Folder Name (Optional) is set to CRUZ FILES, the same group goes into RENAMED\CRUZ FILES\ instead. All document types for that group stay together in that one folder."),
            ("12", "Display Settings", "Click Settings to change Light/Dark Mode, Font Size, and UI Scale. Your display preferences are saved automatically."),
        ]

        for num, title, desc in steps:
            card = tk.Frame(body, bg=CARD, highlightbackground=BORDER, highlightthickness=1)
            card.pack(fill="x", pady=(0,9), padx=2)
            badge = tk.Label(card, text=num, bg=PRIMARY, fg="white", width=4,
                             font=("Segoe UI Semibold", max(9, self.font_size)))
            badge.pack(side="left", padx=(10,12), pady=12, anchor="n")
            content = tk.Frame(card, bg=CARD)
            content.pack(side="left", fill="both", expand=True, padx=(0,12), pady=10)
            tk.Label(content, text=title, bg=CARD, fg=TEXT,
                     font=("Segoe UI Semibold", self.font_size+1)).pack(anchor="w")
            tk.Label(content, text=desc, bg=CARD, fg=MUTED, justify="left", anchor="w",
                     wraplength=620, font=("Segoe UI", max(8, self.font_size-1))).pack(anchor="w", pady=(3,0))

        note = tk.Frame(body, bg=SOFT, highlightbackground=BORDER, highlightthickness=1)
        note.pack(fill="x", padx=2, pady=(2,12))
        tk.Label(note, text="IMPORTANT", bg=SOFT, fg=TEXT,
                 font=("Segoe UI Semibold", self.font_size)).pack(anchor="w", padx=12, pady=(10,2))
        tk.Label(note, text="Original PDFs stay in the original folder. Renamed copies/moved files are organized under the automatically created RENAMED folder. Each Excel group gets one folder containing all document types in that group.",
                 bg=SOFT, fg=TEXT, justify="left", wraplength=680,
                 font=("Segoe UI", max(8, self.font_size-1))).pack(anchor="w", padx=12, pady=(0,10))

        btnbar = tk.Frame(win, bg=BG)
        btnbar.pack(fill="x", padx=20, pady=(0,14))
        self._button(btnbar, "Close", win.destroy, primary=True).pack(side="right")

    def _open_display_settings(self):
        win = tk.Toplevel(self.root)
        win.title("Display Settings")
        win.geometry("430x330")
        win.configure(bg=BG)
        win.transient(self.root)
        win.grab_set()

        tk.Label(win, text="Display Settings", bg=BG, fg=TEXT,
                 font=("Segoe UI Semibold", 15)).pack(anchor="w", padx=20, pady=(18,2))
        tk.Label(win, text="Customize the appearance of PDF Auto Rename.", bg=BG, fg=MUTED,
                 font=("Segoe UI", self.font_size-1)).pack(anchor="w", padx=20, pady=(0,14))

        form = tk.Frame(win, bg=CARD, highlightbackground=BORDER, highlightthickness=1)
        form.pack(fill="both", expand=True, padx=20, pady=4)

        theme_var = tk.StringVar(value=self.theme_name)
        font_var = tk.StringVar(value=str(self.font_size))
        scale_pct = int(round(self.ui_scale * 100))
        scale_var = tk.StringVar(value=str(scale_pct))

        def field(label, variable, values):
            row = tk.Frame(form, bg=CARD)
            row.pack(fill="x", padx=16, pady=(14,0))
            tk.Label(row, text=label, bg=CARD, fg=TEXT, font=("Segoe UI Semibold", 9)).pack(side="left")
            cb = ttk.Combobox(row, textvariable=variable, values=values, state="readonly", width=17)
            cb.pack(side="right")
            return cb

        field("Theme", theme_var, ["Light", "Dark"])
        field("Font Size", font_var, ["8","9","10","11","12","13","14","16"])
        field("UI Scale", scale_var, ["75","80","88","90","100","110","120","125"])

        tk.Label(form, text="UI Scale changes the overall interface size. Font Size controls text size.",
                 bg=CARD, fg=MUTED, font=("Segoe UI", max(8,self.font_size-2)), wraplength=350, justify="left").pack(anchor="w", padx=16, pady=14)

        buttons = tk.Frame(win, bg=BG)
        buttons.pack(fill="x", padx=20, pady=14)

        def apply():
            self.theme_name = theme_var.get()
            self.font_size = int(font_var.get())
            self.ui_scale = int(scale_var.get()) / 100.0
            apply_theme_constants(DARK_THEME if self.theme_name == "Dark" else LIGHT_THEME)
            try:
                self.root.tk.call("tk", "scaling", self.ui_scale)
            except Exception:
                pass
            self._save_display_settings()
            # Rebuild the interface so all cards, labels, entries and buttons
            # receive the selected theme and font scale consistently.
            current_folder = self.folder
            current_excel = self.excel_path
            current_count = self.doc_count_var.get()
            current_rows = list(self.rows)
            current_status = self.status_var.get() if hasattr(self, "status_var") else "Ready — select PDF folder, Excel, and document order."
            for child in list(self.root.winfo_children()):
                if child is not win:
                    child.destroy()
            self.doc_vars = []
            self.doc_combos = []
            self._build_style()
            self._build_ui()
            self.doc_count_var.set(current_count)
            self._rebuild_document_order()
            if current_folder:
                self.folder = current_folder
                self.folder_var.set(current_folder)
            if current_excel:
                self.excel_path = current_excel
                self.excel_var.set(current_excel)
            self.rows = current_rows
            self.refresh_tree()
            self.status_var.set(current_status)
            try:
                win.destroy()
            except Exception:
                pass

        self._button(buttons, "Cancel", win.destroy).pack(side="right", padx=(8,0))
        self._button(buttons, "Apply", apply, primary=True).pack(side="right")

    def _load_doc_types(self):
        defaults = ["CSF", "PBEF", "CF4", "AF", "DTR"]
        try:
            if self.settings_path.exists():
                data = json.loads(self.settings_path.read_text(encoding="utf-8"))
                vals = data.get("document_types", [])
                vals = [str(v).strip().upper() for v in vals if str(v).strip()]
                if vals:
                    return list(dict.fromkeys(vals))
        except Exception:
            pass
        return defaults

    def _save_doc_types(self):
        try:
            self.settings_path.parent.mkdir(parents=True, exist_ok=True)
            data = {}
            if self.settings_path.exists():
                try:
                    data = json.loads(self.settings_path.read_text(encoding="utf-8"))
                except Exception:
                    data = {}
            data["document_types"] = self.doc_types
            data["display"] = {"theme": self.theme_name, "ui_scale": self.ui_scale, "font_size": self.font_size}
            self.settings_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except Exception as e:
            messagebox.showwarning(APP_TITLE, f"Could not save document type settings:\n{e}")

    def _build_style(self):
        s = ttk.Style()
        try:
            s.theme_use("clam")
        except Exception:
            pass
        s.configure("Treeview", background=CARD, fieldbackground=CARD, foreground=TEXT,
                    rowheight=32, font=("Segoe UI", self.font_size-1), borderwidth=0)
        s.configure("Treeview.Heading", background=SOFT, foreground=TEXT,
                    font=("Segoe UI Semibold", self.font_size-1), relief="flat", padding=7)
        s.map("Treeview", background=[("selected", SELECT)], foreground=[("selected", TEXT)])
        s.configure("TProgressbar", troughcolor=PROGRESS, background=PRIMARY, thickness=8)
        s.configure("TCombobox", padding=5, font=("Segoe UI", self.font_size))

    def _button(self, parent, text, command, primary=False):
        b = tk.Button(parent, text=text, command=command, relief="flat", bd=0,
                      padx=14, pady=8, cursor="hand2", font=("Segoe UI Semibold", self.font_size-1),
                      bg=PRIMARY if primary else CARD, fg="white" if primary else TEXT,
                      activebackground=PRIMARY_DARK if primary else SOFT,
                      activeforeground="white" if primary else TEXT)
        return b

    def _build_ui(self):
        header = tk.Frame(self.root, bg=PRIMARY, height=82)
        header.pack(fill="x")
        header.pack_propagate(False)
        brand = tk.Frame(header, bg=PRIMARY)
        brand.pack(side="left", padx=24)
        tk.Label(brand, text="PH", bg="white", fg=PRIMARY, width=3,
                 font=("Segoe UI Black", self.font_size+5)).pack(side="left", padx=(0,12), ipady=3)
        titlebox = tk.Frame(brand, bg=PRIMARY)
        titlebox.pack(side="left")
        tk.Label(titlebox, text="PDF Auto Rename", bg=PRIMARY, fg="white",
                 font=("Segoe UI Semibold", self.font_size+8)).pack(anchor="w")
        tk.Label(titlebox, text="Excel-based filename • Custom document order • Preview before rename",
                 bg=PRIMARY, fg=HEADER_SUB, font=("Segoe UI", self.font_size-1)).pack(anchor="w", pady=(1,0))
        self._button(header, "❓ Instructions", self._open_instructions).pack(side="right", padx=(8,8), pady=18)
        self._button(header, "⚙ Settings", self._open_display_settings).pack(side="right", padx=(8,24), pady=18)
        tk.Label(header, text="EXCEL GROUP TEMPLATE + DOCUMENT ORDER", bg=PRIMARY, fg=HEADER_TEXT,
                 font=("Segoe UI", self.font_size-1)).pack(side="right", padx=(8,8))

        outer = tk.Frame(self.root, bg=BG)
        outer.pack(fill="both", expand=True, padx=22, pady=16)
        canvas = tk.Canvas(outer, bg=BG, highlightthickness=0)
        scroll = ttk.Scrollbar(outer, orient="vertical", command=canvas.yview)
        body = tk.Frame(canvas, bg=BG)
        body.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.create_window((0, 0), window=body, anchor="nw", tags="body")
        canvas.bind("<Configure>", lambda e: canvas.itemconfigure("body", width=e.width))
        canvas.configure(yscrollcommand=scroll.set)
        canvas.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        self.body = body

        # 01 PDF folder
        card = tk.Frame(body, bg=CARD, highlightbackground=BORDER, highlightthickness=1)
        card.pack(fill="x", pady=(0,10))
        tk.Label(card, text="01", bg=SOFT, fg=TEXT, width=4,
                 font=("Segoe UI Semibold", 9)).pack(side="left", padx=(12,10), pady=12)
        inside = tk.Frame(card, bg=CARD)
        inside.pack(side="left", fill="x", expand=True, padx=(0,14), pady=10)
        tk.Label(inside, text="PDF Folder", bg=CARD, fg=TEXT,
                 font=("Segoe UI Semibold", self.font_size+1)).pack(anchor="w")
        row = tk.Frame(inside, bg=CARD)
        row.pack(fill="x", pady=(5,0))
        self.folder_var = tk.StringVar(value="Select the folder containing your PDFs")
        tk.Entry(row, textvariable=self.folder_var, state="readonly", relief="flat", bd=0,
                 bg=ENTRY, fg=TEXT, font=("Segoe UI", self.font_size-1)).pack(side="left", fill="x", expand=True, ipady=8, padx=(0,8))
        self._button(row, "Browse", self.choose_folder).pack(side="left")

        # 02 Excel source
        card = tk.Frame(body, bg=CARD, highlightbackground=BORDER, highlightthickness=1)
        card.pack(fill="x", pady=(0,10))
        tk.Label(card, text="02", bg=SOFT, fg=TEXT, width=4,
                 font=("Segoe UI Semibold", 9)).pack(side="left", padx=(12,10), pady=12)
        inside = tk.Frame(card, bg=CARD)
        inside.pack(side="left", fill="x", expand=True, padx=(0,14), pady=10)
        tk.Label(inside, text="Excel Filename Source", bg=CARD, fg=TEXT,
                 font=("Segoe UI Semibold", self.font_size+1)).pack(anchor="w")
        row = tk.Frame(inside, bg=CARD)
        row.pack(fill="x", pady=(5,0))
        self.excel_var = tk.StringVar(value="Select the Excel file containing the names/filenames")
        tk.Entry(row, textvariable=self.excel_var, state="readonly", relief="flat", bd=0,
                 bg=ENTRY, fg=TEXT, font=("Segoe UI", self.font_size-1)).pack(side="left", fill="x", expand=True, ipady=8, padx=(0,8))
        self._button(row, "Browse Excel", self.choose_excel).pack(side="left")
        self._button(row, "Download Excel Template", self.download_excel_template).pack(side="left", padx=(8,0))
        tk.Label(inside, textvariable=self.template_preview_var, bg=CARD, fg=MUTED,
                 font=("Segoe UI", max(8,self.font_size-2))).pack(anchor="w", pady=(4,0))
        colrow = tk.Frame(inside, bg=CARD)
        colrow.pack(fill="x", pady=(7,0))
        tk.Label(colrow, text="Column to use as filename:", bg=CARD, fg=MUTED,
                 font=("Segoe UI", self.font_size-1)).pack(side="left")
        self.column_combo = ttk.Combobox(colrow, textvariable=self.column_var,
                                         state="readonly", width=32, values=[])
        self.column_combo.pack(side="left", padx=(8,0))
        tk.Label(colrow, text="One Excel row = one patient/group", bg=CARD, fg=MUTED,
                 font=("Segoe UI", self.font_size-1)).pack(side="left", padx=12)

        # 03 Document Order - modeled after the user's screenshot.
        self.order_card = tk.Frame(body, bg=CARD, highlightbackground=BORDER, highlightthickness=1)
        self.order_card.pack(fill="x", pady=(0,10))
        head = tk.Frame(self.order_card, bg=CARD)
        head.pack(fill="x", padx=12, pady=(10,4))
        tk.Label(head, text="03", bg=SOFT, fg=TEXT, width=4,
                 font=("Segoe UI Semibold", 9)).pack(side="left", padx=(0,10))
        htxt = tk.Frame(head, bg=CARD)
        htxt.pack(side="left", fill="x", expand=True)
        tk.Label(htxt, text="Document Order", bg=CARD, fg=TEXT,
                 font=("Segoe UI Semibold", 12)).pack(anchor="w")
        tk.Label(htxt, text="Select the document type for each file in numeric/page order.",
                 bg=CARD, fg=MUTED, font=("Segoe UI", self.font_size-1)).pack(anchor="w", pady=(1,0))
        controls = tk.Frame(head, bg=CARD)
        controls.pack(side="right")
        tk.Label(controls, text="Documents:", bg=CARD, fg=MUTED, font=("Segoe UI", self.font_size-1)).pack(side="left")
        self.doc_count_combo = ttk.Combobox(controls, textvariable=self.doc_count_var,
                                            values=tuple(range(1, 21)), state="readonly", width=6)
        self.doc_count_combo.pack(side="left", padx=(6,8))
        self.doc_count_combo.bind("<<ComboboxSelected>>", lambda e: self._rebuild_document_order())
        self._button(controls, "⚙ Manage Document Types", self.manage_document_types).pack(side="left")

        self.order_rows_frame = tk.Frame(self.order_card, bg=CARD)
        self.order_rows_frame.pack(fill="x", padx=12, pady=(2,12))

        # Action bar
        actions = tk.Frame(body, bg=BG)
        actions.pack(fill="x", pady=(2,10))
        self._button(actions, "Analyze / Preview", self.scan, primary=True).pack(side="left")
        self._button(actions, "Rename All", self.rename_all).pack(side="left", padx=7)
        self._button(actions, "Create ZIP", self.create_zip).pack(side="left")
        self._button(actions, "Export CSV", self.export_csv).pack(side="left", padx=7)
        self.count_var = tk.StringVar(value="0 PDFs")
        tk.Label(actions, textvariable=self.count_var, bg=BG, fg=MUTED,
                 font=("Segoe UI", self.font_size-1)).pack(side="right", padx=8)

        # Preview
        table_card = tk.Frame(body, bg=CARD, highlightbackground=BORDER, highlightthickness=1)
        table_card.pack(fill="both", expand=True)
        tk.Label(table_card, text="04  PREVIEW", bg=CARD, fg=MUTED,
                 font=("Segoe UI Semibold", 9)).pack(anchor="w", padx=12, pady=(10,4))
        table_frame = tk.Frame(table_card, bg=CARD)
        table_frame.pack(fill="both", expand=True, padx=10, pady=(0,10))
        cols = ("#", "old", "group", "new", "status")
        self.tree = ttk.Treeview(table_frame, columns=cols, show="headings", height=12)
        headings = {"#":"#", "old":"Original PDF", "group":"Excel Value", "new":"New Filename", "status":"Status"}
        widths = {"#":45, "old":300, "group":190, "new":350, "status":220}
        for c in cols:
            self.tree.heading(c, text=headings[c])
            self.tree.column(c, width=widths[c], anchor="w")
        self.tree.column("#", anchor="center")
        ybar = ttk.Scrollbar(table_frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=ybar.set)
        self.tree.pack(side="left", fill="both", expand=True)
        ybar.pack(side="right", fill="y")

        footer = tk.Frame(body, bg=BG)
        footer.pack(fill="x", pady=(9,0))
        self.progress = ttk.Progressbar(footer, mode="determinate")
        self.progress.pack(fill="x")
        self.status_var = tk.StringVar(value="Ready — select PDF folder, Excel, and document order.")
        tk.Label(footer, textvariable=self.status_var, bg=BG, fg=MUTED,
                 font=("Segoe UI", self.font_size-1)).pack(anchor="w", pady=(5,0))

    def _rebuild_document_order(self):
        count = int(self.doc_count_var.get())
        old = [v.get() for v in self.doc_vars]
        for w in self.order_rows_frame.winfo_children():
            w.destroy()
        self.doc_vars = []
        self.doc_combos = []
        values = tuple(self.doc_types)
        for i in range(count):
            var = tk.StringVar(value=old[i] if i < len(old) and old[i] in values else (self.doc_types[i] if i < len(self.doc_types) else self.doc_types[0]))
            row = tk.Frame(self.order_rows_frame, bg=CARD)
            row.pack(fill="x", pady=3)
            tk.Label(row, text=str(i+1), bg=SOFT, fg=TEXT, width=4,
                     font=("Segoe UI Semibold", 9)).pack(side="left", padx=(0,10))
            tk.Label(row, text=f"Document {i+1}", bg=CARD, fg=TEXT,
                     font=("Segoe UI", self.font_size), width=14, anchor="w").pack(side="left")
            combo = ttk.Combobox(row, textvariable=var, values=values,
                                 state="readonly", width=22)
            combo.pack(side="left", padx=(0,8))
            self.doc_vars.append(var)
            self.doc_combos.append(combo)
        # Keep the downloadable Excel template synchronized with the selected
        # document count. Example: 4 documents => 1-4, 5-8, 9-12.
        size = count
        self.template_preview_var.set(
            f"Excel template groups: 1-{size}, {size+1}-{size*2}, {size*2+1}-{size*3}..."
        )
        tk.Label(self.order_rows_frame,
                 text="Tip: the selected order is applied to PDF 1, PDF 2, PDF 3... in numeric/page order.",
                 bg=CARD, fg=MUTED, font=("Segoe UI", max(8,self.font_size-2))).pack(anchor="w", pady=(4,0))

    def add_document_type(self):
        self.manage_document_types()

    def manage_document_types(self):
        win = tk.Toplevel(self.root)
        win.title("Manage Document Types")
        win.geometry("520x470")
        win.configure(bg=BG)
        win.transient(self.root)
        win.grab_set()

        tk.Label(win, text="Document Types", bg=BG, fg=TEXT, font=("Segoe UI Semibold", self.font_size+4)).pack(anchor="w", padx=18, pady=(16,2))
        tk.Label(win, text="Add, edit, delete, and reorder the options used by the dropdown.", bg=BG, fg=MUTED, font=("Segoe UI", self.font_size-1)).pack(anchor="w", padx=18, pady=(0,10))

        frame = tk.Frame(win, bg=CARD, highlightbackground=BORDER, highlightthickness=1)
        frame.pack(fill="both", expand=True, padx=18, pady=5)
        lb = tk.Listbox(frame, font=("Segoe UI", self.font_size), activestyle="none", selectmode="single")
        lb.pack(side="left", fill="both", expand=True, padx=10, pady=10)
        sb = ttk.Scrollbar(frame, orient="vertical", command=lb.yview)
        sb.pack(side="right", fill="y", pady=10)
        lb.configure(yscrollcommand=sb.set)

        def refresh(select=None):
            lb.delete(0, "end")
            for x in self.doc_types:
                lb.insert("end", x)
            if self.doc_types:
                idx = min(select if select is not None else 0, len(self.doc_types)-1)
                lb.selection_set(idx)
                lb.see(idx)

        def selected_index():
            sel = lb.curselection()
            if not sel:
                messagebox.showwarning(APP_TITLE, "Select a document type first.", parent=win)
                return None
            return int(sel[0])

        def add():
            name = simpledialog.askstring("Add Document Type", "Enter the new document type:", parent=win)
            if name is None: return
            name = re.sub(r"\s+", " ", name).strip().upper()
            if not name: return
            if name in self.doc_types:
                messagebox.showwarning(APP_TITLE, "That document type already exists.", parent=win); return
            self.doc_types.append(name)
            self._save_doc_types(); refresh(len(self.doc_types)-1); self._rebuild_document_order()

        def edit():
            i = selected_index()
            if i is None: return
            old = self.doc_types[i]
            name = simpledialog.askstring("Edit Document Type", "Document type name:", initialvalue=old, parent=win)
            if name is None: return
            name = re.sub(r"\s+", " ", name).strip().upper()
            if not name: return
            if name != old and name in self.doc_types:
                messagebox.showwarning(APP_TITLE, "That document type already exists.", parent=win); return
            self.doc_types[i] = name
            self._save_doc_types(); refresh(i); self._rebuild_document_order()

        def delete():
            i = selected_index()
            if i is None: return
            name = self.doc_types[i]
            if not messagebox.askyesno(APP_TITLE, f"Delete '{name}' from the dropdown?", parent=win): return
            self.doc_types.pop(i)
            if not self.doc_types:
                messagebox.showwarning(APP_TITLE, "At least one document type is required.", parent=win)
                self.doc_types.append(name); return
            self._save_doc_types(); refresh(max(0,i-1)); self._rebuild_document_order()

        def move(delta):
            i = selected_index()
            if i is None: return
            j = i + delta
            if j < 0 or j >= len(self.doc_types): return
            self.doc_types[i], self.doc_types[j] = self.doc_types[j], self.doc_types[i]
            self._save_doc_types(); refresh(j); self._rebuild_document_order()

        btns = tk.Frame(win, bg=BG); btns.pack(fill="x", padx=18, pady=10)
        for label, cmd in [("+ Add",add),("✏ Edit",edit),("Delete",delete),("↑ Up",lambda:move(-1)),("↓ Down",lambda:move(1))]:
            self._button(btns,label,cmd).pack(side="left", padx=(0,6))
        self._button(win,"Done",win.destroy,primary=True).pack(anchor="e", padx=18, pady=(0,16))
        refresh()

    def choose_folder(self):
        d = filedialog.askdirectory(title="Select folder containing PDFs")
        if d:
            self.folder = d
            self.folder_var.set(d)
            self.set_status("PDF folder selected.")

    def download_excel_template(self):
        """Save a template whose Group ranges match the selected Document Order."""
        group_size = int(self.doc_count_var.get())
        try:
            pdf_count = len(list(Path(self.folder).glob("*.pdf"))) if self.folder else 0
        except Exception:
            pdf_count = 0
        # If a PDF folder is selected, create exactly enough rows for the PDFs.
        # Otherwise provide a useful starter template with 10 groups.
        num_groups = max(1, (pdf_count + group_size - 1) // group_size) if pdf_count else 10
        initial = f"PDF_Auto_Rename_Excel_Group_{group_size}Docs.xlsx"
        path = filedialog.asksaveasfilename(
            title="Save Excel Template",
            defaultextension=".xlsx",
            initialfile=initial,
            filetypes=[("Excel Workbook", "*.xlsx")]
        )
        if not path:
            return
        try:
            wb = build_group_template(group_size, num_groups)
            wb.save(path)
            ranges = group_ranges_from_count(group_size, min(num_groups, 3))
            self.set_status(f"Excel template saved — {group_size} documents/group • {num_groups} group(s).")
            messagebox.showinfo(
                APP_TITLE,
                "Excel template created successfully.\n\n"
                + "\n".join(f"Group {r} → enter one File Name" for r in ranges)
                + ("\n..." if num_groups > 3 else "")
            )
        except Exception as e:
            messagebox.showerror(APP_TITLE, f"Could not create Excel template:\n{e}")

    def choose_excel(self):
        path = filedialog.askopenfilename(
            title="Select Excel filename source",
            filetypes=[("Excel Workbook", "*.xlsx *.xlsm"), ("Excel Workbook", "*.xlsx"), ("All files", "*.*")]
        )
        if not path:
            return
        try:
            headers, names = read_excel_filename_source(path)
            if not headers:
                raise ValueError("The Excel file has no header row.")
            self.excel_path = path
            self.excel_headers = headers
            self.excel_rows = names
            self.excel_var.set(path)
            self.column_combo["values"] = headers
            # Prefer a sensible name column, otherwise use the first column.
            preferred = next((h for h in headers if h.upper() in {
                "FILE NAME", "FILENAME", "LAST NAME", "LASTNAME", "SURNAME", "PATIENT NAME", "NAME"
            }), headers[0])
            self.column_var.set(preferred)
            folder_col = find_optional_folder_column(headers)
            folder_note = " Optional Folder Name column detected." if folder_col is not None else ""
            self.set_status(f"Excel loaded — {len(names)} data row(s). Choose the filename column.{folder_note}")
        except Exception as e:
            messagebox.showerror(APP_TITLE, f"Could not read Excel file:\n{e}")

    def _selected_docs(self):
        return [safe_name(v.get()) for v in self.doc_vars if v.get().strip()]

    def scan(self):
        if self.busy:
            return
        if not self.folder:
            messagebox.showwarning(APP_TITLE, "Please choose the PDF folder first.")
            return
        if not self.excel_path or not self.excel_rows:
            messagebox.showwarning(APP_TITLE, "Please select an Excel file containing the filename values.")
            return
        docs = self._selected_docs()
        if not docs or len(docs) != int(self.doc_count_var.get()):
            messagebox.showwarning(APP_TITLE, "Please complete the Document Order list.")
            return
        column = self.column_var.get().strip()
        if not column:
            messagebox.showwarning(APP_TITLE, "Please select the Excel column to use as the filename.")
            return
        self.busy = True
        self.clear_tree()
        self.rows = []
        threading.Thread(target=self._scan_worker, args=(docs, column), daemon=True).start()

    def _scan_worker(self, docs, column):
        try:
            files = sorted(Path(self.folder).glob("*.pdf"), key=natural_key)
            group_size = len(docs)
            total = len(files)
            groups = (total + group_size - 1) // group_size if group_size else 0
            self.root.after(0, lambda: self.progress.configure(maximum=max(1, total), value=0))
            try:
                col_idx = self.excel_headers.index(column)
            except ValueError:
                col_idx = 0
            excel_row_count = len(self.excel_rows)
            group_col_idx = next((i for i, h in enumerate(self.excel_headers) if h.strip().upper() in {"GROUP", "GROUP #", "GROUP NO", "GROUP NUMBER"}), None)
            folder_col_idx = find_optional_folder_column(self.excel_headers)
            self.root.after(0, lambda: self.count_var.set(f"{total} PDFs • {group_size}-PDF groups • {excel_row_count} Excel groups"))

            # Excel is the source of truth. Each Excel row represents one
            # patient/group. The Group cell may be "1-4", "5-8", etc.; the
            # app also remains compatible with a plain sequential row list.
            for g in range(groups):
                block = files[g * group_size:(g + 1) * group_size]
                if not block:
                    break
                excel_idx = g
                excel_value = ""
                if excel_idx < excel_row_count:
                    row = self.excel_rows[excel_idx]
                    if col_idx < len(row) and row[col_idx] not in (None, ""):
                        excel_value = str(row[col_idx]).strip()
                value = excel_filename_value(excel_value)
                folder_value = value
                if folder_col_idx is not None and excel_idx < excel_row_count:
                    row_folder = self.excel_rows[excel_idx]
                    if folder_col_idx < len(row_folder) and row_folder[folder_col_idx] not in (None, ""):
                        custom_folder = excel_filename_value(row_folder[folder_col_idx])
                        if custom_folder:
                            folder_value = custom_folder
                expected_first = g * group_size + 1
                expected_last = (g + 1) * group_size
                range_ok = True
                if group_col_idx is not None and excel_idx < excel_row_count:
                    row_group = str(self.excel_rows[excel_idx][group_col_idx] or "").strip()
                    m = re.fullmatch(r"\s*(\d+)\s*[-–—]\s*(\d+)\s*", row_group)
                    range_ok = bool(m and int(m.group(1)) == expected_first and int(m.group(2)) == expected_last)
                group_status = ("OK — Excel group" if range_ok else f"WARNING — expected Group {expected_first}-{expected_last}") if value else "WARNING — blank Excel value"
                for j, p in enumerate(block):
                    typ = docs[j]
                    new = f"{value} - {typ}.pdf" if value else ""
                    status = group_status if value else "WARNING — filename source is blank"
                    if len(block) < group_size:
                        status = "WARNING — incomplete PDF group" if value else "WARNING — incomplete group + blank Excel value"
                    row = self._row(p, value, folder_value, new, status, g + 1, typ, excel_idx + 2)
                    self.rows.append(row)
                    n = len(self.rows)
                    self.root.after(0, lambda r=row, n=n: self.tree.insert("", "end", values=(n, r["old"], r["group"], r["new"], r["status"])))
                    self.root.after(0, lambda v=n: self.progress.configure(value=v))

            if excel_row_count < groups:
                self.set_status(f"Preview complete — WARNING: {groups - excel_row_count} PDF group(s) have no matching Excel row.")
            elif excel_row_count > groups:
                self.set_status(f"Preview complete — {groups} PDF group(s); {excel_row_count - groups} Excel row(s) were not used.")
            else:
                self.set_status(f"Preview complete — {total} PDF(s), {groups} group(s), Excel column: {column}.")
        finally:
            self.busy = False

    def _row(self, p, group_value, folder_value, new, status, group_no, doc_type, excel_row):
        # All documents belonging to one Excel group go into ONE patient folder.
        # Folder Name (Optional) overrides File Name only when populated.
        output_root = Path(self.folder) / "RENAMED" if self.folder else p.parent / "RENAMED"
        folder_name = excel_filename_value(folder_value) or excel_filename_value(group_value)
        target_folder = output_root / folder_name if folder_name else output_root
        return {
            "path": str(p), "old": p.name, "group": group_value,
            "new": new, "status": status, "group_no": group_no,
            "doc_type": doc_type, "excel_row": excel_row,
            "target_folder": str(target_folder),
            "target_path": str(target_folder / new) if new else ""
        }

    def rename_all(self):
        if self.busy:
            return
        if not self.rows:
            messagebox.showinfo(APP_TITLE, "Run Analyze / Preview first.")
            return
        safe = [r for r in self.rows if r["new"] and r["status"].startswith("OK")]
        if not safe:
            messagebox.showwarning(APP_TITLE, "No safe rename candidates found. Check the preview warnings.")
            return
        # Detect duplicate target paths before touching any files.
        targets = {}
        duplicate = []
        for r in safe:
            key = str(Path(r["target_path"]).resolve()).lower()
            if key in targets:
                duplicate.append(r["target_path"])
            targets[key] = r
        if duplicate:
            messagebox.showwarning(APP_TITLE, "Duplicate target file(s) detected:\n\n" + "\n".join(sorted(set(duplicate))) + "\n\nRename was cancelled.")
            return
        folder_count = len({r["target_folder"] for r in safe})
        if not messagebox.askyesno(APP_TITLE,
            f"Rename and organize {len(safe)} PDF(s)?\n\n"
            f"Automatic output: RENAMED\\<File Name>\\<renamed PDF>.pdf\n"
            f"Folders to create: {folder_count}\n\n"
            "All documents in the same Excel Group will go into the same folder."):
            return
        self.busy = True
        threading.Thread(target=self._rename_worker, args=(safe,), daemon=True).start()

    def _rename_worker(self, rows):
        try:
            staged = []
            for i, r in enumerate(rows, 1):
                src = Path(r["path"])
                dst = Path(r["target_path"])
                if dst.exists() and dst.resolve() != src.resolve():
                    r["status"] = "TARGET EXISTS"
                    continue
                tmp = src.with_name(f".__pdf_auto_rename_tmp_{i}__.pdf")
                try:
                    src.rename(tmp)
                    staged.append((r, tmp, dst))
                except Exception as e:
                    r["status"] = f"ERROR: {e}"
            for r, tmp, dst in staged:
                try:
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    tmp.rename(dst)
                    r["status"] = "RENAMED → FOLDER"
                    r["old"] = dst.name
                    r["path"] = str(dst)
                except Exception as e:
                    r["status"] = f"ERROR: {e}"
            self.root.after(0, self.refresh_tree)
            renamed = sum(r["status"] == "RENAMED → FOLDER" for r in rows)
            folder_count = len({r["target_folder"] for r in rows if r["status"] == "RENAMED → FOLDER"})
            self.set_status(f"Complete — {renamed}/{len(rows)} PDF(s) renamed and organized into {folder_count} folder(s) inside RENAMED.")
            self.root.after(0, lambda: messagebox.showinfo(APP_TITLE,
                f"Rename complete!\n\n{renamed} PDF(s) renamed.\n{folder_count} patient/group folder(s) created in:\n{Path(self.folder) / 'RENAMED'}"))
        finally:
            self.busy = False

    def refresh_tree(self):
        self.clear_tree()
        for i, r in enumerate(self.rows, 1):
            self.tree.insert("", "end", values=(i, r["old"], r["group"], r["new"], r["status"]))

    def clear_tree(self):
        for x in self.tree.get_children():
            self.tree.delete(x)

    def set_status(self, s):
        self.root.after(0, lambda: self.status_var.set(s))

    def export_csv(self):
        if not self.rows:
            messagebox.showinfo(APP_TITLE, "Nothing to export yet.")
            return
        out = filedialog.asksaveasfilename(defaultextension=".csv", filetypes=[("CSV", "*.csv")], initialfile="PDF_Auto_Rename_Review.csv")
        if not out:
            return
        with open(out, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=["old", "group_no", "excel_row", "group", "doc_type", "new", "status"])
            w.writeheader()
            for r in self.rows:
                w.writerow({k: r.get(k, "") for k in w.fieldnames})
        messagebox.showinfo(APP_TITLE, f"Review CSV saved:\n{out}")

    def create_zip(self):
        if not self.folder:
            messagebox.showwarning(APP_TITLE, "Choose a PDF folder first.")
            return
        pdfs = sorted(Path(self.folder).glob("*.pdf"), key=natural_key)
        if not pdfs:
            messagebox.showinfo(APP_TITLE, "No PDFs found in the selected folder.")
            return
        out = Path(self.folder) / "PDF_Auto_Rename_PDFs.zip"
        try:
            with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
                for p in pdfs:
                    z.write(p, p.name)
            messagebox.showinfo(APP_TITLE, f"ZIP created successfully:\n\n{out}\n\nThe ZIP contains all PDFs currently in the folder.")
            self.set_status(f"ZIP ready — {len(pdfs)} PDF(s) packed.")
        except Exception as e:
            messagebox.showerror(APP_TITLE, str(e))


if __name__ == "__main__":
    root = tk.Tk()
    App(root)
    root.mainloop()
