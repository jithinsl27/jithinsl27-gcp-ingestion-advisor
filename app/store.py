"""Saved scenarios: Firestore on Cloud Run, in-memory for local runs and tests.

Data model (Firestore, native mode):
  scenarios/{id}                   owner, title, customer, region, version, created_at, updated_at,
                                   shared_with [emails], editors [emails], link_access ("none"|"view"|"edit"),
                                   summary {year1, three_year, pricing_option}, scenario {...}
  scenarios/{id}/versions/{n}      version, saved_at, saved_by, note, scenario {...}
  system/pricing                   live price / availability cache shared by instances

Access: the owner and editors can save new versions and share; people in
shared_with can open; with link_access set, anyone signed in who has the link can
open (and edit when "edit").
"""
from __future__ import annotations

import copy
import os
import secrets
import threading
import time

from fastapi import HTTPException

MAX_VERSIONS_LISTED = 50


def _now():
    return time.time()


def _j(scenario):
    import json
    return json.dumps(scenario, separators=(",", ":"))


def _dec(doc):
    """Firestore keeps the scenario as JSON text (no nested-array or key restrictions)."""
    import json
    if "scenario_json" in doc:
        doc = dict(doc)
        doc["scenario"] = json.loads(doc.pop("scenario_json"))
    return doc


def _can(doc, email, need):
    if doc["owner"] == email or email in doc.get("editors", []):
        return True
    if need == "view" and (email in doc.get("shared_with", []) or doc.get("link_access") in ("view", "edit")):
        return True
    return need == "edit" and doc.get("link_access") == "edit"


def _public(doc, email, with_scenario=True):
    out = {k: v for k, v in doc.items() if k != "scenario" or with_scenario}
    out["role"] = ("owner" if doc["owner"] == email else "edit" if _can(doc, email, "edit") else "view")
    return out


class MemoryStore:
    kind = "memory"

    def __init__(self):
        self.docs, self.versions, self.kv = {}, {}, {}
        self.lock = threading.Lock()

    # ------------------------------------------------------------------ scenarios
    def create(self, email, title, scenario, summary, note=""):
        sid = secrets.token_urlsafe(9)
        doc = {"id": sid, "owner": email, "title": title or scenario.get("customer") or "Untitled scenario",
               "customer": scenario.get("customer", ""), "region": scenario.get("region", ""),
               "version": 1, "created_at": _now(), "updated_at": _now(), "updated_by": email,
               "shared_with": [], "editors": [], "link_access": "none", "summary": summary, "scenario": scenario}
        with self.lock:
            self.docs[sid] = doc
            self.versions[sid] = [{"version": 1, "saved_at": _now(), "saved_by": email, "note": note or "Created",
                                   "summary": summary, "scenario": copy.deepcopy(scenario)}]
        return _public(doc, email)

    def _get(self, sid):
        doc = self.docs.get(sid)
        if not doc:
            raise HTTPException(status_code=404, detail="Scenario not found")
        return doc

    def get(self, email, sid):
        doc = self._get(sid)
        if not _can(doc, email, "view"):
            raise HTTPException(status_code=403, detail="You do not have access to this scenario")
        return _public(copy.deepcopy(doc), email)

    def save(self, email, sid, scenario, summary, note="", title=None, base_version=None):
        with self.lock:
            doc = self._get(sid)
            if not _can(doc, email, "edit"):
                raise HTTPException(status_code=403, detail="You can view this scenario but not save changes - save a copy instead")
            if base_version is not None and int(base_version) != doc["version"]:
                raise HTTPException(status_code=409, detail=f"Someone saved version {doc['version']} meanwhile - reload it or save a copy")
            v = doc["version"] + 1
            doc.update({"version": v, "updated_at": _now(), "updated_by": email, "summary": summary, "scenario": scenario,
                        "customer": scenario.get("customer", ""), "region": scenario.get("region", "")})
            if title:
                doc["title"] = title
            self.versions[sid].append({"version": v, "saved_at": _now(), "saved_by": email, "note": note,
                                       "summary": summary, "scenario": copy.deepcopy(scenario)})
            return _public(copy.deepcopy(doc), email)

    def list_for(self, email):
        rows = [_public(d, email, with_scenario=False) for d in self.docs.values()
                if d["owner"] == email or email in d.get("shared_with", []) or email in d.get("editors", [])]
        return sorted(rows, key=lambda d: -d["updated_at"])

    def list_versions(self, email, sid):
        self.get(email, sid)
        return [{k: v for k, v in x.items() if k != "scenario"} for x in reversed(self.versions[sid][-MAX_VERSIONS_LISTED:])]

    def get_version(self, email, sid, version):
        self.get(email, sid)
        for x in self.versions[sid]:
            if x["version"] == int(version):
                return copy.deepcopy(x)
        raise HTTPException(status_code=404, detail="Version not found")

    def share(self, email, sid, viewers, editors, link_access):
        with self.lock:
            doc = self._get(sid)
            if doc["owner"] != email and email not in doc.get("editors", []):
                raise HTTPException(status_code=403, detail="Only the owner or an editor can share")
            doc["shared_with"], doc["editors"], doc["link_access"] = viewers, editors, link_access
            return _public(copy.deepcopy(doc), email, with_scenario=False)

    def delete(self, email, sid):
        with self.lock:
            doc = self._get(sid)
            if doc["owner"] != email:
                raise HTTPException(status_code=403, detail="Only the owner can delete")
            self.docs.pop(sid, None)
            self.versions.pop(sid, None)

    # ------------------------------------------------------------------ small key/value cache
    def kv_get(self, key):
        return self.kv.get(key)

    def kv_put(self, key, value):
        self.kv[key] = value

    def kv_delete(self, key):
        self.kv.pop(key, None)

    # ------------------------------------------------------------------ usage events (who uses the tool)
    def log_event(self, ev):
        with self.lock:
            ev_ = getattr(self, "events", None)
            if ev_ is None:
                self.events = ev_ = []
            ev_.append(dict(ev))
            del ev_[:-20000]

    def list_events(self, since=0.0, limit=5000):
        return [e for e in getattr(self, "events", []) if e.get("ts", 0) >= since][-limit:]

    # ------------------------------------------------------------------ charge-back requests
    def cb_list(self):
        return sorted(getattr(self, "cb", {}).values(), key=lambda d: -d.get("created_at", 0))

    def cb_put(self, doc):
        if not hasattr(self, "cb"):
            self.cb = {}
        self.cb[doc["id"]] = doc
        return doc

    def cb_delete(self, rid):
        getattr(self, "cb", {}).pop(rid, None)


