"""
Flask and Socket.IO server for the Beabots web application.

It serves browser pages, app accounts, per-user Beacon credentials,
workbook uploads, automation API endpoints, and live progress events.

Run directly for local testing:
    python server.py
"""

import os
import sys
import base64
import threading
import tempfile
import uuid
from contextvars import ContextVar
from pathlib import Path

from functools import wraps

from flask import Flask, request, jsonify, send_file, send_from_directory, session
from flask_socketio import SocketIO, join_room
from flask_cors import CORS
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

from openpyxl import load_workbook

from app.core.config import AppConfig
from app.core.database import db
import app.models  # noqa: F401 - imported so SQLAlchemy registers the tables
from app.models import User, UserSetting, utc_now
from app.core import browser_session
from app.core.license import (
    clear_license,
    get_license_status,
    require_valid_license,
    start_background_license_checker,
    verify_license,
)
from app.core.login import load_login_settings, save_login_settings
from app.core.logger import logger
from app.core.updater import (
    apply_downloaded_update,
    check_for_update,
    get_update_status,
    start_background_updater,
)
from app.core.version import APP_VERSION
from app.domain.patient_record import PatientRecord
from app.domain.date_parser import parse_dates
from app.domain.time_parser import parse_time_range, format_beacon_time
from app.domain.cf2_mapper import build_cf2_data
from app.automation.cf2 import CF2Automation
from app.automation.soa import SOAAutomation
from app.automation.beacon import run as beacon_run
from app.domain.reports import report
from app.domain.soa_excel import batch_workbooks, build_batch_template, generate_workbook
from app.core.security import decrypt_field, encrypt_field

BASE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
APP_ICON_PATH = BASE_DIR / "renderer" / "assets" / "bot.ico"
UPLOAD_DIR = Path(
    os.environ.get("BEABOTS_UPLOAD_DIR")
    or Path(tempfile.gettempdir()) / "beabots_uploads"
)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=str(BASE_DIR / "renderer"), static_url_path="")
app.config.from_object(AppConfig)
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("BEABOTS_MAX_UPLOAD_MB", "100")) * 1024 * 1024
db.init_app(app)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# In-memory fallback state for parsed workbook data and active automation runs.
_state = {
    "selected_file": None,
    "patient_records": [],
    # "new_draft" (default) or "existing_draft" — set by the most recent
    # /api/cf2/upload call, read again by /api/cf2/start so the CF2
    # automation knows whether to create a fresh draft or search for one
    # that already exists. See cf2_automation.py's CF2Automation.mode.
    "cf2_mode": "new_draft",
}

_emit_room = ContextVar("beabots_emit_room", default=None)
_cf2_states = {}
_cf2_runs = {}
_soa_runs = {}
_beacon_runs = {}
_job_start_lock = threading.RLock()
_update_installing = False


def claim_update_installation():
    """Prevent new jobs only when every existing automation has finished."""
    global _update_installing
    with _job_start_lock:
        if _update_installing or _cf2_runs or _soa_runs or _beacon_runs:
            return False
        _update_installing = True
        return True


def release_update_installation():
    global _update_installing
    with _job_start_lock:
        _update_installing = False


def serialize_job_start(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        with _job_start_lock:
            if _update_installing:
                return jsonify({"error": "Beabots is updating and will reopen automatically."}), 503
            return fn(*args, **kwargs)
    return wrapped

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]

