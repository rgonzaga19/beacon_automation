"""
Flask and Socket.IO server for the Beabots web application.

It serves browser pages, app accounts, per-user Beacon credentials,
workbook uploads, automation API endpoints, and live progress events.

Run directly for local testing:
    python server.py
"""

import os
import threading
import tempfile
import shutil
import uuid
import re
import json
import time
from calendar import monthrange
from io import BytesIO
from datetime import date, datetime, timedelta, timezone
from contextvars import ContextVar
from pathlib import Path

from functools import wraps

import requests
from flask import Flask, request, jsonify, send_file, send_from_directory, session
from flask_limiter import Limiter
from flask_limiter.errors import RateLimitExceeded
from flask_limiter.util import get_remote_address
from flask_socketio import SocketIO, join_room
from flask_cors import CORS
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename
from sqlalchemy import DateTime, LargeBinary, inspect, text, or_, func
from sqlalchemy.orm import load_only, selectinload

from openpyxl import load_workbook

from app.core.config import AppConfig
from app.core.database import db
import app.models  # noqa: F401 - imported so SQLAlchemy registers the tables
from app.models import (
    AutomationRun,
    Cf4TransmittalTaskSnapshot,
    BeaconClaimAnalyticsCache,
    BeaconClaimAnalyticsSync,
    ClaimBillingSchedule,
    Cf2TaskSnapshot,
    DocumentTaskSnapshot,
    RunAllTaskSnapshot,
    SoaTaskSnapshot,
    TeamChatMessage,
    UpgradeRequest,
    User,
    UserSetting,
    utc_now,
)
from app.core import browser_session
from app.core.logger import logger
from app.core.version import APP_VERSION
from app.domain.patient_record import PatientRecord
from app.domain.date_parser import MONTHS, parse_dates
from app.domain.claim_analytics import (
    build_claim_analytics,
    classify_claim_status,
    default_billing_weeks,
    initial_billing_weeks,
    parse_billing_month,
    validate_billing_weeks,
)
from app.domain.time_parser import parse_time_range, format_beacon_time
from app.domain.cf2_mapper import build_cf2_data
from app.automation.cf2 import CF2Automation
from app.automation.draft_title import MAX_TITLE_LENGTH
from app.automation.soa import SOAAutomation, _find_soa_file
from app.automation.beacon import run as beacon_run
from app.automation import beacon as beacon_automation
from app.automation.auto_rename_service import build_renamed_archive, build_template, create_preview
from app.api import beacon as beacon_api
from app.api import cf2 as cf2_api
from app.api import soa as soa_api
from app.api import documents as documents_api
from app.automation.soa import _split_surname_and_given, _normalize
from app.domain.time_parser import format_beacon_time
from app.domain.soa_excel import batch_workbooks, build_batch_template, generate_workbook
from app.core.security import decrypt_field, encrypt_field

BASE_DIR = Path(__file__).resolve().parent
APP_ICON_PATH = BASE_DIR / "renderer" / "assets" / "bot.ico"
UPLOAD_DIR = Path(
    os.environ.get("BEABOTS_UPLOAD_DIR")
    or Path(tempfile.gettempdir()) / "beabots_uploads"
)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=str(BASE_DIR / "renderer"), static_url_path="")
_claim_analytics_progress = {}
_claim_analytics_progress_lock = threading.Lock()
_claim_analytics_jobs = {}
_claim_analytics_jobs_lock = threading.Lock()
app.config.from_object(AppConfig)
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("BEABOTS_MAX_UPLOAD_MB", "100")) * 1024 * 1024
db.init_app(app)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")


def _rate_limit_client_ip():
    """Use the client address forwarded by Render, falling back to the socket address."""
    forwarded_for = request.headers.get("X-Forwarded-For", "")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip()
    return get_remote_address()


def _rate_limit_key():
    """Group authenticated API limits by account and unauthenticated limits by client IP."""
    user_id = session.get("user_id")
    return f"user:{user_id}" if user_id else f"ip:{_rate_limit_client_ip()}"


limiter = Limiter(
    key_func=_rate_limit_key,
    app=app,
    storage_uri=os.environ.get("REDIS_URL") or "memory://",
    default_limits=[],
    headers_enabled=True,
)


@app.errorhandler(RateLimitExceeded)
def handle_rate_limit_exceeded(error):
    response = jsonify({
        "error": "rate_limit_exceeded",
        "message": "Too many requests. Please wait a moment and try again.",
    })
    response.status_code = 429
    retry_after = error.get_response().headers.get("Retry-After")
    if retry_after:
        response.headers["Retry-After"] = retry_after
    return response


@app.after_request
def revalidate_renderer_assets(response):
    # Renderer pages and scripts should be revalidated after each deployment,
    # so browsers do not keep running an older UI from their local cache.
    if response.mimetype in {"text/html", "text/css", "text/javascript", "application/javascript"}:
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response

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
_cf2_snapshot_lock = threading.RLock()
_soa_runs = {}
_soa_snapshot_lock = threading.RLock()
_document_runs = {}
_document_snapshot_lock = threading.RLock()
_cf4_transmittal_runs = {}
_cf4_transmittal_snapshot_lock = threading.RLock()
_run_all_runs = {}
_run_all_retry_states = {}
_run_all_status = {}
_run_all_status_lock = threading.RLock()
_server_instance_id = uuid.uuid4().hex
_dashboard_socket_lock = threading.RLock()
_dashboard_sockets = {}
_server_started_at = utc_now()
_job_start_lock = threading.RLock()
def serialize_job_start(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        with _job_start_lock:
            if fn.__name__ != "run_all_start":
                user = current_user()
                if user and user.id in _run_all_runs:
                    return jsonify({"error": "Run All is already running for this account."}), 409
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
        with _dashboard_socket_lock:
            _dashboard_sockets[request.sid] = user_id
        _broadcast_dashboard_presence()


@socketio.on("disconnect")
def socket_disconnected():
    with _dashboard_socket_lock:
        _dashboard_sockets.pop(request.sid, None)
    _broadcast_dashboard_presence()


def _online_user_count():
    with _dashboard_socket_lock:
        return len(set(_dashboard_sockets.values()))


def _online_user_list():
    with _dashboard_socket_lock:
        user_ids = set(_dashboard_sockets.values())
    if not user_ids:
        return []
    users = User.query.filter(User.id.in_(user_ids), User.is_active.is_(True)).all()
    return sorted(
        [{"id": user.id, "name": user.display_name or user.profile_name or user.email}
         for user in users],
        key=lambda user: user["name"].casefold(),
    )


def _broadcast_dashboard_presence():
    socketio.emit("dashboard_presence_update", {"online_users": _online_user_count()})
    payload = {"users": _online_user_list()}
    with _dashboard_socket_lock:
        user_ids = set(_dashboard_sockets.values())
    for user_id in user_ids:
        socketio.emit("dashboard_online_users", payload, room=user_room(user_id))


def _record_automation_run(user_id, workflow, started_at, status, item_count):
    """Persist a compact run summary; no claim identifiers or patient data."""
    finished_at = utc_now()
    duration = max(0, int((finished_at - started_at).total_seconds()))
    try:
        with app.app_context():
            try:
                db.session.add(AutomationRun(
                    workflow=workflow,
                    status=status,
                    item_count=max(0, int(item_count or 0)),
                    duration_seconds=duration,
                    runner_name=(
                        (runner.display_name or runner.profile_name or runner.email)
                        if (runner := db.session.get(User, user_id)) else None
                    ),
                    started_at=started_at,
                    finished_at=finished_at,
                ))
                db.session.flush()
                # Keep a bounded history so this remains a small, predictable table.
                old_ids = db.session.query(AutomationRun.id).order_by(
                    AutomationRun.finished_at.desc(), AutomationRun.id.desc()
                ).offset(500).subquery()
                db.session.query(AutomationRun).filter(AutomationRun.id.in_(old_ids)).delete(synchronize_session=False)
                db.session.commit()
            except Exception:
                db.session.rollback()
                raise
    except Exception:
        logger.exception("Could not save dashboard automation history for user %s", user_id)


def track_dashboard_operation(workflow, skip_paths=()):
    """Record a privacy-safe summary for a synchronous dashboard operation."""
    def decorate(handler):
        @wraps(handler)
        def wrapper(*args, **kwargs):
            if request.path in skip_paths:
                return handler(*args, **kwargs)
            user = current_user()
            if not user:
                return handler(*args, **kwargs)

            started_at = utc_now()
            try:
                result = handler(*args, **kwargs)
            except Exception:
                _record_automation_run(user.id, workflow, started_at, "failed", 1)
                raise

            response = result[0] if isinstance(result, tuple) else result
            status_code = result[1] if isinstance(result, tuple) and len(result) > 1 else getattr(response, "status_code", 200)
            status = "completed" if 200 <= int(status_code) < 300 else "failed"
            _record_automation_run(user.id, workflow, started_at, status, 1)
            return result

        return wrapper
    return decorate


def _automation_outcome(results, stopped=False, failed=False):
    if stopped:
        return "stopped"
    if failed:
        return "partial" if results else "failed"
    values = []
    for item in results or []:
        if not isinstance(item, dict):
            continue
        values.extend(str(value).lower() for key, value in item.items()
                      if key == "status" or key in {"cf2", "soa", "esoa", "cf4"})
    failures = sum(value in {"failed", "failure", "error"} for value in values)
    successes = sum(value in {"success", "completed", "complete"} for value in values)
    if failures:
        return "partial" if successes else "failed"
    return "completed"


def init_database():
    with app.app_context():
        db.create_all()
        run_history_index = next(
            index for index in AutomationRun.__table__.indexes
            if index.name == "ix_automation_runs_finished_at_id"
        )
        run_history_index.create(bind=db.engine, checkfirst=True)
        run_columns = {column["name"] for column in inspect(db.engine).get_columns("automation_runs")}
        if "runner_name" not in run_columns:
            db.session.execute(text("ALTER TABLE automation_runs ADD COLUMN runner_name VARCHAR(120)"))
            db.session.commit()
        # Add profile fields to databases created by earlier releases.
        columns = {column["name"] for column in inspect(db.engine).get_columns("users")}
        if "profile_name" not in columns:
            table = db.engine.dialect.identifier_preparer.quote("users")
            column = db.engine.dialect.identifier_preparer.quote("profile_name")
            db.session.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} VARCHAR(120)"))
            db.session.commit()
            columns.add("profile_name")
        if "avatar" not in columns:
            table = db.engine.dialect.identifier_preparer.quote("users")
            column = db.engine.dialect.identifier_preparer.quote("avatar")
            db.session.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} VARCHAR(32) NOT NULL DEFAULT 'avatar-penguin'"))
            db.session.commit()
        if "role" not in columns:
            table = db.engine.dialect.identifier_preparer.quote("users")
            column = db.engine.dialect.identifier_preparer.quote("role")
            db.session.execute(text(
                f"ALTER TABLE {table} ADD COLUMN {column} VARCHAR(20) NOT NULL DEFAULT 'member'"
            ))
            db.session.commit()
        table_names = set(inspect(db.engine).get_table_names())
        if "team_messages" in table_names:
            legacy_columns = {
                column["name"] for column in inspect(db.engine).get_columns("team_messages")
            }
            if "image_data" not in legacy_columns:
                binary_type = LargeBinary().compile(dialect=db.engine.dialect)
                db.session.execute(text(f"ALTER TABLE team_messages ADD COLUMN image_data {binary_type}"))
            if "image_mime" not in legacy_columns:
                db.session.execute(text("ALTER TABLE team_messages ADD COLUMN image_mime VARCHAR(30)"))
            if "channel" not in legacy_columns:
                db.session.execute(text(
                    "ALTER TABLE team_messages ADD COLUMN channel VARCHAR(20) NOT NULL DEFAULT ''"
                ))
            db.session.commit()

            legacy_rows = db.session.execute(text(
                "SELECT id, sender_id, sender_name, body, image_data, image_mime, created_at, channel "
                "FROM team_messages"
            ).columns(created_at=DateTime(timezone=True))).mappings().all()
            for row in legacy_rows:
                if row["channel"] == "team" and not db.session.get(TeamChatMessage, row["id"]):
                    db.session.add(TeamChatMessage(
                        id=row["id"], sender_id=row["sender_id"], sender_name=row["sender_name"],
                        body=row["body"], image_data=row["image_data"], image_mime=row["image_mime"],
                        created_at=row["created_at"],
                    ))
            db.session.commit()
            if db.engine.dialect.name == "postgresql":
                db.session.execute(text(
                    "SELECT setval(pg_get_serial_sequence('team_chat', 'id'), "
                    "COALESCE((SELECT MAX(id) FROM team_chat), 1), "
                    "EXISTS(SELECT 1 FROM team_chat))"
                ))
                db.session.commit()
            db.session.execute(text("DROP TABLE team_messages"))
            db.session.commit()
        # Keep the legacy flag aligned because existing authorization checks
        # use is_admin. Existing admins retain their role during migration.
        db.session.execute(text(
            "UPDATE users SET role = CASE "
            "WHEN is_admin = TRUE THEN 'admin' "
            "WHEN role = 'admin' THEN 'member' "
            "WHEN role IS NULL THEN 'member' "
            "WHEN role NOT IN ('member', 'subscriber') THEN 'member' "
            "ELSE role END"
        ))
        db.session.commit()


def current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    try:
        last_activity_at = float(session.get("last_activity_at"))
    except (TypeError, ValueError):
        session.clear()
        return None
    if time.time() - last_activity_at >= app.permanent_session_lifetime.total_seconds():
        session.clear()
        return None
    return db.session.get(User, user_id)


def user_payload(user):
    upgrade_request = UpgradeRequest.query.filter_by(user_id=user.id).first()
    name = user.display_name or user.profile_name or ""
    return {
        "id": user.id,
        "email": user.email,
        "profile_name": name,
        "display_name": name,
        "avatar": user.avatar or "avatar-penguin",
        "is_admin": user.is_admin,
        "role": user.role or ("admin" if user.is_admin else "member"),
        "upgrade_request_status": upgrade_request.status if upgrade_request else None,
    }


def login_required(handler):
    @wraps(handler)
    def wrapper(*args, **kwargs):
        user = current_user()
        if not user or not user.is_active:
            return jsonify({"error": "Authentication required."}), 401
        return handler(*args, **kwargs)

    return wrapper


@app.route("/api/dashboard/metrics", methods=["GET"])
@login_required
def dashboard_metrics():
    now = utc_now()
    since_30_days = now - timedelta(days=30)
    recent = AutomationRun.query.filter(AutomationRun.finished_at >= since_30_days).order_by(
        AutomationRun.finished_at.desc(), AutomationRun.id.desc()
    ).all()
    daily = {}
    workflows = {}
    statuses = {"completed": 0, "partial": 0, "stopped": 0, "failed": 0}
    for offset in range(7):
        day = (now.date() - timedelta(days=6 - offset)).isoformat()
        daily[day] = 0
    for run in recent:
        day = run.finished_at.date().isoformat()
        if day in daily:
            daily[day] += 1
        workflows[run.workflow] = workflows.get(run.workflow, 0) + 1
        statuses[run.status if run.status in statuses else "failed"] += 1
    total = len(recent)
    successful = statuses["completed"]
    return jsonify({
        "server_uptime_seconds": max(0, int((now - _server_started_at).total_seconds())),
        "online_users": _online_user_count(),
        "online_user_list": _online_user_list(),
        "runs_30_days": total,
        "success_rate": round((successful / total) * 100) if total else None,
        "daily_runs": [{"date": day, "count": count} for day, count in daily.items()],
        "workflow_runs": [{"workflow": key, "count": value} for key, value in sorted(workflows.items())],
        "statuses": statuses,
    })


def _claim_analytics_progress_update(user_id, **values):
    with _claim_analytics_progress_lock:
        for entry in _claim_analytics_progress.values():
            if entry.get("user_id") == user_id:
                entry.update(values)


def _clear_claim_analytics_cache(user_id):
    """Discard analytics tied to the user's previous Beacon credentials."""
    db.session.query(BeaconClaimAnalyticsCache).filter_by(user_id=user_id).delete(synchronize_session=False)
    sync = db.session.get(BeaconClaimAnalyticsSync, user_id)
    if sync is not None:
        db.session.delete(sync)


