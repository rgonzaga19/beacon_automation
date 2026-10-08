"""Runtime defaults for SOA search behavior, configured through environment variables."""

import os


def load_settings():
    """Return non-secret SOA defaults without reading machine-local config files."""
    facility = os.getenv("BEABOTS_FACILITY_ID", "263")
    search_days = os.getenv("BEABOTS_TRANSMITTAL_SEARCH_DAYS", "31")
    package_type = os.getenv("BEABOTS_TRANSMITTAL_PACKAGE_TYPE", "7")
    try:
        facility = int(facility)
    except (TypeError, ValueError):
        facility = 263
    try:
        search_days = max(1, int(search_days))
    except (TypeError, ValueError):
        search_days = 31
    try:
        package_type = int(package_type) if package_type.strip().lower() not in {"", "none", "null", "all"} else None
    except (TypeError, ValueError):
        package_type = 7
    return {
        "facility_id": facility,
        "transmittal_search_days": search_days,
        "transmittal_package_type": package_type,
    }