# Defaults mirror exactly what beacon.py's `auto_encode_cf4` branch used to
# hardcode inline, now expanded to cover the full "Pertinent Signs and
# Symptoms" and "Physical Examination" checklists from Beacon's live CF4
# form. Keep this in lockstep with DEFAULT_CF4_SETTINGS in js/cf4.js —
# same keys, same values — since that file renders the form these keys
# back onto and both need to agree with beacon.py's DEFAULT_CF4_DATA on
# what each key means.
# Defaults mirror exactly what beacon.py's `auto_encode_cf4` branch used to
# hardcode inline, now expanded to cover the full "Pertinent Signs and
# Symptoms" and "Physical Examination" checklists from Beacon's live CF4
# form. For those two sections, each key IS the confirmed Beacon `name`
# attribute (camelCase) — beacon.py reads cf4_data[key] and locates
# input[name="key"] directly, no separate translation table. Keep this in
# lockstep with DEFAULT_CF4_SETTINGS in js/cf4.js — same keys, same
# values — since that file renders the form these keys back onto and both
# need to agree with beacon.py's DEFAULT_CF4_DATA on what each key means.
DEFAULT_CF4_SETTINGS = {
    "chief_complaint": "FOR HEMODIALYSIS",
    "history_of_present_illness": "N/A",
    "pertinent_past_medical_history": "N/A",
    "general_survey_awake_alert": True,
    "course_in_ward_order": "UF GOAL MET AT L",

    # Pertinent Signs and Symptoms
    "alteredMentalSensorium": False,
    "abdominalCrampPain": False,
    "anorexia": False,
    "bleedingGums": False,
    "bodyWeakness": True,
    "blurringOfVision": False,
    "chestPainDiscomfort": False,
    "constipation": False,
    "cough": False,
    "diarrhea": False,
    "dizziness": False,
    "dysphagia": False,
    "dyspnea": False,
    "dysuria": False,
    "epistaxis": False,
    "fever": False,
    "frequencyOfUrination": False,
    "headache": False,
    "hematemesis": False,
    "hematuria": False,
    "hemoptysis": False,
    "irritability": False,
    "jaundice": False,
    "lowerExtremityEdema": True,
    "myalgia": False,
    "orthopnea": False,
    "pain": False,
    "painSpecify": "",
    "palpitations": False,
    "seizure": False,
    "skinRashes": False,
    "stoolBloodyBlackTarryMucoid": False,
    "sweating": False,
    "urgency": False,
    "vomiting": False,
    "weightLoss": False,
    "others": False,
    "othersSpecify": "",

    # Physical Examination — HEENT
    "heEssentiallyNormal": True,
    "heSunkenFontanelle": False,
    "heAbnormalPupillaryReaction": False,
    "heOthersChk": False,
    "heOthers": "",
    "heCervicalLympadenopathy": False,
    "heDryMucousMembrane": False,
    "heIctericSclerae": False,
    "hePaleConjunctivae": False,
    "heSunkenEyeballs": False,

    # Physical Examination — Chest / Lungs
    "clEssentiallyNormal": True,
    "clOthersChk": False,
    "clOthers": "",
    "clAsymmetricalChestExpansion": False,
    "clDecreasedBreathSounds": False,
    "clWheezes": False,
    "clLumpsOverBreast": False,
    "clCracklesRales": False,
    "clRetractions": False,

    # Physical Examination — CVS
    "cvEssentiallyNormal": True,
    "cvOthersChk": False,
    "cvOthers": "",
    "cvDisplacedApexBeat": False,
    "cvHeavesThrills": False,
    "cvPericardialBulge": False,
    "cvIrregularRhythm": False,
    "cvMuffledHeartSounds": False,
    "cvMurmur": False,

    # Physical Examination — Abdomen
    "abEssentiallyNormal": True,
    "abOthersChk": False,
    "abOthers": "",
    "abAbdominalRigidity": False,
    "abAbdominalTenderness": False,
    "abHyperactiveBowelSounds": False,
    "abPalpableMasses": False,
    "abTympaniticDullAbdomen": False,
    "abUterineContraction": False,

    # Physical Examination — GU (IE)
    "guEssentiallyNormal": False,
    "guBloodStainedInExamFinger": False,
    "guCervicalDilatation": False,
    "guPresenceofAbnormalDischarge": False,
    "guOthersChk": True,
    "guOthers": "NOT EXAMINE",

    # Physical Examination — Skin/Extremities
    "seEssentiallyNormal": True,
    "sePoorSkinTurgor": False,
    "seClubbing": False,
    "seRashesPetechiae": False,
    "seColdClammy": False,
    "seWeakPulse": False,
    "seCyanosisMottledSkin": False,
    "seOthersChk": False,
    "seOthers": "",
    "seEdemaSwelling": False,
    "seDecreasedMobility": False,
    "sePaleNailbeds": False,

    # Physical Examination — Neuro-exam
    "neEssentiallyNormal": True,
    "nePoorCoordination": False,
    "neAbnormalGait": False,
    "neOthersChk": False,
    "neOthers": "",
    "neAbnormalPositionSense": False,
    "neAbnormalSensation": False,
    "neAbnormalReflexes": False,
    "nePoorAlteredMemory": False,
    "nePoorMuscleToneStrength": False,
}


def _load_cf4_settings():
    """Current CF4 defaults, merged over DEFAULT_CF4_SETTINGS so a
    settings.json saved before some new field existed doesn't come back
    with that field missing."""
    settings = load_login_settings()
    return {**DEFAULT_CF4_SETTINGS, **settings.get("cf4", {})}


# ---------------------------------------------------------------------------
# Logging bridge. Automation modules still call logger.<level>(...); the web
# server emits those messages to the current user's Socket.IO room.
# ---------------------------------------------------------------------------
def _emit_log(message, level=None):
    emit_to_current_room("log", {"message": message, "level": level or "INFO"})


logger.set_callback(_emit_log)


def user_room(user_id):
    return f"user:{user_id}"


def emit_to_current_room(event, payload):
    room = _emit_room.get()
    if room:
        socketio.emit(event, payload, room=room)
    else:
        socketio.emit(event, payload)


@socketio.on("connect")
def socket_connected():
    user_id = session.get("user_id")
    if user_id:
        join_room(user_room(user_id))


def init_database():
    with app.app_context():
        db.create_all()


def current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    return db.session.get(User, user_id)


def user_payload(user):
    return {
        "id": user.id,
        "email": user.email,
        "display_name": user.display_name,
        "is_admin": user.is_admin,
    }


def login_required(handler):
    @wraps(handler)
    def wrapper(*args, **kwargs):
        user = current_user()
        if not user or not user.is_active:
            return jsonify({"error": "Authentication required."}), 401
        return handler(*args, **kwargs)

    return wrapper


def get_or_create_user_settings(user):
    settings = user.settings
    if settings is None:
        settings = UserSetting(user_id=user.id)
        db.session.add(settings)
        db.session.commit()
    return settings


def user_settings_payload(settings, include_secret_placeholders=True):
    payload = {
        "username": settings.beacon_username or "",
        "password": "********" if include_secret_placeholders and settings.beacon_password_encrypted else "",
        "server": settings.server or "s4",
        "soa_folder": settings.soa_folder or "",
        "cf4": settings.cf4_settings or {},
        "beacon_connected": bool(settings.beacon_validated_at),
        "beacon_user_id": settings.beacon_user_id,
        "beacon_validated_at": settings.beacon_validated_at.isoformat() if settings.beacon_validated_at else None,
    }
    return payload


