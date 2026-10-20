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
    types = [c["type"] for c in r["platform"]["layer"]["components"]]
    assert types[0] == "looker_studio_pro" and "agent_platform" not in types
    assert {"sdp", "cmek", "vpc_sc"} <= set(types)  # legacy security toggles become components


def test_security_is_dynamic():
    sc = json.loads(SAMPLES[0].read_text())
    no_sec = [c for c in sc["components"] if c["type"] not in ("sdp", "cmek", "vpc_sc", "policy_tags", "scc", "assured_workloads")]
    r = estimate({**sc, "components": no_sec})
    assert not any(s["service"].startswith(("Sensitive Data", "Cloud KMS")) for s in r["by_service"])
    assert not any(b["key"] == "security" for b in r["platform"]["layer"]["story"])


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


def test_excluded_sources_drop_out_of_estimate_and_plan():
    from app.plan import build_plan
    sc = json.loads(SAMPLES[0].read_text())
    part = {**sc, "sources": [{**s, "included": i < 2} for i, s in enumerate(sc["sources"])]}
    full, phase1 = estimate(sc), estimate(part)
    assert len(phase1["recommendations"]) == 2
    assert phase1["totals"]["year1_payg"] < full["totals"]["year1_payg"]
    assert len(build_plan(part)["waves"]) == 2


def test_services_and_components_can_be_left_out_of_pricing():
    sc = json.loads(SAMPLES[0].read_text())
    full = estimate(sc)
    no_composer = estimate({**sc, "excluded_services": ["Datastream (CDC)", "Contingency & operations"]})
    assert not any(s["service"] in ("Datastream (CDC)", "Contingency & operations") for s in no_composer["by_service"])
    assert no_composer["totals"]["year1_payg"] < full["totals"]["year1_payg"]
    comps = [{**c, "included": c["type"] != "gemini_enterprise"} for c in sc["components"]]
    r = estimate({**sc, "components": comps})
    assert not any(s["service"] == "Gemini Enterprise" for s in r["by_service"])
    assert any(c["type"] == "gemini_enterprise" and not c["included"] for c in r["platform"]["layer"]["components"])


# --------------------------------------------------------------------------- environments, BOM, lakehouse, IoT, modes, slots
from app.workload import workload_estimate  # noqa: E402


def _base(**kw):
    sc = {"region": "us-central1", "bq_model": "ondemand", "contingency_pct": 10,
          "sources": [src(id="a", type="oracle", frequency="near_realtime", daily_change_gb=50, initial_volume_gb=1000),
                      src(id="b", type="files_onprem", frequency="daily", daily_change_gb=20, initial_volume_gb=500)],
          "components": [{"id": "c1", "type": "looker", "settings": {}}, {"id": "c2", "type": "gemini_enterprise", "settings": {}},
                         {"id": "c3", "type": "apigee", "settings": {}}]}
    sc.update(kw)
    return sc


def test_environments_add_scaled_cost_and_sum_to_total():
    one = estimate(_base())
    three = estimate(_base(environments=[{"id": "prod"}, {"id": "dev", "preset": "dev"}, {"id": "uat", "preset": "uat"}]))
    assert len(three["environments"]) == 3
    assert three["totals"]["three_year_payg"] > one["totals"]["three_year_payg"]
    assert sum(e["three_year"] for e in three["environments"]) == pytest.approx(three["totals"]["three_year_payg"], abs=1)
    assert three["environments"][0]["three_year"] == pytest.approx(one["totals"]["three_year_payg"], abs=1)
    dev = three["environments"][1]
    assert 0 < dev["three_year"] < three["environments"][0]["three_year"] * 0.5


def test_environment_factor_zero_adds_nothing_and_network_is_shared():
    sc = _base(environments=[{"id": "p"}, {"id": "z", "preset": "dev", **{f: 0 for f in ("data_pct", "ingestion_pct", "compute_pct", "ai_pct", "apps_pct", "platform_pct")}}])
    r = estimate(sc)
    assert r["environments"][1]["three_year"] == 0
    assert r["totals"]["three_year_payg"] == pytest.approx(estimate(_base())["totals"]["three_year_payg"], abs=0.5)


def test_bom_rows_have_quantities_units_and_reasons():
    r = estimate(_base())
    assert r["bom"]
    total = sum(b["three_year"] for b in r["bom"])
    assert total == pytest.approx(r["totals"]["three_year_payg"], abs=1)
    ds = next(b for b in r["bom"] if b["service"] == "Datastream (CDC)")
    assert ds["unit"] == "GiB" and ds["qty_month12"] > 0 and ds["unit_price"] > 0
    assert "Driven by" in ds["why"]
    assert all(b["why"] for b in r["bom"])


