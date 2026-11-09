from calendar import monthrange
from datetime import date, timedelta


def parse_billing_month(value):
    if not isinstance(value, str):
        raise ValueError("Month must use YYYY-MM format.")
    try:
        parsed = date.fromisoformat(f"{value}-01")
    except (TypeError, ValueError):
        raise ValueError("Month must use YYYY-MM format.")
    if len(value) != 7 or parsed.strftime("%Y-%m") != value:
        raise ValueError("Month must use YYYY-MM format.")
    return parsed


def default_billing_weeks(month):
    month_start = month if isinstance(month, date) else parse_billing_month(month)
    last_day = monthrange(month_start.year, month_start.month)[1]
    month_end = date(month_start.year, month_start.month, last_day)
    cursor = month_start
    weeks = []
    week_number = 1
    while cursor <= month_end:
        if cursor.weekday() == 6:
            cursor += timedelta(days=1)
            continue
        end = min(cursor + timedelta(days=5 - cursor.weekday()), month_end)
        weeks.append({
            "week": week_number,
            "start": cursor.isoformat(),
            "end": end.isoformat(),
        })
        week_number += 1
        cursor = end + timedelta(days=2)
    return weeks


def initial_billing_weeks(month):
    month_value = month if isinstance(month, str) else month.strftime("%Y-%m")
    sample_ranges = {
        "2026-09": [("01", "05"), ("07", "12"), ("14", "19"), ("21", "30")],
        "2026-10": [("01", "10"), ("12", "17"), ("19", "24"), ("26", "31")],
        "2026-11": [("02", "07"), ("09", "14"), ("16", "21"), ("23", "30")],
    }
    if month_value not in sample_ranges:
        return default_billing_weeks(month)
    return [
        {"week": index, "start": f"{month_value}-{start}", "end": f"{month_value}-{end}"}
        for index, (start, end) in enumerate(sample_ranges[month_value], start=1)
    ]


def validate_billing_weeks(month, weeks):
    month_start = parse_billing_month(month)
    last_day = monthrange(month_start.year, month_start.month)[1]
    month_end = date(month_start.year, month_start.month, last_day)
    if not isinstance(weeks, list) or not 1 <= len(weeks) <= 6:
        raise ValueError("Between one and six billing week ranges are required.")

    validated = []
    previous_end = None
    for index, item in enumerate(weeks, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"Week {index} must have a start and end date.")
        try:
            start_text = item.get("start", "")
            end_text = item.get("end", "")
            start = date.fromisoformat(start_text)
            end = date.fromisoformat(end_text)
        except (TypeError, ValueError):
            raise ValueError(f"Week {index} must use valid YYYY-MM-DD dates.")
        if start.isoformat() != start_text or end.isoformat() != end_text:
            raise ValueError(f"Week {index} must use valid YYYY-MM-DD dates.")
        if not month_start <= start <= month_end or not month_start <= end <= month_end:
            raise ValueError(f"Week {index} dates must be within the selected month.")
        if start > end:
            raise ValueError(f"Week {index} start date must not be after its end date.")
        if previous_end is not None and start <= previous_end:
            raise ValueError("Billing week ranges must be in order and must not overlap.")
        validated.append({"week": index, "start": start.isoformat(), "end": end.isoformat()})
        previous_end = end
    return validated


def classify_claim_status(status, transmittal_status=None):
    normalized_transmittal = str(transmittal_status or "").strip().upper()
    if normalized_transmittal in {"DRAFT", "TRANSMITTED", "COMPLETE", "TRANSMIT ERROR"}:
        normalized = normalized_transmittal
    else:
        normalized = str(status or "").strip().upper()
    if normalized == "DRAFT":
        return "draft"
    if normalized in {"TRANSMITTED", "COMPLETE"}:
        return "transmitted"
    return "other"