def _sync_beacon_claim_analytics(user_id, beacon_settings, auth_key, date_from, date_to, force_refresh):
    """Refresh compact per-claim fields in a background thread."""
    transmittals_scanned = claims_scanned = failed_transmittals = 0
    errors = []
    failed_transmittal_ids = set()
    try:
        with app.app_context():
            sync = db.session.get(BeaconClaimAnalyticsSync, user_id)
            if sync is None:
                sync = BeaconClaimAnalyticsSync(user_id=user_id)
                db.session.add(sync)
            retry_transmittal_ids = set(sync.failed_transmittal_ids or [])
            sync.window_start, sync.window_end = date_from, date_to
            sync.state, sync.last_attempt_at, sync.error_summary = "running", utc_now(), None
            db.session.commit()
            _claim_analytics_progress_update(user_id, current=0, total=0,
                message="Loading the transmittal list from Beacon...", phase="transmittals", done=False)
            with browser_session.use_auth_context(beacon_settings, key=auth_key):
                browser_session.invalidate_auth_token()
                transmittals = beacon_api.get_transmittals_in_range(date_from, date_to)
                transmittals_scanned = len(transmittals)
                _claim_analytics_progress_update(user_id, current=0, total=transmittals_scanned,
                    message=f"Found {transmittals_scanned} transmittals. Refreshing claim details...", phase="claims")
                for index, transmittal in enumerate(transmittals, start=1):
                    # Settings may have changed while this background refresh was
                    # running. Never let the previous account repopulate its cache.
                    active_settings = db.session.get(UserSetting, user_id)
                    active_beacon_settings = decrypt_user_settings(active_settings) if active_settings else {}
                    active_auth_key = browser_session.auth_context_key(active_beacon_settings, user_key=f"user:{user_id}")
                    if active_auth_key != auth_key:
                        raise RuntimeError("Beacon account changed during analytics refresh.")
                    transmittal_id = transmittal.get("id")
                    transmittal_status = transmittal.get("transmittalStatusDescription")
                    _claim_analytics_progress_update(user_id, current=index - 1, total=transmittals_scanned,
                        message=f"Checking transmittal {index} of {transmittals_scanned}...", phase="claims")
                    cached_transmittal_claims = BeaconClaimAnalyticsCache.query.filter_by(
                        user_id=user_id, transmittal_id=str(transmittal_id)
                    ).all() if transmittal_id is not None else []
                    is_draft = str(transmittal_status or "").strip().casefold() == "draft"
                    # Closed transmittals rarely change claim details. Reuse their
                    # cached claims and refresh only the status exposed in Beacon's
                    # transmittal list; manual Refresh still forces a complete scan.
                    if cached_transmittal_claims and not is_draft and not force_refresh and str(transmittal_id) not in retry_transmittal_ids:
                        for row in cached_transmittal_claims:
                            row.transmittal_status = str(transmittal_status or "")[:80]
                            row.updated_at = utc_now()
                        if index % 10 == 0:
                            db.session.commit()
                        _claim_analytics_progress_update(user_id, current=index, total=transmittals_scanned,
                            message=f"Reused cached claims for transmittal {index} of {transmittals_scanned}...", phase="claims")
                        continue
                    last_error = None
                    claims = None
                    auth_retried = False
                    for attempt in range(3):
                        try:
                            if transmittal_id is None:
                                raise ValueError("Beacon returned a transmittal without an ID.")
                            claims = beacon_api.get_claims(transmittal_id, refresh=True)
                            break
                        except Exception as exc:
                            last_error = exc
                            if "(401)" in str(exc) and not auth_retried:
                                auth_retried = True
                                browser_session.invalidate_auth_token()
                                continue
                            transient = isinstance(exc, requests.RequestException) or any(
                                code in str(exc) for code in ("(429)", "(500)", "(502)", "(503)", "(504)")
                            )
                            if transient and attempt < 2:
                                time.sleep(0.5 * (attempt + 1))
                                continue
                            break
                    if claims is None:
                        failed_transmittals += 1
                        if transmittal_id is not None:
                            failed_transmittal_ids.add(str(transmittal_id))
                        if len(errors) < 3:
                            errors.append(str(last_error)[:150])
                        logger.warning(f"Dashboard analytics skipped transmittal {transmittal_id}: {last_error}")
                        _claim_analytics_progress_update(user_id, current=index, total=transmittals_scanned,
                            message=f"Transmittal {index} of {transmittals_scanned} failed; continuing ({failed_transmittals} skipped)...", phase="claims")
                        continue
                    claims_scanned += len(claims)
                    claim_ids = [str(c.get("id")) for c in claims if isinstance(c, dict) and c.get("id") is not None]
                    existing = {}
                    if claim_ids:
                        existing = {row.claim_id: row for row in BeaconClaimAnalyticsCache.query.filter(
                            BeaconClaimAnalyticsCache.user_id == user_id,
                            BeaconClaimAnalyticsCache.claim_id.in_(claim_ids),
                        ).all()}
                    for claim in claims:
                        if not isinstance(claim, dict) or claim.get("id") is None:
                            continue
                        claim_id = str(claim["id"])
                        row = existing.get(claim_id)
                        cf2 = claim.get("phiccF2") if isinstance(claim.get("phiccF2"), dict) else {}
                        admission_value = cf2.get("admissionDateTime") or claim.get("admissionDateTime")
                        admission = None
                        if not admission_value and row is not None and row.admission_date is not None:
                            admission = datetime.combine(row.admission_date, datetime.min.time())
                        elif not admission_value:
                            try:
                                cf2 = cf2_api.get_cf2(claim_id) or {}
                                admission_value = cf2.get("admissionDateTime")
                            except Exception as exc:
                                logger.warning(f"Dashboard analytics could not retrieve claim {claim_id} admission date: {exc}")
                        if admission is None:
                            try:
                                admission = _beacon_local_datetime(admission_value)
                            except (TypeError, ValueError):
                                admission = None
                        if row is None:
                            row = BeaconClaimAnalyticsCache(user_id=user_id, claim_id=claim_id)
                            db.session.add(row)
                        row.transmittal_id = str(transmittal_id)
                        row.admission_date = admission.date() if admission else None
                        row.claim_status = str(claim.get("claimStatusDescription") or claim.get("status") or "")[:80]
                        row.transmittal_status = str(transmittal_status or "")[:80]
                        row.updated_at = utc_now()
                    if index % 10 == 0:
                        db.session.commit()
                    _claim_analytics_progress_update(user_id, current=index, total=transmittals_scanned,
                        message=f"Cached transmittal {index} of {transmittals_scanned} ({claims_scanned} claims checked; {failed_transmittals} skipped)...", phase="claims")
                db.session.commit()
            # Retain a 30-day buffer beyond the displayed 90-day analytics period.
            db.session.query(BeaconClaimAnalyticsCache).filter(
                BeaconClaimAnalyticsCache.user_id == user_id,
                BeaconClaimAnalyticsCache.admission_date.isnot(None),
                BeaconClaimAnalyticsCache.admission_date < date_from - timedelta(days=30),
            ).delete(synchronize_session=False)
            db.session.query(BeaconClaimAnalyticsCache).filter(
                BeaconClaimAnalyticsCache.user_id == user_id,
                BeaconClaimAnalyticsCache.admission_date.is_(None),
                BeaconClaimAnalyticsCache.updated_at < utc_now() - timedelta(days=120),
            ).delete(synchronize_session=False)
            sync = db.session.get(BeaconClaimAnalyticsSync, user_id)
            sync.transmittals_scanned, sync.claims_scanned = transmittals_scanned, claims_scanned
            sync.failed_transmittals = failed_transmittals
            sync.failed_transmittal_ids = sorted(failed_transmittal_ids)
            sync.state = "partial" if failed_transmittals else "ready"
            sync.error_summary = "; ".join(errors)[:500] or None
            sync.last_completed_at = utc_now()
            db.session.commit()
            message = (f"Refresh finished with {failed_transmittals} failed transmittal(s); showing cached results."
                       if failed_transmittals else f"Refresh complete: {claims_scanned} claims from {transmittals_scanned} transmittals.")
            _claim_analytics_progress_update(user_id, done=True, error=bool(failed_transmittals),
                current=transmittals_scanned, total=transmittals_scanned, message=message,
                phase="partial" if failed_transmittals else "complete")
    except Exception as exc:
        logger.exception(f"Dashboard claim analytics refresh failed for user {user_id}: {exc}")
        with app.app_context():
            sync = db.session.get(BeaconClaimAnalyticsSync, user_id)
            if sync is not None:
                sync.state, sync.error_summary = "error", str(exc)[:500]
                sync.transmittals_scanned, sync.claims_scanned = transmittals_scanned, claims_scanned
                sync.failed_transmittals, sync.last_completed_at = failed_transmittals, utc_now()
                sync.failed_transmittal_ids = sorted(failed_transmittal_ids)
                db.session.commit()
        _claim_analytics_progress_update(user_id, done=True, error=True,
            message="Beacon refresh stopped; showing the latest cached analytics.", phase="error")
    finally:
        with _claim_analytics_jobs_lock:
            _claim_analytics_jobs.pop(user_id, None)


def _start_claim_analytics_refresh(user, date_from, date_to, force=False):
    with _claim_analytics_jobs_lock:
        if user.id in _claim_analytics_jobs:
            return True
        sync = db.session.get(BeaconClaimAnalyticsSync, user.id)
        same_window = bool(sync and sync.window_start == date_from and sync.window_end == date_to)
        attempted = sync.last_attempt_at if sync else None
        if attempted and attempted.tzinfo is None:
            attempted = attempted.replace(tzinfo=timezone.utc)
        age = (utc_now() - attempted).total_seconds() if attempted else None
        retry_after = (
            0 if sync and sync.state == "running"
            else 1800 if sync and sync.state in {"partial", "error"}
            else 21600
        )
        if not force and same_window and age is not None and age < retry_after:
            return False
        beacon_settings, auth_key = _beacon_edit_settings(user)
        _claim_analytics_jobs[user.id] = {"started_at": time.time()}
        worker = threading.Thread(target=_sync_beacon_claim_analytics,
            args=(user.id, beacon_settings, auth_key, date_from, date_to, force), daemon=True)
        worker.start()
        return True


@app.route("/api/dashboard/claim-analytics", methods=["GET"])
@login_required
def dashboard_claim_analytics():
    date_to = datetime.now(timezone(timedelta(hours=8))).date()
    date_from = date_to - timedelta(days=89)
    group = request.args.get("group", "month").strip().lower()
    month_value = request.args.get("month", date_to.strftime("%Y-%m")).strip()
    filter_month = request.args.get("filter_month", "all").strip()
    if group not in {"month", "week"}:
        return jsonify({"error": "Group must be month or week."}), 400
    try:
        month_start = parse_billing_month(month_value)
        if filter_month != "all":
            parse_billing_month(filter_month)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    user = current_user()
    try:
        running = user.id in _claim_analytics_jobs
        sync = db.session.get(BeaconClaimAnalyticsSync, user.id)
        rows = BeaconClaimAnalyticsCache.query.filter_by(user_id=user.id).all()
        daily_counts, missing = {}, 0
        for row in rows:
            if row.admission_date is None:
                missing += 1
                continue
            if not date_from <= row.admission_date <= date_to:
                continue
            category = classify_claim_status(row.claim_status, row.transmittal_status)
            counts = daily_counts.setdefault(row.admission_date.isoformat(), {"draft": 0, "transmitted": 0, "other": 0})
            counts[category] += 1
        schedules = {}
        cursor = date(date_from.year, date_from.month, 1)
        while cursor <= date_to:
            key = cursor.strftime("%Y-%m")
            saved = db.session.get(ClaimBillingSchedule, key)
            schedules[key] = saved.weeks if saved else (initial_billing_weeks(key) if key in {"2026-09", "2026-10", "2026-11"} else default_billing_weeks(cursor))
            cursor = date(cursor.year + (cursor.month == 12), 1 if cursor.month == 12 else cursor.month + 1, 1)
        saved_schedule = db.session.get(ClaimBillingSchedule, month_value)
        if saved_schedule:
            schedule_source, editor_weeks = "saved", saved_schedule.weeks
        elif month_value in {"2026-09", "2026-10", "2026-11"}:
            schedule_source, editor_weeks = "sample", initial_billing_weeks(month_value)
        else:
            schedule_source, editor_weeks = "automatic", default_billing_weeks(month_start)
        analytics = build_claim_analytics(date_from, date_to, group,
            [(date.fromisoformat(day), counts) for day, counts in daily_counts.items()],
            schedules, missing_admission_dates=missing, filter_month=filter_month)
        completed_at = sync.last_completed_at if sync else None
        if completed_at and completed_at.tzinfo is None:
            completed_at = completed_at.replace(tzinfo=timezone.utc)
        cache_age = max(0, int((utc_now() - completed_at).total_seconds())) if completed_at else None
        analytics.update({
            "month": month_value, "weeks": editor_weeks, "estimated": schedule_source == "automatic",
            "schedule_source": schedule_source,
            "transmittals_scanned": sync.transmittals_scanned if sync else 0,
            "claims_scanned": sync.claims_scanned if sync else 0,
            "cached_claims": len(rows),
            "failed_transmittals": sync.failed_transmittals if sync else 0,
            "cache_age_seconds": cache_age,
            "sync_state": "running" if running else ("error" if sync and sync.state == "running" else (sync.state if sync else "empty")),
            "sync_error": sync.error_summary if sync else None,
        })
        return jsonify(analytics)
    except Exception as exc:
        logger.exception(f"Dashboard claim analytics failed: {exc}")
        return jsonify({"error": str(exc) or "Unable to load Beacon claim analytics."}), 502


@app.route("/api/dashboard/claim-analytics/refresh", methods=["POST"])
@login_required
def start_dashboard_claim_analytics_refresh():
    date_to = datetime.now(timezone(timedelta(hours=8))).date()
    date_from = date_to - timedelta(days=89)
    payload = request.get_json(silent=True) or {}
    progress_id = str(payload.get("progress_id") or "").strip()
    if not progress_id:
        return jsonify({"error": "A refresh progress ID is required."}), 400
    user = current_user()
    with _claim_analytics_progress_lock:
        now = time.time()
        for key, entry in list(_claim_analytics_progress.items()):
            if now - entry.get("started_at", now) > 3600:
                _claim_analytics_progress.pop(key, None)
        _claim_analytics_progress[progress_id] = {
            "user_id": user.id, "started_at": now, "done": False,
            "current": 0, "total": 0, "message": "Connecting to Beacon...", "phase": "starting",
        }
    try:
        _start_claim_analytics_refresh(user, date_from, date_to, force=True)
        return jsonify({"sync_state": "running", "progress_id": progress_id})
    except Exception as exc:
        logger.exception(f"Could not start dashboard claim analytics refresh: {exc}")
        with _claim_analytics_progress_lock:
            _claim_analytics_progress[progress_id].update({
                "done": True, "error": True, "phase": "error",
                "message": "Could not start a Beacon refresh. Check your Beacon settings and try again.",
            })
        return jsonify({"error": str(exc) or "Unable to start Beacon analytics refresh."}), 502


@app.route("/api/dashboard/claim-analytics/progress/<progress_id>", methods=["GET"])
@login_required
def get_dashboard_claim_analytics_progress(progress_id):
    with _claim_analytics_progress_lock:
        progress = _claim_analytics_progress.get(progress_id)
        if not progress or progress["user_id"] != current_user().id:
            return jsonify({"error": "Analytics progress not found."}), 404
        result = {key: value for key, value in progress.items() if key not in {"user_id", "started_at"}}
    if current_user().id not in _claim_analytics_jobs and not result.get("done"):
        result.update({"done": True, "current": 1, "total": 1, "message": "Analytics cache is ready.", "phase": "complete"})
    return jsonify(result)


@app.route("/api/dashboard/claim-billing-schedule", methods=["GET", "POST"])
@login_required
def dashboard_claim_billing_schedule():
    month_value = request.args.get("month", "").strip()
    if request.method == "POST":
        if not current_user().is_admin:
            return jsonify({"error": "Administrator access is required to change billing periods."}), 403
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            return jsonify({"error": "A billing schedule object is required."}), 400
        month_value = str(payload.get("month") or month_value).strip()
    try:
        parse_billing_month(month_value)
        if request.method == "POST":
            weeks = validate_billing_weeks(month_value, payload.get("weeks"))
            schedule = db.session.get(ClaimBillingSchedule, month_value)
            if schedule is None:
                schedule = ClaimBillingSchedule(month=month_value, weeks=weeks)
                db.session.add(schedule)
            else:
                schedule.weeks = weeks
            db.session.commit()
        else:
            schedule = db.session.get(ClaimBillingSchedule, month_value)
            if schedule:
                weeks = schedule.weeks
                source = "saved"
            elif month_value in {"2026-09", "2026-10", "2026-11"}:
                weeks = initial_billing_weeks(month_value)
                source = "sample"
            else:
                weeks = default_billing_weeks(month_value)
                source = "estimated"
        return jsonify({
            "month": month_value,
            "estimated": source == "estimated" if request.method == "GET" else False,
            "source": source if request.method == "GET" else "saved",
            "weeks": weeks,
        })
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        db.session.rollback()
        logger.error(f"Dashboard billing schedule could not be saved or loaded: {exc}")
        return jsonify({"error": "Billing schedule could not be saved or loaded."}), 500


@app.route("/api/dashboard/runs", methods=["GET"])
@login_required
def dashboard_runs():
    page_size = 12
    query = AutomationRun.query
    cursor_at = request.args.get("before_at", "").strip()
    cursor_id = request.args.get("before_id", type=int)
    if cursor_at or cursor_id is not None:
        if not cursor_at or cursor_id is None:
            return jsonify({"error": "Both cursor values are required."}), 400
        try:
            before_at = datetime.fromisoformat(cursor_at.replace("Z", "+00:00"))
        except ValueError:
            return jsonify({"error": "Invalid run history cursor."}), 400
        query = query.filter(or_(
            AutomationRun.finished_at < before_at,
            (AutomationRun.finished_at == before_at) & (AutomationRun.id < cursor_id),
        ))
    runs = query.order_by(AutomationRun.finished_at.desc(), AutomationRun.id.desc()).limit(page_size + 1).all()
    has_more = len(runs) > page_size
    runs = runs[:page_size]
    next_cursor = None
    if has_more and runs:
        last_run = runs[-1]
        next_cursor = {"finished_at": last_run.finished_at.isoformat(), "id": last_run.id}
    return jsonify({
        "runs": [{
            "workflow": run.workflow,
            "status": run.status,
            "item_count": run.item_count,
            "duration_seconds": run.duration_seconds,
            "runner_name": run.runner_name,
            "finished_at": run.finished_at.isoformat(),
        } for run in runs],
        "has_more": has_more,
        "next_cursor": next_cursor,
    })


def admin_required(handler):
    @wraps(handler)
    def wrapper(*args, **kwargs):
        user = current_user()
        if not user or not user.is_active:
            return jsonify({"error": "Authentication required."}), 401
        if not user.is_admin:
            return jsonify({"error": "Administrator access required."}), 403
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
        "beacon_user_id": settings.beacon_user_id or "",
        "cf4": settings.cf4_settings or {},
    }


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


@app.route("/")
def web_index():
    return send_from_directory(app.static_folder, "landing.html")


@app.route("/login")
def web_login():
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
@login_required
@track_dashboard_operation("SOA Excel - Individual")
def soa_excel_generate():
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
@login_required
@track_dashboard_operation(
    "SOA Excel - Batch",
    skip_paths=("/api/soa-excel/batch/validate",),
)
def soa_excel_batch():
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
@login_required
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


@app.route("/api/auto-rename/preview", methods=["POST"])
@app.route("/api/auto-rename/run", methods=["POST"])
@login_required
def auto_rename_process():
    try:
        uploads = request.files.getlist("pdfs")
        try:
            groups = json.loads(request.form.get("groups", "[]"))
            assignments = json.loads(request.form.get("assignments", "[]"))
        except json.JSONDecodeError as exc:
            raise ValueError("Group details are not valid. Please review the group entries.") from exc
        document_order = request.form.get("document_order", "CSF,CF4,PBEF,AF").split(",")
        pdfs, rows, group_count = create_preview(uploads, groups, assignments, document_order)
        if request.path.endswith("/preview"):
            return jsonify({"rows": rows, "pdf_count": len(pdfs), "group_count": group_count})
        archive, renamed = build_renamed_archive(pdfs, rows)
        return send_file(
            archive,
            mimetype="application/zip",
            as_attachment=True,
            download_name="Renamed_PDFs.zip",
        )
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:
        logger.exception("PDF auto rename failed")
        return jsonify({"error": "Unable to process the PDFs and group names."}), 500


@app.route("/api/auto-rename/template", methods=["GET"])
def auto_rename_template():
    try:
        group_size = int(request.args.get("group_size", "4"))
        num_groups = int(request.args.get("groups", "10"))
        workbook = BytesIO()
        build_template(group_size, num_groups).save(workbook)
        workbook.seek(0)
        return send_file(
            workbook,
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            as_attachment=True,
            download_name="PDF_Auto_Rename_Template.xlsx",
        )
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:
        logger.exception("PDF auto rename template generation failed")
        return jsonify({"error": "Unable to generate the Excel template."}), 500


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
    expires_in = app.permanent_session_lifetime.total_seconds() - (
        time.time() - float(session["last_activity_at"])
    )
    return jsonify({
        "authenticated": True,
        "user": user_payload(user),
        "expires_in_seconds": max(0, int(expires_in)),
    })


@app.route("/api/auth/activity", methods=["POST"])
@login_required
def auth_activity():
    session["last_activity_at"] = time.time()
    return jsonify({
        "authenticated": True,
        "expires_in_seconds": int(app.permanent_session_lifetime.total_seconds()),
    })


@app.route("/api/chat/latest", methods=["GET"])
@login_required
def chat_latest_ids():
    """Return message cursors only, for lightweight browser-local unread tracking."""
    user = current_user()
    latest_team_id = db.session.query(func.max(TeamChatMessage.id)).filter(
        or_(TeamChatMessage.sender_id.is_(None), TeamChatMessage.sender_id != user.id),
    ).scalar() or 0
    return jsonify({"team": latest_team_id})


@app.route("/api/team/messages", methods=["GET"])
@login_required
def team_list_messages():
    after_id = request.args.get("after_id", type=int)
    if after_id is not None and after_id < 0:
        return jsonify({"error": "Invalid message cursor."}), 400
    query = TeamChatMessage.query.options(load_only(
        TeamChatMessage.id, TeamChatMessage.sender_id, TeamChatMessage.sender_name,
        TeamChatMessage.body, TeamChatMessage.image_mime, TeamChatMessage.created_at,
    ))
    if after_id:
        messages = query.filter(TeamChatMessage.id > after_id).order_by(TeamChatMessage.id.asc()).limit(100).all()
    else:
        messages = query.order_by(TeamChatMessage.id.desc()).limit(100).all()
        messages.reverse()
    user = current_user()
    sender_ids = {message.sender_id for message in messages if message.sender_id is not None}
    sender_avatars = {
        user_id: avatar or "avatar-penguin"
        for user_id, avatar in db.session.query(User.id, User.avatar).filter(User.id.in_(sender_ids)).all()
    } if sender_ids else {}
    return jsonify({"current_user_id": user.id, "messages": [{
        "id": message.id, "sender_id": message.sender_id, "sender_name": message.sender_name,
        "sender_avatar": sender_avatars.get(message.sender_id, "avatar-penguin"),
        "body": message.body, "has_image": bool(message.image_mime),
        "created_at": message.created_at.isoformat() if message.created_at else None,
    } for message in messages]})


@app.route("/api/team/messages", methods=["POST"])
@login_required
def team_send_message():
    user = current_user()
    if request.mimetype == "multipart/form-data":
        body = str(request.form.get("body") or "").strip()
        uploaded_image = request.files.get("image")
    else:
        data = request.get_json(silent=True) or {}
        body = str(data.get("body") or "").strip()
        uploaded_image = None
    image_data = None
    image_mime = None
    if uploaded_image and uploaded_image.filename:
        image_data = uploaded_image.stream.read(5 * 1024 * 1024 + 1)
        if len(image_data) > 5 * 1024 * 1024:
            return jsonify({"error": "Images must be 5 MB or smaller."}), 413
        if image_data.startswith(b"\x89PNG\r\n\x1a\n"):
            image_mime = "image/png"
        elif image_data.startswith(b"\xff\xd8\xff"):
            image_mime = "image/jpeg"
        elif image_data.startswith((b"GIF87a", b"GIF89a")):
            image_mime = "image/gif"
        elif len(image_data) >= 12 and image_data[:4] == b"RIFF" and image_data[8:12] == b"WEBP":
            image_mime = "image/webp"
        else:
            return jsonify({"error": "Choose a valid PNG, JPEG, GIF, or WebP image."}), 400
    if not body and not image_data:
        return jsonify({"error": "Write a message or attach an image before sending."}), 400
    if len(body) > 2000:
        return jsonify({"error": "Messages must be 2,000 characters or fewer."}), 400
    message = TeamChatMessage(
        sender_id=user.id,
        sender_name=user.display_name or user.profile_name or user.email,
        body=body, image_data=image_data, image_mime=image_mime,
    )
    db.session.add(message)
    db.session.commit()
    return jsonify({
        "id": message.id, "sender_id": message.sender_id, "sender_name": message.sender_name,
        "sender_avatar": user.avatar or "avatar-penguin",
        "body": message.body, "has_image": bool(message.image_mime),
        "created_at": message.created_at.isoformat() if message.created_at else None,
    }), 201


