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
            })
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
                 "settings": ({"region": rnd.choice(regions)} if c["costed"] and rnd.random() > .7 else {}),
                 **({"start_month": rnd.randint(1, 6)} if rnd.random() > .7 else {})}
                for k, c in enumerate(rnd.sample(COMPONENTS, rnd.randint(0, 8)))
            ],
            "security": {"enabled": rnd.random() > .3, "cmek": rnd.random() > .5, "sdp_discovery": rnd.random() > .5},
            "workload": {
                "data_region": rnd.choice([None, "europe-west1"]), "streaming_region": rnd.choice([None, "me-central2"]),
                "bq_model": rnd.choice(["ondemand", "enterprise"]), "include_components": rnd.random() > .5,
                "telemetry": {"volume_gb": rnd.choice([0, 100, 3000]), "per": rnd.choice(["day", "month"]), "transform": rnd.random() > .5},
                "pipelines": {"engine": rnd.choice(["elt", "etl"]), "simple": rnd.randint(0, 80)},
                "ramp": {"months": rnd.randint(0, 4)},
                "queries": {"heavy": {"frequency": rnd.choice(["yearly", "quarterly"])}},
            },
            "plan": {"teams": rnd.randint(1, 4)},
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
        # workload sizing
        pw, jw = workload_estimate(sc), res["w"]
        for k, v in pw["totals"].items():
            assert jw["totals"][k] == pytest.approx(v, abs=0.05, rel=1e-6), ("workload", k)
        assert [(l["category"], l["service"], l["item"]) for l in jw["lines"]] == [(l["category"], l["service"], l["item"]) for l in pw["lines"]]
        assert [c["monthly"] for c in jw["compute_comparison"]] == pytest.approx([c["monthly"] for c in pw["compute_comparison"]], abs=0.05)
        # ramp-up plan
        pp, jp = build_plan(sc), res["p"]
        assert jp["horizon"] == pp["horizon"]
        assert [(w["id"], w["team"], w["build_start_month"], w["go_live_month"]) for w in jp["waves"]] == \
               [(w["id"], w["team"], w["build_start_month"], w["go_live_month"]) for w in pp["waves"]]
        assert [c["start_month"] for c in jp["components"]] == [c["start_month"] for c in pp["components"]]
        assert jp["phases"] == pp["phases"]
        assert [m["total"] for m in jp["months"]] == pytest.approx([m["total"] for m in pp["months"]], abs=0.05)
        for k, v in pp["totals"].items():
            assert jp["totals"][k] == pytest.approx(v, abs=0.05, rel=1e-6), ("plan", k)
