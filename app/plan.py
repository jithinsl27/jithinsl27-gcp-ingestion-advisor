"""Ramp-up plan: phases, source waves and component rollout, month by month.

Rules (transparent and tunable):
  * Month 1 is the foundation: landing zone, IAM, networking, VPC-SC, CMEK,
    BigQuery datasets, Dataform CI/CD and the catalog.
  * Sources are built by `teams` parallel squads, quick wins first
    (DTS / log sinks / Pub/Sub), complex migrations last. Build effort in weeks
    comes from the recommended pattern plus modifiers for heavy transforms and
    very large initial loads.
  * A source goes live (and starts consuming) in the month its build finishes.
  * BI starts with the first live source; data AI (agents, GPU serving) once
    half the sources are live; Gemini Enterprise and Apigee follow agents;
    operational databases with the first curated marts; governance from month 1.
The plan then re-runs the estimator with these start months to give a ramped
month-by-month consumption alongside the steady-state view.
"""
from __future__ import annotations

import copy
import math

from .catalog import SOURCE_BY_ID
from .components import COMPONENT_BY_ID, normalized
from .estimator import estimate, service_group
from .readiness import build_readiness
from .recommender import recommend

WEEKS_PER_MONTH = 4.33
FOUNDATION_WEEKS = 4

EFFORT_WEEKS = {
    "dts_free": 2, "log_sink": 1, "pubsub_bqsub": 2, "pubsub": 3, "datastream": 3, "cloud_run": 3,
    "app_integration": 3, "files_transfer": 3, "dataflow_batch": 4, "dataflow_stream": 4, "datafusion": 5,
    "dataproc": 6, "sap_connector": 8, "dts_migration": 10,
}
CATEGORY_EXTRA = {"mainframe": 4, "dwh": 0, "hadoop": 4}


def source_effort(src, rec):
    engines = rec.engine.split("+")
    weeks = max(EFFORT_WEEKS.get(e, 4) for e in engines) + (len(engines) - 1)
    cat = SOURCE_BY_ID.get(src.get("type"), {}).get("category", "")
    weeks += CATEGORY_EXTRA.get(cat, 0)
    if src.get("transform") == "heavy":
        weeks += 2
    if float(src.get("initial_volume_gb") or 0) >= 100 * 1024:
        weeks += 4
    return weeks


