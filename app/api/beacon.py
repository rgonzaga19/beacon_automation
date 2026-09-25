"""Direct Beacon API layer for CF4 automation.

This module mirrors the HTTP calls observed in the recorded CF4 workflow.
Business rules (CF4 settings, medicine selection rules, retry/report behavior)
remain in beacon.py.
"""

from datetime import datetime, timedelta
import time
import requests

from app.core import browser_session


class BeaconApiError(RuntimeError):
    pass


_client_id_cache = {}
_transmittal_cache = {}
_claims_cache = {}
_claim_cache = {}
_cf4_cache = {}
_medicine_search_cache = {}


def _base_url():
    getter = getattr(browser_session, "_get_beacon_url", None)
    if callable(getter):
        return getter().rstrip("/")
    return "https://beacon-s4.bizbox.ph"


def _headers():
    token = browser_session.get_auth_token()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _check(response):
    try:
        response.raise_for_status()
    except requests.HTTPError as exc:
        body = (response.text or "")[:1500]
        raise BeaconApiError(
            f"{response.request.method} {response.url} failed "
            f"({response.status_code}): {body}"
        ) from exc
    return response


def _is_beacon_out_of_memory(response):
    return (
        response.status_code >= 500
        and "System.OutOfMemoryException" in (response.text or "")
    )


def _json(response):
    _check(response)

    if not response.text:
        return None

    try:
        return response.json()
    except ValueError:
        return response.text.strip('"')


def _get(path, params=None):
    last_response = None
    for attempt in range(3):
        response = requests.get(
            _base_url() + path,
            headers=_headers(),
            params=params,
            timeout=30,
        )
        if response.ok or not _is_beacon_out_of_memory(response) or attempt == 2:
            return _json(response)
        last_response = response
        time.sleep(0.8 * (attempt + 1))

    return _json(
        last_response
    )


def _post(path, json_body=None, params=None):
    last_response = None
    for attempt in range(3):
        response = requests.post(
            _base_url() + path,
            headers=_headers(),
            params=params,
            json=json_body,
            timeout=60,
        )
        if response.ok or not _is_beacon_out_of_memory(response) or attempt == 2:
            return _json(response)
        last_response = response
        time.sleep(0.8 * (attempt + 1))

    return _json(
        last_response
    )


def get_client_id():
    """Resolve the current Beacon client/facility ID dynamically."""
    cache_key = browser_session._context_key()
    if cache_key in _client_id_cache:
        return _client_id_cache[cache_key]

    user_id = browser_session.get_user_id()
    if not user_id:
        raise BeaconApiError("Beacon userId is unavailable")

    clients = _get(
        "/api/Account/GetAllClientsByUserId",
        params={"userId": user_id},
    ) or []

    if not clients:
        raise BeaconApiError(
            f"GetAllClientsByUserId returned no clients for userId={user_id}"
        )

    _client_id_cache[cache_key] = int(clients[0]["id"])
    return _client_id_cache[cache_key]


def get_transmittal(transmittal_no, client_id=None):
    """Search the exact transmittal number, preserving the original workflow."""
    if client_id is None:
        client_id = get_client_id()

    cache_key = (browser_session._context_key(), int(client_id), str(transmittal_no).strip())
    if cache_key in _transmittal_cache:
        return _transmittal_cache[cache_key]

    # Same Transmittals table request shape used by Beacon/SOA API migration.
    today = datetime.now().date()
    date_from = today - timedelta(days=31)
    date_to = today + timedelta(days=1)

    data = _get(
        "/api/PHICTransmittal/GetAllPHICTransmittal",
        params={
            "clientId": client_id,
            "dateFrom": date_from.strftime("%Y-%m-%dT16:00:00.000Z"),
            "dateTo": date_to.strftime("%Y-%m-%dT15:59:59.999Z"),
            "itemStart": 0,
            "itemEnd": 30,
            "que": str(transmittal_no),
            "transmittalPackageType": 7,
        },
    ) or {}

    if isinstance(data, list):
        rows = data
    else:
        rows = (
            data.get("transmittalList")
            or data.get("items")
            or data.get("data")
            or []
        )

    exact = [
        row for row in rows
        if str(row.get("transmittalNumber") or "").strip()
        == str(transmittal_no).strip()
    ]

    result = exact[0] if exact else None
    if result:
        _transmittal_cache[cache_key] = result
    return result