def decrypt_user_settings(settings):
    return {
        "username": settings.beacon_username or "",
        "password": decrypt_field(settings.beacon_password_encrypted),
        "server": settings.server or "s4",
        "soa_folder": settings.soa_folder or "",
        "cf4": settings.cf4_settings or {},
    }


def sync_legacy_settings_for_user(user):
    settings = get_or_create_user_settings(user)
    decrypted = decrypt_user_settings(settings)
    legacy = load_login_settings()
    legacy.update(decrypted)
    save_login_settings(legacy)
    browser_session.invalidate_auth_token()
    return decrypted


def require_beacon_connection():
    user = current_user()
    if not user or not user.is_active:
        return None, None, (jsonify({"error": "Authentication required."}), 401)

    settings = get_or_create_user_settings(user)
    decrypted = decrypt_user_settings(settings)
    if not decrypted["username"] or not decrypted["password"] or not settings.beacon_validated_at:
        return None, None, (jsonify({
            "error": "Please connect and validate your Beacon account in Settings before running automation.",
            "requires_beacon": True,
        }), 403)

    return user, decrypted, None


def license_error_response(status=None):
    status = status or get_license_status()
    message = status.get("reason") or "Please activate a valid Beabots license before running automation."
    if status.get("code") == "UPDATE_REQUIRED":
        message = "This Beabots version must be updated before automation can run."
    return jsonify({
        "error": message,
        "requires_license": True,
        "license": status,
    }), 403


def require_license_connection():
    status = require_valid_license()
    if status is None:
        return None
    return license_error_response(status)


def resource_path(relative_path):
    return str(BASE_DIR / relative_path)


def _save_upload(file_storage, subdir, allowed_extensions):
    filename = secure_filename(file_storage.filename or "")
    suffix = Path(filename).suffix.lower()
    if not filename or suffix not in allowed_extensions:
        allowed = ", ".join(sorted(allowed_extensions))
        raise ValueError(f"Unsupported file type. Allowed: {allowed}")

    target_dir = UPLOAD_DIR / subdir
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / f"{uuid.uuid4().hex}_{filename}"
    file_storage.save(path)
    return path


def _prepare_upload_folder(files, allowed_extensions):
    folder = UPLOAD_DIR / uuid.uuid4().hex
    folder.mkdir(parents=True, exist_ok=True)
    saved = []
    for file_storage in files:
        if not file_storage or not file_storage.filename:
            continue
        filename = secure_filename(file_storage.filename)
        suffix = Path(filename).suffix.lower()
        if suffix not in allowed_extensions:
            continue
        target = folder / filename
        if target.exists():
            target = folder / f"{uuid.uuid4().hex}_{filename}"
        file_storage.save(target)
        saved.append(target)
    return folder, saved


def _save_generated_download(filename, data_url):
    safe_name = secure_filename(str(filename or "").strip())
    if not safe_name:
        safe_name = "generated.xlsx"

    suffix = Path(safe_name).suffix.lower()
    if suffix not in {".xlsx", ".zip"}:
        raise ValueError("Unsupported generated file type.")

    header, separator, encoded = str(data_url or "").partition(",")
    if not separator or ";base64" not in header:
        raise ValueError("Generated file data is invalid.")

    downloads = Path.home() / "Downloads"
    target_dir = downloads if downloads.is_dir() else Path(tempfile.gettempdir()) / "beabots_downloads"
    target_dir.mkdir(parents=True, exist_ok=True)

    target = target_dir / safe_name
    stem = target.stem
    for index in range(1, 1000):
        if not target.exists():
            break
        target = target_dir / f"{stem} ({index}){suffix}"

    target.write_bytes(base64.b64decode(encoded))
    return target


@app.route("/")
def web_index():
    return send_from_directory(app.static_folder, "login.html")


@app.route("/bot.ico")
@app.route("/favicon.ico")
def web_icon():
    return send_file(APP_ICON_PATH, mimetype="image/x-icon")


@app.route("/api/health", methods=["GET"])
def health_check():
    try:
        with db.engine.connect() as connection:
            connection.exec_driver_sql("SELECT 1")
        database_ok = True
    except Exception:
        database_ok = False

    return jsonify({
        "ok": database_ok,
        "database": "ok" if database_ok else "unavailable",
    }), 200 if database_ok else 503


@app.route("/api/soa-excel/generate", methods=["POST"])
def soa_excel_generate():
    license_response = require_license_connection()
    if license_response:
        return license_response

    try:
        workbook = generate_workbook(request.get_json(force=True), validate_epo_quantity=True, validate_laboratory=True)
        return send_file(
            workbook,
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            as_attachment=True,
            download_name="generated.xlsx",
        )
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:
        logger.exception("SOA Excel generation failed")
        return jsonify({"error": "Unable to generate the SOA workbook."}), 500


@app.route("/api/soa-excel/batch", methods=["POST"])
@app.route("/api/soa-excel/batch/validate", methods=["POST"])
def soa_excel_batch():
    license_response = require_license_connection()
    if license_response:
        return license_response

    upload = request.files.get("file")
    if not upload or not upload.filename:
        return jsonify({"error": "Upload an Excel workbook to generate a batch."}), 400
    try:
        month = int(request.form.get("month", "1"))
        year = int(request.form.get("year", "2026"))
        if not 1 <= month <= 12 or not 1900 <= year <= 2100:
            raise ValueError("Choose a valid claim month and year.")
        upload.stream.seek(0)
        if request.path.endswith("/validate"):
            return jsonify(batch_workbooks(upload.stream, month, year, preview=True))
        archive = batch_workbooks(upload.stream, month, year)
        return send_file(archive, mimetype="application/zip", as_attachment=True, download_name="SOA_Batch.zip")
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:
        logger.exception("SOA Excel batch generation failed")
        return jsonify({"error": "Unable to generate the SOA batch."}), 500


