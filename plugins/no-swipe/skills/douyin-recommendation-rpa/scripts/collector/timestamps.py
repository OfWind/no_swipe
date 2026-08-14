from __future__ import annotations

import re
from datetime import datetime


RFC3339_TIMESTAMP = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)


def require_timezone_timestamp(value: str, field: str = "timestamp") -> str:
    """Validate a timezone-aware RFC 3339 timestamp without changing it."""
    if not RFC3339_TIMESTAMP.fullmatch(value):
        raise ValueError(f"{field} 必须包含 UTC Z 或数字时区偏移")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{field} 不是有效的 RFC 3339 时间") from exc
    if parsed.utcoffset() is None:
        raise ValueError(f"{field} 必须包含 UTC Z 或数字时区偏移")
    return value
