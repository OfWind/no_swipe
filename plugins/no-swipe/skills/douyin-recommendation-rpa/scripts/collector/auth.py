from __future__ import annotations

import base64
import json
import os
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from .config import SupabaseConfig


DEFAULT_AUTH_DIR = Path.home() / ".config" / "no-swipe"


class AuthError(RuntimeError):
    pass


class AuthRequired(AuthError):
    pass


class AuthHttpError(AuthError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _decode_response(raw: bytes) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AuthError("Supabase Auth returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise AuthError("Supabase Auth returned an invalid response")
    return value


def _error_message(payload: dict[str, Any], fallback: str) -> str:
    for key in ("msg", "message", "error_description", "error"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    return fallback


def _jwt_claims(token: str) -> dict[str, Any]:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        value = json.loads(base64.urlsafe_b64decode(payload.encode("ascii")))
        return value if isinstance(value, dict) else {}
    except (IndexError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return {}


class AuthClient:
    def __init__(self, config: SupabaseConfig, auth_dir: Path | None = None):
        self.config = config
        configured = os.environ.get("NO_SWIPE_AUTH_DIR")
        self.auth_dir = Path(configured) if configured else (auth_dir or DEFAULT_AUTH_DIR)
        self.auth_file = self.auth_dir / "auth.json"

    def _request(
        self,
        path: str,
        payload: dict[str, Any] | None = None,
        access_token: str | None = None,
    ) -> dict[str, Any]:
        headers = {
            "apikey": self.config.publishable_key,
            "Content-Type": "application/json",
        }
        if access_token:
            headers["Authorization"] = f"Bearer {access_token}"
        request = urllib.request.Request(
            f"{self.config.url.rstrip('/')}{path}",
            method="POST",
            headers=headers,
            data=json.dumps(payload or {}, separators=(",", ":")).encode("utf-8"),
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return _decode_response(response.read())
        except urllib.error.HTTPError as exc:
            body = _decode_response(exc.read())
            raise AuthHttpError(exc.code, _error_message(body, f"Auth HTTP {exc.code}")) from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise AuthError(f"cannot reach Supabase Auth: {exc}") from exc

    def load_session(self) -> dict[str, Any] | None:
        try:
            value = json.loads(self.auth_file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, json.JSONDecodeError) as exc:
            raise AuthError(f"cannot read cached login: {exc}") from exc
        if not isinstance(value, dict):
            raise AuthError("cached login is invalid")
        return value

    def save_session(self, session: dict[str, Any]) -> None:
        access_token = session.get("access_token")
        refresh_token = session.get("refresh_token")
        if not isinstance(access_token, str) or not isinstance(refresh_token, str):
            raise AuthError("Auth response did not include a complete session")

        claims = _jwt_claims(access_token)
        cached = {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "expires_at": int(session.get("expires_at") or claims.get("exp") or 0),
            "email": (session.get("user") or {}).get("email") or claims.get("email"),
        }
        self.auth_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.auth_dir, 0o700)
        fd, temporary = tempfile.mkstemp(prefix="auth-", suffix=".json", dir=str(self.auth_dir))
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(cached, handle, ensure_ascii=False, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.auth_file)
            os.chmod(self.auth_file, 0o600)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def send_otp(self, email: str) -> None:
        normalized = email.strip().lower()
        if "@" not in normalized or normalized.startswith("@") or normalized.endswith("@"):
            raise AuthError("a valid email address is required")
        self._request("/auth/v1/otp", {"email": normalized, "create_user": True})

    def verify_otp(self, email: str, token: str) -> dict[str, Any]:
        session = self._request(
            "/auth/v1/verify",
            {"email": email.strip().lower(), "token": token.strip(), "type": "email"},
        )
        self.save_session(session)
        return session

    def refresh_session(self) -> dict[str, Any]:
        session = self.load_session()
        if not session or not isinstance(session.get("refresh_token"), str):
            raise AuthRequired("not logged in; run auth-login first")
        refreshed = self._request(
            "/auth/v1/token?grant_type=refresh_token",
            {"refresh_token": session["refresh_token"]},
        )
        self.save_session(refreshed)
        return self.load_session() or {}

    def access_token(self, force_refresh: bool = False) -> str:
        session = self.load_session()
        if not session or not isinstance(session.get("access_token"), str):
            raise AuthRequired("not logged in; run auth-login first")
        expires_at = int(session.get("expires_at") or 0)
        if force_refresh or expires_at <= int(time.time()) + 60:
            session = self.refresh_session()
        token = session.get("access_token")
        if not isinstance(token, str):
            raise AuthRequired("login session is invalid; run auth-login again")
        return token

    def status(self) -> dict[str, Any]:
        session = self.load_session()
        if not session:
            return {"logged_in": False}
        return {
            "logged_in": True,
            "email": session.get("email"),
            "expires_at": session.get("expires_at"),
            "needs_refresh": int(session.get("expires_at") or 0) <= int(time.time()) + 60,
        }

    def logout(self) -> None:
        session = self.load_session()
        if session and isinstance(session.get("access_token"), str):
            try:
                self._request("/auth/v1/logout?scope=global", {}, session["access_token"])
            except AuthError:
                pass
        try:
            self.auth_file.unlink()
        except FileNotFoundError:
            pass