@app.route("/api/soa-excel/download-template", methods=["GET"])
def soa_excel_download_template():
    try:
        workbook = build_batch_template()
        return send_file(
            workbook,
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            as_attachment=True,
            download_name="SOA_Batch_Template.xlsx",
        )
    except Exception:
        logger.exception("SOA Excel template generation failed")
        return jsonify({"error": "Unable to generate the SOA batch template."}), 500


@app.route("/api/soa-excel/save-generated", methods=["POST"])
def soa_excel_save_generated():
    try:
        data = request.get_json(force=True)
        target = _save_generated_download(data.get("filename"), data.get("data_url"))
        return jsonify({"ok": True, "path": str(target)})
    except (TypeError, ValueError) as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception:
        logger.exception("SOA Excel generated file save failed")
        return jsonify({"ok": False, "error": "Unable to save generated file."}), 500


@app.route("/<path:filename>")
def web_static(filename):
    if filename == "bot.ico":
        return send_file(APP_ICON_PATH)
    return send_from_directory(app.static_folder, filename)


@app.route("/api/auth/me", methods=["GET"])
def auth_me():
    user = current_user()
    if not user or not user.is_active:
        return jsonify({"authenticated": False})
    return jsonify({"authenticated": True, "user": user_payload(user)})


@app.route("/api/auth/register", methods=["POST"])
def auth_register():
    data = request.get_json(force=True)
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    display_name = str(data.get("display_name", "")).strip() or None

    if not email or "@" not in email:
        return jsonify({"error": "Please enter a valid email address."}), 400
    if len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters."}), 400
    if User.query.filter_by(email=email).first():
        return jsonify({"error": "An account with this email already exists."}), 409

    user = User(
        email=email,
        password_hash=generate_password_hash(password),
        display_name=display_name,
    )
    db.session.add(user)
    db.session.flush()
    db.session.add(UserSetting(user_id=user.id))
    db.session.commit()

    session.clear()
    session["user_id"] = user.id
    session.permanent = True
    return jsonify({"user": user_payload(user)}), 201


@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    data = request.get_json(force=True)
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    user = User.query.filter_by(email=email).first()

    if not user or not user.is_active or not check_password_hash(user.password_hash, password):
        return jsonify({"error": "Invalid email or password."}), 401

    session.clear()
    session["user_id"] = user.id
    session.permanent = True
    return jsonify({"user": user_payload(user)})


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    session.clear()
    return jsonify({"logged_out": True})


# ---------------------------------------------------------------------------
# Settings
# Auth tokens are invalidated when Beacon credentials or server change.
# ---------------------------------------------------------------------------
@app.route("/api/settings", methods=["GET"])
def get_settings():
    user = current_user()
    if user:
        settings = get_or_create_user_settings(user)
        return jsonify(user_settings_payload(settings))
    return jsonify(load_login_settings())


@app.route("/api/settings", methods=["POST"])
def post_settings():
    """
    Body: username, password, access key, and/or Beacon server settings.
    Authentication is cached in memory, so discard it whenever the account
    or selected Beacon environment changes.
    """
    data = request.get_json(force=True)
    user = current_user()
    if user:
        settings = get_or_create_user_settings(user)
        auth_changed = False

        if "username" in data:
            username = str(data.get("username") or "").strip()
            auth_changed = auth_changed or username != (settings.beacon_username or "")
            settings.beacon_username = username

        if "password" in data and data.get("password") != "********":
            password = str(data.get("password") or "")
            auth_changed = True
            settings.beacon_password_encrypted = encrypt_field(password)

        if "server" in data:
            server = "s2" if data.get("server") == "s2" else "s4"
            auth_changed = auth_changed or server != settings.server
            settings.server = server

        if "soa_folder" in data:
            settings.soa_folder = str(data.get("soa_folder") or "").strip()

        if auth_changed:
            settings.beacon_user_id = None
            settings.beacon_validated_at = None
            browser_session.invalidate_auth_token()

        db.session.commit()
        return jsonify(user_settings_payload(settings))

    settings = load_login_settings()
    auth_changed = any(
        key in data and data[key] != settings.get(key)
        for key in ("username", "password", "server")
    )
    settings.update(data)
    save_login_settings(settings)
    if auth_changed:
        browser_session.invalidate_auth_token()
    return jsonify(settings)


@app.route("/api/license/status", methods=["GET"])
@login_required
def license_status_route():
    return jsonify(get_license_status())


@app.route("/api/license/activate", methods=["POST"])
@login_required
def license_activate_route():
    data = request.get_json(force=True)
    license_key = str(data.get("license_key", "")).strip()
    if not license_key:
        return jsonify({"error": "Please enter a license key."}), 400

    status = verify_license(license_key=license_key, force=True)
    if not status.get("valid"):
        return jsonify({
            "error": status.get("reason") or "Invalid license.",
            "license": status,
        }), 400
    return jsonify(status)


@app.route("/api/license/deactivate", methods=["POST"])
@login_required
def license_deactivate_route():
    return jsonify(clear_license())