@app.route("/api/team/messages/<int:message_id>/image", methods=["GET"])
@login_required
def team_get_image(message_id):
    message = db.session.get(TeamChatMessage, message_id)
    if (not message or not message.image_data or not message.image_mime):
        return jsonify({"error": "Image not found."}), 404
    response = send_file(BytesIO(message.image_data), mimetype=message.image_mime,
                         as_attachment=False, download_name=f"team-chat-image-{message.id}")
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "private, no-store"
    return response


@app.route("/api/admin/users", methods=["GET"])
@admin_required
def admin_list_users():
    try:
        page = max(1, int(request.args.get("page", 1)))
        per_page = min(100, max(1, int(request.args.get("per_page", 25))))
    except (TypeError, ValueError):
        return jsonify({"error": "Page values must be integers."}), 400

    search = str(request.args.get("q") or "").strip()[:120]
    query = User.query.options(selectinload(User.settings), selectinload(User.upgrade_request))
    if search:
        pattern = f"%{search}%"
        query = query.filter(or_(
            User.email.ilike(pattern),
            User.profile_name.ilike(pattern),
            User.display_name.ilike(pattern),
        ))

    total = query.count()
    users = (
        query.order_by(User.created_at.desc(), User.id.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )
    actor_id = current_user().id
    active_admin_ids = {
        row.id for row in User.query.filter_by(is_active=True, is_admin=True).all()
    }
    return jsonify({
        "users": [{
            "id": user.id,
            "email": user.email,
            "profile_name": user.display_name or user.profile_name or "",
            "display_name": user.display_name or user.profile_name or "",
            "avatar": user.avatar or "avatar-penguin",
            "is_active": bool(user.is_active),
            "is_admin": bool(user.is_admin),
            "role": user.role or ("admin" if user.is_admin else "member"),
            "can_change_role": user.id != actor_id,
            "can_delete": user.id != actor_id and not (
                user.id in active_admin_ids and len(active_admin_ids) <= 1
            ),
            "created_at": user.created_at.isoformat() if user.created_at else None,
            "updated_at": user.updated_at.isoformat() if user.updated_at else None,
            "beacon_connected": bool(user.settings and user.settings.beacon_validated_at),
            "beacon_server": user.settings.server if user.settings else "",
            "upgrade_request": ({
                "id": user.upgrade_request.id,
                "message": user.upgrade_request.message,
                "status": user.upgrade_request.status,
                "created_at": user.upgrade_request.created_at.isoformat() if user.upgrade_request.created_at else None,
            } if user.upgrade_request else None),
        } for user in users],
        "page": page,
        "per_page": per_page,
        "total": total,
        "pages": max(1, (total + per_page - 1) // per_page),
        "search": search,
    })


@app.route("/api/admin/users/<int:user_id>/role", methods=["PATCH"])
@admin_required
def admin_update_user_role(user_id):
    data = request.get_json(silent=True) or {}
    role = str(data.get("role") or "").strip().lower()
    if role not in {"admin", "subscriber", "member"}:
        return jsonify({"error": "Role must be admin, subscriber, or member."}), 400

    target = db.session.get(User, user_id)
    if not target:
        return jsonify({"error": "User account not found."}), 404
    actor = current_user()
    if target.id == actor.id and role != "admin":
        return jsonify({"error": "You cannot demote your own account here."}), 409
    if target.is_active and target.is_admin and role != "admin":
        active_admins = User.query.filter_by(is_active=True, is_admin=True).with_for_update().all()
        if len(active_admins) <= 1:
            return jsonify({"error": "Promote another active user to admin before demoting the last active administrator."}), 409

    target.role = role
    target.is_admin = role == "admin"
    db.session.commit()
    return jsonify({"user_id": target.id, "role": target.role, "is_admin": target.is_admin})


@app.route("/api/auth/upgrade-request", methods=["POST"])
@login_required
def auth_create_upgrade_request():
    user = current_user()
    if user.is_admin or user.role == "subscriber":
        return jsonify({"error": "This account already has premium access."}), 409
    data = request.get_json(silent=True) or {}
    message = str(data.get("message") or "").strip()
    if not message or len(message) > 500:
        return jsonify({"error": "Please enter a message of 1 to 500 characters."}), 400
    upgrade_request = UpgradeRequest.query.filter_by(user_id=user.id).first()
    if upgrade_request and upgrade_request.status == "pending":
        return jsonify({"error": "Your upgrade request is already awaiting review."}), 409
    if upgrade_request:
        upgrade_request.message = message
        upgrade_request.status = "pending"
        upgrade_request.created_at = utc_now()
        upgrade_request.reviewed_at = None
    else:
        upgrade_request = UpgradeRequest(user_id=user.id, message=message)
        db.session.add(upgrade_request)
    db.session.commit()
    return jsonify({"status": "pending"}), 201


@app.route("/api/admin/upgrade-requests/<int:request_id>", methods=["PATCH"])
@admin_required
def admin_review_upgrade_request(request_id):
    data = request.get_json(silent=True) or {}
    decision = str(data.get("decision") or "").strip().lower()
    if decision not in {"accepted", "declined"}:
        return jsonify({"error": "Decision must be accepted or declined."}), 400
    upgrade_request = db.session.get(UpgradeRequest, request_id)
    if not upgrade_request:
        return jsonify({"error": "Upgrade request not found."}), 404
    if upgrade_request.status != "pending":
        return jsonify({"error": "This request has already been reviewed."}), 409
    upgrade_request.status = decision
    upgrade_request.reviewed_at = utc_now()
    if decision == "accepted":
        upgrade_request.user.role = "subscriber"
        upgrade_request.user.is_admin = False
    db.session.commit()
    return jsonify({"status": decision, "user_id": upgrade_request.user_id})


@app.route("/api/admin/users/<int:user_id>", methods=["DELETE"])
@admin_required
def admin_delete_user(user_id):
    target = db.session.get(User, user_id)
    if not target:
        return jsonify({"error": "User account not found."}), 404
    actor = current_user()
    if target.id == actor.id:
        return jsonify({"error": "You cannot delete your own account here."}), 409
    if target.is_active and target.is_admin:
        active_admins = User.query.filter_by(is_active=True, is_admin=True).with_for_update().all()
        if len(active_admins) <= 1:
            return jsonify({"error": "Promote another active user to admin before deleting the last active administrator."}), 409

    db.session.delete(target)
    db.session.commit()
    return jsonify({"deleted": True, "user_id": user_id})


@app.route("/api/auth/register", methods=["POST"])
@limiter.limit("5 per hour", key_func=_rate_limit_client_ip)
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
        profile_name=display_name,
        display_name=display_name,
        role="member",
    )
    db.session.add(user)
    db.session.flush()
    db.session.add(UserSetting(user_id=user.id))
    db.session.commit()

    session.clear()
    session["user_id"] = user.id
    session["last_activity_at"] = time.time()
    session.permanent = True
    return jsonify({"user": user_payload(user)}), 201


@app.route("/api/auth/login", methods=["POST"])
@limiter.limit("5 per minute", key_func=_rate_limit_client_ip)
def auth_login():
    data = request.get_json(force=True)
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    user = User.query.filter_by(email=email).first()

    if not user or not user.is_active or not check_password_hash(user.password_hash, password):
        return jsonify({"error": "Invalid email or password."}), 401

    session.clear()
    session["user_id"] = user.id
    session["last_activity_at"] = time.time()
    session.permanent = True
    return jsonify({"user": user_payload(user)})


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    session.clear()
    return jsonify({"logged_out": True})


@app.route("/api/auth/profile", methods=["PATCH"])
@login_required
def auth_update_profile():
    user = current_user()
    data = request.get_json(force=True)
    display_name = str(data.get("display_name", data.get("profile_name", ""))).strip()
    avatar = str(data.get("avatar", user.avatar or "avatar-penguin")).strip().lower()
    allowed_avatars = {
        "avatar-bunny", "avatar-cat", "avatar-dog",
        "avatar-fox", "avatar-panda", "avatar-penguin",
    }
    if len(display_name) > 120:
        return jsonify({"error": "Names must be 120 characters or fewer."}), 400
    if avatar not in allowed_avatars:
        return jsonify({"error": "Choose one of the available profile avatars."}), 400
    user.profile_name = display_name or None
    user.display_name = display_name or None
    user.avatar = avatar
    db.session.commit()
    return jsonify({"user": user_payload(user)})


# ---------------------------------------------------------------------------
# Settings
# Auth tokens are invalidated when Beacon credentials or server change.
# ---------------------------------------------------------------------------
@app.route("/api/settings", methods=["GET"])
@login_required
def get_settings():
    settings = get_or_create_user_settings(current_user())
    return jsonify(user_settings_payload(settings))


@app.route("/api/cf2/account-receivable", methods=["GET", "POST"])
@login_required
def cf2_account_receivable_settings():
    settings = get_or_create_user_settings(current_user())
    all_settings = dict(settings.cf4_settings or {})
    if request.method == "GET":
        return jsonify(all_settings.get("account_receivable") or {"name": "", "designation": "", "number": ""})

    data = request.get_json(silent=True) or {}
    all_settings["account_receivable"] = {
        "name": str(data.get("name") or "").strip(),
        "designation": str(data.get("designation") or "").strip(),
        "number": str(data.get("number") or "").strip(),
    }
    settings.cf4_settings = all_settings
    db.session.commit()
    return jsonify(all_settings["account_receivable"])


@app.route("/api/settings", methods=["POST"])
@login_required
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
        old_auth_key = browser_session.auth_context_key(
            decrypt_user_settings(settings),
            user_key=f"user:{user.id}",
        )
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

        if auth_changed:
            settings.beacon_user_id = None
            settings.beacon_validated_at = None
            browser_session.invalidate_auth_token(old_auth_key)
            _clear_claim_analytics_cache(user.id)

        db.session.commit()
        return jsonify(user_settings_payload(settings))


@app.route("/api/app/version", methods=["GET"])
def app_version_route():
    return jsonify({"version": APP_VERSION})


@app.route("/api/beacon/validate", methods=["POST"])
@login_required
def beacon_validate():
    user = current_user()
    settings = get_or_create_user_settings(user)
    previous_beacon_user_id = settings.beacon_user_id or ""
    data = request.get_json(silent=True) or {}

    username = str(data.get("username") or settings.beacon_username or "").strip()
    password = str(data.get("password") or decrypt_field(settings.beacon_password_encrypted))
    server = "s2" if (data.get("server") or settings.server) == "s2" else "s4"

    if not username or not password:
        return jsonify({
            "valid": False,
            "error": "Beacon username and password are required.",
        }), 400

    token_data = None
    current_user_info = None
    validation_settings = {
        "username": username,
        "password": password,
        "server": server,
    }
    auth_key = browser_session.auth_context_key(
        validation_settings,
        user_key=f"user:{user.id}",
    )
    previous_auth_key = browser_session.auth_context_key(
        decrypt_user_settings(settings),
        user_key=f"user:{user.id}",
    )
    with browser_session.use_auth_context(validation_settings, key=auth_key):
        browser_session.invalidate_auth_token(auth_key)
        try:
            token_data = browser_session.login_via_api(username, password, server=server)
        except Exception as ex:
            status_code = (
                ex.response.status_code
                if isinstance(ex, requests.HTTPError) and ex.response is not None
                else None
            )
            if status_code is not None and status_code < 500:
                settings.beacon_user_id = None
                settings.beacon_validated_at = None
                db.session.commit()
                return jsonify({
                    "valid": False,
                    "error": f"Beacon login failed. Please check the username, password, and server. ({ex})",
                }), 401
            try:
                current_user_info = browser_session.get_current_user_information(server=server)
            except Exception:
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
    beacon_user_id = None
    if isinstance(token_data, dict):
        beacon_user_id = token_data.get("Id")
    if beacon_user_id in (None, "") and isinstance(current_user_info, dict):
        beacon_user_id = current_user_info.get("id")
    settings.beacon_user_id = str(beacon_user_id or settings.beacon_user_id or "")
    settings.beacon_validated_at = utc_now()
    if auth_key != previous_auth_key or str(beacon_user_id or "") != previous_beacon_user_id:
        _clear_claim_analytics_cache(user.id)
    db.session.commit()
    return jsonify({
        "valid": True,
        "beacon_connected": True,
        "beacon_user_id": settings.beacon_user_id,
        "beacon_validated_at": settings.beacon_validated_at.isoformat(),
    })


@app.route("/api/beacon/finalize-claims", methods=["GET"])
@login_required
def get_finalize_claims():
    search_id = str(request.args.get("search_id") or "").strip()
    progress_state = None
    if search_id:
        progress_state = {"user_id": current_user().id, "done": False, "current": 0, "total": 0, "message": "Connecting to Beacon..."}
        with _finalize_claim_progress_lock:
            _finalize_claim_progress[search_id] = progress_state
    patient_query = str(request.args.get("patient") or "").strip()
    transmittal_numbers = list(dict.fromkeys(str(request.args.get("transmittal") or "").split()))
    admission_from = str(request.args.get("admission_from") or "").strip()
    admission_to = str(request.args.get("admission_to") or "").strip()
    date_filter_requested = bool(admission_from or admission_to)
    if not patient_query and not transmittal_numbers and not date_filter_requested:
        return jsonify({"error": "Enter a transmittal number or patient name, or set at least one date filter."}), 400

    def _parse_filter_date(value, label):
        if not value:
            return None
        try:
            return datetime.strptime(value, "%Y-%m-%d").date()
        except ValueError:
            raise ValueError(f"{label} must be a valid date (YYYY-MM-DD).")

    try:
        admission_from_d = _parse_filter_date(admission_from, "Admission From")
        admission_to_d = _parse_filter_date(admission_to, "Admission To")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    if admission_from_d and admission_to_d:
        if admission_from_d > admission_to_d:
            return jsonify({"error": "Admission From must not be after Admission To."}), 400
        if (admission_to_d - admission_from_d).days > 31:
            return jsonify({"error": "Admission date range cannot exceed 31 days."}), 400
    date_mode = bool(date_filter_requested) and not patient_query and not transmittal_numbers

    user = current_user()
    settings = get_or_create_user_settings(user)
    beacon_settings = {
        "username": settings.beacon_username,
        "password": decrypt_field(settings.beacon_password_encrypted),
        "server": settings.server,
        "user_id": settings.beacon_user_id,
    }
    auth_key = browser_session.auth_context_key(beacon_settings, user_key=f"user:{user.id}")
    transmittals = []
    rows = []
    not_found = []
    query_tokens = set(re.sub(r"[^a-z0-9]+", " ", patient_query.casefold()).split())

    def patient_matches(claim):
        form1 = claim.get("phiccF1") or {}
        patient_name = form1.get("patientFullname") or " ".join(
            str(form1.get(key) or "")
            for key in ("patientFirstname", "patientMiddlename", "patientLastname", "patientSuffix")
        )
        patient_tokens = set(re.sub(r"[^a-z0-9]+", " ", patient_name.casefold()).split())
        return bool(query_tokens) and query_tokens.issubset(patient_tokens)

    def claim_matches_dates(admission):
        if admission_from_d or admission_to_d:
            if admission is None:
                return False
            if admission_from_d and admission.date() < admission_from_d:
                return False
            if admission_to_d and admission.date() > admission_to_d:
                return False
        return True

    try:
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            if date_mode:
                today = datetime.now().date()
                # The Beacon endpoint filters by transmittal creation date, while
                # this screen filters by claim admission date. A transmittal can
                # be created well after admission, so search candidates through
                # today and apply the requested admission range below.
                earliest_admission = admission_from_d or admission_to_d or (today - timedelta(days=7))
                # A claim's transmittal is created on or after admission; starting
                # earlier only adds unrelated rows and slows this claim lookup.
                window_start = earliest_admission
                window_end = today
                candidates = beacon_api.get_transmittals_in_range(window_start, window_end)
                if progress_state is not None:
                    progress_state.update({"total": len(candidates), "message": f"Checking {len(candidates)} transmittals..."})
                logger.info(
                    f"Edit Claims admission-date search: requested={admission_from or '*'}.."
                    f"{admission_to or '*'}, transmittal window={window_start}.."
                    f"{window_end}, candidates={len(candidates)}"
                )
                not_found = []
            elif patient_query:
                candidates = beacon_api.search_transmittals(patient_query, search_days=93)
            else:
                candidates = [
                    transmittal
                    for number in transmittal_numbers
                    if (transmittal := beacon_api.get_transmittal(number, search_days=93))
                ]
                found_numbers = {str(item.get("transmittalNumber") or "") for item in candidates}
                not_found = [number for number in transmittal_numbers if number not in found_numbers]

            for candidate_index, transmittal in enumerate(candidates, start=1):
                if progress_state is not None and date_mode:
                    progress_state.update({
                        "current": candidate_index,
                        "total": len(candidates),
                        "message": f"Checking transmittal {candidate_index} of {len(candidates)}... ({len(rows)} matching claims found)",
                    })
                transmittal_number = str(transmittal.get("transmittalNumber") or "")
                transmittal_status = transmittal.get("transmittalStatusDescription") or ""
                claims = beacon_api.get_claims(transmittal.get("id"))
                if patient_query:
                    claims = [claim for claim in claims if patient_matches(claim)]
                    if not claims:
                        continue
                if date_mode:
                    matched_claims = []
                    for claim in claims:
                        admission = discharge = None
                        embedded_admission = claim.get("admissionDateTime") or (claim.get("phiccF2") or {}).get("admissionDateTime")
                        embedded_discharge = claim.get("dischargeDateTime") or (claim.get("phiccF2") or {}).get("dischargeDateTime")
                        try:
                            if embedded_admission:
                                admission = _beacon_local_datetime(embedded_admission)
                            if embedded_discharge:
                                discharge = _beacon_local_datetime(embedded_discharge)
                            if not admission or not discharge:
                                cf2 = cf2_api.get_cf2(claim.get("id")) or {}
                                admission = admission or _beacon_local_datetime(cf2.get("admissionDateTime"))
                                discharge = discharge or _beacon_local_datetime(cf2.get("dischargeDateTime"))
                        except Exception as cf2_exc:
                            logger.warning(f"Could not fetch CF2 dates for claim {claim.get('id')}: {cf2_exc}")
                        if claim_matches_dates(admission):
                            claim["_admission"] = admission
                            claim["_discharge"] = discharge
                            matched_claims.append(claim)
                    claims = matched_claims
                    if not claims:
                        continue
                transmittals.append({
                    "number": transmittal_number,
                    "status": transmittal_status,
                })
                for claim in claims:
                    form1 = claim.get("phiccF1") or {}
                    admission = claim.get("_admission")
                    discharge = claim.get("_discharge")
                    if not date_mode:
                        admission_date = ""
                        discharge_date = ""
                        try:
                            embedded_admission = claim.get("admissionDateTime") or (claim.get("phiccF2") or {}).get("admissionDateTime")
                            embedded_discharge = claim.get("dischargeDateTime") or (claim.get("phiccF2") or {}).get("dischargeDateTime")
                            if embedded_admission:
                                admission = _beacon_local_datetime(embedded_admission)
                            if embedded_discharge:
                                discharge = _beacon_local_datetime(embedded_discharge)
                            if not admission or not discharge:
                                cf2 = cf2_api.get_cf2(claim.get("id")) or {}
                                admission = admission or _beacon_local_datetime(cf2.get("admissionDateTime"))
                                discharge = discharge or _beacon_local_datetime(cf2.get("dischargeDateTime"))
                            admission_date = admission.strftime("%Y-%m-%d") if admission else ""
                            discharge_date = discharge.strftime("%Y-%m-%d") if discharge else ""
                        except Exception as cf2_exc:
                            logger.warning(f"Could not fetch CF2 dates for claim {claim.get('id')}: {cf2_exc}")
                    else:
                        admission_date = admission.strftime("%Y-%m-%d") if admission else ""
                        discharge_date = discharge.strftime("%Y-%m-%d") if discharge else ""
                    rows.append({
                        "transmittal_id": transmittal.get("id"),
                        "claim_id": claim.get("id"),
                        "transmittal_number": transmittal.get("transmittalNumber") or transmittal_number,
                        "transmittal_status": transmittal_status,
                        "claim_series": claim.get("claimSeriesLhio") or "",
                        "patient_name": form1.get("patientFullname") or "",
                        "member_name": form1.get("memberFullname") or "",
                        "admission_date": admission_date,
                        "discharge_date": discharge_date,
                        "status": claim.get("claimStatusDescription") or "",
                        "package": claim.get("phicPackageDescription") or "",
                    })
            if patient_query and not rows:
                not_found.append(patient_query)
        if progress_state is not None:
            progress_state.update({"done": True, "message": f"Search complete. {len(rows)} matching claims found."})
        return jsonify({
            "transmittals": transmittals,
            "not_found": not_found,
            "claims": rows,
        })
    except Exception as exc:
        logger.error(f"Finalize Claims lookup failed for {patient_query or ', '.join(transmittal_numbers)}: {exc}")
        if progress_state is not None:
            progress_state.update({"done": True, "message": "Beacon lookup failed. See the server log for details."})
        return jsonify({"error": "Beacon lookup failed. Check your connection and Beacon settings, then try again."}), 502


_finalize_claim_progress = {}
_finalize_claim_progress_lock = threading.Lock()


@app.route("/api/beacon/finalize-claims/progress/<search_id>", methods=["GET"])
@login_required
def get_finalize_claim_search_progress(search_id):
    with _finalize_claim_progress_lock:
        progress = _finalize_claim_progress.get(search_id)
        if not progress or progress["user_id"] != current_user().id:
            return jsonify({"error": "Search progress not found."}), 404
        return jsonify({key: value for key, value in progress.items() if key != "user_id"})


def _beacon_edit_settings(user):
    settings = get_or_create_user_settings(user)
    beacon_settings = {
        "username": settings.beacon_username,
        "password": decrypt_field(settings.beacon_password_encrypted),
        "server": settings.server,
        "user_id": settings.beacon_user_id,
    }
    auth_key = browser_session.auth_context_key(beacon_settings, user_key=f"user:{user.id}")
    return beacon_settings, auth_key


def _require_draft_claim(transmittal_id, claim_id):
    transmittal = beacon_api.get_transmittal_by_id(transmittal_id) or {}
    if str(transmittal.get("transmittalStatusDescription") or "").strip().casefold() != "draft":
        raise ValueError("Only claims in a DRAFT transmittal can be edited here.")
    claims = beacon_api.get_claims(transmittal_id)
    claim = next((row for row in claims if str(row.get("id")) == str(claim_id)), None)
    if not claim:
        raise LookupError("This claim does not belong to the selected transmittal.")
    return transmittal, claim


@app.route("/api/beacon/finalize-claims/<int:transmittal_id>/<int:claim_id>", methods=["DELETE"])
@login_required
@track_dashboard_operation("Edit Claims")
def delete_finalize_claim(transmittal_id, claim_id):
    user = current_user()
    beacon_settings, auth_key = _beacon_edit_settings(user)
    try:
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            _require_draft_claim(transmittal_id, claim_id)
            removed_documents = soa_api.remove_generated_esoa_documents(claim_id)
            beacon_api.delete_claim(claim_id)
        return jsonify({"deleted": True, "documents_deleted": removed_documents})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except LookupError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        logger.error(f"Finalize Claims deletion failed for claim {claim_id}: {exc}")
        return jsonify({"error": "Beacon could not delete this draft claim."}), 502


@app.route("/api/beacon/finalize-claims/<int:transmittal_id>", methods=["DELETE"])
@login_required
@track_dashboard_operation("Edit Claims")
def delete_finalize_transmittal(transmittal_id):
    user = current_user()
    beacon_settings, auth_key = _beacon_edit_settings(user)
    try:
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            transmittal = beacon_api.get_transmittal_by_id(transmittal_id) or {}
            if str(transmittal.get("transmittalStatusDescription") or "").strip().casefold() != "draft":
                return jsonify({"error": "Only empty DRAFT transmittals can be deleted here."}), 409

            cache_key = (browser_session._context_key(), int(transmittal_id))
            beacon_api._claims_cache.pop(cache_key, None)
            if beacon_api.get_claims(transmittal_id):
                return jsonify({"error": "This DRAFT transmittal still contains claims and was not deleted."}), 409

            beacon_api.delete_transmittal(transmittal_id)
        return jsonify({"deleted": True})
    except Exception as exc:
        logger.error(f"Finalize Claims transmittal deletion failed for {transmittal_id}: {exc}")
        return jsonify({"error": "Beacon could not delete this empty draft transmittal."}), 502


@app.route("/api/beacon/finalize-claims/<int:transmittal_id>/transmit", methods=["POST"])
@login_required
@track_dashboard_operation("Edit Claims")
def transmit_finalize_claims_transmittal(transmittal_id):
    user = current_user()
    beacon_settings, auth_key = _beacon_edit_settings(user)
    try:
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            transmittal = beacon_api.get_transmittal_by_id(transmittal_id) or {}
            if str(transmittal.get("transmittalStatusDescription") or "").strip().casefold() != "draft":
                return jsonify({"error": "Only DRAFT transmittals can be transmitted here."}), 409
            result = beacon_api.transmit_transmittal(transmittal_id)
            return jsonify({"status": result.get("transmittalStatusDescription"), "transmittal_number": result.get("transmittalNumber"), "e_ticket_number": result.get("eTicketNumber"), "control_number": result.get("transmissionControlNumber")})
    except Exception as exc:
        logger.error(f"Finalize Claims transmit failed for {transmittal_id}: {exc}")
        return jsonify({"error": str(exc) or "Beacon transmit failed."}), 502


@app.route("/api/beacon/finalize-claims/<int:transmittal_id>/<int:claim_id>/finalize", methods=["POST"])
@login_required
@track_dashboard_operation("Edit Claims")
def finalize_finalize_claim(transmittal_id, claim_id):
    user = current_user()
    beacon_settings, auth_key = _beacon_edit_settings(user)
    try:
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            _transmittal, claim = _require_draft_claim(transmittal_id, claim_id)
            cf2 = cf2_api.get_cf2(claim_id) or claim.get("phiccF2") or {}
            admission = cf2.get("admissionDateTime") or claim.get("admissionDateTime")
            discharge = cf2.get("dischargeDateTime") or claim.get("dischargeDateTime")
            if not admission or not discharge:
                raise ValueError("Claim admission and discharge dates are required to finalize eligibility.")
            result = cf2_api.finalize_claim_eligibility(claim_id, transmittal_id, admission, discharge)
            return jsonify(result)
    except Exception as exc:
        logger.error(f"Finalize Claims eligibility finalize failed for claim {claim_id}: {exc}")
        return jsonify({"error": str(exc) or "Claim finalization failed."}), 502


def _beacon_local_datetime(value):
    if not value:
        return None
    text = str(value).strip()
    has_iso_time = "T" in text
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        parsed = None
        for date_format in ("%m-%d-%Y", "%m/%d/%Y", "%Y-%m-%d"):
            try:
                parsed = datetime.strptime(text, date_format)
                break
            except ValueError:
                continue
        if parsed is None:
            raise
    # Beacon may return UTC CF2 timestamps without a timezone suffix on
    # drafts; normalize them like the same values returned with a trailing Z.
    if parsed.tzinfo is None and has_iso_time:
        parsed = parsed.replace(tzinfo=timezone.utc)
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone(timedelta(hours=8))).replace(tzinfo=None)
    return parsed


