import os
import secrets
from pathlib import Path


APP_NAME = "Beabots"


def get_data_dir():
    data_root = (
        os.getenv("BEABOTS_DATA_DIR")
        or os.getenv("LOCALAPPDATA")
        or os.getenv("XDG_DATA_HOME")
        or Path.home() / ".local" / "share"
    )
    data_dir = Path(data_root) / APP_NAME
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


def get_database_url():
    database_url = os.getenv("DATABASE_URL")
    if database_url:
        if database_url.startswith("postgres://"):
            return database_url.replace("postgres://", "postgresql://", 1)
        return database_url

    return f"sqlite:///{get_data_dir() / 'beabots.sqlite3'}"


def get_secret_key():
    configured = os.getenv("SECRET_KEY")
    if configured:
        return configured

    secret_file = get_data_dir() / "secret.key"
    if secret_file.exists():
        return secret_file.read_text(encoding="utf-8").strip()

    secret = secrets.token_hex(32)
    secret_file.write_text(secret, encoding="utf-8")
    return secret


class AppConfig:
    SECRET_KEY = get_secret_key()
    SQLALCHEMY_DATABASE_URI = get_database_url()
    SQLALCHEMY_TRACK_MODIFICATIONS = False