def test_raw_zone_and_medallion_layers():
    on = estimate(_base())
    off = estimate(_base(lakehouse={"raw_zone": False}))
    svcs_on = {s["service"] for s in on["by_service"]}
    assert "Cloud Storage (raw zone)" in svcs_on
    assert "Cloud Storage (raw zone)" not in {s["service"] for s in off["by_service"]}
    layers = on["platform"]["lakehouse"]["layers"]
    assert [l["id"] for l in layers] == ["bronze", "silver", "gold"]
    more_gold = estimate(_base(lakehouse={"gold_pct": 80}))
    bq = lambda r: next(s["three_year"] for s in r["by_service"] if s["service"] == "BigQuery storage")  # noqa: E731
    assert bq(more_gold) > bq(on)


def test_iot_options_change_pattern_and_cost():
    native = recommend(src(type="iot", frequency="realtime", iot_option="native"), {})
    litmus = recommend(src(type="iot", frequency="realtime", iot_option="litmus"), {})
    mqtt = recommend(src(type="iot", frequency="realtime", iot_option="mqtt_broker"), {})
    assert litmus.chain[0] == "litmus" and litmus.primary == "litmus"
    assert "mqtt_broker" in mqtt.engine
    assert native.chain[0] == "pubsub"
    sc = lambda opt: {"sources": [src(type="iot", frequency="realtime", daily_change_gb=10, iot_option=opt)]}  # noqa: E731
    assert "MQTT broker (Compute Engine)" in {s["service"] for s in estimate(sc("mqtt_broker"))["by_service"]}
    assert estimate(sc("litmus"))["totals"]["three_year_payg"] == pytest.approx(estimate(sc("native"))["totals"]["three_year_payg"])


def test_gemini_enterprise_grounding_and_apigee_role():
    bq_q = lambda r: [s for s in r["by_service"] if s["service"] == "BigQuery queries from Gemini Enterprise"]  # noqa: E731
    assert bq_q(estimate(_base()))
    agents_only = _base()
    agents_only["components"][1]["settings"] = {"grounding": "agents"}
    assert not bq_q(estimate(agents_only))
    looker = _base()
    looker["components"][1]["settings"] = {"grounding": "looker"}
    view = next(c for c in estimate(looker)["platform"]["layer"]["components"] if c["type"] == "gemini_enterprise")
    assert "Looker" in view["mode_note"]
    ap = _base()
    ap["components"][2]["settings"] = {"role": "agents"}
    row = next(b for b in estimate(ap)["bom"] if b["service"] == "Apigee (environment)")
    assert "AI gateway" in row["why"]


def test_slot_sizing_recommendation():
    w = workload_estimate({"region": "us-central1", "components": [], "workload": {}})
    sl = w["slots"]
    assert sl["max_slots"] % 50 == 0 and sl["max_slots"] >= sl["baseline_slots"]
    assert sl["edition"] in ("standard", "enterprise", "enterprise_plus")
    assert sl["recommendations"] and len(sl["profile"]) == 24
    big = workload_estimate({"region": "us-central1", "components": [{"id": "c", "type": "vpc_sc"}],
                             "workload": {"data": {"structured_tb": 2000}, "pipelines": {"simple": 2000, "medium": 1000, "complex": 500, "runs_per_day": 4},
                                           "slots": {"batch_window_hours": 24}}})["slots"]
    assert big["edition"] == "enterprise"
    assert big["avg_slots"] > sl["avg_slots"]
    assert big["model"] == "editions" and big["baseline_slots"] > 0


def test_standard_edition_has_no_commitments():
    w = workload_estimate({"region": "us-central1", "components": [], "workload": {"slots": {"edition": "standard"}}})
    assert w["slots"]["baseline_slots"] == 0


def test_api_accepts_new_fields():
    c = TestClient(app)
    body = _base(environments=[{"id": "p", "name": "Prod"}, {"id": "d", "preset": "dev", "bq_slots": 50}],
                 lakehouse={"raw_scope": "all", "raw_storage_class": "nearline"})
    body["sources"].append(src(id="i", type="iot", frequency="realtime", iot_option="clearblade", daily_change_gb=1e6))
    r = c.post("/api/estimate", json=body)
    assert r.status_code == 200, r.text
    assert len(r.json()["environments"]) == 2
    cfg = c.get("/api/config").json()
    assert cfg["google_client_id"] == "" and cfg["auth"] is False and cfg["pricing"]["source"] in ("static", "live")


def test_nothing_designed_costs_nothing():
    from app.estimator import estimate
    for model in ("ondemand", "standard", "enterprise", "enterprise_plus"):
        out = estimate({"sources": [], "components": [], "bq_model": model, "bq_slots": 400,
                        "environments": [{"id": "prod", "preset": "prod"}, {"id": "dev", "preset": "dev"}]})
        assert out["totals"]["three_year_payg"] == 0
        assert out["bom"] == []