def _week_label(week):
    start = date.fromisoformat(week["start"])
    end = date.fromisoformat(week["end"])
    if start.month == end.month:
        range_label = f"{start.strftime('%b')} {start.day}-{end.day}"
    else:
        range_label = f"{start.strftime('%b')} {start.day}-{end.strftime('%b')} {end.day}"
    return f"Week {week['week']} · {range_label}"


def _new_bucket(label, start, end):
    return {
        "label": label,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "draft": 0,
        "transmitted": 0,
        "other": 0,
        "total": 0,
    }


def _month_windows(date_from, date_to):
    month_start = date(date_from.year, date_from.month, 1)
    while month_start <= date_to:
        month_end = date(month_start.year, month_start.month, monthrange(month_start.year, month_start.month)[1])
        yield max(month_start, date_from), min(month_end, date_to)
        if month_start.month == 12:
            month_start = date(month_start.year + 1, 1, 1)
        else:
            month_start = date(month_start.year, month_start.month + 1, 1)


def build_claim_analytics(
    date_from,
    date_to,
    group,
    daily_counts,
    schedules,
    missing_admission_dates=0,
    filter_month="all",
):
    if group not in {"month", "week"}:
        raise ValueError("Group must be month or week.")
    window_from = date_from
    window_to = date_to
    if filter_month != "all":
        filter_start = parse_billing_month(filter_month)
        filter_end = date(
            filter_start.year,
            filter_start.month,
            monthrange(filter_start.year, filter_start.month)[1],
        )
        date_from = max(date_from, filter_start)
        date_to = min(date_to, filter_end)

    totals = {"draft": 0, "transmitted": 0, "other": 0}
    unassigned = {"label": "Unassigned dates", "draft": 0, "transmitted": 0, "other": 0, "total": 0}
    buckets = {}

    if group == "month":
        for start, end in _month_windows(date_from, date_to):
            month_label = start.strftime("%b %Y")
            bucket = _new_bucket(month_label, start, end)
            buckets[month_label] = bucket
    else:
        for month, weeks in schedules.items():
            month_start = parse_billing_month(month)
            month_end = date(
                month_start.year,
                month_start.month,
                monthrange(month_start.year, month_start.month)[1],
            )
            if month_end < date_from or month_start > date_to:
                continue
            for week in weeks:
                start = date.fromisoformat(week["start"])
                end = date.fromisoformat(week["end"])
                if end < date_from or start > date_to:
                    continue
                key = (month, week["week"])
                buckets[key] = {
                    **_new_bucket(_week_label(week), start, end),
                    "week": week["week"],
                    "month": month,
                }

    for day, counts in daily_counts:
        if not date_from <= day <= date_to:
            continue
        if group == "month":
            bucket = buckets[day.strftime("%b %Y")]
        else:
            month = day.strftime("%Y-%m")
            week = next(
                (
                    item for item in schedules.get(month, [])
                    if date.fromisoformat(item["start"]) <= day <= date.fromisoformat(item["end"])
                ),
                None,
            )
            bucket = buckets.get((month, week["week"])) if week else None
            if bucket is None:
                for category, count in counts.items():
                    if category in totals:
                        unassigned[category] += count
                unassigned["total"] += sum(counts.get(category, 0) for category in totals)
                continue
        for category in totals:
            count = int(counts.get(category, 0))
            bucket[category] += count
            totals[category] += count
        bucket["total"] += sum(int(counts.get(category, 0)) for category in totals)

    return {
        "date_from": window_from.isoformat(),
        "date_to": window_to.isoformat(),
        "period_from": date_from.isoformat(),
        "period_to": date_to.isoformat(),
        "group": group,
        "total_claims": sum(totals.values()),
        "draft_claims": totals["draft"],
        "transmitted_claims": totals["transmitted"],
        "other_claims": totals["other"],
        "missing_admission_dates": missing_admission_dates,
        "unassigned": unassigned,
        "buckets": list(buckets.values()),
    }
