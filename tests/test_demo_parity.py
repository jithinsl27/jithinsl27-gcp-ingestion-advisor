"""The static demo's JavaScript engine must match the Python engine."""
import json
import random
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "demo"))

from app.catalog import SOURCE_TYPES  # noqa: E402
from app.components import COMPONENTS  # noqa: E402
from app.plan import build_plan  # noqa: E402
from app.workload import workload_estimate  # noqa: E402
from app.estimator import estimate  # noqa: E402
from build_demo import data_payload  # noqa: E402

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


def random_scenarios(n=25, seed=7):
    rnd = random.Random(seed)
    regions = ["us-central1", "me-central2", "europe-west2", "asia-south1", "US"]
    out = []
    for i in range(n):
        srcs = []
        for j in range(rnd.randint(1, 7)):
            srcs.append({
                "id": f"s{j}", "name": f"Source {j}", "type": rnd.choice(SOURCE_TYPES)["id"],
                "data_type": rnd.choice(["structured", "semi_structured", "events", "unstructured"]),
                "frequency": rnd.choice(["realtime", "near_realtime", "hourly", "daily", "weekly", "monthly", "one_time"]),
                "location": rnd.choice(["on_prem", "gcp", "aws", "azure", "saas"]),
                "transform": rnd.choice(["none", "light", "heavy"]),
                "initial_volume_gb": rnd.choice([0, 50, 2000, 150000]),
                "daily_change_gb": rnd.choice([0, 0.5, 10, 300, 1500]),
                **({"region": rnd.choice(regions)} if rnd.random() > .6 else {}),
                **({"start_month": rnd.randint(1, 8)} if rnd.random() > .6 else {}),
                **({"included": False} if rnd.random() > .8 else {}),
                **({"iot_option": rnd.choice(["native", "mqtt_broker", "litmus", "clearblade", "mde"])} if rnd.random() > .5 else {}),
            })
            if rnd.random() > .7:
                srcs[-1]["type"] = "iot"
            if rnd.random() > .85:
                srcs[-1].update({"type": "custom", "custom_name": "Workday", "like_type": rnd.choice(["saas_other", "oracle", "kafka", "files_onprem", "bogus"])})
            if rnd.random() > .5:
                srcs[-1]["target"] = rnd.choice(["data_platform", "data_lake", "operational_db"])
        out.append({
            "region": rnd.choice(regions), "skill": rnd.choice(["sql", "low_code", "code", "spark"]),
            "orchestration": rnd.choice(["auto", "auto", "composer", "workflows", "none"]),
            "environment": rnd.choice(["poc", "production", "production_ha"]),
            "bq_model": rnd.choice(["ondemand", "standard", "enterprise", "enterprise_plus"]),
            "bq_slots": rnd.choice([50, 100, 400]), "analytics_tib_month": rnd.choice([None, 5]),
            "annual_growth_pct": rnd.choice([0, 20, 60]), "contingency_pct": 10,
            "processing_region": rnd.choice(regions),
            "components": [
                {"id": f"c{k}", "type": c["id"],
                 "settings": {**({"region": rnd.choice(regions)} if c["costed"] and rnd.random() > .7 else {}),
                              **({"grounding": rnd.choice(["bigquery", "looker", "both", "agents"])} if c["id"] == "gemini_enterprise" else {}),
                              **({"role": rnd.choice(["integration", "agents", "both"])} if c["id"] == "apigee" else {})},
                 **({"start_month": rnd.randint(1, 6)} if rnd.random() > .7 else {}),
                 **({"included": False} if rnd.random() > .8 else {})}
                for k, c in enumerate(rnd.sample(COMPONENTS, rnd.randint(0, 8)))
            ],
            "security": {"enabled": rnd.random() > .3, "cmek": rnd.random() > .5, "sdp_discovery": rnd.random() > .5},
            "workload": {
                "data_region": rnd.choice([None, "europe-west1"]), "streaming_region": rnd.choice([None, "me-central2"]),
                "bq_model": rnd.choice(["ondemand", "enterprise"]), "include_components": rnd.random() > .5,
                "telemetry": {"volume_gb": rnd.choice([0, 100, 3000]), "per": rnd.choice(["day", "month"]), "transform": rnd.random() > .5},
                "pipelines": {"engine": rnd.choice(["elt", "etl"]), "simple": rnd.randint(0, 80)},
                "ramp": {"months": rnd.randint(0, 4)},
                "queries": {"heavy": {"frequency": rnd.choice(["yearly", "quarterly"]), "gb": rnd.choice([100, 1024, 20000])}},
                "slots": {"batch_window_hours": rnd.choice([4, 6, 10]), "edition": rnd.choice(["auto", "auto", "standard", "enterprise_plus"])},
            },
            "plan": {"teams": rnd.randint(1, 4)},
            "environments": rnd.choice([None, [{"id": "prod", "name": "Prod"}, {"id": "dev", "preset": "dev"}],
                                        [{"id": "p"}, {"id": "u", "preset": "uat", "compute_pct": 40, "bq_slots": 50}, {"id": "d", "preset": "dr"},
                                         {"id": "x", "preset": "sandbox", "included": False}]]),
            "lakehouse": rnd.choice([None, {"raw_zone": False}, {"raw_scope": "all", "raw_retention_months": 12, "raw_storage_class": "nearline", "silver_pct": 60, "gold_pct": 10}]),
            "excluded_services": rnd.sample(["Contingency & operations", "Datastream (CDC)", "BigQuery storage", "Composer (Airflow)", "Pub/Sub", "Network (HA VPN)"], rnd.randint(0, 2)),
            "sources": srcs,
        })
    return out


