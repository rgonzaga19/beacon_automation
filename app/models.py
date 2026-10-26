from datetime import datetime, timezone

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


class UpgradeRequest(db.Model):
    __tablename__ = "upgrade_requests"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), unique=True, nullable=False, index=True)
    message = db.Column(db.String(500), nullable=False)
    status = db.Column(db.String(20), nullable=False, default="pending")
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now)
    reviewed_at = db.Column(db.DateTime(timezone=True), nullable=True)
    user = db.relationship("User", back_populates="upgrade_request")


class TeamSupportMessage(db.Model):
    __tablename__ = "team_support"

    id = db.Column(db.Integer, primary_key=True)
    sender_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    support_user_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    sender_name = db.Column(db.String(120), nullable=False)
    body = db.Column(db.String(2000), nullable=False)
    image_data = db.Column(db.LargeBinary, nullable=True)
    image_mime = db.Column(db.String(30), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utc_now, index=True)


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
