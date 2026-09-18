import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import AppConfig


def _fernet_key():
    configured = os.getenv("FIELD_ENCRYPTION_KEY")
    if configured:
        try:
            decoded = base64.urlsafe_b64decode(configured.encode("utf-8"))
            if len(decoded) == 32:
                return configured.encode("utf-8")
        except Exception:
            pass
        digest = hashlib.sha256(configured.encode("utf-8")).digest()
        return base64.urlsafe_b64encode(digest)

    digest = hashlib.sha256(AppConfig.SECRET_KEY.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


_fernet = Fernet(_fernet_key())


def encrypt_field(value):
    if value is None:
        return None
    text = str(value)
    if text == "":
        return None
    return _fernet.encrypt(text.encode("utf-8")).decode("utf-8")


def decrypt_field(value):
    if not value:
        return ""
    try:
        return _fernet.decrypt(value.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        return ""