def test_js_engine_matches_python(tmp_path):
    scenarios = [json.loads(p.read_text()) for p in sorted((ROOT / "samples").glob("*.json"))] + random_scenarios()
    runner = tmp_path / "run.js"
    (tmp_path / "data.json").write_text(json.dumps(data_payload()))
    (tmp_path / "scenarios.json").write_text(json.dumps(scenarios))
    runner.write_text(
        "const fs=require('fs');globalThis.ADVISOR_DATA=JSON.parse(fs.readFileSync(process.argv[2]));"
        f"require({json.dumps(str(ROOT / 'demo' / 'engine.js'))});"
        "const sc=JSON.parse(fs.readFileSync(process.argv[3]));"
        "const E=globalThis.ADVISOR_ENGINE;"
        "process.stdout.write(JSON.stringify(sc.map(s=>({e:E.estimate(s),w:E.workloadEstimate(s),p:E.buildPlan(s)}))));"
    )
    out = subprocess.run(["node", str(runner), str(tmp_path / "data.json"), str(tmp_path / "scenarios.json")],
                         capture_output=True, text=True, check=True).stdout
    js_results = json.loads(out)
    for sc, res in zip(scenarios, js_results):
        js = res["e"]
        py = estimate(sc)
        for k, v in py["totals"].items():
            assert js["totals"][k] == pytest.approx(v, abs=0.05, rel=1e-6), (k, sc)
        assert [r["service"] for r in js["by_service"]] == [r["service"] for r in py["by_service"]]
        for a, b in zip(js["by_service"], py["by_service"]):
            assert a["three_year"] == pytest.approx(b["three_year"], abs=0.05, rel=1e-6)
        for a, b in zip(js["recommendations"], py["recommendations"]):
            for f in ("primary", "pattern", "chain", "engine", "rationale", "alternatives", "caveats", "needs_connectivity"):
                assert a[f] == b[f], (f, a["source_id"])
        for f in ("orchestration", "connectivity", "datafusion_edition"):
            assert js["platform"][f] == py["platform"][f]
        assert js["platform"]["layer"]["story"] == py["platform"]["layer"]["story"]
        assert [m["payg"] for m in js["monthly"]] == pytest.approx([m["payg"] for m in py["monthly"]], abs=0.05)
        assert {r["region"]: r["three_year"] for r in js["by_region"]} == pytest.approx({r["region"]: r["three_year"] for r in py["by_region"]}, abs=0.05)
        assert [c["type"] for c in js["platform"]["layer"]["components"]] == [c["type"] for c in py["platform"]["layer"]["components"]]
        assert [c["mode_note"] for c in js["platform"]["layer"]["components"]] == [c["mode_note"] for c in py["platform"]["layer"]["components"]]
        for f in ("raw_zone", "raw_scope", "raw_retention_months", "raw_storage_class"):
            assert js["platform"]["lakehouse"][f] == py["platform"]["lakehouse"][f]
        assert [l["gib_month12"] for l in js["platform"]["lakehouse"]["layers"]] == pytest.approx([l["gib_month12"] for l in py["platform"]["lakehouse"]["layers"]], abs=0.05)
        # environments and bill of materials
        assert [(e["id"], e["factors"]) for e in js["environments"]] == [(e["id"], e["factors"]) for e in py["environments"]]
        assert [e["three_year"] for e in js["environments"]] == pytest.approx([e["three_year"] for e in py["environments"]], abs=0.05)
        assert [(b["environment"], b["service"], b["unit"]) for b in js["bom"]] == [(b["environment"], b["service"], b["unit"]) for b in py["bom"]]
        for a, b in zip(js["bom"], py["bom"]):
            assert a["three_year"] == pytest.approx(b["three_year"], abs=0.05)
            assert (a["qty_year1"] or 0) == pytest.approx(b["qty_year1"] or 0, abs=0.05, rel=1e-6)
            assert a["why"] == b["why"]
        # workload sizing
        pw, jw = workload_estimate(sc), res["w"]
        for k, v in pw["totals"].items():
            assert jw["totals"][k] == pytest.approx(v, abs=0.05, rel=1e-6), ("workload", k)
        assert [(l["category"], l["service"], l["item"]) for l in jw["lines"]] == [(l["category"], l["service"], l["item"]) for l in pw["lines"]]
        assert [c["monthly"] for c in jw["compute_comparison"]] == pytest.approx([c["monthly"] for c in pw["compute_comparison"]], abs=0.05)
        assert [e["three_year"] for e in jw["environments"]] == pytest.approx([e["three_year"] for e in pw["environments"]], abs=0.05)
        js_s, py_s = jw["slots"], pw["slots"]
        for f in ("max_slots", "baseline_slots", "edition", "edition_reasons", "model", "by_environment"):
            assert js_s[f] == py_s[f], ("slots", f)
        assert js_s["costs"] == pytest.approx(py_s["costs"], abs=0.05)
        assert js_s["profile"] == pytest.approx(py_s["profile"], abs=0.11)
        # ramp-up plan
        pp, jp = build_plan(sc), res["p"]
        assert jp["horizon"] == pp["horizon"]
        assert [(w["id"], w["team"], w["build_start_month"], w["go_live_month"]) for w in jp["waves"]] == \
               [(w["id"], w["team"], w["build_start_month"], w["go_live_month"]) for w in pp["waves"]]
        assert [c["start_month"] for c in jp["components"]] == [c["start_month"] for c in pp["components"]]
        assert jp["phases"] == pp["phases"]
        assert [m["total"] for m in jp["months"]] == pytest.approx([m["total"] for m in pp["months"]], abs=0.05)
        for view in ("ramped", "steady"):
            for k, plan in pp["pricing"][view]["plans"].items():
                assert jp["pricing"][view]["plans"][k]["total"] == pytest.approx(plan["total"], abs=0.1), ("pricing", view, k)
                assert jp["pricing"][view]["plans"][k]["by_year"] == pytest.approx(plan["by_year"], abs=0.1)
            assert [(x["environment"], x["service"], x["commit_eligible"]) for x in jp["pricing"][view]["products"]] == \
                   [(x["environment"], x["service"], x["commit_eligible"]) for x in pp["pricing"][view]["products"]]
        for a, b in zip(js["recommendations"], py["recommendations"]):
            assert a["target"] == b["target"]
        assert js["platform"]["targets"] == py["platform"]["targets"]
        for k, v in pp["totals"].items():
            assert jp["totals"][k] == pytest.approx(v, abs=0.05, rel=1e-6), ("plan", k)
