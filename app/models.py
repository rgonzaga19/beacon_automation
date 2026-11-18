from datetime import date, datetime, timezone

from sqlalchemy import Index, UniqueConstraint

from app.core.database import db


def utc_now():
    return datetime.now(timezone.utc)


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    profile_name = db.Column(db.String(120), nullable=True)
    display_name = db.Column(db.String(120), nullable=True)
    avatar = db.Column(db.String(32), nullable=False, default="avatar-penguin")
    is_active = db.Column(db.Boolean, nullable=False, default=True)
    is_admin = db.Column(db.Boolean, nullable=False, default=False)
    role = db.Column(db.String(20), nullable=False, default="member")
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at = db.Column(
        db.DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        onupdate=utc_now,
    )

    settings = db.relationship(
        "UserSetting",
        back_populates="user",
        cascade="all, delete-orphan",
        uselist=False,
    )
    upgrade_request = db.relationship(
        "UpgradeRequest",
        back_populates="user",
        cascade="all, delete-orphan",
        uselist=False,
    )


class UserSetting(db.Model):
    __tablename__ = "user_settings"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), unique=True, nullable=False)
    beacon_username = db.Column(db.String(255), nullable=True)
    beacon_password_encrypted = db.Column(db.Text, nullable=True)
    beacon_user_id = db.Column(db.String(80), nullable=True)
    beacon_validated_at = db.Column(db.DateTime(timezone=True), nullable=True)
    server = db.Column(db.String(20), nullable=False, default="s4")
    soa_folder = db.Column(db.String(1024), nullable=True)
    cf4_settings = db.Column(db.JSON, nullable=False, default=dict)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at = db.Column(
        db.DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        onupdate=utc_now,
    )

    user = db.relationship("User", back_populates="settings")


class ClaimBillingSchedule(db.Model):
    __tablename__ = "claim_billing_schedules"

    month = db.Column(db.String(7), primary_key=True)
    weeks = db.Column(db.JSON, nullable=False)
    updated_at = db.Column(
        db.DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        onupdate=utc_now,
    )


class BeaconClaimAnalyticsCache(db.Model):
    """Small, refreshable snapshot of Beacon fields used by dashboard analytics."""

    __tablename__ = "beacon_claim_analytics_cache"
    __table_args__ = (
        UniqueConstraint("user_id", "claim_id", name="uq_beacon_claim_analytics_user_claim"),
        Index("ix_beacon_claim_analytics_user_admission", "user_id", "admission_date"),
        Index("ix_beacon_claim_analytics_user_transmittal", "user_id", "transmittal_id"),
    )

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    claim_id = db.Column(db.String(80), nullable=False)
    transmittal_id = db.Column(db.String(80), nullable=False)
    admission_date = db.Column(db.Date, nullable=True)
    claim_status = db.Column(db.String(80), nullable=True)
    transmittal_status = db.Column(db.String(80), nullable=True)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now)


class BeaconClaimAnalyticsSync(db.Model):
    """Refresh state for a user's compact Beacon analytics cache."""

    __tablename__ = "beacon_claim_analytics_sync"

    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    window_start = db.Column(db.Date, nullable=True)
    window_end = db.Column(db.Date, nullable=True)
    state = db.Column(db.String(20), nullable=False, default="idle")
    last_attempt_at = db.Column(db.DateTime(timezone=True), nullable=True)
    last_completed_at = db.Column(db.DateTime(timezone=True), nullable=True)
    transmittals_scanned = db.Column(db.Integer, nullable=False, default=0)
    claims_scanned = db.Column(db.Integer, nullable=False, default=0)
    failed_transmittals = db.Column(db.Integer, nullable=False, default=0)
    failed_transmittal_ids = db.Column(db.JSON, nullable=False, default=list)
    error_summary = db.Column(db.String(500), nullable=True)


class UpgradeRequest(db.Model):
    __tablename__ = "upgrade_requests"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), unique=True, nullable=False, index=True)
    message = db.Column(db.String(500), nullable=False)
    status = db.Column(db.String(20), nullable=False, default="pending")
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now)
    reviewed_at = db.Column(db.DateTime(timezone=True), nullable=True)
    user = db.relationship("User", back_populates="upgrade_request")


class TeamChatMessage(db.Model):
    __tablename__ = "team_chat"

    id = db.Column(db.Integer, primary_key=True)
    sender_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    sender_name = db.Column(db.String(120), nullable=False)
    body = db.Column(db.String(2000), nullable=False)
    image_data = db.Column(db.LargeBinary, nullable=True)
    image_mime = db.Column(db.String(30), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now, index=True)


class AutomationRun(db.Model):
    __tablename__ = "automation_runs"
    __table_args__ = (Index("ix_automation_runs_finished_at_id", "finished_at", "id"),)

    id = db.Column(db.Integer, primary_key=True)
    workflow = db.Column(db.String(40), nullable=False, index=True)
    status = db.Column(db.String(20), nullable=False, index=True)
    item_count = db.Column(db.Integer, nullable=False, default=0)
    duration_seconds = db.Column(db.Integer, nullable=False, default=0)
    runner_name = db.Column(db.String(120), nullable=True)
    started_at = db.Column(db.DateTime(timezone=True), nullable=False, index=True)
    finished_at = db.Column(db.DateTime(timezone=True), nullable=False)


class RunAllTaskSnapshot(db.Model):
    """Latest Run All progress/results, retained so a user can reconnect."""

    __tablename__ = "run_all_task_snapshots"

    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    snapshot = db.Column(db.JSON, nullable=False)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now)


class Cf2TaskSnapshot(db.Model):
    """Latest CF2 batch state so its page can reconnect after sign-in."""

    __tablename__ = "cf2_task_snapshots"

    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    snapshot = db.Column(db.JSON, nullable=False)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now)


class SoaTaskSnapshot(db.Model):
    """Latest SOA upload progress so its page can reconnect after sign-in."""

    __tablename__ = "soa_task_snapshots"

    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    snapshot = db.Column(db.JSON, nullable=False)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now)


class Cf4TransmittalTaskSnapshot(db.Model):
    """Latest CF4 transmittal automation progress for reconnecting to its task."""

    __tablename__ = "beacon_task_snapshots"

    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    snapshot = db.Column(db.JSON, nullable=False)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now)


class DocumentTaskSnapshot(db.Model):
    """Latest document upload progress for reconnecting to the task."""

    __tablename__ = "document_task_snapshots"

    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    snapshot = db.Column(db.JSON, nullable=False)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now)