def test_env_slots_auto_sized_and_editable():
    from app.estimator import estimate
    sc = {"region": "us-central1", "bq": {"mode": "editions", "edition": "enterprise"}, "components": [],
          "sources": [{"id": "s1", "type": "oracle", "frequency": "near_realtime", "daily_change_gb": 500, "initial_volume_gb": 50000}],
          "environments": [{"id": "prod", "preset": "prod"}, {"id": "dev", "preset": "dev"},
                           {"id": "uat", "preset": "uat", "bq_baseline": 100, "bq_max": 300}]}
    out = estimate(sc)
    bq = out["bigquery"]
    assert bq["edition"] == "enterprise" and bq["auto_max"] >= 50
    assert bq["baseline"] == bq["auto_baseline"] and bq["max"] == bq["auto_max"]
    s = {e["id"]: e["slots"] for e in out["environments"]}
    assert s["uat"]["baseline"] == 100 and s["uat"]["max"] == 300 and s["uat"]["baseline_set"]
    assert s["dev"]["baseline"] == 0          # dev runs part-time -> autoscaling only
    assert not s["prod"]["baseline_set"]
    for b in out["bom"]:
        if b["unit"]:
            assert b["qty_three_year"] >= b["qty_year1"]
    assert abs(sum(b["three_year"] for b in out["bom"]) - out["totals"]["three_year_payg"]) < 1
    # architect override wins and commitments only discount the baseline
    sc["bq"].update({"baseline_slots": 300, "max_slots": 600})
    out2 = estimate(sc)
    assert out2["bigquery"]["baseline"] == 300 and out2["bigquery"]["max"] == 600
    t = out2["by_option"]
    assert t["cud3"]["totals"]["three_year"] < t["cud1"]["totals"]["three_year"] < t["payg"]["totals"]["three_year"]


def test_standard_edition_has_no_baseline():
    from app.estimator import estimate
    out = estimate({"bq": {"mode": "editions", "edition": "standard", "baseline_slots": 500}, "components": [],
                    "sources": [{"id": "s1", "type": "oracle", "frequency": "daily", "daily_change_gb": 100}]})
    assert out["bigquery"]["baseline"] == 0
    assert any("no baseline" in w for w in out["bigquery"]["warnings"])


def test_runtime_hours_scale_always_on_services():
    from app.estimator import estimate
    base = {"region": "us-central1", "components": [],
            "sources": [{"id": "k", "type": "kafka", "frequency": "realtime", "daily_change_gb": 200, "transform": "heavy"}]}
    full = estimate({**base, "environments": [{"id": "p", "preset": "prod"}, {"id": "d", "preset": "dev", "runtime_pct": 100}]})
    part = estimate({**base, "environments": [{"id": "p", "preset": "prod"}, {"id": "d", "preset": "dev", "runtime_pct": 36}]})
    df = lambda o: next(b["year1"] for b in o["bom"] if b["environment"] == "d" and b["service"] == "Dataflow (streaming)")  # noqa: E731
    assert abs(df(part) / df(full) - 0.36) < 0.01


def test_scan_basis_measured_calibrates_slot_hours():
    from app.estimator import estimate
    out = estimate({"bq": {"mode": "editions", "measured_scan_tib_month": 100, "measured_slot_hours_month": 4000}, "components": [],
                    "sources": [{"id": "s1", "type": "oracle", "frequency": "daily", "daily_change_gb": 10}]})
    b = out["bigquery"]
    assert b["scan_basis"] == "measured" and b["slot_hours_per_tib"] == 40
    assert abs(b["slot_hours_month"] - b["scan_tib_month"] * 40) < 1


def test_commercial_discount_support_and_range():
    from app.estimator import estimate, support_fee, load_pricing
    base = {"components": [], "sources": [{"id": "s1", "type": "oracle", "frequency": "near_realtime", "daily_change_gb": 300}]}
    a = estimate(base)
    b = estimate({**base, "commercial": {"discount_pct": 10, "support_plan": "enhanced", "range_low_pct": -10, "range_high_pct": 20}})
    ya, yb = a["totals"]["year1_payg"], b["totals"]["year1_payg"]
    support = next(r["year1"] for r in b["by_service"] if r["service"].startswith("Google Cloud Customer Care"))
    assert abs(yb - (ya * 0.9 + support)) < 1
    assert abs(sum(r["year1"] for r in b["bom"]) - yb) < 1
    assert abs(sum(e["year1"] for e in b["environments"]) - yb) < 1
    assert b["totals"]["range_high_1y"] == round(yb * 1.2, 2)
    p = load_pricing()
    assert support_fee(500, "enhanced", p) == 100            # minimum
    assert abs(support_fee(20000, "enhanced", p) - (1000 + 700)) < 1e-6
    assert support_fee(1000, "premium", p) == 15000