@app.route("/api/app/version", methods=["GET"])
def app_version_route():
    return jsonify({"version": APP_VERSION})


@app.route("/api/update/status", methods=["GET"])
@login_required
def update_status_route():
    return jsonify(get_update_status())


@app.route("/api/update/check", methods=["POST"])
@login_required
def update_check_route():
    try:
        return jsonify(check_for_update())
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502


@app.route("/api/update/apply", methods=["POST"])
@login_required
def update_apply_route():
    return jsonify({"started": apply_downloaded_update()})


@app.route("/api/beacon/validate", methods=["POST"])
@login_required
def beacon_validate():
    user = current_user()
    settings = get_or_create_user_settings(user)
    data = request.get_json(silent=True) or {}

    username = str(data.get("username") or settings.beacon_username or "").strip()
    password = str(data.get("password") or decrypt_field(settings.beacon_password_encrypted))
    server = "s2" if (data.get("server") or settings.server) == "s2" else "s4"

    if not username or not password:
        return jsonify({
            "valid": False,
            "error": "Beacon username and password are required.",
        }), 400

    try:
        token_data = browser_session.login_via_api(username, password, server=server)
    except Exception as ex:
        settings.beacon_user_id = None
        settings.beacon_validated_at = None
        db.session.commit()
        return jsonify({
            "valid": False,
            "error": f"Beacon login failed. Please check the username, password, and server. ({ex})",
        }), 401

    settings.beacon_username = username
    settings.beacon_password_encrypted = encrypt_field(password)
    settings.server = server
    settings.beacon_user_id = str(token_data.get("Id") or "")
    settings.beacon_validated_at = utc_now()
    db.session.commit()
    sync_legacy_settings_for_user(user)

    return jsonify({
        "valid": True,
        "beacon_connected": True,
        "beacon_user_id": settings.beacon_user_id,
        "beacon_validated_at": settings.beacon_validated_at.isoformat(),
    })


@app.route("/api/cf4/settings", methods=["GET"])
def get_cf4_settings():
    """Backs the CF4 screen's initial load — same values beacon.py's
    Auto Encode CF4 step will use on the next run."""
    user = current_user()
    if user:
        settings = get_or_create_user_settings(user)
        return jsonify({**DEFAULT_CF4_SETTINGS, **(settings.cf4_settings or {})})
    return jsonify(_load_cf4_settings())


@app.route("/api/cf4/settings", methods=["POST"])
def post_cf4_settings():
    """
    Body: any subset of DEFAULT_CF4_SETTINGS' keys. Merged over the
    current saved values (not replaced wholesale), then written into
    settings.json under "cf4" via the existing save_login_settings().
    """
    data = request.get_json(force=True)
    user = current_user()
    if user:
        settings = get_or_create_user_settings(user)
        cf4 = {**DEFAULT_CF4_SETTINGS, **(settings.cf4_settings or {}), **data}
        settings.cf4_settings = cf4
        db.session.commit()
        return jsonify(cf4)

    settings = load_login_settings()
    cf4 = {**DEFAULT_CF4_SETTINGS, **settings.get("cf4", {}), **data}
    settings["cf4"] = cf4
    save_login_settings(settings)
    return jsonify(cf4)


# ---------------------------------------------------------------------------
# CF2 workbook analysis
# Analyze the uploaded workbook and return a structured JSON payload.
# ---------------------------------------------------------------------------
def _analyze_workbook(workbook, claim_year, claim_month=None, mode="new_draft"):
    sheet = workbook["Sheet1"]
    records = []
    time_column = next(
        (
            cell.column
            for cell in sheet[1]
            if str(cell.value or "").strip().casefold()
            in ("time", "time (optional)")
        ),
        None,
    )
    px_contact_column = next(
        (
            cell.column
            for cell in sheet[1]
            if str(cell.value or "").strip().casefold()
            in ("px contact# (optional)", "px contact # (optional)", "px contact", "px contact#")
        ),
        None,
    )

    for row in range(2, sheet.max_row + 1):
        # Column layout is the same in both templates — only what column A
        # MEANS changes: Member PIN for a fresh draft (new_draft, the
        # original CF2_Template.xlsx), or an existing Transmittal No. to
        # search for instead (existing_draft, CF2_Template_ExistingDraft.xlsx).
        # B=NAME, C=DOCTOR, D=ACCREDITATION NO., E=TREATMENT DATES either way.
        patient = sheet[f"B{row}"].value
        if patient is None:
            continue

        identifier = sheet[f"A{row}"].value
        doctor = sheet[f"C{row}"].value
        accreditation = sheet[f"D{row}"].value
        treatment_dates = sheet[f"E{row}"].value
        time_range = sheet.cell(row=row, column=time_column).value if time_column else None
        px_contact = sheet.cell(row=row, column=px_contact_column).value if px_contact_column else None
        try:
            admission_time, discharge_time = parse_time_range(time_range)
        except ValueError as ex:
            raise ValueError(f"Row {row}: {ex}") from ex

        identifier_str = str(identifier).strip() if identifier is not None else ""

        record = PatientRecord(
            transmittal=identifier_str if mode == "existing_draft" else "",
            patient_name=str(patient),
            doctor=str(doctor),
            accreditation_no=str(accreditation),
            treatment_dates_raw=str(treatment_dates),
            time_range_raw=str(time_range).strip() if time_range is not None else "",
            member_pin=identifier_str if mode == "new_draft" else "",
            px_contact_no=str(px_contact).strip() if px_contact is not None else "",
            admission_time=admission_time,
            discharge_time=discharge_time,
            source_row=row,
        )

        record.treatment_dates = parse_dates(
            record.treatment_dates_raw, claim_year, claim_month
        )

        if record.treatment_dates:
            record.first_treatment = record.treatment_dates[0]
            record.last_treatment = record.treatment_dates[-1]
            record.total_sessions = len(record.treatment_dates)

        records.append(record)

    return records


