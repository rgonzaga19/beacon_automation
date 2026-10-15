"""Beacon claim document upload API, based on the captured upload workflow."""

from datetime import datetime, timezone
import mimetypes
from pathlib import Path

from app.core import browser_session


DOCUMENT_TYPES = {
    "HDA": "Philhealth Hemodialysis Package Agreement Form",
    "OTH": "Other Documents",
    "CSF": "Claim Signature Form",
    "COE": "Certificate of Eligibility",
    "SOA": "Statement of Account",
    "PBEF": "Certificate of Eligibility",
}


def upload_documents(claim_id, transmittal, files):
    """Upload a document batch for a claim using Beacon's multipart API."""
    hospital_code = transmittal.get("hospitalCode") or ""
    accreditation = transmittal.get("accreditationNumber") or ""
    if not hospital_code or not accreditation:
        raise RuntimeError("Transmittal is missing its hospital identity.")

    data, opened = [], []
    try:
        for index, path in enumerate(files):
            path = Path(path)
            name = path.stem.upper()
            doc_type = (
                "CSF" if "CSF" in name else
                "COE" if "PBEF" in name or "COE" in name else
                "SOA" if "SOA" in name else
                "HDA" if " AF" in f" {name}" or "AGREEMENT" in name else
                "OTH"
            )
            stream = path.open("rb")
            opened.append(stream)
            data.extend([
                (f"remarks_{index}", (None, "")),
                (f"documenttype_{index}", (None, doc_type)),
                (f"documentvalue_{index}", (None, DOCUMENT_TYPES[doc_type])),
                (f"file_{index}", (path.name, stream, mimetypes.guess_type(path.name)[0] or "application/octet-stream")),
            ])
        now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        token = browser_session.require_auth_token()
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        response = browser_session.http_request(
            "POST",
            browser_session._get_beacon_url().rstrip("/") + "/api/PHICDocument/UploadDocuments",
            params={
                "phicClaimId": int(claim_id), "dateToday": now,
                "hospitalCodeId": hospital_code, "returnDocument": "false",
                "accreditationNumber": accreditation,
            },
            headers=headers, files=data, timeout=120,
        )
        response.raise_for_status()
        return response.json() if response.text else None
    except Exception as exc:
        raise RuntimeError(f"Beacon document upload failed: {exc}") from exc
    finally:
        for stream in opened:
            stream.close()