def get_transmittal_by_id(transmittal_id):
    return _get(
        "/api/PHICTransmittal/GetPHICTransmittalById",
        params={"transmittalId": transmittal_id},
    )


def get_claims(transmittal_id):
    cache_key = (browser_session._context_key(), int(transmittal_id))
    if cache_key in _claims_cache:
        return _claims_cache[cache_key]

    try:
        data = _get(
            "/api/PHICClaim/GetAllPHICClaimByPHICTransmittalId",
            params={"transmittalId": transmittal_id},
        ) or []
    except BeaconApiError:
        data = get_transmittal_by_id(transmittal_id) or {}
        fallback_claims = data.get("transmittalClaims") if isinstance(data, dict) else None
        if isinstance(fallback_claims, list) and fallback_claims:
            _claims_cache[cache_key] = fallback_claims
            return fallback_claims
        raise

    if isinstance(data, list):
        _claims_cache[cache_key] = data
        return data

    if isinstance(data, dict):
        for key in (
            "phicClaims",
            "claims",
            "claimList",
            "items",
            "data",
        ):
            value = data.get(key)
            if isinstance(value, list):
                _claims_cache[cache_key] = value
                return value

    return []


def get_claim(claim_id):
    cache_key = (browser_session._context_key(), int(claim_id))
    if cache_key in _claim_cache:
        return _claim_cache[cache_key]

    claim = _get(
        "/api/PHICClaim/GetPHICClaim",
        params={"id": claim_id},
    )
    if isinstance(claim, dict) and claim:
        _claim_cache[cache_key] = claim
    return claim


def get_cf4_values(claim_id):
    cache_key = (browser_session._context_key(), int(claim_id))
    if cache_key in _cf4_cache:
        return _cf4_cache[cache_key]

    cf4 = _get(
        "/api/PHICCF4/GetCf4Values",
        params={"ClaimId": claim_id},
    )
    if isinstance(cf4, dict) and cf4:
        _cf4_cache[cache_key] = cf4
    return cf4


def get_doctors_by_claim_id(claim_id):
    """Return doctors already encoded on the claim."""
    data = _get(
        "/api/PHICDoctor/GetAllPHICDoctorByClaimId",
        params={"claimId": claim_id},
    ) or []

    if isinstance(data, list):
        return data

    if isinstance(data, dict):
        for key in ("items", "data", "doctors", "phicDoctors"):
            value = data.get(key)
            if isinstance(value, list):
                return value

    return []


def new_pdf_cf4(claim_id, doctor_name, date_signed):
    """Save the CF4 New-tab attending doctor/sign date data."""
    return _post(
        "/api/PHICDocument/NewPdfCF4",
        json_body={
            "phicClaimId": str(claim_id),
            "type": "cf4",
            "revision": "revision",
            "data": {
                "sigOverPrintedNameOfAttendingHCProf": doctor_name,
                "dateSigned": date_signed,
            },
        },
    )


def get_surgical_procedures(cf2_id):
    data = _get(
        "/api/PHICSurgicalProcedure/GetPHICSurgicalProcedure",
        params={"cf2Id": cf2_id},
    ) or []

    if isinstance(data, list):
        return data

    if isinstance(data, dict):
        for key in ("items", "data", "procedures", "surgicalProcedures"):
            value = data.get(key)
            if isinstance(value, list):
                return value

    return []


def search_medicines(search_term):
    cache_key = (browser_session._context_key(), str(search_term or "").strip().casefold())
    if cache_key in _medicine_search_cache:
        return _medicine_search_cache[cache_key]

    data = _post(
        "/api/Medicine/SearchMedicines",
        json_body={"search": search_term},
    ) or []

    if isinstance(data, list):
        _medicine_search_cache[cache_key] = data
        return data

    if isinstance(data, dict):
        for key in ("items", "data", "result", "medicines"):
            value = data.get(key)
            if isinstance(value, list):
                _medicine_search_cache[cache_key] = value
                return value

    return []


def save_cf4_values(payload):
    return _post(
        "/api/PHICCF4/SavePhicCf4Values",
        json_body=payload,
    )