def _record_to_dict(record, cf2, mode="new_draft"):
    """Same fields the old log_box printed per patient, as JSON instead of
    text. "identifier"/"identifier_label" replace the old hardcoded
    "member_pin" display line so the CF2 window can show whichever column
    A actually meant for this upload (Member PIN vs. Transmittal No.)."""
    return {
        "identifier_label": "Transmittal No." if mode == "existing_draft" else "Member PIN",
        "identifier": record.transmittal if mode == "existing_draft" else record.member_pin,
        "excel_row": record.source_row,
        "patient_name": record.patient_name,
        "doctor": record.doctor,
        "accreditation_no": record.accreditation_no,
        "treatment_dates_raw": record.treatment_dates_raw,
        "time_range_raw": record.time_range_raw,
        "px_contact_no": record.px_contact_no,
        "admission_time": format_beacon_time(record.admission_time) if record.admission_time else None,
        "discharge_time": format_beacon_time(record.discharge_time) if record.discharge_time else None,
        "parsed_dates": [d.strftime("%m-%d-%Y") for d in record.treatment_dates],
        "first_treatment": record.first_treatment.strftime("%m-%d-%Y") if record.first_treatment else None,
        "last_treatment": record.last_treatment.strftime("%m-%d-%Y") if record.last_treatment else None,
        "total_sessions": record.total_sessions,
        "cf2": {
            "transmittal": cf2.transmittal,
            "patient_name": cf2.patient_name,
            "doctor": cf2.doctor,
            "accreditation_no": cf2.accreditation_no,
            "first_treatment": cf2.first_treatment.strftime("%m-%d-%Y") if cf2.first_treatment else None,
            "last_treatment": cf2.last_treatment.strftime("%m-%d-%Y") if cf2.last_treatment else None,
            "total_sessions": cf2.total_sessions,
        },
    }


@app.route("/api/cf2/upload", methods=["POST"])
@login_required
def cf2_upload():
    """
    Body: {"path": "<file path>", "claim_year": 2026, "claim_month": "June",
           "mode": "new_draft" | "existing_draft"}
    Browser clients upload the workbook as multipart form data. The path
    fallback is kept for trusted local deployments.
    """
    if request.content_type and request.content_type.startswith("multipart/form-data"):
        data = request.form
        uploaded = request.files.get("file")
        if not uploaded:
            return jsonify({"error": "No Excel file uploaded."}), 400
        try:
            filename = str(_save_upload(uploaded, "cf2", {".xlsx", ".xlsm", ".xls"}))
        except ValueError as ex:
            return jsonify({"error": str(ex)}), 400
    else:
        data = request.get_json(force=True)
        filename = data.get("path")
    claim_year = int(data.get("claim_year"))
    claim_month_name = data.get("claim_month")
    claim_month = MONTH_NAMES.index(claim_month_name) + 1 if claim_month_name else None
    mode = data.get("mode") if data.get("mode") in ("new_draft", "existing_draft") else "new_draft"

    if not filename or not Path(filename).is_file():
        return jsonify({"error": "File not found."}), 400

    try:
        workbook = load_workbook(filename, data_only=True)
    except Exception as ex:
        return jsonify({"error": str(ex)}), 400

    try:
        records = _analyze_workbook(workbook, claim_year, claim_month, mode)
    except ValueError as ex:
        workbook.close()
        return jsonify({"error": str(ex)}), 400
    user = current_user()
    _cf2_states[user.id] = {
        "selected_file": filename,
        "patient_records": records,
        "cf2_mode": mode,
    }

    payload_records = [_record_to_dict(r, build_cf2_data(r), mode) for r in records]

    return jsonify({
        "sheets": workbook.sheetnames,
        "patient_count": len(records),
        "records": payload_records,
    })


@app.route("/api/cf2/download-template", methods=["GET"])
def cf2_download_template():
    """
    Returns the template bytes for the requested mode (?mode=new_draft,
    the default, or ?mode=existing_draft).
    """
    mode = request.args.get("mode") if request.args.get("mode") in ("new_draft", "existing_draft") else "new_draft"

    if mode == "existing_draft":
        template_path = resource_path(os.path.join("templates", "CF2_Template_ExistingDraft.xlsx"))
        download_name = "CF2_Template_ExistingDraft.xlsx"
    else:
        template_path = resource_path(os.path.join("templates", "CF2_Template.xlsx"))
        download_name = "CF2_Template.xlsx"

    return send_file(template_path, as_attachment=True, download_name=download_name)


