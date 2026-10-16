"""Who uses Data Cloud Compass and what they do.

* The browser asks for a name and email on the first visit and sends them with every API call
  (X-Compass-User / X-Compass-Email) - self-reported, no sign-in.
* Every API call is written to stdout as one JSON line, which Cloud Run sends to Cloud Logging as a
  structured log (filter: jsonPayload.kind="compass_request").
* Meaningful actions (visits, module opens, exports, proposals, charge-back runs) are stored as usage
  events (Firestore collection `usage` on Cloud Run); estimate calls are throttled to one per user a minute.
* GET /api/admin/usage (header X-Admin-Key = ADMIN_KEY) summarises users, last activity and actions.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from collections import Counter, defaultdict

_last = {}
_lock = threading.Lock()
THROTTLED = ("/api/estimate", "/api/plan", "/api/workload")


def identity(request):
    h = request.headers
    name = (h.get("x-compass-user") or "").strip()[:80]
    email = (h.get("x-compass-email") or "").strip().lower()[:120]
    return name, email


def client_ip(request):
    fwd = request.headers.get("x-forwarded-for", "")
    return (fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else ""))[:64]


def log_line(payload: dict):
    if not (os.environ.get("K_SERVICE") or os.environ.get("LOG_REQUESTS") == "on"):
        return
    try:
        sys.stdout.write(json.dumps({"severity": "INFO", **payload}) + "\n")
        sys.stdout.flush()
    except Exception:  # noqa: BLE001 - logging must never break a request
        pass


def should_store(email, path):
    if path not in THROTTLED:
        return True
    key = (email or "anonymous", path)
    now = time.time()
    with _lock:
        if now - _last.get(key, 0) < 60:
            return False
        _last[key] = now
    return True


def record(store, request, status, ms, action=None, detail=None):
    name, email = identity(request)
    ev = {"ts": time.time(), "name": name, "email": email, "action": action or f"{request.method} {request.url.path}",
          "path": request.url.path, "status": status, "ms": round(ms, 1), "ip": client_ip(request),
          "ua": (request.headers.get("user-agent") or "")[:160]}
    if detail:
        ev["detail"] = str(detail)[:300]
    log_line({"kind": "compass_request", **ev})
    if store is not None and (action or should_store(email, request.url.path)):
        try:
            store.log_event(ev)
        except Exception as e:  # noqa: BLE001
            log_line({"kind": "compass_usage_error", "error": str(e)[:200]})


def admin_ok(request) -> bool:
    key = os.environ.get("ADMIN_KEY", "")
    if not key:
        return not os.environ.get("K_SERVICE")          # open locally, closed on Cloud Run until a key is set
    return request.headers.get("x-admin-key", "") == key


def summary(events: list[dict]) -> dict:
    users = defaultdict(lambda: {"name": "", "email": "", "first": None, "last": None, "events": 0, "actions": Counter(), "days": set()})
    actions = Counter()
    by_day = Counter()
    for e in events:
        k = e.get("email") or e.get("name") or "anonymous"
        u = users[k]
        u["name"] = e.get("name") or u["name"]
        u["email"] = e.get("email") or u["email"]
        ts = e.get("ts", 0)
        u["first"] = ts if u["first"] is None else min(u["first"], ts)
        u["last"] = ts if u["last"] is None else max(u["last"], ts)
        u["events"] += 1
        a = e.get("action", "")
        u["actions"][a] += 1
        day = time.strftime("%Y-%m-%d", time.gmtime(ts))
        u["days"].add(day)
        actions[a] += 1
        by_day[day] += 1
    rows = []
    for k, u in users.items():
        rows.append({"key": k, "name": u["name"], "email": u["email"], "first": u["first"], "last": u["last"],
                     "events": u["events"], "active_days": len(u["days"]),
                     "top_actions": [{"action": a, "count": c} for a, c in u["actions"].most_common(5)]})
    rows.sort(key=lambda r: -(r["last"] or 0))
    return {"users": rows, "user_count": len(rows), "event_count": len(events),
            "actions": [{"action": a, "count": c} for a, c in actions.most_common(20)],
            "by_day": [{"day": d, "events": c} for d, c in sorted(by_day.items())][-60:],
            "recent": sorted(events, key=lambda e: -e.get("ts", 0))[:200]}
