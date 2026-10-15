"""Google sign-in for the endpoints that store data or call Gemini.

The browser signs in with Google Identity Services and sends the Google ID token
as `Authorization: Bearer <token>`. The token is verified against the OAuth web
client ID (GOOGLE_OAUTH_CLIENT_ID). Optional allow-lists:
  ALLOWED_DOMAINS  comma-separated e-mail domains (e.g. "google.com,partner.com")
  ALLOWED_EMAILS   comma-separated addresses
With neither set, any Google account may sign in.

Local development and tests: AUTH_DEV_USER=someone@example.com skips verification.
The estimate endpoints stay open - they store nothing.
"""
from __future__ import annotations

import os
import time

from fastapi import Header, HTTPException

_cache: dict[str, tuple[float, dict]] = {}


def _csv(name):
    return {x.strip().lower() for x in os.environ.get(name, "").split(",") if x.strip()}


def client_id() -> str:
    return os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "").strip()


def enabled() -> bool:
    return bool(client_id() or os.environ.get("AUTH_DEV_USER"))


def _allowed(email: str) -> bool:
    domains, emails = _csv("ALLOWED_DOMAINS"), _csv("ALLOWED_EMAILS")
    if not domains and not emails:
        return True
    return email.lower() in emails or email.lower().rsplit("@", 1)[-1] in domains


def verify(token: str) -> dict:
    hit = _cache.get(token)
    if hit and hit[0] > time.time():
        return hit[1]
    from google.auth.transport import requests as g_requests
    from google.oauth2 import id_token
    try:
        info = id_token.verify_oauth2_token(token, g_requests.Request(), client_id())
    except ValueError as e:
        raise HTTPException(status_code=401, detail=f"Sign-in expired or invalid - sign in again ({e})") from e
    if not info.get("email_verified"):
        raise HTTPException(status_code=401, detail="Google account e-mail is not verified")
    user = {"email": info["email"].lower(), "name": info.get("name") or info["email"], "picture": info.get("picture")}
    _cache[token] = (min(float(info.get("exp", 0)), time.time() + 3000), user)
    if len(_cache) > 2000:
        for k in [k for k, v in _cache.items() if v[0] < time.time()]:
            _cache.pop(k, None)
    return user


def current_user(authorization: str = Header(default="")) -> dict:
    """FastAPI dependency: the signed-in user, or 401."""
    dev = os.environ.get("AUTH_DEV_USER")
    if dev:
        email = (authorization.split(" ", 1)[1] if authorization.startswith("Dev ") else dev).lower()
        return {"email": email, "name": email.split("@")[0], "picture": None}
    if not client_id():
        raise HTTPException(status_code=503, detail="Sign-in is not configured on this deployment (GOOGLE_OAUTH_CLIENT_ID)")
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Sign in with Google to use this feature")
    user = verify(authorization[7:].strip())
    if not _allowed(user["email"]):
        raise HTTPException(status_code=403, detail=f"{user['email']} is not allowed on this deployment")
    return user