def build_plan(scenario: dict) -> dict:
    teams = max(1, int((scenario.get("plan") or {}).get("teams") or 2))
    prefs = {"skill": scenario.get("skill", "sql"), "orchestration": scenario.get("orchestration", "auto"),
             "environment": scenario.get("environment", "production")}
    sources = [s for s in scenario.get("sources", []) if s.get("type") and s.get("included", True) is not False]
    recs = [recommend(s, prefs) for s in sources]

    # ---------------- schedule source builds (quick wins first, stable order)
    items = []
    for i, (s, r) in enumerate(zip(sources, recs)):
        items.append({"idx": i, "id": s.get("id") or s["type"], "name": s.get("name") or s["type"],
                      "pattern": r.pattern, "primary": r.primary, "effort_weeks": source_effort(s, r),
                      "override": s.get("go_live_override")})
    order = sorted(items, key=lambda x: (x["effort_weeks"], x["idx"]))
    free_at = [FOUNDATION_WEEKS] * teams
    for it in order:
        t = min(range(teams), key=lambda k: (free_at[k], k))
        it["team"] = t + 1
        it["start_week"] = free_at[t]
        it["end_week"] = free_at[t] + it["effort_weeks"]
        free_at[t] = it["end_week"]
        it["build_start_month"] = int(it["start_week"] // WEEKS_PER_MONTH) + 1
        it["go_live_month"] = min(36, max(2, math.ceil(it["end_week"] / WEEKS_PER_MONTH)))
        it["planned_month"] = it["go_live_month"]
        if it.get("override"):
            # a go-live month set by the architect or by an applied risk (e.g. "source X slips to month 5")
            it["go_live_month"] = min(36, max(2, int(it["override"])))
            it["build_start_month"] = max(1, min(it["build_start_month"], it["go_live_month"] - 1))
            it["overridden"] = True
    waves = sorted(order, key=lambda x: (x["go_live_month"], x["idx"]))
    go_lives = sorted(w["go_live_month"] for w in waves)
    first_live = go_lives[0] if go_lives else 2
    half_live = go_lives[(len(go_lives) - 1) // 2] if go_lives else 2
    all_live = go_lives[-1] if go_lives else 2

    # ---------------- component rollout
    comps, sec = normalized(scenario)
    agents_month = min(36, half_live + 1)
    comp_rows = []
    for c in comps:
        meta = COMPONENT_BY_ID[c["type"]]
        cat, t = meta["category"], c["type"]
        if cat in ("governance", "security"):
            start = 1
        elif cat == "bi":
            start = first_live
        elif t in ("agent_platform", "vertex_gpu", "bqml") or cat == "ai" and meta["vendor"] == "partner":
            start = agents_month
        elif t == "gemini_enterprise":
            start = min(36, agents_month + 1)
        elif cat == "integration":
            start = agents_month
        elif cat == "database":
            start = min(36, first_live + 1)
        else:
            start = first_live
        comp_rows.append({"id": c["id"], "type": t, "name": meta["name"], "category": cat, "vendor": meta["vendor"], "start_month": start})

    horizon = max([all_live + 2] + [c["start_month"] + 1 for c in comp_rows] + [6])
    horizon = min(horizon, 24)

    # ---------------- phases (for the Gantt)
    phases = [{"key": "foundation", "name": "Foundation & landing zone", "start": 1, "end": 1,
               "items": ["Projects, IAM and org policies", "Networking" + (" and private connectivity" if any(r.needs_connectivity for r in recs) else ""),
                         "Security controls: " + ", ".join(c["name"] for c in comp_rows if c["category"] == "security") if any(c["category"] == "security" for c in comp_rows) else "Security baseline",
                         "BigQuery datasets (raw / curated / marts)", "Dataform repo and CI/CD", "Monitoring and cost controls (budgets, quotas)"]}]
    for w in waves:
        phases.append({"key": "source", "id": w["id"], "name": w["name"], "start": w["build_start_month"], "end": w["go_live_month"],
                       "items": [w["pattern"], f"{w['effort_weeks']} weeks, team {w['team']}"]})
    if go_lives:
        phases.append({"key": "elt", "name": "Curated models & data quality (Dataform)", "start": first_live, "end": all_live,
                       "items": ["Curated and mart layers per source as it lands", "Assertions and quality scans"]})
    for c in comp_rows:
        phases.append({"key": "component", "id": c["id"], "category": c["category"], "vendor": c["vendor"], "name": c["name"],
                       "start": c["start_month"], "end": min(horizon, c["start_month"] + (0 if c["category"] in ("governance", "security") else 1)),
                       "items": ["Rollout and enablement" if c["vendor"] == "google" else "Connect partner tool to BigQuery (not costed)"]})
    phases.append({"key": "hypercare", "name": "Optimisation & hypercare", "start": min(horizon, all_live + 1), "end": horizon,
                   "items": ["Partitioning, clustering, BI Engine", "Slot / commitment right-sizing", "FinOps review"]})

    milestones = [{"month": 1, "name": "Landing zone ready"}]
    if go_lives:
        milestones.append({"month": first_live, "name": "First data live in BigQuery"})
        milestones.append({"month": all_live, "name": "All sources live"})
    if any(c["category"] == "bi" for c in comp_rows):
        milestones.append({"month": first_live, "name": "First dashboards"})
    if any(c["type"] in ("agent_platform", "gemini_enterprise") for c in comp_rows):
        milestones.append({"month": agents_month, "name": "First data agents"})
    milestones.sort(key=lambda x: x["month"])

    # ---------------- ramped estimate
    ramped = copy.deepcopy(scenario)
    start_by_id = {w["id"]: w["go_live_month"] for w in waves}
    for s in ramped.get("sources", []):
        s["start_month"] = start_by_id.get(s.get("id") or s.get("type"), 1)
    comp_start = {c["id"]: c["start_month"] for c in comp_rows}
    ramped["components"] = [{**c, "start_month": comp_start.get(c["id"], 1)} for c in comps]
    ramped.pop("platform", None)
    est = estimate(ramped, keep_items=True, detail=True)
    steady = estimate({**scenario}, detail=True)

    months = []
    for m in range(1, horizon + 1):
        groups = {}
        for (mm, svc, sid, rid), v in est["_items"].items():
            if mm == m:
                g = service_group(svc)
                groups[g] = groups.get(g, 0.0) + v
        live = [w["name"] for w in waves if w["go_live_month"] == m]
        started = [c["name"] for c in comp_rows if c["start_month"] == m]
        months.append({
            "month": m,
            "total": round(est["monthly"][m - 1]["payg"], 2),
            "steady": round(steady["monthly"][m - 1]["payg"], 2),
            "by_group": {k: round(v, 2) for k, v in groups.items()},
            "sources_live": live,
            "components_started": started,
        })
    est.pop("_items", None)
    steady.pop("_items", None)
    pricing = {"ramped": pricing_plans(est["product_months"]), "steady": pricing_plans(steady["product_months"]),
               "go_live": {"first": first_live, "all": all_live}}
    readiness = build_readiness(scenario, sources, recs, comp_rows, waves, teams, first_live, half_live, all_live, horizon, agents_month,
                                connectivity=(steady.get("platform") or {}).get("connectivity", ""))
    return {
        "readiness": readiness,
        "pricing": pricing,
        "teams": teams,
        "horizon": horizon,
        "phases": phases,
        "waves": waves,
        "components": comp_rows,
        "milestones": milestones,
        "months": months,
        "totals": {"ramped_year1": est["totals"]["year1_payg"], "steady_year1": steady["totals"]["year1_payg"],
                   "ramped_three_year": est["totals"]["three_year_payg"], "steady_three_year": steady["totals"]["three_year_payg"],
                   "ramped_year1_cud1": est["totals"]["year1_cud1"], "ramped_three_year_cud3": est["totals"]["three_year_cud3"]},
        "group_order": ["Data ingestion & CDC", "BigQuery & storage", "Analytics & AI", "APIs & databases", "Governance & security", "Platform & network", "Contingency"],
        "assumptions": {"foundation_weeks": FOUNDATION_WEEKS, "effort_weeks": EFFORT_WEEKS, "weeks_per_month": WEEKS_PER_MONTH},
    }


def pricing_plans(products):
    """Whole-programme pricing: pay-as-you-go vs 1-year and 3-year commitments, month by month and per product."""
    r2 = lambda x: round(x + 1e-12, 2)  # noqa: E731

    def monthly(key):
        return [r2(sum(p[key][m] for p in products)) for m in range(36)]

    payg, c1, c3 = monthly("payg"), monthly("cud1"), monthly("cud3")
    year = lambda arr, y: r2(sum(arr[(y - 1) * 12: y * 12]))  # noqa: E731
    plans = {
        "payg_1y": {"label": "Pay as you go - 1 year", "months": 12, "monthly": payg[:12], "total": year(payg, 1), "by_year": [year(payg, 1)]},
        "commit_1y": {"label": "1-year commitment", "months": 12, "monthly": c1[:12], "total": year(c1, 1), "by_year": [year(c1, 1)],
                      "saving": r2(year(payg, 1) - year(c1, 1))},
        "commit_3y": {"label": "3-year commitment", "months": 36, "monthly": c3, "total": r2(sum(c3)), "by_year": [year(c3, y) for y in (1, 2, 3)],
                      "saving": r2(sum(payg) - sum(c3))},
        "payg_3y": {"label": "Pay as you go - 3 years", "months": 36, "monthly": payg, "total": r2(sum(payg)), "by_year": [year(payg, y) for y in (1, 2, 3)]},
    }
    return {"plans": plans, "products": products}