# --------------------------------------------------------------------------- targets, custom sources, pricing plans
from app.plan import build_plan  # noqa: E402


def test_custom_source_follows_like_type():
    r = recommend(src(type="custom", custom_name="Workday", like_type="saas_other", frequency="daily"), {})
    assert "Workday" in r.rationale[0]
    assert r.primary == recommend(src(type="saas_other", frequency="daily"), {}).primary
    res = client.post("/api/estimate", json={"sources": [src(type="custom", custom_name="Workday", like_type="saas_other", target="data_lake")]})
    assert res.status_code == 200
    rec = res.json()["recommendations"][0]
    assert "Workday" in rec["rationale"][1] and rec["target"] == "data_lake"


def test_targets_change_pattern_and_cost():
    lake = recommend(src(type="files_onprem", frequency="daily", target="data_lake"), {})
    assert lake.target == "data_lake" and lake.chain[-1] == "gcs_lake"
    opdb = recommend(src(type="postgresql", target="operational_db"), {})
    assert opdb.engine == "dms_native"
    hetero = recommend(src(type="oracle", target="operational_db"), {})
    assert hetero.engine == "dms_hetero"
    # not allowed -> falls back to the data platform
    assert recommend(src(type="salesforce", target="data_lake"), {}).target == "data_platform"
    e_lake = estimate({"sources": [src(type="files_onprem", frequency="daily", daily_change_gb=50, target="data_lake")]})
    svcs = {s["service"] for s in e_lake["by_service"]}
    assert "Cloud Storage (data lake)" in svcs and "BigQuery storage" not in svcs and "BigQuery compute" not in svcs
    e_ora = estimate({"sources": [src(type="oracle", daily_change_gb=50, initial_volume_gb=2000, target="operational_db")]})
    svcs = {s["service"] for s in e_ora["by_service"]}
    assert "Database Migration Service (CDC)" in svcs and "Database Migration Service (backfill)" in svcs
    assert e_ora["platform"]["targets"]["operational_db"]


def test_pricing_plans_are_consistent():
    sc = json.loads((Path(__file__).parents[1] / "samples" / "retail-bank-ksa.json").read_text())
    pr = build_plan(sc)["pricing"]
    for view in ("ramped", "steady"):
        p = pr[view]["plans"]
        assert p["commit_1y"]["total"] <= p["payg_1y"]["total"]
        assert p["commit_3y"]["total"] <= p["payg_3y"]["total"]
        assert sum(p["commit_3y"]["by_year"]) == pytest.approx(p["commit_3y"]["total"], abs=0.1)
        prods = pr[view]["products"]
        assert sum(sum(x["payg"][:12]) for x in prods) == pytest.approx(p["payg_1y"]["total"], abs=1)
        assert any(x["commit_eligible"] for x in prods)
    # ramp-up makes year 1 cheaper than running everything from month 1
    assert pr["ramped"]["plans"]["payg_1y"]["total"] < pr["steady"]["plans"]["payg_1y"]["total"]


# ---------------------------------------------------------------- kickoff readiness and Gemini 3.8
from app.plan import build_plan  # noqa: E402


@pytest.mark.parametrize("path", SAMPLES, ids=lambda p: p.stem)
def test_readiness_follows_the_architecture(path):
    sc = json.loads(path.read_text())
    sc = sc.get("scenario", sc)
    rd = build_plan(sc)["readiness"]
    assert rd["summary"]["items"] == len(rd["checklist"]) > 20
    assert {c["owner"] for c in rd["checklist"]} <= {"Customer", "Partner", "Joint"}
    names = [m["name"] for m in rd["milestones"]]
    assert names[0] == "Mobilise & kickoff" and "Landing zone ready" in names and names[-1].startswith("Hypercare")
    assert [m["month"] for m in rd["milestones"]] == sorted(m["month"] for m in rd["milestones"])
    roles = {r["role"] for r in rd["team"]["partner"]}
    assert {"Data & AI solution architect", "Data engineer", "Cloud platform engineer"} <= roles
    assert rd["team"]["partner_fte"] == sum(r["count"] for r in rd["team"]["partner"])
    # every included source gets its own owner / SME item
    for s in sc["sources"]:
        if s.get("included", True):
            assert any(s["name"] in c["item"] for c in rd["checklist"]), s["name"]