# ---------------------------------------------------------------------------
# CF2 automation run — identical worker logic to the old
# _run_automation_worker(), just triggered by an HTTP call instead of a
# button's command=, and reporting back over the "cf2_done" socket event
# instead of log_box.after(...).
# ---------------------------------------------------------------------------
def _run_cf2_automation(user_id, beacon_settings, state, stop_event):
    automation = None
    stopped = False
    room_token = _emit_room.set(user_room(user_id))
    try:
        records = state["patient_records"]
        total = len(records)
        mode = state["cf2_mode"]

        def emit_progress(record, current, status, phase="", message="", result=None):
            identifier_label = "Transmittal No." if mode == "existing_draft" else "Member PIN"
            identifier = record.transmittal if mode == "existing_draft" else record.member_pin
            emit_to_current_room("cf2_progress", {
                "mode": mode,
                "current": current,
                "total": total,
                "excel_row": getattr(record, "source_row", 0),
                "identifier_label": identifier_label,
                "identifier": identifier,
                "patient_name": getattr(record, "patient_name", ""),
                "status": status,
                "phase": phase,
                "message": message,
                "result": result,
            })

        auth_key = browser_session.auth_context_key(
            beacon_settings,
            user_key=f"user:{user_id}",
        )
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            automation = CF2Automation(
                uploaded_excel_path=state["selected_file"],
                mode=mode,
                progress_callback=lambda phase, message="": emit_progress(
                    automation._progress_record,
                    automation._progress_current,
                    "running",
                    phase,
                    message,
                ) if automation and automation._progress_record is not None else None,
            )
            for current, record in enumerate(records, start=1):
                if stop_event.is_set():
                    stopped = True
                    emit_to_current_room("log", {
                        "message": "STOP REQUESTED: CF2 automation stopped before the next patient.",
                        "level": "WARNING",
                    })
                    break
                try:
                    emit_progress(record, current, "running", "Starting", "Preparing patient row.")
                    result = automation.process_patient(record, current=current, total=total)
                    final_status = result.get("status", "failed")
                    emit_progress(
                        record,
                        current,
                        final_status,
                        "Completed" if final_status == "success" else result.get("message", ""),
                        result.get("message", ""),
                        result=result,
                    )
                except Exception as ex:
                    failed_result = {
                        "transmittal": getattr(record, "transmittal", "?"),
                        "patient_name": getattr(record, "patient_name", "?"),
                        "status": "failed",
                        "message": f"Unhandled error: {ex}",
                    }
                    automation.results.append(failed_result)
                    emit_progress(
                        record,
                        current,
                        "failed",
                        "Failed",
                        failed_result["message"],
                        result=failed_result,
                    )
                if stop_event.is_set():
                    stopped = True
                    emit_to_current_room("log", {
                        "message": "STOP REQUESTED: CF2 automation stopped after the current patient.",
                        "level": "WARNING",
                    })
                    break
    except Exception as ex:
        emit_to_current_room("log", {"message": f"ERROR: {ex}", "level": "ERROR"})
    finally:
        if automation is not None:
            try:
                automation.close()
            except Exception as ex:
                emit_to_current_room("log", {
                    "message": f"WARNING: Could not close automation session: {ex}",
                    "level": "WARNING",
                })

        results = automation.get_summary() if automation is not None else []
        _cf2_runs.pop(user_id, None)
        emit_to_current_room("cf2_done", {"results": results, "stopped": stopped})
        _emit_room.reset(room_token)


@app.route("/api/cf2/start", methods=["POST"])
@login_required
@serialize_job_start
def cf2_start():
    user, beacon_settings, error_response = require_beacon_connection()
    if error_response:
        return error_response
    license_response = require_license_connection()
    if license_response:
        return license_response
    state = _cf2_states.get(user.id)
    if not state or not state["patient_records"]:
        return jsonify({"error": "No patients loaded."}), 400
    if user.id in _cf2_runs:
        return jsonify({"error": "Automation already running."}), 409

    stop_event = threading.Event()
    _cf2_runs[user.id] = {"stop_event": stop_event}
    threading.Thread(
        target=_run_cf2_automation,
        args=(user.id, beacon_settings, state, stop_event),
        daemon=True,
    ).start()
    return jsonify({"started": True})


@app.route("/api/cf2/stop", methods=["POST"])
@login_required
def cf2_stop():
    user = current_user()
    run = _cf2_runs.get(user.id)
    if not run:
        return jsonify({"stopped": False, "running": False})
    run["stop_event"].set()
    socketio.emit("log", {
        "message": "Stop requested. CF2 automation will end after the current safe step.",
        "level": "WARNING",
    }, room=user_room(user.id))
    return jsonify({"stopped": True, "running": True})


# ---------------------------------------------------------------------------
# SOA upload automation worker. The browser handles its own controls while
# this runs.
# ---------------------------------------------------------------------------
def _run_soa_automation(user_id, beacon_settings, soa_folder, transmittals, stop_event):
    soa_automation = None
    stopped = False
    room_token = _emit_room.set(user_room(user_id))
    try:
        auth_key = browser_session.auth_context_key(
            beacon_settings,
            user_key=f"user:{user_id}",
        )
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            soa_automation = SOAAutomation(soa_folder=soa_folder)
            soa_automation.run(transmittals, should_stop=stop_event.is_set)
            stopped = stop_event.is_set()
    except Exception as ex:
        emit_to_current_room("log", {"message": f"FATAL ERROR: {ex}", "level": "ERROR"})
    finally:
        results = soa_automation.get_results() if soa_automation is not None else []
        _soa_runs.pop(user_id, None)
        emit_to_current_room("soa_done", {"results": results, "stopped": stopped})
        _emit_room.reset(room_token)


