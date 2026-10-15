"""Saved scenarios, sharing, versions, compare and spreadsheet import (memory store, dev sign-in)."""
import io
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

SAMPLE = json.loads((Path(__file__).resolve().parents[1] / "samples" / "retail-bank-ksa.json").read_text())


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("AUTH_DEV_USER", "alice@example.com")
    monkeypatch.setenv("LIVE_PRICING", "off")
    from app import store
    store._store = store.MemoryStore()
    from app.main import app
    return TestClient(app)


def as_user(email):
    return {"Authorization": f"Dev {email}"}


def test_save_version_share_flow(client):
    r = client.post("/api/scenarios", json={"scenario": SAMPLE, "title": "Bank v1", "note": "first"}, headers=as_user("alice@example.com"))
    assert r.status_code == 200, r.text
    doc = r.json()
    sid = doc["id"]
    assert doc["version"] == 1 and doc["summary"]["year1"] > 0 and doc["role"] == "owner"

    sc2 = {**SAMPLE, "customer": "Bank (option B)"}
    r = client.put(f"/api/scenarios/{sid}", json={"scenario": sc2, "note": "more sources", "base_version": 1}, headers=as_user("alice@example.com"))
    assert r.json()["version"] == 2
    stale = client.put(f"/api/scenarios/{sid}", json={"scenario": sc2, "base_version": 1}, headers=as_user("alice@example.com"))
    assert stale.status_code == 409

    vers = client.get(f"/api/scenarios/{sid}/versions", headers=as_user("alice@example.com")).json()
    assert [v["version"] for v in vers] == [2, 1]
    v1 = client.get(f"/api/scenarios/{sid}/versions/1", headers=as_user("alice@example.com")).json()
    assert v1["scenario"]["customer"] == SAMPLE["customer"]

    assert client.get(f"/api/scenarios/{sid}", headers=as_user("bob@example.com")).status_code == 403
    client.post(f"/api/scenarios/{sid}/share", json={"viewers": ["Bob@example.com"]}, headers=as_user("alice@example.com"))
    bob = client.get(f"/api/scenarios/{sid}", headers=as_user("bob@example.com")).json()
    assert bob["role"] == "view"
    assert client.put(f"/api/scenarios/{sid}", json={"scenario": sc2}, headers=as_user("bob@example.com")).status_code == 403
    assert [d["id"] for d in client.get("/api/scenarios", headers=as_user("bob@example.com")).json()] == [sid]

    client.post(f"/api/scenarios/{sid}/share", json={"link_access": "edit"}, headers=as_user("alice@example.com"))
    assert client.put(f"/api/scenarios/{sid}", json={"scenario": sc2}, headers=as_user("carol@example.com")).status_code == 200
    assert client.delete(f"/api/scenarios/{sid}", headers=as_user("carol@example.com")).status_code == 403
    assert client.delete(f"/api/scenarios/{sid}", headers=as_user("alice@example.com")).status_code == 200


def test_sign_in_required_without_dev_user(monkeypatch):
    monkeypatch.delenv("AUTH_DEV_USER", raising=False)
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "x.apps.googleusercontent.com")
    from app.main import app
    c = TestClient(app)
    assert c.get("/api/scenarios").status_code == 401
    assert c.post("/api/estimate", json={"sources": []}).status_code == 200      # estimates stay open


def test_compare(client):
    b = {**SAMPLE, "bq": {"mode": "ondemand"}}
    r = client.post("/api/compare", json={"scenarios": [SAMPLE, b], "labels": ["Editions", "On-demand"]})
    assert r.status_code == 200
    a, o = r.json()
    assert a["label"] == "Editions" and o["bigquery"]["mode"] == "ondemand"
    assert a["by_option"]["payg"]["totals"]["year1"] != o["by_option"]["payg"]["totals"]["year1"]


def test_spreadsheet_template_import(client):
    tpl = client.get("/api/assist/template.csv").text
    assert tpl.startswith("name,type,frequency")
    csv = "Name,Type,Frequency,Daily change GB,Initial volume GB,Location\nCore,Oracle Database,CDC,60,8 TB,on-prem\nX,unknown thing,daily,1,1,on_prem\n"
    r = client.post("/api/assist/file", files={"file": ("inv.csv", io.BytesIO(csv.encode()), "text/csv")},
                    headers=as_user("alice@example.com"))
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["method"] == "template" and d["sources"][0]["type"] == "oracle"
    assert d["sources"][0]["frequency"] == "near_realtime" and d["sources"][0]["initial_volume_gb"] == 8000
    assert any("unknown type" in a for a in d["assumptions"])


def test_assist_clean_drops_invalid_values():
    from app.assist import clean
    out = clean({"sources": [{"name": "A", "type": "oracle", "frequency": "bogus", "daily_change_gb": -5},
                             {"name": "B", "type": "not-a-type"}],
                 "components": [{"type": "looker", "reason": "BI"}, {"type": "looker"}, {"type": "nope"}],
                 "questions": ["q"], "assumptions": []})
    assert [s["name"] for s in out["sources"]] == ["A"] and out["sources"][0]["frequency"] == "daily"
    assert out["sources"][0]["daily_change_gb"] == 0
    assert [c["type"] for c in out["components"]] == ["looker"]


def test_cors_for_demo_origin(client):
    r = client.options("/api/estimate", headers={"Origin": "https://jithinsl27.github.io", "Access-Control-Request-Method": "POST",
                                                 "Access-Control-Request-Headers": "content-type"})
    assert r.headers.get("access-control-allow-origin") == "https://jithinsl27.github.io"