def test_readiness_items_depend_on_components_and_sources():
    base = {"region": "us-central1", "sources": [{"id": "s1", "name": "ERP", "type": "oracle", "frequency": "near_realtime", "location": "on_prem",
                                                  "initial_volume_gb": 500, "daily_change_gb": 10}], "components": []}
    rd = build_plan(base)["readiness"]
    text = " ".join(c["item"] for c in rd["checklist"])
    assert "supplemental logging" in text and "ordered" in text  # CDC prerequisites and private connectivity
    assert "Cloud KMS" not in text and "AI use cases" not in text
    rd2 = build_plan({**base, "components": [{"id": "c1", "type": "cmek", "settings": {}}, {"id": "c2", "type": "agent_platform", "settings": {}}]})["readiness"]
    text2 = " ".join(c["item"] for c in rd2["checklist"])
    assert "Cloud KMS" in text2 and "AI use cases" in text2 and "Gemini 3.8 Flash" in text2
    assert any(r["role"] == "AI / ML engineer" for r in rd2["team"]["partner"])
    more = build_plan({**base, "plan": {"teams": 4}})["readiness"]
    de = lambda r: next(x["count"] for x in r["team"]["partner"] if x["role"] == "Data engineer")  # noqa: E731
    assert de(more) > de(rd)


def test_gemini_38_flash_is_the_default_agent_model():
    from app.components import COMPONENT_BY_ID
    pricing = json.loads((Path(__file__).parents[1] / "app" / "data" / "pricing.json").read_text())
    assert pricing["gemini_models"]["flash"]["name"] == "Gemini 3.8 Flash"
    assert pricing["gemini_models"]["flash"]["model_id"] == "gemini-3.8-flash"
    model = next(f for f in COMPONENT_BY_ID["agent_platform"]["settings"] if f["key"] == "model")
    assert model["default"] == "flash"
    sc = {"region": "us-central1", "sources": [], "components": [{"id": "c1", "type": "agent_platform", "settings": {}}]}
    lines = [b["service"] for b in estimate(sc)["bom"]]
    assert any("Gemini 3.8 Flash tokens" in s for s in lines)


# ---------------------------------------------------------------- v3: slot rules, plan specs, BOM edits, use cases, charge-back, usage
from app import slots as SLT  # noqa: E402
from app.chargeback import match_services, parse_price_sheet, price_request, template_rows  # noqa: E402


def test_slot_rules_start_at_100_then_steps_of_50():
    assert SLT.res_max(0) == 0 and SLT.res_max(1) == 100 and SLT.res_max(101) == 150 and SLT.res_max(260) == 300
    assert SLT.res_baseline(99) == 0 and SLT.res_baseline(120) == 100 and SLT.res_baseline(180) == 150
    assert SLT.snap_baseline(1) == 100 and SLT.snap_baseline(130) == 150 and SLT.snap_baseline(0) == 0


@pytest.mark.parametrize("path", SAMPLES, ids=lambda p: p.stem)
def test_bigquery_spec_per_environment_and_plan(path):
    sc = json.loads(path.read_text())
    sc = {**sc.get("scenario", sc), "bq": {"mode": "editions", "edition": "enterprise"}}
    b = estimate(sc)["bigquery"]
    assert len(b["env_specs"]) == len(sc.get("environments") or [1])
    for e in b["env_specs"]:
        for o in ("payg", "cud1", "cud3"):
            x = e["by_option"][o]
            assert x["baseline"] == 0 or (x["baseline"] >= 100 and x["baseline"] % 50 == 0)
            assert x["max"] == 0 or (x["max"] >= 100 and x["max"] % 50 == 0)
            assert x["baseline"] <= x["max"]
        assert e["by_option"]["payg"]["commitment"] == 0
        # the 3-year plan is never more expensive than the 1-year plan, which is never above pay as you go
        assert e["by_option"]["cud3"]["monthly"] <= e["by_option"]["cud1"]["monthly"] + 0.01 <= e["by_option"]["payg"]["monthly"] + 0.02
    t = b["project_totals"]
    assert t["cud3"]["commitment"] == sum(e["by_option"]["cud3"]["commitment"] for e in b["env_specs"])


def test_bom_edit_changes_quantity_cost_and_totals():
    sc = json.loads(SAMPLES[0].read_text())
    sc = sc.get("scenario", sc)
    base = estimate(sc)
    row = next(r for r in base["bom"] if r["service"] == "BigQuery storage")
    edited = estimate({**sc, "bom_overrides": [{"service": "BigQuery storage", "environment": row["environment"], "qty": row["qty_month12"] * 2}]})
    row2 = next(r for r in edited["bom"] if r["service"] == "BigQuery storage" and r["environment"] == row["environment"])
    assert row2["edited"] and abs(row2["qty_month12"] - 2 * row["qty_month12"]) < 1
    assert abs(row2["year1"] - 2 * row["year1"]) < 1
    assert edited["totals"]["year1_payg"] > base["totals"]["year1_payg"]
    priced = estimate({**sc, "bom_overrides": [{"service": "BigQuery storage", "environment": row["environment"], "unit_price": row["unit_price"] / 2}]})
    row3 = next(r for r in priced["bom"] if r["service"] == "BigQuery storage" and r["environment"] == row["environment"])
    assert abs(row3["year1"] - row["year1"] / 2) < 1 and abs(row3["qty_month12"] - row["qty_month12"]) < 0.01
    assert row["region"]