@app.route("/api/soa/start", methods=["POST"])
@login_required
@serialize_job_start
def soa_start():
    user, beacon_settings, error_response = require_beacon_connection()
    if error_response:
        return error_response
    license_response = require_license_connection()
    if license_response:
        return license_response
    is_multipart = request.content_type and request.content_type.startswith("multipart/form-data")
    if is_multipart:
        data = request.form
        transmittals = [
            line.strip()
            for line in data.get("transmittals", "").splitlines()
            if line.strip()
        ]
        soa_folder_path, soa_files = _prepare_upload_folder(
            request.files.getlist("soa_files"),
            {".xlsx", ".xls"},
        )
        soa_folder = str(soa_folder_path)
        if not soa_files:
            return jsonify({"error": "Please upload at least one SOA Excel file."}), 400
    else:
        data = request.get_json(force=True)
        transmittals = data.get("transmittals", [])
        soa_folder = data.get("soa_folder", "").strip()

    if not transmittals:
        return jsonify({"error": "Please enter at least one transmittal number."}), 400
    if not soa_folder:
        return jsonify({"error": "Please select the folder where your SOA files are located."}), 400
    if not Path(soa_folder).is_dir():
        return jsonify({"error": f"The selected SOA folder does not exist:\n\n{soa_folder}"}), 400
    if user.id in _soa_runs:
        return jsonify({"error": "Automation already running."}), 409

    # Remember the folder choice for next time — same as the old
    # browse_soa_folder()'s settings["soa_folder"] = chosen; save_login_settings(settings)
    if not is_multipart:
        user_settings = get_or_create_user_settings(user)
        user_settings.soa_folder = soa_folder
        db.session.commit()

    stop_event = threading.Event()
    _soa_runs[user.id] = {"stop_event": stop_event}
    threading.Thread(
        target=_run_soa_automation,
        args=(user.id, beacon_settings, soa_folder, transmittals, stop_event),
        daemon=True,
    ).start()
    return jsonify({"started": True})


@app.route("/api/soa/stop", methods=["POST"])
@login_required
def soa_stop():
    user = current_user()
    run = _soa_runs.get(user.id)
    if not run:
        return jsonify({"stopped": False, "running": False})
    run["stop_event"].set()
    socketio.emit("log", {
        "message": "Stop requested. SOA automation will end after the current safe step.",
        "level": "WARNING",
    }, room=user_room(user.id))
    return jsonify({"stopped": True, "running": True})


# ---------------------------------------------------------------------------
# Main dashboard automation (beacon.run() + reports.report) — the flow
# ui.py's start_automation()/run_automation() drove. Distinct from the CF2
# and SOA automations above: this is the original "Move to CF2" precursor
# run against a plain list of transmittals.
# ---------------------------------------------------------------------------
def _run_beacon_automation(user_id, beacon_settings, transmittals, auto_encode_cf4, cf4_settings, stop_event):
    stopped = False
    room_token = _emit_room.set(user_room(user_id))
    try:
        auth_key = browser_session.auth_context_key(
            beacon_settings,
            user_key=f"user:{user_id}",
        )
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            beacon_run(
                transmittals,
                auto_encode_cf4=auto_encode_cf4,
                cf4_data=cf4_settings,
                should_stop=stop_event.is_set,
            )
            stopped = stop_event.is_set()
    except Exception as ex:
        emit_to_current_room("log", {"message": f"ERROR: {ex}", "level": "ERROR"})
    finally:
        _beacon_runs.pop(user_id, None)
        emit_to_current_room("beacon_done", {"results": report.results, "stopped": stopped})
        _emit_room.reset(room_token)


@app.route("/api/beacon/start", methods=["POST"])
@login_required
@serialize_job_start
def beacon_start():
    user, beacon_settings, error_response = require_beacon_connection()
    if error_response:
        return error_response
    license_response = require_license_connection()
    if license_response:
        return license_response
    data = request.get_json(force=True)
    transmittals = data.get("transmittals", [])
    auto_encode_cf4 = bool(data.get("auto_encode_cf4", False))

    if not transmittals:
        return jsonify({"error": "Please paste at least one transmittal number."}), 400
    if user.id in _beacon_runs:
        return jsonify({"error": "Automation already running."}), 409

    # Read whatever was last saved on the CF4 screen (falls back to
    # DEFAULT_CF4_SETTINGS for anything never saved) — this is what makes
    # the checkbox on the dashboard use the *current* CF4 defaults rather
    # than whatever was hardcoded in beacon.py at build time.
    user_settings = get_or_create_user_settings(user)
    cf4_settings = {**DEFAULT_CF4_SETTINGS, **(user_settings.cf4_settings or {})}

    stop_event = threading.Event()
    _beacon_runs[user.id] = {"stop_event": stop_event}
    threading.Thread(
        target=_run_beacon_automation,
        args=(user.id, beacon_settings, transmittals, auto_encode_cf4, cf4_settings, stop_event),
        daemon=True,
    ).start()
    return jsonify({"started": True})


@app.route("/api/beacon/stop", methods=["POST"])
@login_required
def beacon_stop():
    user = current_user()
    run = _beacon_runs.get(user.id)
    if not run:
        return jsonify({"stopped": False, "running": False})
    run["stop_event"].set()
    socketio.emit("log", {
        "message": "Stop requested. CF4 automation will end after the current safe step.",
        "level": "WARNING",
    }, room=user_room(user.id))
    return jsonify({"stopped": True, "running": True})


if __name__ == "__main__":
    init_database()
    start_background_license_checker()
    start_background_updater()
    port = int(os.environ.get("PORT") or os.environ.get("BEABOTS_PORT", 5417))
    host = os.environ.get("HOST", "0.0.0.0")
    socketio.run(app, host=host, port=port, allow_unsafe_werkzeug=True)
