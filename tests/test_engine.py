import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.catalog import SOURCE_TYPES, TOOLS
from app.estimator import estimate, tiered, load_regions
from app.main import app
from app.recommender import recommend

SAMPLES = sorted((Path(__file__).parents[1] / "samples").glob("*.json"))
client = TestClient(app)


def src(**kw):
    base = {"id": "x", "type": "oracle", "data_type": "structured", "frequency": "near_realtime",
            "location": "on_prem", "transform": "none", "initial_volume_gb": 100, "daily_change_gb": 5}
    base.update(kw)
    return base


@pytest.mark.parametrize("stype", [s["id"] for s in SOURCE_TYPES])
@pytest.mark.parametrize("freq", ["realtime", "hourly", "daily", "one_time"])
def test_every_source_type_gets_known_tools(stype, freq):
    r = recommend(src(type=stype, frequency=freq), {"skill": "sql"})
    assert r.primary in TOOLS
    assert r.chain and all(t in TOOLS for t in r.chain)
    assert all(a["tool"] in TOOLS for a in r.alternatives)
    assert r.rationale


def test_cdc_sources_use_datastream():
    for t in ("oracle", "mysql", "postgresql", "sqlserver", "alloydb"):
        assert recommend(src(type=t)).primary == "datastream"


def test_streaming_events_without_transform_use_bq_subscription():
    r = recommend(src(type="clickstream", frequency="realtime", transform="none", location="saas"))
    assert r.engine == "pubsub_bqsub"


def test_low_code_skill_prefers_data_fusion_for_jdbc():
    r = recommend(src(type="db2", frequency="daily"), {"skill": "low_code"})
    assert r.primary == "datafusion" and r.needs_datafusion


def test_warehouse_migration_uses_dts():
    assert recommend(src(type="teradata", frequency="daily")).primary == "bq_dts"


def test_datastream_tiers():
    assert tiered(1000, [[2500, 2.0], [5000, 1.5], [None, 0.8]]) == 2000
    assert tiered(3000, [[2500, 2.0], [5000, 1.5], [None, 0.8]]) == 2500 * 2 + 500 * 1.5
    assert tiered(6000, [[2500, 2.0], [5000, 1.5], [None, 0.8]]) == 2500 * 2 + 2500 * 1.5 + 1000 * 0.8


@pytest.mark.parametrize("path", SAMPLES, ids=lambda p: p.stem)
def test_samples_estimate(path):
    r = estimate(json.loads(path.read_text()))
    t = r["totals"]
    assert t["year1_payg"] > 0
    assert t["three_year_payg"] > t["year1_payg"]
    assert t["year1_cud1"] <= t["year1_payg"] + 0.01
    assert t["three_year_cud3"] <= t["three_year_payg"] + 0.01
    assert abs(sum(s["three_year"] for s in r["by_service"]) - t["three_year_payg"]) < 1
    assert len(r["monthly"]) == 36
    assert {b["key"] for b in r["platform"]["layer"]["story"]} >= {"lakehouse", "governance"}


def test_region_uplift_increases_cost():
    sc = json.loads(SAMPLES[0].read_text())
    base = estimate({**sc, "region": "us-central1"})["totals"]["year1_payg"]
    dammam = estimate({**sc, "region": "me-central2"})["totals"]["year1_payg"]
    assert dammam > base


def test_toggling_ai_layer_changes_cost():
    sc = json.loads(SAMPLES[0].read_text())
    on = estimate(sc)["totals"]["year1_payg"]
    off_platform = {k: {**v, "enabled": False} for k, v in sc["platform"].items()}
    off = estimate({**sc, "platform": off_platform})["totals"]["year1_payg"]
    assert off < on


def test_regions_unique():
    ids = [r["id"] for r in load_regions()]
    assert len(ids) == len(set(ids))


def test_api_roundtrip():
    assert client.get("/healthz").json()["status"] == "ok"
    cat = client.get("/api/catalog").json()
    assert cat["source_types"] and cat["regions"]
    assert len(client.get("/api/samples").json()) == len(SAMPLES)
    sc = json.loads(SAMPLES[0].read_text())
    res = client.post("/api/estimate", json=sc)
    assert res.status_code == 200, res.text
    assert client.get("/").status_code == 200


def test_api_rejects_bad_input():
    assert client.post("/api/estimate", json={"region": "mars-1", "sources": []}).status_code == 422
    bad = {"sources": [{"id": "a", "type": "not-a-db"}]}
    assert client.post("/api/estimate", json=bad).status_code == 422