@pytest.mark.parametrize("path", SAMPLES, ids=lambda p: p.stem)
def test_top_five_use_cases(path):
    sc = json.loads(path.read_text())
    ucs = estimate(sc.get("scenario", sc))["use_cases"]
    assert 1 <= len(ucs) <= 5 and all(u["why"] for u in ucs)
    assert [u["score"] for u in ucs] == sorted((u["score"] for u in ucs), reverse=True)


def test_chargeback_uses_negotiated_prices():
    req = {"department": "Marketing", "sources": [{"kind": "database_cdc", "count": 2, "daily_gb": 10, "history_gb": 400}],
           "pipelines": {"simple": 4}, "reports": {"dashboards": 4, "users": 20, "bi_tool": "looker_studio_pro"}, "ai": {"use_cases": 1}}
    base = price_request(req, None)
    assert base["totals"]["monthly"] > 0 and not base["price_book_used"]
    assert not any(l["service"].startswith("Network") for l in base["lines"])          # shared items paid centrally
    book = {"items": [{"service": l["service"], "unit": l["unit"], "price": l["unit_price"] * 0.5} for l in base["lines"] if l["unit_price"]]}
    disc = price_request(req, book)
    assert disc["price_book_used"] and disc["totals"]["monthly"] < base["totals"]["monthly"] * 0.6
    assert abs(disc["totals"]["saving_monthly"] - (base["totals"]["monthly"] - disc["totals"]["monthly"])) < 1


def test_price_sheet_parsing_and_matching():
    known = template_rows("us-central1")
    assert {"service", "unit", "list_price"} <= set(known[0])
    rows = [["Quote 2026"], [], ["Service", "Unit", "List price", "Negotiated price"], ["Datastream CDC", "GiB", "2", "1.6"], ["BigQuery storage", "GiB-months", "", "$0.015"]]
    items = match_services(parse_price_sheet(rows), known)
    ds = next(i for i in items if i["source_name"] == "Datastream CDC")
    assert ds["service"] == "Datastream (CDC)" and ds["price"] == 1.6 and ds["match"] == "closest"
    assert next(i for i in items if i["source_name"] == "BigQuery storage")["price"] == 0.015
    with pytest.raises(ValueError):
        parse_price_sheet([["Name", "Cost"], ["x", "1"]])


def test_chargeback_and_usage_api():
    h = {"X-Compass-User": "Test User", "X-Compass-Email": "test@example.com"}
    csv_ = "Service,Unit,List price,Negotiated price\nDatastream (CDC),GiB,2,1\n"
    r = client.post("/api/chargeback/pricebook/extract", files={"file": ("p.csv", csv_)}, headers=h)
    assert r.status_code == 200 and any(i["price"] == 1 for i in r.json()["items"])
    assert client.post("/api/chargeback/pricebook/extract", files={"file": ("p.docx", b"x")}).status_code == 422
    items = [i for i in r.json()["items"] if i["service"]]
    assert client.put("/api/chargeback/pricebook", json={"region": "us-central1", "items": items}, headers=h).status_code == 200
    req = {"department": "Finance", "title": "Board pack", "sources": [{"kind": "database_cdc", "count": 1, "daily_gb": 5, "history_gb": 100}]}
    saved = client.post("/api/chargeback/requests", json=req, headers=h).json()
    assert saved["department"] == "Finance" and saved["created_by"] == "test@example.com"
    assert any(x["id"] == saved["id"] for x in client.get("/api/chargeback/requests").json())
    assert client.delete(f"/api/chargeback/requests/{saved['id']}").status_code == 200
    client.post("/api/usage/event", json={"action": "module opened", "detail": "pricing"}, headers=h)
    u = client.get("/api/admin/usage").json()                 # open locally (no ADMIN_KEY)
    assert any(x["email"] == "test@example.com" for x in u["users"])
    assert "text/csv" in client.get("/api/chargeback/template?format=csv").headers["content-type"]


def test_admin_usage_needs_the_key(monkeypatch):
    monkeypatch.setenv("ADMIN_KEY", "s3cret")
    assert client.get("/api/admin/usage").status_code == 403
    assert client.get("/api/admin/usage", headers={"X-Admin-Key": "s3cret"}).status_code == 200


def test_price_sheet_pdf_text_fallback_and_bad_files():
    from app import chargeback as CB
    known = [{"service": "Datastream (CDC)", "unit": "GiB", "list_price": 2.0}, {"service": "BigQuery storage", "unit": "GiB-months", "list_price": 0.02}]
    got = CB.match_text("Quote 2026\nDatastream (CDC)   per GiB   list $2.00   negotiated $1.40\nOther line 5", known)
    assert got == [{"service": "Datastream (CDC)", "unit": "GiB", "list_price": 2.0, "price": 1.4}]
    with pytest.raises(ValueError):
        CB.read_price_file("quote.docx", b"x", known, None)
    with pytest.raises(ValueError):
        CB.google_sheet_rows("https://example.com/not-a-sheet")


