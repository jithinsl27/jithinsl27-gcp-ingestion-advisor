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
    assert {b["key"] for b in r["platform"]["layer"]["story"]} >= {"lakehouse"}
    assert r["by_region"] and abs(sum(x["three_year"] for x in r["by_region"]) - t["three_year_payg"]) < 1


def test_region_uplift_increases_cost():
    sc = json.loads(SAMPLES[0].read_text())
    base = estimate({**sc, "region": "us-central1"})["totals"]["year1_payg"]
    dammam = estimate({**sc, "region": "me-central2"})["totals"]["year1_payg"]
    assert dammam > base


def test_removing_components_lowers_cost():
    sc = json.loads(SAMPLES[0].read_text())
    on = estimate(sc)["totals"]["year1_payg"]
    off = estimate({**sc, "components": [], "security": {"enabled": False}})["totals"]["year1_payg"]
    assert off < on


def test_partner_components_are_not_costed():
    sc = json.loads(SAMPLES[0].read_text())
    base = estimate({**sc, "components": []})["totals"]["year1_payg"]
    partners = [{"id": f"p{i}", "type": t} for i, t in enumerate(
        ["power_bi", "tableau", "microstrategy", "qlik", "thoughtspot", "datarobot", "dataiku", "sagemaker", "azure_ai", "databricks", "collibra", "alation", "atlan", "informatica_cdgc"])]
    with_partners = estimate({**sc, "components": partners})
    assert with_partners["totals"]["year1_payg"] == base
    assert len(with_partners["platform"]["layer"]["components"]) == len(partners)


def test_google_database_and_apigee_components_are_costed():
    sc = json.loads(SAMPLES[0].read_text())
    base = estimate({**sc, "components": []})["totals"]["year1_payg"]
    for t in ("apigee", "alloydb", "cloudsql", "spanner", "bigtable", "firestore", "memorystore"):
        r = estimate({**sc, "components": [{"id": "x", "type": t}]})
        assert r["totals"]["year1_payg"] > base, t
        assert any(g["group"] == "APIs & databases" for g in r["by_group"]), t


def test_legacy_platform_block_still_supported():
    sc = json.loads(SAMPLES[0].read_text())
    legacy = {k: v for k, v in sc.items() if k not in ("components", "security")}
    legacy["platform"] = {"bi": {"enabled": True, "tool": "looker_studio_pro", "users": 10}, "agents": {"enabled": False},
                          "gemini_enterprise": {"enabled": False}, "governance": {"enabled": False}}
    r = estimate(legacy)
    assert [c["type"] for c in r["platform"]["layer"]["components"]] == ["looker_studio_pro"]


def test_per_service_regions_and_cross_region_transfer():
    sc = json.loads(SAMPLES[0].read_text())
    sc = {**sc, "region": "US"}
    sc["sources"] = [{**sc["sources"][0], "region": "me-central2"}] + sc["sources"][1:]
    r = estimate(sc)
    regions = {x["region"] for x in r["by_region"]}
    assert {"US", "me-central2"} <= regions
    assert any(s["service"] == "Cross-region data transfer" for s in r["by_service"])


def test_start_months_ramp_costs():
    sc = json.loads(SAMPLES[0].read_text())
    late = {**sc, "sources": [{**s, "start_month": 6} for s in sc["sources"]],
            "components": [{**c, "start_month": 6} for c in sc["components"]]}
    a, b = estimate(sc), estimate(late)
    assert b["totals"]["year1_payg"] < a["totals"]["year1_payg"]
    assert b["monthly"][0]["payg"] < a["monthly"][0]["payg"]


def test_plan_schedules_everything():
    from app.plan import build_plan
    sc = json.loads(SAMPLES[0].read_text())
    p = build_plan(sc)
    assert len(p["waves"]) == len(sc["sources"])
    assert all(2 <= w["go_live_month"] <= p["horizon"] for w in p["waves"])
    assert p["totals"]["ramped_year1"] <= p["totals"]["steady_year1"]
    assert len(p["months"]) == p["horizon"]


def test_workload_example():
    from app.workload import workload_estimate
    r = workload_estimate({"region": "us-central1"})
    t = r["totals"]
    assert 0 < t["ramp_monthly"] < t["steady_monthly"]
    assert t["three_year_payg"] > t["year1_payg"]
    assert {c["category"] for c in r["by_category"]} >= {"Storage", "Query & ELT compute", "Streaming"}


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
    assert client.post("/api/workload", json=sc).status_code == 200
    assert client.post("/api/plan", json=sc).status_code == 200


def test_api_rejects_bad_input():
    assert client.post("/api/estimate", json={"region": "mars-1", "sources": []}).status_code == 422
    bad = {"sources": [{"id": "a", "type": "not-a-db"}]}
    assert client.post("/api/estimate", json=bad).status_code == 422
    assert client.post("/api/estimate", json={"components": [{"id": "a", "type": "nope"}]}).status_code == 422
    assert client.post("/api/workload", json={"region": "us-central1", "workload": {"data_region": "mars-1"}}).status_code == 422
