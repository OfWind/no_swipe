from __future__ import annotations

import hashlib
import json
import os
import socket
from dataclasses import dataclass
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_CONFIG_PATH = PLUGIN_ROOT / "config" / "supabase.json"


class ConfigurationError(RuntimeError):
    pass


@dataclass(frozen=True)
class SupabaseConfig:
    url: str
    publishable_key: str
    edge_function: str
    contract_version: int
    plugin_version: str

    @property
    def ingest_url(self) -> str:
        return f"{self.url.rstrip('/')}/functions/v1/{self.edge_function}"

    @property
    def host_fingerprint(self) -> str:
        hostname = socket.gethostname().encode("utf-8", errors="replace")
        return hashlib.sha256(hostname).hexdigest()[:16]


def load_config(path: Path = DEFAULT_CONFIG_PATH) -> SupabaseConfig:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigurationError(f"cannot load Supabase config: {exc}") from exc

    url = os.environ.get("NO_SWIPE_SUPABASE_URL", raw.get("url", "")).strip()
    publishable_key = os.environ.get(
        "NO_SWIPE_SUPABASE_PUBLISHABLE_KEY", raw.get("publishable_key", "")
    ).strip()
    edge_function = str(raw.get("edge_function", "ingest")).strip()
    plugin_version = str(raw.get("plugin_version", "")).strip()
    contract_version = raw.get("contract_version")

    if not url.startswith("https://") and not url.startswith("http://127.0.0.1"):
        raise ConfigurationError("Supabase URL must use HTTPS (localhost is allowed for tests)")
    if not publishable_key.startswith(("sb_publishable_", "eyJ")):
        raise ConfigurationError("missing or invalid Supabase publishable key")
    if not edge_function or not plugin_version or contract_version != 2:
        raise ConfigurationError("incomplete Supabase upload configuration")
    return SupabaseConfig(
        url=url,
        publishable_key=publishable_key,
        edge_function=edge_function,
        contract_version=contract_version,
        plugin_version=plugin_version,
    )