@app.route("/api/beacon/finalize-claims/<int:transmittal_id>/<int:claim_id>/edit", methods=["GET"])
@login_required
def get_finalize_claim_edit_data(transmittal_id, claim_id):
    user = current_user()
    beacon_settings, auth_key = _beacon_edit_settings(user)
    try:
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            transmittal, claim_row = _require_draft_claim(transmittal_id, claim_id)
            cf2 = cf2_api.get_cf2(claim_id) or {}
            cf2_pdf = cf2_api.get_cf2_pdf_details(claim_id, cf2_api.get_client_id()) or {}
            signatories = cf2_api.get_esoa_signatories(claim_id) or {}
            session_dates = [
                parsed for procedure in (beacon_api.get_surgical_procedures(claim_id) or [])
                for session in (procedure.get("sessions") or [])
                if isinstance(session, dict)
                for parsed in [_beacon_local_datetime(session.get("sessionDate"))]
                if parsed is not None
            ]
            last_treatment = max(session_dates) if session_dates else None
            doctors = cf2_api.get_doctors(claim_id) or []
            cf4 = beacon_api.get_cf4_values(claim_id) or {}
            meds, xlso = soa_api.get_charges(claim_id)
            payments = soa_api.get_payment_receipts(claim_id)

        admission = _beacon_local_datetime(cf2.get("admissionDateTime"))
        discharge = _beacon_local_datetime(cf2.get("dischargeDateTime"))
        exam = cf4.get("phiccF4PhysicalExam") or {}
        course_in_ward = []
        for order in cf4.get("phiccF4DoctorsOrder") or []:
            if not isinstance(order, dict):
                continue
            order_date = _beacon_local_datetime(order.get("date"))
            course_in_ward.append({
                "id": order.get("id"),
                "date": order_date.strftime("%Y-%m-%d") if order_date else "",
                "order": order.get("order") or "",
            })
        return jsonify({
            "transmittal_number": transmittal.get("transmittalNumber") or "",
            "claim_series": claim_row.get("claimSeriesLhio") or "",
            "patient_name": ((claim_row.get("phiccF1") or {}).get("patientFullname") or ""),
            "cf2": {
                "admission_date": admission.strftime("%Y-%m-%d") if admission else "",
                "admission_time": admission.strftime("%H:%M") if admission else "",
                "discharge_date": discharge.strftime("%Y-%m-%d") if discharge else "",
                "discharge_time": discharge.strftime("%H:%M") if discharge else "",
            },
            "account_receivable": {
                "name": cf2_pdf.get("signatureOverPrintedNameOfAuthHCIRep") or signatories.get("preparedBy") or "",
                "designation": cf2_pdf.get("officialCapacityDesignation") or "",
                "number": signatories.get("adminContactNo") or "",
                "date_signed": last_treatment.strftime("%Y-%m-%d") if last_treatment else "",
            },
            "doctors": [
                {
                    "id": doctor.get("id"),
                    "accreditation_number": doctor.get("accreditationNumber") or "",
                    "fullname": doctor.get("fullname") or "",
                    "sign_date": str(doctor.get("doctorSignDate") or "").split("T", 1)[0],
                }
                for doctor in doctors if isinstance(doctor, dict)
            ],
            "cf4_vitals": {
                key: exam.get(key)
                for key in ("vsbpSystolic", "vsbpDiastolic", "vshr", "vsrr", "vsTemp", "height", "weight")
            },
            "cf4_text": {
                "history_of_present_illness": cf4.get("historyOfPresentIllness") or "",
                "pertinent_past_medical_history": cf4.get("pertinentPastMedicalHistory") or "",
            },
            "cf4_course_in_ward": course_in_ward,
            "soa_counts": {"med": len(meds), "xlso": len(xlso), "payments": len(payments)},
        })
    except (ValueError, LookupError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error(f"Finalize Claims editor load failed for claim {claim_id}: {exc}")
        return jsonify({"error": "Could not load this draft claim from Beacon."}), 502


@app.route("/api/beacon/finalize-claims/<int:transmittal_id>/<int:claim_id>/cf2", methods=["POST"])
@login_required
@track_dashboard_operation("Edit Claims")
def save_finalize_claim_cf2(transmittal_id, claim_id):
    data = request.get_json(silent=True) or {}
    try:
        admission_date = datetime.strptime(str(data.get("admission_date") or ""), "%Y-%m-%d").date()
        admission_time = datetime.strptime(str(data.get("admission_time") or ""), "%H:%M").time()
        discharge_date = datetime.strptime(str(data.get("discharge_date") or ""), "%Y-%m-%d").date()
        discharge_time = datetime.strptime(str(data.get("discharge_time") or ""), "%H:%M").time()
        if datetime.combine(discharge_date, discharge_time) < datetime.combine(admission_date, admission_time):
            return jsonify({"error": "Discharge date and time must be after admission."}), 400

        user = current_user()
        beacon_settings, auth_key = _beacon_edit_settings(user)
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            _require_draft_claim(transmittal_id, claim_id)
            cf2 = cf2_api.get_cf2(claim_id)
            if not isinstance(cf2, dict) or not cf2:
                raise RuntimeError("Beacon did not return the CF2 record.")
            cf2.update({
                "admissionDate": admission_date.strftime("%m-%d-%Y"),
                "admissionTime": format_beacon_time(admission_time),
                "admissionDateTime": cf2_api.to_utc_datetime_iso(admission_date, admission_time),
                "dischargeDate": discharge_date.strftime("%m-%d-%Y"),
                "dischargeTime": format_beacon_time(discharge_time),
                "dischargeDateTime": cf2_api.to_utc_datetime_iso(discharge_date, discharge_time),
                "surgicalProcedures": cf2_api.build_surgical_procedures_for_cf2(claim_id),
            })
            cf2_api.edit_cf2(cf2)
            # A later CF4 save round-trips the full CF4 object. Drop any
            # editor-load cache so that it cannot write CF4 values captured
            # before this CF2 update.
            beacon_api._cf4_cache.pop((browser_session._context_key(), int(claim_id)), None)
        return jsonify({"saved": True})
    except (ValueError, LookupError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error(f"Finalize Claims CF2 save failed for claim {claim_id}: {exc}")
        return jsonify({"error": "Beacon could not save the CF2 date and time changes."}), 502


@app.route("/api/beacon/finalize-claims/<int:transmittal_id>/<int:claim_id>/receivable", methods=["POST"])
@login_required
@track_dashboard_operation("Edit Claims")
def save_finalize_claim_account_receivable(transmittal_id, claim_id):
    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()
    designation = str(data.get("designation") or "").strip()
    number = str(data.get("number") or "").strip()
    try:
        user = current_user()
        beacon_settings, auth_key = _beacon_edit_settings(user)
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            _require_draft_claim(transmittal_id, claim_id)

            procedures = beacon_api.get_surgical_procedures(claim_id) or []
            session_dates = [
                parsed for procedure in procedures
                for session in (procedure.get("sessions") or [])
                if isinstance(session, dict)
                for parsed in [_beacon_local_datetime(session.get("sessionDate"))]
                if parsed is not None
            ]
            if not session_dates:
                raise RuntimeError("No CF2 treatment session date was found for this claim.")
            last_treatment = max(session_dates).date()

            pdf_data = cf2_api.get_cf2_pdf_details(claim_id, cf2_api.get_client_id())
            if not isinstance(pdf_data, dict) or not pdf_data:
                raise RuntimeError("Beacon did not return the CF2 PDF data.")
            pdf_data["signatureOverPrintedNameOfAuthHCIRep"] = name
            pdf_data["officialCapacityDesignation"] = designation
            # Match CF2 automation's confirmed local-midnight date encoding.
            pdf_data["dateSigned"] = cf2_api.to_utc_midnight_iso(last_treatment)
            cf2_api.new_pdf_claim_form_two(claim_id, pdf_data)

            signatories = cf2_api.get_esoa_signatories(claim_id)
            if not isinstance(signatories, dict) or signatories.get("id") is None:
                raise RuntimeError("Beacon did not return the eSOA signatory record.")
            signatories.update({
                "phicClaimId": claim_id,
                "preparedBy": name,
                "adminContactNo": number,
            })
            cf2_api.update_esoa_signatories(signatories)
        return jsonify({"saved": True})
    except (ValueError, LookupError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error(f"Finalize Claims account receivable save failed for claim {claim_id}: {exc}")
        return jsonify({"error": "Beacon could not save the account receivable details."}), 502


@app.route("/api/beacon/finalize-claims/<int:transmittal_id>/<int:claim_id>/doctor", methods=["POST"])
@login_required
@track_dashboard_operation("Edit Claims")
def save_finalize_claim_doctor(transmittal_id, claim_id):
    data = request.get_json(silent=True) or {}
    accreditation_number = str(data.get("accreditation_number") or "").strip()
    sign_date_text = str(data.get("sign_date") or "").strip()
    try:
        if not accreditation_number:
            return jsonify({"error": "Enter the doctor's accreditation number."}), 400
        sign_date = datetime.strptime(sign_date_text, "%Y-%m-%d").date()
        selected_id = str(data.get("doctor_id") or "")
        user = current_user()
        beacon_settings, auth_key = _beacon_edit_settings(user)
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            _require_draft_claim(transmittal_id, claim_id)
            doctors = cf2_api.get_doctors(claim_id) or []
            previous = next((d for d in doctors if selected_id and str(d.get("id")) == selected_id), None)
            if selected_id and not previous:
                return jsonify({"error": "The selected doctor is no longer on this claim. Reload the editor."}), 409
            same_doctor = (
                previous
                and str(previous.get("accreditationNumber") or "").strip() == accreditation_number
            )
            if same_doctor and str(previous.get("doctorSignDate") or "").startswith(sign_date_text):
                return jsonify({"saved": True, "unchanged": True})

            cf2 = cf2_api.get_cf2(claim_id) or {}
            admission = _beacon_local_datetime(cf2.get("admissionDateTime"))
            discharge = _beacon_local_datetime(cf2.get("dischargeDateTime"))
            if not admission or not discharge:
                raise RuntimeError("Save the CF2 admission and discharge dates before changing the doctor.")
            admission_date_str = admission.strftime("%m-%d-%Y")
            discharge_date_str = discharge.strftime("%m-%d-%Y")
            sign_date_str = sign_date.strftime("%m-%d-%Y")
            if same_doctor:
                accreditation_check = cf2_api.is_doctor_accredited(
                    accreditation_number,
                    admission_date_str,
                    discharge_date_str,
                    cf2_api.get_hospital_identity(transmittal_id),
                )
                updated = cf2_api.edit_doctor(
                    doctor=previous,
                    claim_id=claim_id,
                    sign_date_str=sign_date_str,
                    admission_date_str=admission_date_str,
                    discharge_date_str=discharge_date_str,
                    is_accredited=accreditation_check.get("isaccredited") == "YES",
                )
                if not isinstance(updated, dict) or not updated:
                    raise RuntimeError("Beacon did not confirm the doctor update.")
                doctor = updated
            else:
                doctor = cf2_api.add_doctor(
                    claim_id=claim_id,
                    client_id=cf2_api.get_client_id(),
                    accreditation_number=accreditation_number,
                    sign_date_str=sign_date_str,
                    admission_date_str=admission_date_str,
                    discharge_date_iso=cf2_api.to_utc_midnight_iso(discharge.date()),
                    hospital_identity=cf2_api.get_hospital_identity(transmittal_id),
                )
                if not isinstance(doctor, dict) or not doctor:
                    raise RuntimeError("Beacon did not confirm the replacement doctor record.")

            returned_sign_date = str(doctor.get("doctorSignDate") or "").split("T", 1)[0]
            if returned_sign_date not in (sign_date.isoformat(), sign_date_str):
                raise RuntimeError("Beacon did not save the requested CF2 doctor sign date.")
            if previous and not same_doctor:
                cf2_api.delete_doctor(previous.get("id"))
            doctor_name = beacon_automation._cf4_signature_doctor_name(
                doctor.get("fullname")
                or " ".join(
                    str(doctor.get(key) or "")
                    for key in ("firstname", "middlename", "lastname", "suffix")
                )
            )
            cf4_date_signed = (sign_date - timedelta(days=1)).strftime("%Y-%m-%dT16:00:00Z")
            if not doctor_name:
                raise RuntimeError("Beacon saved the CF2 doctor but returned no usable signature name.")
            if not beacon_api.new_pdf_cf4(claim_id, doctor_name, cf4_date_signed):
                raise RuntimeError("Beacon saved the CF2 doctor but did not confirm the CF4 signature update.")
        return jsonify({"saved": True, "doctor": doctor or {}})
    except (ValueError, LookupError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error(f"Finalize Claims doctor save failed for claim {claim_id}: {exc}")
        return jsonify({"error": "Beacon could not save the doctor change."}), 502


@app.route("/api/beacon/finalize-claims/<int:transmittal_id>/<int:claim_id>/cf4-vitals", methods=["POST"])
@login_required
@track_dashboard_operation("Edit Claims")
def save_finalize_claim_cf4_vitals(transmittal_id, claim_id):
    data = request.get_json(silent=True) or {}
    vital_keys = ("vsbpSystolic", "vsbpDiastolic", "vshr", "vsrr", "vsTemp", "height", "weight")
    try:
        submitted = {}
        for key in vital_keys:
            value = data.get(key)
            submitted[key] = None if value in (None, "") else float(value)
        user = current_user()
        beacon_settings, auth_key = _beacon_edit_settings(user)
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            _require_draft_claim(transmittal_id, claim_id)
            cache_key = (browser_session._context_key(), int(claim_id))
            # Do not send an editor-load snapshot back to Beacon; it may be
            # stale if another CF2/CF4 operation has happened since then.
            beacon_api._cf4_cache.pop(cache_key, None)
            cf4 = beacon_api.get_cf4_values(claim_id)
            if not isinstance(cf4, dict) or not cf4:
                raise RuntimeError("Beacon did not return the CF4 record.")
            payload = beacon_automation._normalize_cf4_save_payload(cf4, claim_id, False, {}, [])
            # Beacon timestamps for Course in the Ward are date-only values
            # represented through UTC. Canonicalize them on every full-CF4
            # save so an unrelated vitals edit cannot shift their local date.
            orders = payload.get("phiccF4DoctorsOrder") or []
            normalized_orders = []
            for order in orders:
                if not isinstance(order, dict):
                    normalized_orders.append(order)
                    continue
                normalized_order = dict(order)
                local_order_date = _beacon_local_datetime(order.get("date"))
                if local_order_date:
                    normalized_order["date"] = beacon_automation._local_date_to_beacon_utc(
                        local_order_date.date()
                    )
                normalized_orders.append(normalized_order)
            payload["phiccF4DoctorsOrder"] = normalized_orders
            exam = dict(payload.get("phiccF4PhysicalExam") or {})
            exam.update(submitted)
            payload["phiccF4PhysicalExam"] = exam
            payload.update(submitted)
            if not beacon_api.save_cf4_values(payload):
                raise RuntimeError("Beacon returned an empty CF4 save response.")
            beacon_api._cf4_cache.pop(cache_key, None)
        return jsonify({"saved": True})
    except (ValueError, LookupError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error(f"Finalize Claims CF4 vital save failed for claim {claim_id}: {exc}")
        return jsonify({"error": "Beacon could not save the CF4 vital sign changes."}), 502


@app.route("/api/beacon/finalize-claims/<int:transmittal_id>/<int:claim_id>/cf4-text", methods=["POST"])
@login_required
@track_dashboard_operation("Edit Claims")
def save_finalize_claim_cf4_text(transmittal_id, claim_id):
    data = request.get_json(silent=True) or {}
    field_keys = (
        "historyOfPresentIllness",
        "pertinentPastMedicalHistory",
    )
    if not any(key in data for key in field_keys):
        return jsonify({"error": "No CF4 text field was provided."}), 400

    try:
        user = current_user()
        beacon_settings, auth_key = _beacon_edit_settings(user)
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            _require_draft_claim(transmittal_id, claim_id)
            cache_key = (browser_session._context_key(), int(claim_id))
            # Render keeps its worker alive across requests, so the CF4 object
            # loaded by the editor may still be cached when this save runs.
            # Fetch the latest record before round-tripping the full payload.
            beacon_api._cf4_cache.pop(cache_key, None)
            cf4 = beacon_api.get_cf4_values(claim_id)
            if not isinstance(cf4, dict) or not cf4:
                raise RuntimeError("Beacon did not return the CF4 record.")
            payload = beacon_automation._normalize_cf4_save_payload(cf4, claim_id, False, {}, [])
            payload["historyOfPresentIllness"] = cf4.get("historyOfPresentIllness") or ""
            payload["pertinentPastMedicalHistory"] = cf4.get("pertinentPastMedicalHistory") or ""
            for key in field_keys:
                if key in data:
                    payload[key] = str(data.get(key) or "").strip()
            if not beacon_api.save_cf4_values(payload):
                raise RuntimeError("Beacon returned an empty CF4 save response.")
            beacon_api._cf4_cache.pop((browser_session._context_key(), int(claim_id)), None)
        return jsonify({"saved": True})
    except (ValueError, LookupError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error(f"Finalize Claims CF4 text save failed for claim {claim_id}: {exc}")
        return jsonify({"error": "Beacon could not save the CF4 text changes."}), 502


@app.route("/api/beacon/finalize-claims/<int:transmittal_id>/<int:claim_id>/course-in-ward", methods=["POST"])
@login_required
@track_dashboard_operation("Edit Claims")
def save_finalize_claim_course_in_ward(transmittal_id, claim_id):
    entries = (request.get_json(silent=True) or {}).get("entries")
    if not isinstance(entries, list):
        return jsonify({"error": "Course in the Ward entries must be a list."}), 400

    try:
        submitted = []
        for index, entry in enumerate(entries, start=1):
            if not isinstance(entry, dict):
                raise ValueError(f"Course in the Ward entry {index} is invalid.")
            date = datetime.strptime(str(entry.get("date") or ""), "%Y-%m-%d").date()
            order = str(entry.get("order") or "").strip()
            if not order:
                raise ValueError(f"Enter the course text for entry {index}.")
            submitted.append({"id": str(entry.get("id") or ""), "date": date, "order": order})

        user = current_user()
        beacon_settings, auth_key = _beacon_edit_settings(user)
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            _require_draft_claim(transmittal_id, claim_id)
            cache_key = (browser_session._context_key(), int(claim_id))
            # Render keeps its worker alive across requests, so the CF4 object
            # loaded by the editor may still be cached when this save runs.
            # Fetch the latest record before round-tripping the full payload.
            beacon_api._cf4_cache.pop(cache_key, None)
            cf4 = beacon_api.get_cf4_values(claim_id)
            if not isinstance(cf4, dict) or not cf4:
                raise RuntimeError("Beacon did not return the CF4 record.")
            payload = beacon_automation._normalize_cf4_save_payload(cf4, claim_id, False, {}, [])
            existing = {
                str(order.get("id")): dict(order)
                for order in (payload.get("phiccF4DoctorsOrder") or [])
                if isinstance(order, dict) and order.get("id") is not None
            }
            payload["phiccF4DoctorsOrder"] = [
                {
                    **existing.get(entry["id"], {"informalEntry": False}),
                    "date": beacon_automation._local_date_to_beacon_utc(entry["date"]),
                    "order": entry["order"],
                }
                for entry in submitted
            ]
            if not beacon_api.save_cf4_values(payload):
                raise RuntimeError("Beacon returned an empty CF4 save response.")
            beacon_api._cf4_cache.pop(cache_key, None)
        return jsonify({"saved": True, "entries": len(submitted)})
    except (ValueError, LookupError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error(f"Finalize Claims Course in the Ward save failed for claim {claim_id}: {exc}")
        return jsonify({"error": "Beacon could not save the Course in the Ward changes."}), 502


@app.route("/api/beacon/finalize-claims/<int:transmittal_id>/<int:claim_id>/soa", methods=["DELETE"])
@login_required
@track_dashboard_operation("Edit Claims")
def remove_finalize_claim_soa(transmittal_id, claim_id):
    user = current_user()
    beacon_settings, auth_key = _beacon_edit_settings(user)
    try:
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            _require_draft_claim(transmittal_id, claim_id)
            receipts = soa_api.get_payment_receipts(claim_id)
            if receipts:
                return jsonify({
                    "error": "This claim has payment receipts, so no SOA data was changed."
                }), 409
            meds, xlso = soa_api.get_charges(claim_id)
            med_ids = [row.get("id") for row in meds if row.get("id") is not None]
            xlso_ids = [row.get("id") for row in xlso if row.get("id") is not None]
            if med_ids:
                soa_api.remove_med_charges(claim_id, med_ids)
            if xlso_ids:
                soa_api.remove_xlso_charges(claim_id, xlso_ids)
            remaining_meds, remaining_xlso = soa_api.get_charges(claim_id)
            if remaining_meds or remaining_xlso:
                raise RuntimeError("Beacon still returns SOA charge rows after removal.")
        return jsonify({"removed": True, "med_count": len(med_ids), "xlso_count": len(xlso_ids)})
    except (ValueError, LookupError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error(f"Finalize Claims SOA removal failed for claim {claim_id}: {exc}")
        return jsonify({"error": "Beacon could not remove all SOA charge rows."}), 502


@app.route("/api/beacon/finalize-claims/<int:transmittal_id>/<int:claim_id>/soa/generated", methods=["DELETE"])
@login_required
@track_dashboard_operation("Edit Claims")
def remove_finalize_claim_generated_soa(transmittal_id, claim_id):
    user = current_user()
    beacon_settings, auth_key = _beacon_edit_settings(user)
    try:
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            _require_draft_claim(transmittal_id, claim_id)
            removed_count = soa_api.remove_generated_esoa_documents(claim_id)
            issue_count = soa_api.get_claim_issue_count(claim_id)
        return jsonify({
            "removed": True,
            "document_count": removed_count,
            "issue_count": issue_count,
        })
    except (ValueError, LookupError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error(f"Finalize Claims generated SOA removal failed for claim {claim_id}: {exc}")
        return jsonify({"error": "Beacon could not remove all generated eSOA documents."}), 502


@app.route("/api/beacon/finalize-claims/<int:transmittal_id>/<int:claim_id>/soa/generate", methods=["POST"])
@login_required
@track_dashboard_operation("SOA Generation - Edit Claims")
def generate_finalize_claim_soa(transmittal_id, claim_id):
    user = current_user()
    beacon_settings, auth_key = _beacon_edit_settings(user)
    try:
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            _require_draft_claim(transmittal_id, claim_id)
            facility_id = beacon_api.get_client_id()
            soa_api.validate_and_generate_esoa(claim_id, facility_id)
        return jsonify({"generated": True})
    except (ValueError, LookupError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error(f"Finalize Claims SOA generation failed for claim {claim_id}: {exc}")
        return jsonify({"error": "Beacon could not generate and upload the SOA."}), 502


@app.route("/api/beacon/finalize-claims/<int:transmittal_id>/<int:claim_id>/cf4-generate", methods=["POST"])
@login_required
@track_dashboard_operation("Edit Claims")
def generate_finalize_claim_cf4(transmittal_id, claim_id):
    user = current_user()
    beacon_settings, auth_key = _beacon_edit_settings(user)
    try:
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            _require_draft_claim(transmittal_id, claim_id)
            generated = beacon_api.generate_cf4_xml(
                claim_id=claim_id,
                facility_id=beacon_api.get_client_id(),
                transmittal_id=transmittal_id,
            )
            if generated is not True:
                raise RuntimeError(f"Beacon returned an unsuccessful CF4 generation response: {generated}")
        return jsonify({"generated": True})
    except (ValueError, LookupError) as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        logger.error(f"Finalize Claims CF4 generation failed for claim {claim_id}: {exc}")
        return jsonify({"error": "Beacon could not generate the CF4."}), 502


@app.route("/api/cf4/settings", methods=["GET"])
@login_required
def get_cf4_settings():
    """Backs the CF4 screen's initial load — same values beacon.py's
    Auto Encode CF4 step will use on the next run."""
    settings = get_or_create_user_settings(current_user())
    return jsonify({**DEFAULT_CF4_SETTINGS, **(settings.cf4_settings or {})})


@app.route("/api/cf4/settings", methods=["POST"])
@login_required
def post_cf4_settings():
    """
    Body: any subset of DEFAULT_CF4_SETTINGS' keys. Merged over the
    current saved values (not replaced wholesale), then stored for this user.
    """
    data = request.get_json(force=True)
    settings = get_or_create_user_settings(current_user())
    cf4 = {**DEFAULT_CF4_SETTINGS, **(settings.cf4_settings or {}), **data}
    settings.cf4_settings = cf4
    db.session.commit()
    return jsonify(cf4)


# ---------------------------------------------------------------------------
# CF2 workbook analysis
# Analyze the uploaded workbook and return a structured JSON payload.
# ---------------------------------------------------------------------------
def _analyze_workbook(workbook, claim_year, claim_month=None, mode="new_draft"):
    sheet = workbook["Sheet1"]
    records = []
    header_columns = {
        re.sub(r"[^a-z0-9]+", "", str(cell.value or "").casefold()): cell.column
        for cell in sheet[1]
        if cell.value is not None
    }

    def find_header(*names):
        for name in names:
            column = header_columns.get(re.sub(r"[^a-z0-9]+", "", name.casefold()))
            if column:
                return column
        return None

    draft_title_column = find_header("draft title", "draft title optional") if mode == "new_draft" else None
    if mode == "new_draft" and draft_title_column:
        if draft_title_column != 1:
            raise ValueError("In the New Draft template, DRAFT TITLE (OPTIONAL) must be in column A.")
        # Current New Draft template: the optional title was inserted as
        # column A, shifting the original fields one column to the right.
        draft_title_column = 1
        identifier_column = 2
        patient_column = 3
        doctor_column = 4
        accreditation_column = 5
        treatment_dates_column = 6
    else:
        # Legacy New Draft and Existing Draft workbooks retain their original
        # positions. Resolve those by header so both formats remain supported.
        patient_column = find_header("name of patient", "patient name")
        identifier_column = (
            find_header("transmittal no", "transmittal number")
            if mode == "existing_draft"
            else find_header("member pin")
        )
        doctor_column = find_header("attending nephrologist", "doctor")
        accreditation_column = find_header("accreditation no", "accreditation number")
        treatment_dates_column = find_header("treatment dates")
    required_headers = {
        "NAME OF PATIENT": patient_column,
        "MEMBER PIN" if mode == "new_draft" else "TRANSMITTAL NO.": identifier_column,
        "ATTENDING/ NEPHROLOGIST": doctor_column,
        "ACCREDITATION NO.": accreditation_column,
        "TREATMENT DATES": treatment_dates_column,
    }
    missing_headers = [label for label, column in required_headers.items() if column is None]
    expected_labels = {
        patient_column: "NAME OF PATIENT",
        identifier_column: "MEMBER PIN" if mode == "new_draft" else "TRANSMITTAL NO.",
        doctor_column: "ATTENDING/ NEPHROLOGIST",
        accreditation_column: "ACCREDITATION NO.",
        treatment_dates_column: "TREATMENT DATES",
    }
    expected_headers = {
        patient_column: {"nameofpatient", "patientname"},
        identifier_column: {"memberpin"} if mode == "new_draft" else {"transmittalno", "transmittalnumber"},
        doctor_column: {"attendingnephrologist", "doctor"},
        accreditation_column: {"accreditationno", "accreditationnumber"},
        treatment_dates_column: {"treatmentdates"},
    }
    for column, accepted_headers in expected_headers.items():
        if column is None:
            continue
        actual_header = next(
            (header for header, header_column in header_columns.items() if header_column == column),
            None,
        )
        if actual_header not in accepted_headers:
            label = expected_labels[column]
            missing_headers.append(f"{label} in column {column}")
    if missing_headers:
        raise ValueError(
            "The workbook headers do not match the selected CF2 template. "
            f"Missing required column(s): {', '.join(missing_headers)}. "
            "Download the template for this workflow and keep its headers unchanged."
        )
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
        # Column positions are read from headers so the optional New Draft
        # title column can be added without changing Existing Draft files.
        patient = sheet.cell(row=row, column=patient_column).value
        identifier = sheet.cell(row=row, column=identifier_column).value
        doctor = sheet.cell(row=row, column=doctor_column).value
        accreditation = sheet.cell(row=row, column=accreditation_column).value
        treatment_dates = sheet.cell(row=row, column=treatment_dates_column).value
        draft_title = (
            sheet.cell(row=row, column=draft_title_column).value
            if draft_title_column
            else None
        )
        if all(
            value is None or not str(value).strip()
            for value in (patient, identifier, doctor, accreditation, treatment_dates, draft_title)
        ):
            continue

        if patient is None or not str(patient).strip():
            raise ValueError(f"Row {row}: NAME OF PATIENT is required.")
        patient_name = str(patient).strip()
        if not any(character.isalpha() for character in patient_name):
            raise ValueError(
                f"Row {row}: NAME OF PATIENT appears to contain an identifier, not a patient name. "
                "Check that the workbook columns have not shifted."
            )
        if identifier is None or not str(identifier).strip():
            identifier_label = "MEMBER PIN" if mode == "new_draft" else "TRANSMITTAL NO."
            raise ValueError(f"Row {row}: {identifier_label} is required.")
        if doctor is None or not str(doctor).strip():
            raise ValueError(f"Row {row}: ATTENDING/ NEPHROLOGIST is required.")
        if accreditation is None or not str(accreditation).strip():
            raise ValueError(f"Row {row}: ACCREDITATION NO. is required.")
        if treatment_dates is None or not str(treatment_dates).strip():
            raise ValueError(
                f"Row {row}: TREATMENT DATES is required. Use a format such as "
                "'June 15,17,19' or '6/15,17,19'."
            )
        draft_title = str(draft_title).strip() if draft_title is not None else ""
        if draft_title and len(draft_title) > MAX_TITLE_LENGTH:
            raise ValueError(
                f"Row {row}: Draft Title must be {MAX_TITLE_LENGTH} characters or fewer."
            )
        time_range = sheet.cell(row=row, column=time_column).value if time_column else None
        px_contact = sheet.cell(row=row, column=px_contact_column).value if px_contact_column else None
        try:
            admission_time, discharge_time = parse_time_range(time_range)
        except ValueError as ex:
            raise ValueError(f"Row {row}: {ex}") from ex

        try:
            parsed_treatment_dates = parse_dates(
                treatment_dates, claim_year, claim_month
            )
        except ValueError as ex:
            raise ValueError(f"Row {row}: Invalid TREATMENT DATES: {ex}") from ex
        if not parsed_treatment_dates:
            raise ValueError(
                f"Row {row}: Could not read TREATMENT DATES {str(treatment_dates)!r}. "
                "Use a format such as 'June 15,17,19', '6/15,17,19', or '15,17,19' "
                "with the claim month selected."
            )

        identifier_str = str(identifier).strip() if identifier is not None else ""

        record = PatientRecord(
            transmittal=identifier_str if mode == "existing_draft" else "",
            patient_name=patient_name,
            doctor=str(doctor),
            accreditation_no=str(accreditation),
            treatment_dates_raw=str(treatment_dates),
            time_range_raw=str(time_range).strip() if time_range is not None else "",
            member_pin=identifier_str if mode == "new_draft" else "",
            draft_title=draft_title,
            px_contact_no=str(px_contact).strip() if px_contact is not None else "",
            admission_time=admission_time,
            discharge_time=discharge_time,
            source_row=row,
        )

        record.treatment_dates = parsed_treatment_dates

        if record.treatment_dates:
            record.first_treatment = record.treatment_dates[0]
            record.last_treatment = record.treatment_dates[-1]
            record.total_sessions = len(record.treatment_dates)

        records.append(record)

    if not records:
        raise ValueError("No patient rows were found. Add at least one completed patient row and upload again.")

    return records


def _record_to_dict(record, cf2, mode="new_draft"):
    """Same fields the old log_box printed per patient, as JSON instead of
    text. "identifier"/"identifier_label" let the CF2 window show the
    correct New Draft Member PIN or Existing Draft Transmittal No."""
    return {
        "identifier_label": "Transmittal No." if mode == "existing_draft" else "Member PIN",
        "identifier": record.transmittal if mode == "existing_draft" else record.member_pin,
        "excel_row": record.source_row,
        "patient_name": record.patient_name,
        "draft_title": record.draft_title,
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


def _write_cf2_snapshot(user_id, snapshot):
    with _cf2_snapshot_lock:
        with app.app_context():
            try:
                row = db.session.get(Cf2TaskSnapshot, user_id)
                if row is None:
                    row = Cf2TaskSnapshot(user_id=user_id, snapshot=dict(snapshot))
                    db.session.add(row)
                else:
                    row.snapshot = dict(snapshot)
                db.session.commit()
            except Exception:
                db.session.rollback()
                logger.exception("Could not persist CF2 status for user %s", user_id)


def _cf2_resume_record(record, mode):
    return {
        "identifier_label": "Transmittal No." if mode == "existing_draft" else "Member PIN",
        "identifier": record.transmittal if mode == "existing_draft" else record.member_pin,
        "excel_row": record.source_row,
        "patient_name": record.patient_name,
    }


def _update_cf2_snapshot(user_id, **updates):
    with _cf2_snapshot_lock:
        with app.app_context():
            try:
                row = db.session.get(Cf2TaskSnapshot, user_id)
                if row is None:
                    return None
                snapshot = dict(row.snapshot or {})
                progress_item = updates.pop("progress_item", None)
                if progress_item:
                    progress = dict(snapshot.get("progress") or {})
                    item_result = progress_item.get("result") or {}
                    progress[str(progress_item.get("excel_row"))] = {
                        key: progress_item.get(key)
                        for key in (
                            "mode", "current", "total", "excel_row", "identifier_label",
                            "identifier", "patient_name", "status", "phase", "message",
                        )
                    }
                    if item_result.get("transmittal"):
                        progress[str(progress_item.get("excel_row"))]["transmittal"] = item_result["transmittal"]
                    snapshot["progress"] = progress
                snapshot.update(updates)
                snapshot["updated_at"] = utc_now().isoformat()
                row.snapshot = snapshot
                db.session.commit()
                return dict(snapshot)
            except Exception:
                db.session.rollback()
                logger.exception("Could not update CF2 status for user %s", user_id)
                return None


@app.route("/api/cf2/upload", methods=["POST"])
@login_required
def cf2_upload():
    """Accept a browser-uploaded workbook and analyze its claims."""
    if not request.content_type or not request.content_type.startswith("multipart/form-data"):
        return jsonify({"error": "Upload the Excel workbook from your browser."}), 400
    data = request.form
    uploaded = request.files.get("file")
    if not uploaded:
        return jsonify({"error": "No Excel file uploaded."}), 400
    try:
        filename = str(_save_upload(uploaded, "cf2", {".xlsx", ".xlsm", ".xls"}))
    except ValueError as ex:
        return jsonify({"error": str(ex)}), 400
    try:
        claim_year = int(data.get("claim_year"))
        claim_month_name = data.get("claim_month")
        claim_month = MONTH_NAMES.index(claim_month_name) + 1 if claim_month_name else None
        mode = data.get("mode") if data.get("mode") in ("new_draft", "existing_draft") else "new_draft"
        workbook = load_workbook(filename, data_only=True)
        try:
            sheet_names = workbook.sheetnames
            records = _analyze_workbook(workbook, claim_year, claim_month, mode)
        finally:
            workbook.close()
    except (TypeError, ValueError) as ex:
        return jsonify({"error": str(ex)}), 400
    except Exception as ex:
        return jsonify({"error": str(ex)}), 400
    finally:
        Path(filename).unlink(missing_ok=True)

    user = current_user()
    _cf2_states[user.id] = {
        "patient_records": records,
        "cf2_mode": mode,
    }

    payload_records = [_record_to_dict(r, build_cf2_data(r), mode) for r in records]

    _write_cf2_snapshot(user.id, {
        "run_id": uuid.uuid4().hex,
        "server_instance": _server_instance_id,
        "mode": mode,
        "records": [_cf2_resume_record(record, mode) for record in records],
        "progress": {},
        "running": False,
        "done": False,
        "message": "Workbook ready.",
        "updated_at": utc_now().isoformat(),
    })

    return jsonify({
        "sheets": sheet_names,
        "patient_count": len(records),
        "records": payload_records,
    })


@app.route("/api/cf2/status", methods=["GET"])
@login_required
def cf2_status():
    user = current_user()
    row = db.session.get(Cf2TaskSnapshot, user.id)
    snapshot = dict(row.snapshot) if row and row.snapshot else None
    if snapshot and snapshot.get("running") and snapshot.get("server_instance") != _server_instance_id:
        progress = dict(snapshot.get("progress") or {})
        for item in progress.values():
            if item.get("status") == "running":
                item.update({"status": "failed", "phase": "Interrupted by server restart"})
        snapshot.update({
            "running": False,
            "done": True,
            "failed": True,
            "message": "The server restarted while this automation was active. Saved results are shown.",
            "progress": progress,
            "server_instance": _server_instance_id,
            "updated_at": utc_now().isoformat(),
        })
        _write_cf2_snapshot(user.id, snapshot)
    return jsonify({"run": snapshot})


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
    run_started_at = utc_now()
    automation = None
    stopped = False
    failed = False
    room_token = _emit_room.set(user_room(user_id))
    try:
        records = state["patient_records"]
        total = len(records)
        mode = state["cf2_mode"]

        def emit_progress(record, current, status, phase="", message="", result=None):
            identifier_label = "Transmittal No." if mode == "existing_draft" else "Member PIN"
            identifier = record.transmittal if mode == "existing_draft" else record.member_pin
            progress = {
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
            }
            _update_cf2_snapshot(user_id, progress_item=progress, current=current, total=total, message=message)
            emit_to_current_room("cf2_progress", progress)

        auth_key = browser_session.auth_context_key(
            beacon_settings,
            user_key=f"user:{user_id}",
        )
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            automation = CF2Automation(
                mode=mode,
                account_receivable_name=state.get("account_receivable_name", ""),
                account_receivable_designation=state.get("account_receivable_designation", ""),
                account_receivable_number=state.get("account_receivable_number", ""),
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
        failed = True
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
        if failed or stopped:
            with app.app_context():
                row = db.session.get(Cf2TaskSnapshot, user_id)
                progress = dict((row.snapshot or {}).get("progress") or {}) if row else {}
            for item in progress.values():
                if item.get("status") == "running":
                    item.update({
                        "status": "failed" if failed else "skipped",
                        "phase": "Automation ended before this row completed",
                    })
            _update_cf2_snapshot(user_id, progress=progress)
        _update_cf2_snapshot(
            user_id,
            running=False,
            done=True,
            stopped=stopped,
            failed=failed,
            message="Automation stopped." if stopped else "Automation finished with errors." if failed else "Automation complete.",
        )
        _record_automation_run(user_id, "CF2", run_started_at, _automation_outcome(results, stopped, failed), len(results))
        _cf2_runs.pop(user_id, None)
        emit_to_current_room("cf2_done", {"results": results, "stopped": stopped})
        _emit_room.reset(room_token)


@app.route("/api/cf2/start", methods=["POST"])
@limiter.limit("5 per minute")
@login_required
@serialize_job_start
def cf2_start():
    user, beacon_settings, error_response = require_beacon_connection()
    if error_response:
        return error_response
    state = _cf2_states.get(user.id)
    if not state or not state["patient_records"]:
        return jsonify({"error": "No patients loaded."}), 400
    if user.id in _cf2_runs:
        return jsonify({"error": "Automation already running."}), 409

    settings = request.get_json(silent=True) or {}
    state["account_receivable_name"] = str(settings.get("account_receivable_name") or "").strip()
    state["account_receivable_designation"] = str(settings.get("account_receivable_designation") or "").strip()
    state["account_receivable_number"] = str(settings.get("account_receivable_number") or "").strip()

    existing_row = db.session.get(Cf2TaskSnapshot, user.id)
    snapshot = dict(existing_row.snapshot) if existing_row and existing_row.snapshot else {}
    snapshot.update({
        "run_id": uuid.uuid4().hex,
        "server_instance": _server_instance_id,
        "mode": state["cf2_mode"],
        "records": snapshot.get("records") or [
            _cf2_resume_record(record, state["cf2_mode"])
            for record in state["patient_records"]
        ],
        "progress": {},
        "running": True,
        "done": False,
        "failed": False,
        "stopped": False,
        "current": 0,
        "total": len(state["patient_records"]),
        "message": "Starting automation.",
        "updated_at": utc_now().isoformat(),
    })
    _write_cf2_snapshot(user.id, snapshot)

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
def _write_soa_snapshot(user_id, snapshot):
    with _soa_snapshot_lock:
        with app.app_context():
            try:
                row = db.session.get(SoaTaskSnapshot, user_id)
                if row is None:
                    row = SoaTaskSnapshot(user_id=user_id, snapshot=dict(snapshot))
                    db.session.add(row)
                else:
                    row.snapshot = dict(snapshot)
                db.session.commit()
            except Exception:
                db.session.rollback()
                logger.exception("Could not persist SOA status for user %s", user_id)


def _update_soa_snapshot(user_id, **updates):
    with _soa_snapshot_lock:
        with app.app_context():
            try:
                row = db.session.get(SoaTaskSnapshot, user_id)
                if row is None:
                    return None
                snapshot = dict(row.snapshot or {})
                progress_item = updates.pop("progress_item", None)
                if progress_item:
                    progress = dict(snapshot.get("progress") or {})
                    progress[str(progress_item.get("current"))] = dict(progress_item)
                    snapshot["progress"] = progress
                snapshot.update(updates)
                snapshot["updated_at"] = utc_now().isoformat()
                row.snapshot = snapshot
                db.session.commit()
                return dict(snapshot)
            except Exception:
                db.session.rollback()
                logger.exception("Could not update SOA status for user %s", user_id)
                return None


def _run_soa_automation(user_id, beacon_settings, soa_folder, transmittals, stop_event, run_id):
    run_started_at = utc_now()
    soa_automation = None
    stopped = False
    failed = False
    room_token = _emit_room.set(user_room(user_id))
    emit_to_current_room("soa_progress", {"status": "running"})
    try:
        auth_key = browser_session.auth_context_key(
            beacon_settings,
            user_key=f"user:{user_id}",
        )
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            soa_automation = SOAAutomation(soa_folder=soa_folder)
            def publish_progress(current, total, transmittal, status):
                progress = {
                    "current": current,
                    "total": total,
                    "transmittal": transmittal,
                    "status": status,
                }
                _update_soa_snapshot(user_id, progress_item=progress, current=current, total=total)
                emit_to_current_room("soa_progress", {"run_id": run_id, "running": True, **progress})

            soa_automation.run(
                transmittals,
                should_stop=stop_event.is_set,
                progress_callback=publish_progress,
            )
            stopped = stop_event.is_set()
    except Exception as ex:
        failed = True
        emit_to_current_room("log", {"message": f"FATAL ERROR: {ex}", "level": "ERROR"})
    finally:
        results = soa_automation.get_results() if soa_automation is not None else []
        _update_soa_snapshot(
            user_id,
            running=False,
            done=True,
            stopped=stopped,
            failed=failed,
            message="SOA upload stopped." if stopped else "SOA upload finished with errors." if failed else "SOA upload complete.",
        )
        _record_automation_run(user_id, "SOA Upload", run_started_at, _automation_outcome(results, stopped, failed), len(results))
        shutil.rmtree(soa_folder, ignore_errors=True)
        _soa_runs.pop(user_id, None)
        emit_to_current_room("soa_done", {"results": results, "stopped": stopped})
        _emit_room.reset(room_token)


def _write_document_snapshot(user_id, snapshot):
    with _document_snapshot_lock:
        with app.app_context():
            try:
                row = db.session.get(DocumentTaskSnapshot, user_id)
                if row is None:
                    row = DocumentTaskSnapshot(user_id=user_id, snapshot=dict(snapshot))
                    db.session.add(row)
                else:
                    row.snapshot = dict(snapshot)
                db.session.commit()
            except Exception:
                db.session.rollback()
                logger.exception("Could not persist document upload status for user %s", user_id)


def _update_document_snapshot(user_id, **updates):
    with _document_snapshot_lock:
        with app.app_context():
            try:
                row = db.session.get(DocumentTaskSnapshot, user_id)
                if row is None:
                    return None
                snapshot = dict(row.snapshot or {})
                progress_item = updates.pop("progress_item", None)
                if progress_item:
                    progress = dict(snapshot.get("progress") or {})
                    progress[str(progress_item.get("current"))] = dict(progress_item)
                    snapshot["progress"] = progress
                snapshot.update(updates)
                snapshot["updated_at"] = utc_now().isoformat()
                row.snapshot = snapshot
                db.session.commit()
                return dict(snapshot)
            except Exception:
                db.session.rollback()
                logger.exception("Could not update document upload status for user %s", user_id)
                return None


def _run_document_automation(user_id, beacon_settings, files_root, relative_paths, transmittals, stop_event, run_id):
    run_started_at = utc_now()
    room_token = _emit_room.set(user_room(user_id))
    socketio.emit("documents_progress", {"status": "running"}, room=user_room(user_id))
    results = []
    failed = False
    try:
        auth_key = browser_session.auth_context_key(beacon_settings, user_key=f"user:{user_id}")
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            facility_ids = soa_api.get_client_ids()
            for current, number in enumerate(transmittals, start=1):
                if stop_event.is_set():
                    break
                progress = {"current": current, "total": len(transmittals), "transmittal": number, "status": "running"}
                _update_document_snapshot(user_id, progress_item=progress, current=current, total=len(transmittals))
                socketio.emit("documents_progress", {"run_id": run_id, "running": True, **progress}, room=user_room(user_id))
                try:
                    transmittal = None
                    for facility_id in facility_ids:
                        transmittal = soa_api.get_transmittal(number, client_id=facility_id)
                        if transmittal:
                            break
                    if not transmittal:
                        raise ValueError("Transmittal not found.")
                    claims = soa_api.get_claims(int(transmittal["id"])) or []
                    if isinstance(claims, dict):
                        claims = claims.get("phicClaims") or claims.get("claims") or claims.get("claimList") or []
                    if not claims:
                        raise ValueError("No claim found in transmittal.")
                    claim_id = int(claims[0]["id"])
                    patient = soa_api.get_cf1(claim_id) or {}
                    patient_name = str(patient.get("patientFullname") or "").strip()
                    surname, given = _split_surname_and_given(patient_name)
                    if not surname or not given:
                        raise ValueError("Patient surname and first name are required to match duplicate surnames.")
                    surname_tokens = [_normalize(token) for token in surname if _normalize(token)]
                    first_key = _normalize(given[0])
                    cf2_record = cf2_api.get_cf2(claim_id) or {}
                    raw_treatment_dates = []
                    procedures = beacon_api.get_surgical_procedures(claim_id) or []
                    for procedure in procedures:
                        raw_treatment_dates.extend(
                            session.get("sessionDate")
                            for session in procedure.get("sessions") or []
                            if session.get("sessionDate")
                        )
                    if not raw_treatment_dates:
                        raw_treatment_dates.extend([
                            cf2_record.get("admissionDateTime") or cf2_record.get("admissionDate"),
                            cf2_record.get("dischargeDateTime") or cf2_record.get("dischargeDate"),
                        ])
                    treatment_dates = set()
                    for raw_date in raw_treatment_dates:
                        if not raw_date:
                            continue
                        date_text = str(raw_date).strip()
                        parsed_date = None
                        try:
                            parsed_datetime = datetime.fromisoformat(date_text.replace("Z", "+00:00"))
                            if parsed_datetime.tzinfo is not None:
                                parsed_datetime = parsed_datetime.astimezone(timezone(timedelta(hours=8)))
                            parsed_date = parsed_datetime.date()
                        except ValueError:
                            for date_format in ("%m-%d-%Y", "%m/%d/%Y", "%Y-%m-%d", "%m-%d-%y", "%m/%d/%y"):
                                try:
                                    parsed_date = datetime.strptime(date_text, date_format).date()
                                    break
                                except ValueError:
                                    continue
                        if parsed_date:
                            treatment_dates.add(parsed_date)
                    surname_matches = {}
                    for relative in relative_paths:
                        parts = Path(relative).parts
                        for part_index, part in enumerate(parts[:-1]):
                            raw_tokens = [_normalize(token) for token in re.split(r"[\W_]+", part) if _normalize(token)]
                            # Folder suffixes often include dates, batch numbers, or
                            # other digits. Ignore those when comparing names.
                            tokens = [token for token in raw_tokens if not any(char.isdigit() for char in token)]
                            if len(tokens) < len(surname_tokens) or tokens[:len(surname_tokens)] != surname_tokens:
                                continue
                            folder = Path(*parts[:part_index + 1]).as_posix()
                            surname_matches.setdefault(folder, {"given_token": "", "dates": set(), "days": set(), "files": set()})
                            surname_matches[folder]["files"].add(relative)
                            month_tokens = {_normalize(month) for month in MONTHS}
                            name_suffix_tokens = [token for token in tokens[len(surname_tokens):] if token not in month_tokens]
                            if not surname_matches[folder]["given_token"] and name_suffix_tokens:
                                surname_matches[folder]["given_token"] = name_suffix_tokens[0]
                            for number in re.findall(r"(?<!\d)(\d{1,2})(?!\d)", part):
                                day_number = int(number)
                                if 1 <= day_number <= 31:
                                    surname_matches[folder]["days"].add(day_number)
                            for first_day, last_day in re.findall(r"(?<!\d)(\d{1,2})\s*-\s*(\d{1,2})(?!\d)", part):
                                first_day, last_day = int(first_day), int(last_day)
                                if 1 <= first_day <= last_day <= 31:
                                    surname_matches[folder]["days"].update(range(first_day, last_day + 1))
                            for month, day, year in re.findall(r"(?<!\d)(\d{1,2})[-_./ ](\d{1,2})[-_./ ](\d{2,4})(?!\d)", part):
                                year_number = int(year)
                                if year_number < 100:
                                    year_number += 2000 if year_number < 70 else 1900
                                try:
                                    surname_matches[folder]["dates"].add(date(year_number, int(month), int(day)))
                                except ValueError:
                                    pass
                            for year, month, day in re.findall(r"(?<!\d)(\d{4})[-_./ ](\d{1,2})[-_./ ](\d{1,2})(?!\d)", part):
                                try:
                                    surname_matches[folder]["dates"].add(date(int(year), int(month), int(day)))
                                except ValueError:
                                    pass
                            for compact_date in re.findall(r"(?<!\d)(\d{8})(?!\d)", part):
                                for date_format in ("%Y%m%d", "%m%d%Y"):
                                    try:
                                        surname_matches[folder]["dates"].add(datetime.strptime(compact_date, date_format).date())
                                    except ValueError:
                                        continue
                            month_date_texts = re.findall(
                                r"(?i)\b(?:JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:T(?:EMBER)?)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\.?\s+\d{1,2}(?:\s*-\s*\d{1,2})?(?:,?\s+\d{4})?",
                                part.replace("_", " "),
                            )
                            default_year = min(treatment_dates).year if treatment_dates else datetime.now().year
                            for month_date_text in month_date_texts:
                                try:
                                    parsed_dates = parse_dates(month_date_text, default_year=default_year)
                                except ValueError:
                                    parsed_dates = []
                                surname_matches[folder]["dates"].update(parsed_dates)
                                day_range = re.search(r"(\d{1,2})\s*-\s*(\d{1,2})", month_date_text)
                                if day_range and parsed_dates:
                                    start_day, end_day = map(int, day_range.groups())
                                    month_date = parsed_dates[0]
                                    if start_day <= end_day:
                                        for day_number in range(start_day, end_day + 1):
                                            try:
                                                surname_matches[folder]["dates"].add(
                                                    date(month_date.year, month_date.month, day_number)
                                                )
                                            except ValueError:
                                                continue
                    if len(surname_matches) > 1:
                        date_matches = {
                            folder: match for folder, match in surname_matches.items()
                            if match["dates"] & treatment_dates
                        }
                        if date_matches:
                            surname_matches = date_matches
                    if len(surname_matches) > 1:
                        day_matches = {
                            folder: match for folder, match in surname_matches.items()
                            if match["days"] & {treatment_date.day for treatment_date in treatment_dates}
                        }
                        if day_matches:
                            surname_matches = day_matches
                    if len(surname_matches) > 1:
                        full_first_name_matches = {
                            folder: match for folder, match in surname_matches.items()
                            if match["given_token"] == first_key
                        }
                        if full_first_name_matches:
                            surname_matches = full_first_name_matches
                    if len(surname_matches) > 1:
                        surname_matches = {
                            folder: match for folder, match in surname_matches.items()
                            if match["given_token"] and first_key.startswith(match["given_token"])
                        }
                    if len(surname_matches) != 1:
                        raise ValueError("No unique patient folder matched the surname; first name is used only to resolve duplicate surnames.")
                    unique_files = sorted(next(iter(surname_matches.values()))["files"])
                    paths = [Path(files_root) / Path(relative) for relative in unique_files]
                    if sum(path.stat().st_size for path in paths) > 50 * 1024 * 1024:
                        raise ValueError("Matched patient documents exceed Beacon's 50 MB per-upload limit.")
                    details = beacon_api.get_transmittal_by_id(int(transmittal["id"])) or {}
                    documents_api.upload_documents(claim_id, details, paths)
                    result = {"transmittal": number, "status": "success", "message": f"Uploaded {len(paths)} document(s)."}
                    socketio.emit("documents_log", {"message": f"{number}: uploaded {len(paths)} document(s).", "level": "SUCCESS"}, room=user_room(user_id))
                except Exception as exc:
                    result = {"transmittal": number, "status": "failed", "message": str(exc)}
                    socketio.emit("documents_log", {"message": f"{number}: {exc}", "level": "ERROR"}, room=user_room(user_id))
                results.append(result)
                progress["status"] = result["status"]
                _update_document_snapshot(user_id, progress_item=progress)
                socketio.emit("documents_progress", {"run_id": run_id, "running": True, **progress}, room=user_room(user_id))
    except Exception as exc:
        failed = True
        socketio.emit("documents_log", {"message": f"FATAL ERROR: {exc}", "level": "ERROR"}, room=user_room(user_id))
    finally:
        if failed or stop_event.is_set():
            with app.app_context():
                row = db.session.get(DocumentTaskSnapshot, user_id)
                progress_rows = dict((row.snapshot or {}).get("progress") or {}) if row else {}
            for item in progress_rows.values():
                if item.get("status") == "running":
                    item["status"] = "failed" if failed else "skipped"
            _update_document_snapshot(user_id, progress=progress_rows)
        _update_document_snapshot(
            user_id,
            running=False,
            done=True,
            stopped=stop_event.is_set(),
            failed=failed,
            results=[{"transmittal": item.get("transmittal"), "status": item.get("status")} for item in results],
            message="Document upload stopped." if stop_event.is_set() else "Document upload finished with errors." if failed else "Document upload complete.",
        )
        _record_automation_run(user_id, "Document Upload", run_started_at, _automation_outcome(results, stop_event.is_set(), failed), len(results))
        shutil.rmtree(files_root, ignore_errors=True)
        _document_runs.pop(user_id, None)
        socketio.emit("documents_done", {"results": results, "stopped": stop_event.is_set()}, room=user_room(user_id))
        _emit_room.reset(room_token)


@app.route("/api/documents/start", methods=["POST"])
@limiter.limit("5 per minute")
@login_required
@serialize_job_start
def documents_start():
    user, beacon_settings, error_response = require_beacon_connection()
    if error_response:
        return error_response
    transmittals = list(dict.fromkeys(line.strip() for line in request.form.get("transmittals", "").splitlines() if line.strip()))
    uploads = request.files.getlist("documents")
    try:
        relative_paths = json.loads(request.form.get("relative_paths", "[]"))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid folder paths."}), 400
    if not transmittals:
        return jsonify({"error": "Please enter at least one transmittal number."}), 400
    if not uploads or len(uploads) != len(relative_paths):
        return jsonify({"error": "Select a patient folder containing documents."}), 400
    for upload in uploads:
        if upload and upload.filename:
            upload.stream.seek(0, os.SEEK_END)
            size = upload.stream.tell()
            upload.stream.seek(0)
            if size > 2 * 1024 * 1024:
                return jsonify({"error": "Beacon allows a maximum of 2 MB per document."}), 413
    if user.id in _document_runs:
        return jsonify({"error": "Document upload is already running."}), 409
    allowed = {".pdf", ".jpg", ".jpeg", ".png", ".tif", ".tiff"}
    root = UPLOAD_DIR / uuid.uuid4().hex
    root.mkdir(parents=True, exist_ok=True)
    kept_paths = []
    for upload, relative in zip(uploads, relative_paths):
        if not upload or not upload.filename or Path(upload.filename).suffix.lower() not in allowed:
            continue
        rel = Path(str(relative).replace("\\", "/"))
        if rel.is_absolute() or ".." in rel.parts or not rel.parts:
            continue
        safe_parts = [secure_filename(part) for part in rel.parts]
        if any(not part for part in safe_parts):
            continue
        target = root.joinpath(*safe_parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        upload.save(target)
        kept_paths.append(Path(*safe_parts).as_posix())
    if not kept_paths:
        shutil.rmtree(root, ignore_errors=True)
        return jsonify({"error": "No supported documents found. Use PDF or image files."}), 400
    run_id = uuid.uuid4().hex
    _write_document_snapshot(user.id, {
        "run_id": run_id,
        "server_instance": _server_instance_id,
        "transmittals": transmittals,
        "progress": {},
        "current": 0,
        "total": len(transmittals),
        "running": True,
        "done": False,
        "failed": False,
        "stopped": False,
        "message": "Starting document upload.",
        "updated_at": utc_now().isoformat(),
    })
    stop_event = threading.Event()
    _document_runs[user.id] = {"stop_event": stop_event}
    threading.Thread(target=_run_document_automation, args=(user.id, beacon_settings, str(root), kept_paths, transmittals, stop_event, run_id), daemon=True).start()
    return jsonify({"started": True})


@app.route("/api/documents/status", methods=["GET", "DELETE"])
@login_required
def documents_status():
    user = current_user()
    if request.method == "DELETE":
        row = db.session.get(DocumentTaskSnapshot, user.id)
        if row:
            db.session.delete(row)
            db.session.commit()
        return jsonify({"cleared": True})
    row = db.session.get(DocumentTaskSnapshot, user.id)
    snapshot = dict(row.snapshot) if row and row.snapshot else None
    if snapshot and snapshot.get("running") and snapshot.get("server_instance") != _server_instance_id:
        progress = dict(snapshot.get("progress") or {})
        for item in progress.values():
            if item.get("status") == "running":
                item["status"] = "failed"
        snapshot.update({
            "running": False,
            "done": True,
            "failed": True,
            "message": "The server restarted while this upload was active. Saved results are shown.",
            "progress": progress,
            "server_instance": _server_instance_id,
            "updated_at": utc_now().isoformat(),
        })
        _write_document_snapshot(user.id, snapshot)
    return jsonify({"run": snapshot})


@app.route("/api/documents/stop", methods=["POST"])
@login_required
def documents_stop():
    run = _document_runs.get(current_user().id)
    if not run:
        return jsonify({"stopped": False, "running": False})
    run["stop_event"].set()
    return jsonify({"stopped": True, "running": True})


@app.route("/api/soa/start", methods=["POST"])
@limiter.limit("5 per minute")
@login_required
@serialize_job_start
def soa_start():
    user, beacon_settings, error_response = require_beacon_connection()
    if error_response:
        return error_response
    if not request.content_type or not request.content_type.startswith("multipart/form-data"):
        return jsonify({"error": "Upload the SOA Excel files from your browser."}), 400
    data = request.form
    transmittals = [line.strip() for line in data.get("transmittals", "").splitlines() if line.strip()]
    soa_folder_path, soa_files = _prepare_upload_folder(
        request.files.getlist("soa_files"),
        {".xlsx", ".xls"},
    )
    soa_folder = str(soa_folder_path)
    if not soa_files:
        shutil.rmtree(soa_folder_path, ignore_errors=True)
        return jsonify({"error": "Please upload at least one SOA Excel file."}), 400

    if not transmittals:
        shutil.rmtree(soa_folder_path, ignore_errors=True)
        return jsonify({"error": "Please enter at least one transmittal number."}), 400
    if user.id in _soa_runs:
        shutil.rmtree(soa_folder_path, ignore_errors=True)
        return jsonify({"error": "Automation already running."}), 409

    run_id = uuid.uuid4().hex
    _write_soa_snapshot(user.id, {
        "run_id": run_id,
        "server_instance": _server_instance_id,
        "transmittals": transmittals,
        "progress": {},
        "current": 0,
        "total": len(transmittals),
        "running": True,
        "done": False,
        "failed": False,
        "stopped": False,
        "message": "Starting SOA upload.",
        "updated_at": utc_now().isoformat(),
    })
    stop_event = threading.Event()
    _soa_runs[user.id] = {"stop_event": stop_event}
    threading.Thread(
        target=_run_soa_automation,
        args=(user.id, beacon_settings, soa_folder, transmittals, stop_event, run_id),
        daemon=True,
    ).start()
    return jsonify({"started": True})


@app.route("/api/soa/status", methods=["GET"])
@login_required
def soa_status():
    user = current_user()
    row = db.session.get(SoaTaskSnapshot, user.id)
    snapshot = dict(row.snapshot) if row and row.snapshot else None
    if snapshot and snapshot.get("running") and snapshot.get("server_instance") != _server_instance_id:
        progress = dict(snapshot.get("progress") or {})
        for item in progress.values():
            if item.get("status") == "running":
                item.update({"status": "failed"})
        snapshot.update({
            "running": False,
            "done": True,
            "failed": True,
            "message": "The server restarted while this upload was active. Saved results are shown.",
            "progress": progress,
            "server_instance": _server_instance_id,
            "updated_at": utc_now().isoformat(),
        })
        _write_soa_snapshot(user.id, snapshot)
    return jsonify({"run": snapshot})


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
# CF4 Transmittal Automation, an API-only run over a supplied list of
# transmittals. The route keeps its legacy /api/beacon URL for compatibility.
# ---------------------------------------------------------------------------
def _write_cf4_transmittal_snapshot(user_id, snapshot):
    with _cf4_transmittal_snapshot_lock:
        with app.app_context():
            try:
                row = db.session.get(Cf4TransmittalTaskSnapshot, user_id)
                if row is None:
                    row = Cf4TransmittalTaskSnapshot(user_id=user_id, snapshot=dict(snapshot))
                    db.session.add(row)
                else:
                    row.snapshot = dict(snapshot)
                db.session.commit()
            except Exception:
                db.session.rollback()
                logger.exception("Could not persist CF4 transmittal status for user %s", user_id)


def _update_cf4_transmittal_snapshot(user_id, **updates):
    with _cf4_transmittal_snapshot_lock:
        with app.app_context():
            try:
                row = db.session.get(Cf4TransmittalTaskSnapshot, user_id)
                if row is None:
                    return None
                snapshot = dict(row.snapshot or {})
                progress_item = updates.pop("progress_item", None)
                if progress_item:
                    progress = dict(snapshot.get("progress") or {})
                    progress[str(progress_item.get("current"))] = dict(progress_item)
                    snapshot["progress"] = progress
                snapshot.update(updates)
                snapshot["updated_at"] = utc_now().isoformat()
                row.snapshot = snapshot
                db.session.commit()
                return dict(snapshot)
            except Exception:
                db.session.rollback()
                logger.exception("Could not update CF4 transmittal status for user %s", user_id)
                return None


def _run_cf4_transmittal_automation(user_id, beacon_settings, transmittals, auto_encode_cf4, cf4_settings, stop_event, run_id):
    run_started_at = utc_now()
    stopped = False
    failed = False
    results = []
    room_token = _emit_room.set(user_room(user_id))
    emit_to_current_room("beacon_progress", {"status": "running"})
    try:
        auth_key = browser_session.auth_context_key(
            beacon_settings,
            user_key=f"user:{user_id}",
        )
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            def publish_progress(current, total, transmittal, status):
                progress = {
                    "current": current,
                    "total": total,
                    "transmittal": transmittal,
                    "status": str(status).lower(),
                }
                _update_cf4_transmittal_snapshot(user_id, progress_item=progress, current=current, total=total)
                emit_to_current_room("beacon_progress", {"run_id": run_id, "running": True, **progress})

            results = beacon_run(
                transmittals,
                auto_encode_cf4=auto_encode_cf4,
                cf4_data=cf4_settings,
                should_stop=stop_event.is_set,
                progress_callback=publish_progress,
            )
            stopped = stop_event.is_set()
    except Exception as ex:
        failed = True
        emit_to_current_room("log", {"message": f"ERROR: {ex}", "level": "ERROR"})
    finally:
        if stopped or failed:
            with app.app_context():
                row = db.session.get(Cf4TransmittalTaskSnapshot, user_id)
                progress = dict((row.snapshot or {}).get("progress") or {}) if row else {}
            for item in progress.values():
                if item.get("status") == "running":
                    item["status"] = "failed" if failed else "skipped"
            _update_cf4_transmittal_snapshot(user_id, progress=progress)
        _update_cf4_transmittal_snapshot(
            user_id,
            running=False,
            done=True,
            stopped=stopped,
            failed=failed,
            results=[
                {"transmittal": item.get("transmittal"), "status": str(item.get("status", "FAILED")).lower()}
                for item in results
            ],
            message="CF4 transmittal automation stopped." if stopped else "CF4 transmittal automation finished with errors." if failed else "CF4 transmittal automation complete.",
        )
        _record_automation_run(user_id, "CF4 Transmittal Automation", run_started_at, _automation_outcome(results, stopped, failed), len(results))
        _cf4_transmittal_runs.pop(user_id, None)
        emit_to_current_room("beacon_done", {"results": results, "stopped": stopped})
        _emit_room.reset(room_token)


@app.route("/api/cf4-transmittal/start", methods=["POST"])
@app.route("/api/beacon/start", methods=["POST"])
@limiter.limit("5 per minute")
@login_required
@serialize_job_start
def cf4_transmittal_start():
    user, beacon_settings, error_response = require_beacon_connection()
    if error_response:
        return error_response
    data = request.get_json(force=True)
    transmittals = data.get("transmittals", [])
    auto_encode_cf4 = bool(data.get("auto_encode_cf4", False))

    if not transmittals:
        return jsonify({"error": "Please paste at least one transmittal number."}), 400
    if user.id in _cf4_transmittal_runs:
        return jsonify({"error": "Automation already running."}), 409

    # Read whatever was last saved on the CF4 screen (falls back to
    # DEFAULT_CF4_SETTINGS for anything never saved) — this is what makes
    # the Auto Encode CF4 option use the *current* CF4 defaults rather
    # than whatever was hardcoded in beacon.py at build time.
    user_settings = get_or_create_user_settings(user)
    cf4_settings = {**DEFAULT_CF4_SETTINGS, **(user_settings.cf4_settings or {})}

    run_id = uuid.uuid4().hex
    _write_cf4_transmittal_snapshot(user.id, {
        "run_id": run_id,
        "server_instance": _server_instance_id,
        "transmittals": [str(value).strip() for value in transmittals],
        "auto_encode_cf4": auto_encode_cf4,
        "progress": {},
        "results": [],
        "current": 0,
        "total": len(transmittals),
        "running": True,
        "done": False,
        "failed": False,
        "stopped": False,
        "message": "Starting CF4 automation.",
        "updated_at": utc_now().isoformat(),
    })

    stop_event = threading.Event()
    _cf4_transmittal_runs[user.id] = {"stop_event": stop_event}
    threading.Thread(
        target=_run_cf4_transmittal_automation,
        args=(user.id, beacon_settings, transmittals, auto_encode_cf4, cf4_settings, stop_event, run_id),
        daemon=True,
    ).start()
    return jsonify({"started": True})


@app.route("/api/cf4-transmittal/status", methods=["GET"])
@app.route("/api/beacon/status", methods=["GET"])
@login_required
def cf4_transmittal_status():
    user = current_user()
    row = db.session.get(Cf4TransmittalTaskSnapshot, user.id)
    snapshot = dict(row.snapshot) if row and row.snapshot else None
    if snapshot and snapshot.get("running") and snapshot.get("server_instance") != _server_instance_id:
        progress = dict(snapshot.get("progress") or {})
        for item in progress.values():
            if item.get("status") == "running":
                item["status"] = "failed"
        snapshot.update({
            "running": False,
            "done": True,
            "failed": True,
            "message": "The server restarted while this automation was active. Saved results are shown.",
            "progress": progress,
            "server_instance": _server_instance_id,
            "updated_at": utc_now().isoformat(),
        })
        _write_cf4_transmittal_snapshot(user.id, snapshot)
    return jsonify({"run": snapshot})


@app.route("/api/cf4-transmittal/stop", methods=["POST"])
@app.route("/api/beacon/stop", methods=["POST"])
@login_required
def cf4_transmittal_stop():
    user = current_user()
    run = _cf4_transmittal_runs.get(user.id)
    if not run:
        return jsonify({"stopped": False, "running": False})
    run["stop_event"].set()
    socketio.emit("log", {
        "message": "Stop requested. CF4 automation will end after the current safe step.",
        "level": "WARNING",
    }, room=user_room(user.id))
    return jsonify({"stopped": True, "running": True})


# ---------------------------------------------------------------------------
# Combined CF2 -> SOA -> CF4 workflow. This is an additive entry point; the
# existing single-purpose automation pages and endpoints remain independent.
# ---------------------------------------------------------------------------
def _expire_run_all_retry_state(user_id, run_id):
    state = _run_all_retry_states.get(user_id)
    if state and state.get("run_id") == run_id:
        _run_all_retry_states.pop(user_id, None)
        shutil.rmtree(state["soa_folder"], ignore_errors=True)


def _copy_run_all_status(state):
    snapshot = dict(state)
    snapshot["results"] = [dict(result) for result in state.get("results", [])]
    return snapshot


def _persist_run_all_status(user_id, state):
    """Keep one latest snapshot per user so Run All can restore after reconnects."""
    with app.app_context():
        try:
            row = db.session.get(RunAllTaskSnapshot, user_id)
            if row is None:
                row = RunAllTaskSnapshot(user_id=user_id, snapshot=_copy_run_all_status(state))
                db.session.add(row)
            else:
                row.snapshot = _copy_run_all_status(state)
            db.session.commit()
        except Exception:
            db.session.rollback()
            logger.exception("Could not persist Run All status for user %s", user_id)


def _start_run_all_status(user_id, run_id, total, results=None, stage="starting", message=""):
    with _run_all_status_lock:
        previous = _run_all_status.get(user_id)
        sequence = (previous.get("sequence", 0) if previous else 0) + 1
        state = {
            "run_id": run_id,
            "running": True,
            "done": False,
            "index": 0,
            "total": total,
            "stage": stage,
            "message": message,
            "results": [dict(result) for result in (results or [])],
            "retry_run_id": None,
            "stopped": False,
            "failed": False,
            "sequence": sequence,
            "updated_at": utc_now().isoformat(),
            "server_instance": _server_instance_id,
        }
        _run_all_status[user_id] = state
        _persist_run_all_status(user_id, state)
        return _copy_run_all_status(state)


def _update_run_all_status(user_id, run_id, **updates):
    with _run_all_status_lock:
        state = _run_all_status.get(user_id)
        if not state or state["run_id"] != run_id:
            return None
        if "results" in updates:
            updates["results"] = [dict(result) for result in updates["results"]]
        state.update(updates)
        state["sequence"] += 1
        state["updated_at"] = utc_now().isoformat()
        state["server_instance"] = _server_instance_id
        _persist_run_all_status(user_id, state)
        return _copy_run_all_status(state)


def _expire_run_all_status(user_id, run_id):
    with _run_all_status_lock:
        state = _run_all_status.get(user_id)
        if state and state["run_id"] == run_id and not state["running"]:
            _run_all_status.pop(user_id, None)


def _schedule_run_all_status_expiry(user_id, run_id):
    expiry_timer = threading.Timer(3600, _expire_run_all_status, args=(user_id, run_id))
    expiry_timer.daemon = True
    expiry_timer.start()


def _run_all_generate_esoa(transmittal_number):
    facility_id = beacon_api.get_client_id()
    transmittal = beacon_api.get_transmittal(transmittal_number, client_id=facility_id)
    if not transmittal:
        raise ValueError("Beacon could not find the new draft transmittal for eSOA generation.")
    claims = beacon_api.get_claims(int(transmittal["id"])) or []
    if isinstance(claims, dict):
        claims = claims.get("phicClaims") or claims.get("claims") or claims.get("claimList") or []
    if not claims:
        raise ValueError("Beacon returned no claim for eSOA generation.")
    claim_id = int(claims[0]["id"])
    _require_draft_claim(int(transmittal["id"]), claim_id)
    soa_api.validate_and_generate_esoa(claim_id, facility_id)


def _run_all_automation(user_id, beacon_settings, records, soa_folder, cf2_settings, cf4_settings, generate_soa, stop_event, run_id):
    run_started_at = utc_now()
    room_token = _emit_room.set(user_room(user_id))
    results = []
    stopped = False
    failed = False
    auth_key = browser_session.auth_context_key(beacon_settings, user_key=f"user:{user_id}")
    try:
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            cf2 = CF2Automation(
                mode="new_draft",
                account_receivable_name=cf2_settings["account_receivable_name"],
                account_receivable_designation=cf2_settings["account_receivable_designation"],
                account_receivable_number=cf2_settings["account_receivable_number"],
            )
            try:
                for index, record in enumerate(records, start=1):
                    if stop_event.is_set():
                        stopped = True
                        break

                    item = {
                        "patient_name": record.patient_name,
                        "member_pin": record.member_pin,
                        "transmittal": "",
                        "cf2": "waiting",
                        "soa": "waiting",
                        "esoa": "waiting" if generate_soa else "skipped",
                        "cf4": "waiting",
                        "message": "",
                    }
                    results.append(item)

                    def publish(stage, status, message=""):
                        item[stage] = status
                        if message:
                            item["message"] = message
                        status_snapshot = _update_run_all_status(
                            user_id,
                            run_id,
                            index=index,
                            total=len(records),
                            stage=stage,
                            message=item.get("message", ""),
                            results=results,
                        )
                        emit_to_current_room("run_all_progress", {
                            "run_id": run_id,
                            "sequence": status_snapshot["sequence"] if status_snapshot else None,
                            "updated_at": status_snapshot["updated_at"] if status_snapshot else None,
                            "running": True,
                            "index": index,
                            "total": len(records),
                            "result": dict(item),
                            "stage": stage,
                        })

                    publish("cf2", "running", "Creating and encoding CF2 draft")
                    cf2_result = cf2.process_patient(record, current=index, total=len(records))
                    item["transmittal"] = str(cf2_result.get("transmittal") or "").strip()
                    if cf2_result.get("status") != "success" or not item["transmittal"]:
                        publish("cf2", cf2_result.get("status", "failed"), cf2_result.get("message", "CF2 did not return a transmittal."))
                        item["soa"] = item["cf4"] = "blocked"
                        if generate_soa:
                            item["esoa"] = "blocked"
                        continue
                    publish("cf2", "success", cf2_result.get("message", "CF2 draft completed."))

                    if stop_event.is_set():
                        stopped = True
                        item["soa"] = item["cf4"] = "blocked"
                        if generate_soa:
                            item["esoa"] = "blocked"
                        break
                    publish("soa", "running", "Uploading matched SOA")
                    soa = SOAAutomation(soa_folder=str(soa_folder))
                    try:
                        soa.run([item["transmittal"]], should_stop=stop_event.is_set)
                        soa_result = next(iter(soa.get_results()), None)
                    finally:
                        soa.close()
                    if not soa_result or soa_result.get("status") != "success":
                        message = (soa_result or {}).get("message", "SOA upload did not complete.")
                        publish("soa", (soa_result or {}).get("status", "failed"), message)
                        if generate_soa:
                            item["esoa"] = "blocked"
                        item["cf4"] = "blocked"
                        continue
                    publish("soa", "success", soa_result.get("message", "SOA uploaded."))

                    if stop_event.is_set():
                        stopped = True
                        if generate_soa:
                            item["esoa"] = "blocked"
                        item["cf4"] = "blocked"
                        break
                    if generate_soa:
                        publish("esoa", "running", "Validating, generating, and uploading eSOA in Beacon")
                        try:
                            _run_all_generate_esoa(item["transmittal"])
                        except Exception as ex:
                            publish("esoa", "failed", str(ex))
                            item["cf4"] = "blocked"
                            continue
                        publish("esoa", "success", "eSOA generated and uploaded to Beacon.")

                    if stop_event.is_set():
                        stopped = True
                        item["cf4"] = "blocked"
                        break
                    publish("cf4", "running", "Generating CF4")
                    cf4_results = beacon_run(
                        [item["transmittal"]],
                        auto_encode_cf4=True,
                        cf4_data=cf4_settings,
                        should_stop=stop_event.is_set,
                    )
                    cf4_result = next(iter(cf4_results), None)
                    if cf4_result and cf4_result.get("status") == "SUCCESS":
                        summary = "CF2 draft created and encoded, matched SOA uploaded, and CF4 data encoded in Beacon."
                        if generate_soa:
                            summary = "CF2 draft created and encoded, matched SOA uploaded, eSOA validated and uploaded in Beacon, and CF4 data encoded."
                        publish("cf4", "success", summary)
                    else:
                        message = (cf4_result or {}).get("remarks", "CF4 generation did not complete.")
                        publish("cf4", "failed", message)

                    if stop_event.is_set():
                        stopped = True
                        break
            finally:
                cf2.close()
    except Exception as ex:
        failed = True
        logger.exception(f"Run All automation failed: {ex}")
        if results:
            last = results[-1]
            for stage in ("cf2", "soa", "esoa", "cf4"):
                if last.get(stage) == "running":
                    last[stage] = "failed"
                    last["message"] = str(ex)
                    break
    finally:
        retryable = any(
            item.get("cf2") == "success"
            and (item.get("soa") in ("failed", "blocked") or item.get("esoa") in ("failed", "blocked") or item.get("cf4") in ("failed", "blocked"))
            for item in results
        )
        retry_run_id = None
        if retryable:
            retry_run_id = run_id
            _run_all_retry_states[user_id] = {
                "run_id": run_id,
                "beacon_settings": beacon_settings,
                "cf4_settings": cf4_settings,
                "generate_soa": generate_soa,
                "soa_folder": soa_folder,
                "results": results,
            }
            expiry_timer = threading.Timer(3600, _expire_run_all_retry_state, args=(user_id, run_id))
            expiry_timer.daemon = True
            expiry_timer.start()
        else:
            shutil.rmtree(soa_folder, ignore_errors=True)
        _run_all_runs.pop(user_id, None)
        final_status = _update_run_all_status(
            user_id,
            run_id,
            running=False,
            done=True,
            index=len(results),
            total=len(records),
            stage="complete",
            message=(
                "Run stopped safely."
                if stopped else "Run failed."
                if failed else "Run complete."
            ),
            results=results,
            stopped=stopped,
            failed=failed,
            retry_run_id=retry_run_id,
        )
        _record_automation_run(user_id, "Full Workflow", run_started_at, _automation_outcome(results, stopped, failed), len(results))
        emit_to_current_room("run_all_done", {
            "run_id": run_id,
            "sequence": final_status["sequence"] if final_status else None,
            "updated_at": final_status["updated_at"] if final_status else None,
            "running": False,
            "done": True,
            "index": len(results),
            "total": len(records),
            "stage": "complete",
            "message": final_status["message"] if final_status else "",
            "results": results,
            "stopped": stopped,
            "failed": failed,
            "retry_run_id": retry_run_id,
        })
        _schedule_run_all_status_expiry(user_id, run_id)
        _emit_room.reset(room_token)


def _run_all_retry_automation(user_id, retry_state, item, start_at, stop_event):
    run_started_at = utc_now()
    room_token = _emit_room.set(user_room(user_id))
    run_id = retry_state["run_id"]
    transmittal = item["transmittal"]
    beacon_settings = retry_state["beacon_settings"]
    cf4_settings = retry_state["cf4_settings"]

    def publish(stage, status, message=""):
        item[stage] = status
        if message:
            item["message"] = message
        status_snapshot = _update_run_all_status(
            user_id,
            run_id,
            index=retry_state["results"].index(item) + 1,
            total=len(retry_state["results"]),
            stage=stage,
            message=item.get("message", ""),
            results=retry_state["results"],
        )
        emit_to_current_room("run_all_progress", {
            "run_id": run_id,
            "sequence": status_snapshot["sequence"] if status_snapshot else None,
            "updated_at": status_snapshot["updated_at"] if status_snapshot else None,
            "running": True,
            "index": retry_state["results"].index(item) + 1,
            "total": len(retry_state["results"]),
            "result": dict(item),
            "stage": stage,
        })

    try:
        auth_key = browser_session.auth_context_key(beacon_settings, user_key=f"user:{user_id}")
        with browser_session.use_auth_context(beacon_settings, key=auth_key):
            browser_session.invalidate_auth_token()
            if start_at == "soa":
                publish("soa", "running", "Retrying SOA upload for the existing CF2 draft")
                soa = SOAAutomation(soa_folder=str(retry_state["soa_folder"]))
                try:
                    soa.run([transmittal], should_stop=stop_event.is_set)
                    soa_result = next(iter(soa.get_results()), None)
                finally:
                    soa.close()
                if not soa_result or soa_result.get("status") != "success":
                    publish("soa", (soa_result or {}).get("status", "failed"), (soa_result or {}).get("message", "SOA upload did not complete."))
                else:
                    publish("soa", "success", soa_result.get("message", "SOA uploaded."))

            if start_at == "soa" and item.get("soa") == "success" and retry_state.get("generate_soa"):
                start_at = "esoa"

            if start_at == "esoa" and not stop_event.is_set():
                publish("esoa", "running", "Retrying eSOA validation and upload in Beacon")
                try:
                    _run_all_generate_esoa(transmittal)
                    publish("esoa", "success", "eSOA generated and uploaded to Beacon.")
                except Exception as ex:
                    publish("esoa", "failed", str(ex))

            if item.get("soa") == "success" and item.get("esoa") in ("success", "skipped") and not stop_event.is_set():
                publish("cf4", "running", "Generating CF4 for the existing draft")
                cf4_results = beacon_run([transmittal], auto_encode_cf4=True, cf4_data=cf4_settings, should_stop=stop_event.is_set)
                cf4_result = next(iter(cf4_results), None)
                if cf4_result and cf4_result.get("status") == "SUCCESS":
                    summary = "CF2 draft created and encoded, matched SOA uploaded, and CF4 data encoded in Beacon."
                    if retry_state.get("generate_soa"):
                        summary = "CF2 draft created and encoded, matched SOA uploaded, eSOA validated and uploaded in Beacon, and CF4 data encoded."
                    publish("cf4", "success", summary)
                else:
                    publish("cf4", "failed", (cf4_result or {}).get("remarks", "CF4 generation did not complete."))
    except Exception as ex:
        logger.exception(f"Run All retry failed for {transmittal}: {ex}")
        stage = "soa" if start_at == "soa" and item.get("soa") == "running" else "esoa" if start_at == "esoa" and item.get("esoa") == "running" else "cf4"
        publish(stage, "failed", str(ex))
    finally:
        all_done = all(
            result.get("cf2") == "success"
            and result.get("soa") == "success"
            and result.get("esoa") in ("success", "skipped")
            and result.get("cf4") == "success"
            for result in retry_state["results"]
        )
        if all_done:
            _expire_run_all_retry_state(user_id, run_id)
        _run_all_runs.pop(user_id, None)
        final_status = _update_run_all_status(
            user_id,
            run_id,
            running=False,
            done=True,
            index=len(retry_state["results"]),
            total=len(retry_state["results"]),
            stage="complete",
            message="Retry complete." if all_done else "Retry finished; some stages remain incomplete.",
            results=retry_state["results"],
            stopped=stop_event.is_set(),
            failed=not all_done,
            retry_run_id=None if all_done else run_id,
        )
        _record_automation_run(user_id, "Full Workflow Retry", run_started_at, _automation_outcome([item], stop_event.is_set()), 1)
        emit_to_current_room("run_all_done", {
            "run_id": run_id,
            "sequence": final_status["sequence"] if final_status else None,
            "updated_at": final_status["updated_at"] if final_status else None,
            "running": False,
            "done": True,
            "index": len(retry_state["results"]),
            "total": len(retry_state["results"]),
            "stage": "complete",
            "message": final_status["message"] if final_status else "",
            "results": retry_state["results"],
            "stopped": stop_event.is_set(),
            "retry_run_id": None if all_done else run_id,
        })
        _schedule_run_all_status_expiry(user_id, run_id)
        _emit_room.reset(room_token)


@app.route("/api/run-all/start", methods=["POST"])
@limiter.limit("3 per minute")
@login_required
@serialize_job_start
def run_all_start():
    user = current_user()
    if not (user.is_admin or user.role == "subscriber"):
        return jsonify({
            "error": "Run All is available to Subscriber and Admin accounts only. Contact your administrator to request Subscriber access."
        }), 403
    user, beacon_settings, error_response = require_beacon_connection()
    if error_response:
        return error_response
    if not request.content_type or not request.content_type.startswith("multipart/form-data"):
        return jsonify({"error": "Upload the CF2 workbook and SOA files from this page."}), 400

    uploaded = request.files.get("workbook")
    if not uploaded:
        return jsonify({"error": "Select a CF2 Excel workbook."}), 400
    try:
        workbook_path = _save_upload(uploaded, "run_all", {".xlsx", ".xlsm", ".xls"})
    except ValueError as ex:
        return jsonify({"error": str(ex)}), 400

    try:
        claim_year = int(request.form.get("claim_year"))
        claim_month_name = request.form.get("claim_month")
        claim_month = MONTH_NAMES.index(claim_month_name) + 1 if claim_month_name else None
        workbook = load_workbook(workbook_path, data_only=True)
        try:
            records = _analyze_workbook(workbook, claim_year, claim_month, "new_draft")
        finally:
            workbook.close()
    except Exception as ex:
        return jsonify({"error": str(ex)}), 400
    finally:
        workbook_path.unlink(missing_ok=True)

    soa_folder_path, soa_files = _prepare_upload_folder(request.files.getlist("soa_files"), {".xlsx", ".xls"})
    if not soa_files:
        shutil.rmtree(soa_folder_path, ignore_errors=True)
        return jsonify({"error": "Select at least one SOA Excel file (.xlsx or .xls)."}), 400
    if len(soa_files) != len(records):
        shutil.rmtree(soa_folder_path, ignore_errors=True)
        return jsonify({
            "error": (
                f"The workbook contains {len(records)} completed patient row(s), "
                f"but {len(soa_files)} SOA file(s) were selected. "
                "The counts must match exactly."
            )
        }), 400

    # Validate every filename match before creating any drafts. Never guess
    # when a patient has no unique SOA workbook.
    match_token = _emit_room.set(user_room(user.id))
    try:
        matched_soa = {}
        match_errors = []
        for record in records:
            # CF2 workbooks commonly write names as "SURNAME, GIVEN" while
            # the existing SOA matcher expects the Beacon/API order "GIVEN
            # SURNAME". Normalize only for preflight; the SOA automation
            # still resolves the patient name from Beacon as it always has.
            soa_match_name = record.patient_name
            if "," in soa_match_name:
                surname, given = soa_match_name.split(",", 1)
                if surname.strip() and given.strip():
                    soa_match_name = f"{given.strip()} {surname.strip()}"
            try:
                matched_file = _find_soa_file(
                    soa_match_name,
                    soa_folder_path,
                    treatment_dates=getattr(record, "treatment_dates", None),
                )
            except Exception as ex:
                match_errors.append(str(ex))
                continue
            if matched_file in matched_soa:
                match_errors.append(
                    f"The SOA file '{matched_file.name}' matched both "
                    f"'{matched_soa[matched_file]}' and '{record.patient_name}'. "
                    "Use distinct filenames so each patient has their own SOA."
                )
            else:
                matched_soa[matched_file] = record.patient_name
        if match_errors:
            raise ValueError("\n".join(match_errors))
    except Exception as ex:
        shutil.rmtree(soa_folder_path, ignore_errors=True)
        return jsonify({"error": f"SOA matching check failed: {ex}"}), 400
    finally:
        _emit_room.reset(match_token)

    active_runs = (_cf2_runs, _soa_runs, _document_runs, _cf4_transmittal_runs, _run_all_runs)
    if any(user.id in runs for runs in active_runs):
        shutil.rmtree(soa_folder_path, ignore_errors=True)
        return jsonify({"error": "Another automation is already running for this account."}), 409

    ar_values = {
        "account_receivable_name": str(request.form.get("account_receivable_name") or "").strip(),
        "account_receivable_designation": str(request.form.get("account_receivable_designation") or "").strip(),
        "account_receivable_number": str(request.form.get("account_receivable_number") or "").strip(),
    }
    user_settings = get_or_create_user_settings(user)
    cf4_settings = {**DEFAULT_CF4_SETTINGS, **(user_settings.cf4_settings or {})}
    generate_soa = True
    stop_event = threading.Event()
    old_retry_state = _run_all_retry_states.get(user.id)
    if old_retry_state:
        _expire_run_all_retry_state(user.id, old_retry_state["run_id"])
    run_id = uuid.uuid4().hex
    _start_run_all_status(
        user.id,
        run_id,
        total=len(records),
        stage="queued",
        message="Run queued.",
    )
    _run_all_runs[user.id] = {"stop_event": stop_event}
    threading.Thread(
        target=_run_all_automation,
        args=(user.id, beacon_settings, records, soa_folder_path, ar_values, cf4_settings, generate_soa, stop_event, run_id),
        daemon=True,
    ).start()
    return jsonify({"started": True, "patient_count": len(records), "run_id": run_id})


@app.route("/api/run-all/retry", methods=["POST"])
@login_required
@serialize_job_start
def run_all_retry():
    user = current_user()
    if not (user.is_admin or user.role == "subscriber"):
        return jsonify({
            "error": "Run All is available to Subscriber and Admin accounts only. Contact your administrator to request Subscriber access."
        }), 403
    data = request.get_json(silent=True) or {}
    retry_state = _run_all_retry_states.get(user.id)
    if not retry_state or data.get("run_id") != retry_state.get("run_id"):
        return jsonify({"error": "This run is no longer available to retry. Start a new run."}), 410
    item = next((row for row in retry_state["results"] if row.get("member_pin") == data.get("member_pin")), None)
    if not item or item.get("cf2") != "success":
        return jsonify({"error": "This claim has no completed CF2 draft to continue."}), 400
    if item.get("soa") != "success":
        start_at = "soa"
    elif retry_state.get("generate_soa") and item.get("esoa") != "success":
        start_at = "esoa"
    elif item.get("cf4") != "success":
        start_at = "cf4"
    else:
        return jsonify({"error": "All stages for this claim are already complete."}), 409

    stop_event = threading.Event()
    status_snapshot = _update_run_all_status(
        user.id,
        retry_state["run_id"],
        running=True,
        done=False,
        index=retry_state["results"].index(item) + 1,
        total=len(retry_state["results"]),
        stage=start_at,
        message="Retry queued.",
        results=retry_state["results"],
        retry_run_id=retry_state["run_id"],
    )
    if not status_snapshot:
        _start_run_all_status(
            user.id,
            retry_state["run_id"],
            total=len(retry_state["results"]),
            results=retry_state["results"],
            stage=start_at,
            message="Retry queued.",
        )
    _run_all_runs[user.id] = {"stop_event": stop_event}
    threading.Thread(
        target=_run_all_retry_automation,
        args=(user.id, retry_state, item, start_at, stop_event),
        daemon=True,
    ).start()
    return jsonify({"started": True, "stage": start_at, "run_id": retry_state["run_id"]})


@app.route("/api/run-all/status", methods=["GET"])
@login_required
def run_all_status():
    user = current_user()
    if not (user.is_admin or user.role == "subscriber"):
        return jsonify({"error": "Run All is available to Subscriber and Admin accounts only."}), 403
    with _run_all_status_lock:
        state = _run_all_status.get(user.id)
        if state is None:
            try:
                row = db.session.get(RunAllTaskSnapshot, user.id)
                state = _copy_run_all_status(row.snapshot) if row and row.snapshot else None
                if state and state.get("running") and state.get("server_instance") != _server_instance_id:
                    state.update({
                        "running": False,
                        "done": True,
                        "failed": True,
                        "message": "The server restarted while this run was active. Saved results are shown; start a new run to continue.",
                        "retry_run_id": None,
                        "server_instance": _server_instance_id,
                        "updated_at": utc_now().isoformat(),
                    })
                    _persist_run_all_status(user.id, state)
                if state:
                    _run_all_status[user.id] = state
            except Exception:
                db.session.rollback()
                logger.exception("Could not restore Run All status for user %s", user.id)
                state = None
        snapshot = _copy_run_all_status(state) if state else None
    return jsonify({"run": snapshot})


@app.route("/api/run-all/stop", methods=["POST"])
@login_required
def run_all_stop():
    user = current_user()
    run = _run_all_runs.get(user.id)
    if not run:
        return jsonify({"stopped": False, "running": False})
    run["stop_event"].set()
    return jsonify({"stopped": True, "running": True})


if __name__ == "__main__":
    init_database()
    port = int(os.environ.get("PORT") or os.environ.get("BEABOTS_PORT", 5417))
    host = os.environ.get("HOST", "0.0.0.0")
    socketio.run(app, host=host, port=port, allow_unsafe_werkzeug=True)