def test_enquiry_keeps_only_google_documentation_sources():
    from types import SimpleNamespace as N
    from app import enquiry as EQ
    meta = N(grounding_chunks=[N(web=N(uri="https://cloud.google.com/bigquery/docs/slots", title="cloud.google.com", domain=None)),
                               N(web=N(uri="https://medium.com/some-post", title="medium.com", domain=None)),
                               N(web=N(uri="https://docs.cloud.google.com/apigee/docs/api-platform/fundamentals/environments-overview", title="docs.cloud.google.com", domain=None))])
    refs = EQ.references_from(meta)
    assert [r["host"] for r in refs] == ["cloud.google.com", "docs.cloud.google.com"]
    assert refs[0]["title"] == "BigQuery · Slots"
    from fastapi.testclient import TestClient
    from app.main import app
    r = TestClient(app).post("/api/enquiry", json={"question": "hi"})
    assert r.status_code in (422, 503)


# ---------------------------------------------------------------- year-by-year slot plan (1-yr / 3-yr commitments)
def _telco(**bq):
    sc = json.loads((Path(__file__).parents[1] / "samples" / "telco-dwh-modernisation.json").read_text())
    sc = sc.get("scenario", sc)
    return {**sc, "bq": {**(sc.get("bq") or {}), "mode": "editions", "edition": "enterprise", **bq}}


@pytest.mark.parametrize("bq", [{}, {"commit_strategy": "average"}, {"shared_commitment": True}], ids=["optimal", "average", "shared"])
def test_slot_plan_years_match_the_bill_of_materials(bq):
    r = estimate(_telco(**bq))
    plan = r["bigquery"]["plan"]
    rows = [b for b in r["bom"] if b["service"] == "BigQuery compute"]
    assert abs(sum(b["year1"] for b in rows) - plan["totals"][0]["cost"]["payg"]) < 1
    assert abs(sum(b["three_year"] for b in rows) - plan["three_year"]["payg"]) < 1
    assert abs(sum(b["cud3"]["three_year"] for b in rows) - plan["three_year"]["cud3"]) < 1
    assert abs(sum(b["cud1"]["year1"] for b in rows) - plan["totals"][0]["cost"]["cud1"]) < 1


def test_three_year_commitment_never_shrinks_and_demand_grows():
    plan = estimate(_telco(commit_strategy="average"))["bigquery"]["plan"]
    for e in plan["environments"]:
        c3 = [y["commitment"]["cud3"] for y in e["years"]]
        assert c3 == sorted(c3)
        assert sum(y["cud3_topup"] for y in e["years"]) == c3[-1]
        for y in e["years"]:
            for o in ("payg", "cud1", "cud3"):
                b = y["baseline"][o]
                assert b == 0 or (b >= 100 and b % 50 == 0)
    prod = plan["environments"][0]["years"]
    assert prod[0]["avg_slots"] < prod[1]["avg_slots"] < prod[2]["avg_slots"]     # 20 % yearly growth
    assert prod[0]["max"] <= prod[1]["max"] <= prod[2]["max"]


def test_cost_optimal_commitment_is_cheapest_and_shared_is_not_dearer():
    opt = estimate(_telco())["bigquery"]["plan"]["three_year"]
    avg = estimate(_telco(commit_strategy="average"))["bigquery"]["plan"]["three_year"]
    shared = estimate(_telco(shared_commitment=True))["bigquery"]["plan"]["three_year"]
    assert opt["cud3"] <= avg["cud3"] + 0.01 and opt["cud1"] <= avg["cud1"] + 0.01
    assert opt["cud3"] <= opt["payg"] + 0.01
    assert shared["cud3"] <= opt["cud3"] + 0.01