class FirestoreStore(MemoryStore):
    kind = "firestore"

    def __init__(self, database=None):
        from google.cloud import firestore
        self.fs = firestore
        self.db = firestore.Client(database=database or os.environ.get("FIRESTORE_DATABASE", "(default)"))
        self.col = self.db.collection("scenarios")

    def create(self, email, title, scenario, summary, note=""):
        sid = secrets.token_urlsafe(9)
        doc = {"id": sid, "owner": email, "title": title or scenario.get("customer") or "Untitled scenario",
               "customer": scenario.get("customer", ""), "region": scenario.get("region", ""),
               "version": 1, "created_at": _now(), "updated_at": _now(), "updated_by": email,
               "shared_with": [], "editors": [], "link_access": "none", "summary": summary, "scenario_json": _j(scenario)}
        batch = self.db.batch()
        batch.set(self.col.document(sid), doc)
        batch.set(self.col.document(sid).collection("versions").document("1"),
                  {"version": 1, "saved_at": _now(), "saved_by": email, "note": note or "Created", "summary": summary, "scenario_json": _j(scenario)})
        batch.commit()
        return _public(_dec(doc), email)

    def _get(self, sid):
        snap = self.col.document(sid).get()
        if not snap.exists:
            raise HTTPException(status_code=404, detail="Scenario not found")
        return _dec(snap.to_dict())

    def get(self, email, sid):
        doc = self._get(sid)
        if not _can(doc, email, "view"):
            raise HTTPException(status_code=403, detail="You do not have access to this scenario")
        return _public(doc, email)

    def save(self, email, sid, scenario, summary, note="", title=None, base_version=None):
        ref = self.col.document(sid)
        transaction = self.db.transaction()

        @self.fs.transactional
        def run(tx):
            snap = ref.get(transaction=tx)
            if not snap.exists:
                raise HTTPException(status_code=404, detail="Scenario not found")
            doc = _dec(snap.to_dict())
            if not _can(doc, email, "edit"):
                raise HTTPException(status_code=403, detail="You can view this scenario but not save changes - save a copy instead")
            if base_version is not None and int(base_version) != doc["version"]:
                raise HTTPException(status_code=409, detail=f"Someone saved version {doc['version']} meanwhile - reload it or save a copy")
            v = doc["version"] + 1
            upd = {"version": v, "updated_at": _now(), "updated_by": email, "summary": summary, "scenario_json": _j(scenario),
                   "customer": scenario.get("customer", ""), "region": scenario.get("region", "")}
            if title:
                upd["title"] = title
            tx.update(ref, upd)
            tx.set(ref.collection("versions").document(str(v)),
                   {"version": v, "saved_at": _now(), "saved_by": email, "note": note, "summary": summary, "scenario_json": _j(scenario)})
            doc.update(upd)
            return _dec(doc)
        return _public(run(transaction), email)

    def list_for(self, email):
        seen, rows = set(), []
        from google.cloud.firestore_v1.base_query import FieldFilter
        for q in (self.col.where(filter=FieldFilter("owner", "==", email)),
                  self.col.where(filter=FieldFilter("shared_with", "array_contains", email)),
                  self.col.where(filter=FieldFilter("editors", "array_contains", email))):
            for snap in q.select(["id", "owner", "title", "customer", "region", "version", "created_at", "updated_at",
                                  "updated_by", "shared_with", "editors", "link_access", "summary"]).stream():
                d = snap.to_dict()
                if d["id"] not in seen:
                    seen.add(d["id"])
                    rows.append(_public(d, email, with_scenario=False))
        return sorted(rows, key=lambda d: -d["updated_at"])

    def list_versions(self, email, sid):
        self.get(email, sid)
        q = (self.col.document(sid).collection("versions").order_by("version", direction=self.fs.Query.DESCENDING)
             .limit(MAX_VERSIONS_LISTED).select(["version", "saved_at", "saved_by", "note", "summary"]))
        return [s.to_dict() for s in q.stream()]

    def get_version(self, email, sid, version):
        self.get(email, sid)
        snap = self.col.document(sid).collection("versions").document(str(int(version))).get()
        if not snap.exists:
            raise HTTPException(status_code=404, detail="Version not found")
        return _dec(snap.to_dict())

    def share(self, email, sid, viewers, editors, link_access):
        doc = self._get(sid)
        if doc["owner"] != email and email not in doc.get("editors", []):
            raise HTTPException(status_code=403, detail="Only the owner or an editor can share")
        self.col.document(sid).update({"shared_with": viewers, "editors": editors, "link_access": link_access})
        doc.update({"shared_with": viewers, "editors": editors, "link_access": link_access})
        return _public(doc, email, with_scenario=False)

    def delete(self, email, sid):
        doc = self._get(sid)
        if doc["owner"] != email:
            raise HTTPException(status_code=403, detail="Only the owner can delete")
        ref = self.col.document(sid)
        for v in ref.collection("versions").stream():
            v.reference.delete()
        ref.delete()

    def kv_get(self, key):
        import json
        snap = self.db.collection("system").document(key).get()
        return json.loads(snap.to_dict()["json"]) if snap.exists else None

    def kv_put(self, key, value):
        import json
        self.db.collection("system").document(key).set({"json": json.dumps(value), "updated_at": _now()})

    def kv_delete(self, key):
        self.db.collection("system").document(key).delete()

    def log_event(self, ev):
        self.db.collection("usage").add(dict(ev))

    def list_events(self, since=0.0, limit=5000):
        q = (self.db.collection("usage").where("ts", ">=", since)
             .order_by("ts", direction=self.fs.Query.DESCENDING).limit(limit))
        return list(reversed([d.to_dict() for d in q.stream()]))

    def cb_list(self):
        import json
        return [json.loads(d.to_dict()["json"]) for d in
                self.db.collection("chargeback").order_by("created_at", direction=self.fs.Query.DESCENDING).limit(500).stream()]

    def cb_put(self, doc):
        import json
        self.db.collection("chargeback").document(doc["id"]).set({"json": json.dumps(doc), "created_at": doc.get("created_at", _now())})
        return doc

    def cb_delete(self, rid):
        self.db.collection("chargeback").document(rid).delete()


_store = None


def get_store():
    """Firestore when STORE=firestore (set by deploy.sh), memory otherwise."""
    global _store
    if _store is None:
        _store = FirestoreStore() if os.environ.get("STORE", "memory") == "firestore" else MemoryStore()
    return _store