def test_chargeback_price_book_and_ledger_are_per_person(monkeypatch):
    monkeypatch.setenv("K_SERVICE", "compass")            # behave like Cloud Run: admin needs the key
    monkeypatch.setenv("ADMIN_KEY", "k3y")
    a = {"X-Compass-User": "Ana", "X-Compass-Email": "ana@example.com"}
    b = {"X-Compass-User": "Ben", "X-Compass-Email": "ben@example.com"}
    adm = {"X-Admin-Key": "k3y"}
    item = {"service": "Datastream (CDC)", "unit": "GiB", "price": 1.0, "list_price": 2.0}
    # admin publishes a default; Ana saves her own; Ben still sees the default
    assert client.put("/api/chargeback/pricebook?scope=default", json={"items": [item], "note": "default"}, headers=a).status_code == 403
    assert client.put("/api/chargeback/pricebook?scope=default", json={"items": [item], "note": "default"}, headers={**a, **adm}).status_code == 200
    assert client.put("/api/chargeback/pricebook", json={"items": [{**item, "price": 0.5}], "note": "ana"}, headers=a).status_code == 200
    assert client.get("/api/chargeback/pricebook", headers=a).json()["scope"] == "mine"
    gb = client.get("/api/chargeback/pricebook", headers=b).json()
    assert gb["scope"] == "default" and gb["note"] == "default"
    # Ana's ledger entry is hers alone; Ben cannot delete it
    req = {"department": "Finance", "title": "Board pack", "sources": [{"kind": "database_cdc", "count": 1, "daily_gb": 5, "history_gb": 100}]}
    rid = client.post("/api/chargeback/requests", json=req, headers=a).json()["id"]
    assert any(x["id"] == rid for x in client.get("/api/chargeback/requests", headers=a).json())
    assert not any(x["id"] == rid for x in client.get("/api/chargeback/requests", headers=b).json())
    assert client.delete(f"/api/chargeback/requests/{rid}", headers=b).status_code == 403
    assert client.delete(f"/api/chargeback/requests/{rid}", headers=a).status_code == 200
    # Ana goes back to the default
    client.delete("/api/chargeback/pricebook", headers=a)
    assert client.get("/api/chargeback/pricebook", headers=a).json()["scope"] == "default"


# ---------------------------------------------------------------- data mesh target and Dataplex scope
def _mesh_sample():
    sc = json.loads((Path(__file__).parents[1] / "samples" / "retail-bank-ksa.json").read_text())
    sc = sc.get("scenario", sc)
    for s, d in zip(sc["sources"][:3], ["Finance", "Risk", "Finance"]):
        s["target"], s["domain"] = "data_mesh", d
    return sc


def test_data_mesh_target_groups_sources_by_domain():
    r = estimate(_mesh_sample())
    assert [d["domain"] for d in r["domains"]] == ["Finance", "Risk"]
    assert len(r["domains"][0]["sources"]) == 2 and r["domains"][0]["year1"] > 0
    rec = next(x for x in r["recommendations"] if x["target"] == "data_mesh")
    assert rec["domain"] and "data product" in rec["pattern"] and "BigQuery sharing" in rec["rationale"][0]
    chk = client.post("/api/plan", json=_mesh_sample()).json()["readiness"]["checklist"]
    assert any("domain owners named for Finance, Risk" in i["item"] for i in chk)
    # a mesh domain lands in BigQuery, so it costs the same as the data platform target
    base = estimate({**_mesh_sample(), "sources": [{**s, "target": "data_platform"} for s in _mesh_sample()["sources"]]})
    assert abs(base["totals"]["year1_payg"] - r["totals"]["year1_payg"]) < 1
    assert "data_mesh" in client.get("/api/catalog").json()["allowed_targets"]["oracle"]


def test_dataplex_scope_follows_the_layers_it_governs():
    def kc_cost(sc):
        return sum(b["year1"] for b in estimate(sc)["bom"] if b["service"].startswith("Knowledge Catalog"))
    sc = _mesh_sample()
    full = kc_cost(sc)
    assert estimate(sc)["platform"]["dataplex_scope"] == ["bigquery", "mesh"]
    for c in sc["components"]:
        if c["type"] == "knowledge_catalog":
            c["settings"]["governs"] = "mesh"
    assert 0 < kc_cost(sc) < full
    assert estimate(sc)["platform"]["dataplex_scope"] == ["mesh"]


def test_signin_notification_is_logged_once_per_person(monkeypatch, capsys):
    from app import usage as USG
    from app.store import get_store
    monkeypatch.setenv("LOG_REQUESTS", "on")
    st = get_store()
    assert USG.signin(st, "New.Person@Example.com", "New Person", "Google sign-in") is True
    assert USG.signin(st, "new.person@example.com", "New Person", "Google sign-in") is False      # within 12 h
    out = [json.loads(l) for l in capsys.readouterr().out.splitlines() if "compass_signin" in l]
    assert len(out) == 1 and out[0]["email"] == "new.person@example.com" and out[0]["kind"] == "compass_signin"
    assert USG.signin(st, "", "nobody") is False


def test_no_formatter_passed_straight_to_map():
    """arr.map(money) passes the index as money()'s 'digits' argument - year 2 gets 1 decimal, year 3 gets 2."""
    import re
    root = Path(__file__).parents[1] / "app" / "static"
    bad = [f"{p.name}:{i + 1}" for p in root.rglob("*.js") if "vendor" not in p.parts
           for i, line in enumerate(p.read_text().splitlines())
           if re.search(r"\.map\((m|ms|money|moneyShort|fmt|fmtQty|unitPrice|fmtGB)\)", line)]
    assert not bad, bad
