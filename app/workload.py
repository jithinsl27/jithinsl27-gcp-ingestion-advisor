"""Workload-based sizing: estimate consumption from what the customer will *run*.

Independent of the source-by-source ingestion design, the architect enters:
  * data estate by type (structured / semi-structured in BigQuery, unstructured in Cloud Storage)
  * streaming telemetry volume
  * pipelines by complexity and how they run (ELT in BigQuery or ETL on Dataflow)
  * queries by complexity and frequency, ad-hoc reports, dashboards
  * an optional ramp-up phase (e.g. first 2 months: 110 GB and 1 report)
and gets monthly, 1-year and 3-year consumption, a compute-model comparison and
a line-by-line breakdown. Regions can differ for data, pipelines and streaming.
"""
from __future__ import annotations

import math
from collections import defaultdict

from .components import cost_components, normalized
from .environments import env_summary, normalized_envs, replicate
from .estimator import inter_region_rate, load_pricing, load_regions, service_group

GIB_PER_TIB = 1024
HOURS = 730

FREQ_RUNS = {"hourly": 730.0, "daily": 30.0, "weekly": 4.3, "monthly": 1.0, "quarterly": 1 / 3, "yearly": 1 / 12}

WORKLOAD_ASSUMPTIONS = {
    "elt_gb_scanned_per_run": {"simple": 5.0, "medium": 50.0, "complex": 250.0},
    "etl_vcpu_hr_per_run": {"simple": 0.5, "medium": 2.0, "complex": 8.0},
    "memory_gib_per_vcpu": 3.75,
    "telemetry_gb_per_vcpu_day": 100.0,
    "longterm_share_after_90d": 0.6,
    "ramp_dev_scan_multiplier": 5.0,       # during ramp, ad-hoc development scans ~5x the ramp data per month
    "composer_threshold_pipelines": 10,
    "slot_hours_per_tib": 60.0,            # editions: slot-hours consumed per TiB scanned (highly workload dependent)
}

DEFAULT_WORKLOAD = {
    "data_region": None, "pipelines_region": None, "streaming_region": None,
    "bq_model": "ondemand",
    "data": {"structured_tb": 20, "semi_structured_tb": 10, "unstructured_tb": 20, "annual_growth_pct": 20, "tables": 500},
    "telemetry": {"volume_gb": 100, "per": "day", "transform": False, "retention_months": 13},
    "pipelines": {"simple": 50, "medium": 30, "complex": 20, "runs_per_day": 1, "engine": "elt"},
    "queries": {
        "simple": {"count": 20, "frequency": "daily", "gb": 2},
        "complex": {"count": 25, "frequency": "daily", "gb": 50},
        "heavy": {"count": 100, "frequency": "yearly", "gb": 1024},
        "adhoc": {"count": 10, "frequency": "monthly", "gb": 200},
    },
    "dashboards": {"count": 25, "refreshes_per_day": 12, "queries_per_refresh": 8, "gb_per_query": 0.5, "cache_pct": 60},
    "ramp": {"months": 2, "data_gb": 110, "pipelines": 5, "reports": 1},
    "slot_hours_per_tib": 60,
    "contingency_pct": 10,
    "include_components": False,
    "slots": {
        "batch_window_hours": 6,        # pipelines and heavy periodic jobs run in this overnight window
        "business_hours": 10,           # dashboards, interactive and ad-hoc queries run in these hours
        "peak_concurrency": 1.5,        # busiest business hour vs. the business-hours average
        "heavy_target_minutes": 30,     # a single heavy / periodic query should finish within this time
        "edition": "auto",              # auto | standard | enterprise | enterprise_plus
    },
}

SLOT_STEP = 50                          # baseline and autoscaling move in 50-slot increments
STANDARD_MAX_SLOTS = 1600

QUERY_LABELS = {"simple": "Simple queries", "complex": "Complex queries", "heavy": "Heavy / periodic queries", "adhoc": "Ad-hoc reports"}


def merged_workload(w):
    w = w or {}
    out = {}
    for k, v in DEFAULT_WORKLOAD.items():
        if isinstance(v, dict) and k != "queries":
            out[k] = {**v, **{kk: vv for kk, vv in (w.get(k) or {}).items() if vv is not None}}
        elif k == "queries":
            q = w.get("queries") or {}
            out[k] = {qk: {**qv, **{kk: vv for kk, vv in (q.get(qk) or {}).items() if vv is not None}} for qk, qv in v.items()}
        else:
            out[k] = w.get(k) if w.get(k) is not None else v
    return out


def workload_estimate(scenario: dict) -> dict:
    pricing = load_pricing()
    regions = {r["id"]: r for r in load_regions()}
    home = scenario.get("region") if scenario.get("region") in regions else "us-central1"
    W = merged_workload(scenario.get("workload"))
    data_rid = W["data_region"] if W["data_region"] in regions else home
    pipe_rid = W["pipelines_region"] if W["pipelines_region"] in regions else data_rid
    strm_rid = W["streaming_region"] if W["streaming_region"] in regions else data_rid
    bq = pricing["bigquery"]
    df = pricing["dataflow"]
    A = {**WORKLOAD_ASSUMPTIONS, "slot_hours_per_tib": float(W["slot_hours_per_tib"])}
    ctx = {"rid": data_rid}

    def up(key):
        return regions[ctx["rid"]]["uplift"] if pricing[key].get("regional") else 1.0

    payg, cud1_v, cud3_v = defaultdict(float), defaultdict(float), defaultdict(float)

    excluded = set(scenario.get("excluded_services") or [])

    def add(m, svc, item, usd, cud1_usd=None, cud3_usd=None, *, cud1=None, cud3=None, q=None):
        if not usd or svc in excluded:
            return
        c1 = cud1 if cud1 is not None else cud1_usd
        c3 = cud3 if cud3 is not None else cud3_usd
        k = (m, svc, item, ctx["rid"])
        payg[k] += usd
        cud1_v[k] += usd if c1 is None else c1
        cud3_v[k] += usd if c3 is None else c3

    d, tel, pipes, dash, ramp = W["data"], W["telemetry"], W["pipelines"], W["dashboards"], W["ramp"]
    ramp_months = max(0, int(ramp["months"]))
    growth = float(d["annual_growth_pct"]) / 100
    bq_tb = float(d["structured_tb"]) + float(d["semi_structured_tb"])
    gcs_tb = float(d["unstructured_tb"])
    total_tb = bq_tb + gcs_tb
    tel_gb_day = float(tel["volume_gb"]) / (30 if tel["per"] == "month" else 1)
    n_pipes = {k: float(pipes[k]) for k in ("simple", "medium", "complex")}
    runs_month = float(pipes["runs_per_day"]) * 30
    stored_by_month, ingested_by_month = {}, {}
    scan_lines_steady = []

    def edition_cost(tib):
        sh = tib * A["slot_hours_per_tib"]
        ed = bq["editions"][W["bq_model"]]
        return sh * ed["payg"], sh * ed["cud1"], sh * ed["cud3"]

    def add_compute(m, item, tib):
        ctx["rid"] = data_rid
        if W["bq_model"] == "ondemand":
            add(m, "BigQuery compute", item, tib * bq["ondemand_tib"] * up("bigquery"))
        else:
            p, c1, c3 = edition_cost(tib)
            u = up("bigquery")
            add(m, "BigQuery compute", item, p * u, c1 * u, c3 * u)

    free_left = {}

    for m in range(1, 37):
        in_ramp = m <= ramp_months
        steady_idx = max(0, m - ramp_months - 1)
        g = (1 + growth) ** (steady_idx / 12)
        scans = []  # (item, TiB)

        # ---------------- storage
        ctx["rid"] = data_rid
        if in_ramp:
            share_bq = bq_tb / total_tb if total_tb else 1.0
            bq_gib = float(ramp["data_gb"]) * share_bq
            gcs_gib = float(ramp["data_gb"]) - bq_gib
            tel_stored = 0.0
        else:
            bq_gib = bq_tb * GIB_PER_TIB * g
            gcs_gib = gcs_tb * GIB_PER_TIB * g
            months_tel = min(steady_idx + 1, int(tel["retention_months"]))
            tel_stored = tel_gb_day * 30 * months_tel * g
        bq_total = bq_gib + tel_stored
        lt = 0.0 if (m <= 3 or in_ramp) else bq_total * A["longterm_share_after_90d"]
        active = max(0.0, bq_total - lt - bq["storage_free_gib"])
        add(m, "BigQuery storage", "Structured, semi-structured & telemetry data",
            (active * bq["storage_active_gib_month"] + lt * bq["storage_longterm_gib_month"]) * up("bigquery"))
        add(m, "Cloud Storage", "Unstructured data (object tables)", gcs_gib * pricing["gcs"]["standard_gib_month"] * up("gcs"))
        stored_by_month[m] = bq_total + gcs_gib
        ingested_by_month[m] = 0.0 if in_ramp else tel_gb_day * 30 * g + (bq_gib * growth / 12)

        # ---------------- telemetry streaming
        if not in_ramp and tel_gb_day > 0:
            ctx["rid"] = strm_rid
            monthly_gib = tel_gb_day * 30 * g
            tib = monthly_gib / GIB_PER_TIB
            ps = pricing["pubsub"]
            if tel.get("transform"):
                add(m, "Pub/Sub", "Telemetry streaming", tib * ps["throughput_tib"] * 2)
                v = max(2, math.ceil(tel_gb_day * g / A["telemetry_gb_per_vcpu_day"]))
                c = (v * HOURS * df["streaming_vcpu_hr"] + v * HOURS * A["memory_gib_per_vcpu"] * df["memory_gib_hr"]
                     + v * HOURS * 0.5 * df["streaming_engine_cu_hr"]) * up("dataflow")
                add(m, "Dataflow (streaming)", "Telemetry streaming", c, c * (1 - df["cud1_discount"]), c * (1 - df["cud3_discount"]))
            else:
                add(m, "Pub/Sub", "Telemetry streaming", tib * (ps["throughput_tib"] + ps["bq_subscription_tib"]))
            rate = inter_region_rate(regions, strm_rid, data_rid, pricing)
            if rate:
                add(m, "Cross-region data transfer", "Telemetry to data region", monthly_gib * rate)

        # ---------------- pipelines
        if in_ramp:
            counts = {"simple": 0.0, "medium": float(ramp["pipelines"]), "complex": 0.0}
        else:
            counts = n_pipes
        if W["pipelines"]["engine"] == "etl":
            ctx["rid"] = pipe_rid
            for k, n in counts.items():
                vh = n * runs_month * A["etl_vcpu_hr_per_run"][k] * (1 if in_ramp else g)
                add(m, "Dataflow (batch)", f"{k.title()} pipelines", (vh * df["batch_vcpu_hr"] + vh * A["memory_gib_per_vcpu"] * df["memory_gib_hr"]) * up("dataflow"))
        else:
            for k, n in counts.items():
                tib = n * runs_month * A["elt_gb_scanned_per_run"][k] * (1 if in_ramp else g) / GIB_PER_TIB
                if tib:
                    scans.append((f"{k.title()} pipelines (ELT)", tib))
        total_pipes = sum(counts.values())
        if total_pipes:
            ctx["rid"] = pipe_rid
            if total_pipes > A["composer_threshold_pipelines"]:
                cp = pricing["composer"]
                dcu_h = cp["small_env_avg_dcu" if total_pipes <= 150 else "medium_env_avg_dcu"] * HOURS
                add(m, "Composer (Airflow)", "Pipeline orchestration", dcu_h * cp["dcu_hr"] * up("composer"),
                    dcu_h * cp["cud1_dcu_hr"] * up("composer"), dcu_h * cp["cud3_dcu_hr"] * up("composer"))
            else:
                add(m, "Workflows + Scheduler", "Pipeline orchestration", total_pipes * pricing["workflows"]["scheduler_job_month"])

        # ---------------- queries, reports, dashboards
        if in_ramp:
            dev = float(ramp["data_gb"]) * A["ramp_dev_scan_multiplier"] / GIB_PER_TIB
            scans.append(("Development & exploration", dev))
            n_dash = float(ramp["reports"])
        else:
            for qk, q in W["queries"].items():
                tib = float(q["count"]) * FREQ_RUNS.get(q["frequency"], 30) * float(q["gb"]) * g / GIB_PER_TIB
                if tib:
                    scans.append((QUERY_LABELS[qk], tib))
            n_dash = float(dash["count"])
        dash_tib = (n_dash * float(dash["refreshes_per_day"]) * 30 * float(dash["queries_per_refresh"])
                    * float(dash["gb_per_query"]) * (1 - float(dash["cache_pct"]) / 100) * (1 if in_ramp else g) / GIB_PER_TIB)
        if dash_tib:
            scans.append(("Dashboards / reports", dash_tib))

        total_tib = sum(t for _, t in scans)
        free = bq["ondemand_free_tib"] if W["bq_model"] == "ondemand" else 0.0
        for item, tib in scans:
            billable = tib * max(0.0, 1 - free / total_tib) if total_tib else 0.0
            add_compute(m, item, billable)
        if m == ramp_months + 1:
            scan_lines_steady = [{"item": i, "tib": round(t, 3)} for i, t in scans]
        free_left[m] = total_tib

    # ---------------- optional analytics / AI / governance components
    if W.get("include_components"):
        comps, sec = normalized(scenario)

        def set_region(r):
            ctx["rid"] = r if r in regions else data_rid

        new_by_month = {m: (stored_by_month[1] if m == 1 else ingested_by_month[m]) for m in range(1, 37)}
        cost_components(comps, sec, pricing, up, [{"tables": int(float(d["tables"]) / 2.5)}],
                        new_by_month, W["bq_model"], add, 0.5, set_region, data_rid)

    # ---------------- environments: non-production copies sized by their factors
    envs = normalized_envs(scenario)
    env_tot = replicate([payg, cud1_v, cud3_v], {}, envs, service_group, "ondemand", 0.0)

    # ---------------- contingency
    cont = float(W["contingency_pct"]) / 100
    cont_on = "Contingency & operations" not in excluded
    ctx["rid"] = data_rid
    for view in (payg, cud1_v, cud3_v):
        mt = defaultdict(float)
        for (m, *_), v in list(view.items()):
            mt[m] += v
        for m, v in mt.items():
            if cont_on:
                view[(m, "Contingency & operations", "Contingency", data_rid)] += v * cont

    out = _summary(payg, cud1_v, cud3_v, W, regions, data_rid, pipe_rid, strm_rid, ramp_months, scan_lines_steady, free_left, pricing, A)
    out["environments"] = env_summary(envs, env_tot, cont, cont_on)
    comp_types = {c["type"] for c in normalized(scenario)[0] if c.get("included") is not False}
    out["slots"] = slot_sizing(W, scan_lines_steady, A, pricing, regions[data_rid]["uplift"], comp_types, envs)
    return out


def _ceil_step(x, step=SLOT_STEP):
    return int(math.ceil(max(0.0, x) / step - 1e-9) * step)


def slot_sizing(W, scan_lines, A, pricing, uplift, comp_types, envs):
    """Size BigQuery slots from the workload: data volume, job types and frequencies.

    Builds an average 24-hour slot profile (pipelines and heavy jobs in the batch window,
    dashboards / interactive / ad-hoc in business hours), then picks the baseline that
    minimises baseline commitment + autoscaling cost for the recommended edition.
    """
    S = W["slots"]
    sph = float(A["slot_hours_per_tib"])
    window = max(1, min(24, int(float(S["batch_window_hours"]))))
    biz = max(1, min(24, int(float(S["business_hours"]))))
    peak_f = max(1.0, float(S["peak_concurrency"]))
    target_min = max(1.0, float(S["heavy_target_minutes"]))

    tib = {i["item"]: i["tib"] for i in scan_lines}
    cls = {"pipelines": 0.0, "interactive": 0.0, "adhoc": 0.0, "heavy": 0.0}
    for item, t in tib.items():
        if item.endswith("pipelines (ELT)"):
            cls["pipelines"] += t
        elif item in ("Simple queries", "Complex queries", "Dashboards / reports"):
            cls["interactive"] += t
        elif item == "Ad-hoc reports":
            cls["adhoc"] += t
        elif item == "Heavy / periodic queries":
            cls["heavy"] += t
    sh = {k: v * sph for k, v in cls.items()}                 # slot-hours per month
    total_sh = sum(sh.values())

    profile = [0.0] * 24
    for h in range(window):                                   # overnight batch window from 00:00
        profile[h] += (sh["pipelines"] + sh["heavy"]) / 30 / window
    start = 8
    for h in range(start, min(24, start + biz)):
        profile[h] += (sh["interactive"] + sh["adhoc"]) / 30 / biz
    avg_slots = total_sh / 730
    peak_profile = [p * (peak_f if start <= h < start + biz else 1.0) for h, p in enumerate(profile)]
    peak_slots = max(peak_profile) if peak_profile else 0.0

    heavy_q = W["queries"]["heavy"]
    heavy_run_sh = float(heavy_q["gb"]) / 1024 * sph
    heavy_burst = heavy_run_sh / (target_min / 60) if float(heavy_q["count"]) else 0.0
    adhoc_q = W["queries"]["adhoc"]
    adhoc_burst = float(adhoc_q["gb"]) / 1024 * sph / (target_min / 60) if float(adhoc_q["count"]) else 0.0
    max_slots = _ceil_step(max(peak_slots, heavy_burst, adhoc_burst, SLOT_STEP))

    # ---- edition
    reasons, edition = [], "standard"
    ent = []
    if "vpc_sc" in comp_types:
        ent.append("VPC Service Controls")
    if "cmek" in comp_types:
        ent.append("customer-managed encryption keys")
    if "policy_tags" in comp_types:
        ent.append("column / row-level security and data masking")
    if comp_types & {"bqml", "agent_platform", "gemini_enterprise"}:
        ent.append("BigQuery ML and AI functions")
    if float(W["dashboards"]["count"]) and float(W["dashboards"]["cache_pct"]) > 0:
        ent.append("BI Engine acceleration for dashboards")
    if ent:
        edition = "enterprise"
        reasons.append("Enterprise edition is needed for " + ", ".join(ent) + " (not available in Standard).")
    if "assured_workloads" in comp_types:
        edition = "enterprise_plus"
        reasons.append("Enterprise Plus is needed for Assured Workloads compliance controls and managed disaster recovery.")
    if edition == "standard":
        reasons.append("No Enterprise-only features are in the architecture, so Standard edition (autoscaling only) fits.")
    if max_slots > STANDARD_MAX_SLOTS and edition == "standard":
        edition = "enterprise"
        reasons.append(f"Peak demand of {max_slots} slots exceeds Standard edition's {STANDARD_MAX_SLOTS}-slot reservation limit.")
    if S.get("edition") in ("standard", "enterprise", "enterprise_plus"):
        if S["edition"] != edition:
            reasons.append(f"Edition overridden to {S['edition'].replace('_', ' ').title()} by the architect.")
        edition = S["edition"]

    ed = pricing["bigquery"]["editions"][edition]
    payg_p, c1_p, c3_p = ed["payg"] * uplift, ed["cud1"] * uplift, ed["cud3"] * uplift
    can_commit = edition != "standard"

    def monthly_cost(baseline, commit_price):
        auto = sum(_ceil_step(max(0.0, p - baseline)) for p in profile) * 30
        return baseline * 730 * commit_price + auto * payg_p, auto

    candidates = range(0, max_slots + SLOT_STEP, SLOT_STEP) if can_commit else [0]
    best_b, best_cost, best_auto = 0, None, 0.0
    for b in candidates:
        c, auto = monthly_cost(b, c1_p)
        if best_cost is None or c < best_cost - 1e-9:
            best_b, best_cost, best_auto = b, c, auto
    autoscale_only, _ = monthly_cost(0, payg_p)
    rec3, _ = monthly_cost(best_b, c3_p)

    bq = pricing["bigquery"]
    total_tib = sum(tib.values())
    ondemand = max(0.0, total_tib - bq["ondemand_free_tib"]) * bq["ondemand_tib"] * uplift
    model = "editions" if best_cost < ondemand * 0.9 else "ondemand"
    r2 = lambda x: round(x + 1e-12, 2)  # noqa: E731
    ed_name = edition.replace("_", " ").title()
    recs = []
    if model == "editions":
        recs.append(f"Use BigQuery {ed_name} edition: {r2(best_cost):,.0f} USD/month vs {r2(ondemand):,.0f} USD on-demand for the same work.")
    else:
        recs.append(f"Stay on on-demand pricing ({r2(ondemand):,.0f} USD/month): at this volume slots would cost {r2(best_cost):,.0f} USD/month. Revisit when scans grow.")
    if can_commit and best_b:
        recs.append(f"Reserve a baseline of {best_b} slots on a 1-year commitment ({r2(rec3):,.0f} USD/month on 3 years) and let autoscaling cover peaks up to {max_slots} slots.")
    elif can_commit:
        recs.append(f"No baseline is worth committing yet - use an autoscaling reservation with max {max_slots} slots.")
    else:
        recs.append(f"Standard edition has no baseline or commitments: create an autoscaling reservation with max {max_slots} slots.")
    if heavy_burst > peak_slots:
        recs.append(f"Heavy / periodic queries need ~{_ceil_step(heavy_burst)} slots to finish within {target_min:g} minutes - schedule them in the batch window or a separate reservation so dashboards are not starved.")
    recs.append("Separate reservations (or assignments) for ELT, BI and data science keep workloads isolated; idle slots are shared between reservations automatically.")
    recs.append("Validate after go-live with INFORMATION_SCHEMA.JOBS_TIMELINE and the slot estimator, then right-size the baseline.")

    by_env = []
    for e in envs:
        f = e["compute_pct"] / 100.0
        by_env.append({"id": e["id"], "name": e["name"], "baseline_slots": _ceil_step(best_b * f) if best_b else 0,
                       "max_slots": _ceil_step(max_slots * f) if f else 0, "bq_slots": e.get("bq_slots")})
    labels = {"pipelines": "ELT pipelines", "interactive": "Dashboards & interactive queries", "adhoc": "Ad-hoc reports", "heavy": "Heavy / periodic queries"}
    return {
        "inputs": S, "slot_hours_per_tib": sph,
        "by_class": [{"class": labels[k], "tib_month": round(cls[k], 3), "slot_hours_month": round(sh[k], 1),
                      "avg_slots": round(sh[k] / 730, 1)} for k in cls],
        "profile": [round(p, 1) for p in peak_profile],
        "avg_slots": round(avg_slots, 1), "peak_slots": round(peak_slots, 1),
        "heavy_burst_slots": round(heavy_burst, 1), "max_slots": max_slots, "baseline_slots": best_b,
        "edition": edition, "edition_reasons": reasons, "model": model,
        "costs": {"ondemand_month": r2(ondemand), "autoscale_only_month": r2(autoscale_only),
                  "recommended_month": r2(best_cost), "recommended_month_3yr": r2(rec3),
                  "autoscale_slot_hours_month": round(best_auto, 1)},
        "recommendations": recs, "by_environment": by_env,
    }


CATEGORY = {
    "BigQuery storage": "Storage", "Cloud Storage": "Storage",
    "BigQuery compute": "Query & ELT compute",
    "Dataflow (batch)": "Pipelines", "Composer (Airflow)": "Orchestration", "Workflows + Scheduler": "Orchestration",
    "Pub/Sub": "Streaming", "Dataflow (streaming)": "Streaming", "Cross-region data transfer": "Network",
    "Contingency & operations": "Contingency",
}
for _svc in ("Apigee (environment)", "Apigee (API calls)", "Apigee (Advanced API Security)", "AlloyDB", "Cloud SQL", "Spanner", "Bigtable", "Firestore", "Memorystore"):
    CATEGORY[_svc] = "APIs & databases"
CATEGORY_ORDER = ["Storage", "Query & ELT compute", "Pipelines", "Streaming", "Orchestration", "Network", "APIs & databases", "Analytics, AI & governance", "Contingency"]


def _summary(payg, cud1, cud3, W, regions, data_rid, pipe_rid, strm_rid, ramp_months, scan_lines, scans_by_month, pricing, A):
    r2 = lambda x: round(x + 1e-12, 2)  # noqa: E731

    def tot(view, lo, hi):
        return r2(sum(v for (m, *_), v in view.items() if lo <= m <= hi))

    def month_total(view, m):
        return sum(v for (mm, *_), v in view.items() if mm == m)

    monthly = [{"month": m, "payg": r2(month_total(payg, m)), "cud3": r2(month_total(cud3, m))} for m in range(1, 37)]
    totals = {
        "year1_payg": tot(payg, 1, 12), "year1_cud1": tot(cud1, 1, 12),
        "year2_payg": tot(payg, 13, 24), "year3_payg": tot(payg, 25, 36),
        "three_year_payg": tot(payg, 1, 36), "three_year_cud3": tot(cud3, 1, 36),
        "ramp_monthly": r2(sum(month_total(payg, m) for m in range(1, ramp_months + 1)) / ramp_months) if ramp_months else 0.0,
        "steady_monthly": r2(month_total(payg, min(ramp_months + 1, 36))),
    }

    def cat(svc):
        return CATEGORY.get(svc, "Analytics, AI & governance")

    cats = defaultdict(lambda: {"year1": 0.0, "three_year": 0.0, "steady_month": 0.0})
    lines = defaultdict(lambda: {"year1": 0.0, "three_year": 0.0, "steady_month": 0.0})
    regs = defaultdict(lambda: {"year1": 0.0, "three_year": 0.0})
    steady_m = min(ramp_months + 1, 36)
    for (m, svc, item, rid), v in payg.items():
        c = cat(svc)
        for bucket, key in ((cats, c), (lines, (c, svc, item))):
            if m <= 12:
                bucket[key]["year1"] += v
            bucket[key]["three_year"] += v
            if m == steady_m:
                bucket[key]["steady_month"] += v
        if m <= 12:
            regs[rid]["year1"] += v
        regs[rid]["three_year"] += v

    category_rows = [{"category": k, **{kk: r2(vv) for kk, vv in cats[k].items()}} for k in CATEGORY_ORDER if k in cats]
    line_rows = sorted(({"category": k[0], "service": k[1], "item": k[2], **{kk: r2(vv) for kk, vv in v.items()}} for k, v in lines.items()),
                       key=lambda x: (CATEGORY_ORDER.index(x["category"]), -x["three_year"]))
    region_rows = sorted(({"region": k, "name": regions[k]["name"], **{kk: r2(vv) for kk, vv in v.items()}} for k, v in regs.items()),
                         key=lambda x: -x["three_year"])

    # compute-model comparison for the first steady-state month's scan volume
    tib = scans_by_month.get(steady_m, 0.0)
    bq = pricing["bigquery"]
    up = regions[data_rid]["uplift"]
    compare = [{"model": "On-demand", "monthly": r2(max(0.0, tib - bq["ondemand_free_tib"]) * bq["ondemand_tib"] * up), "commit1": None, "commit3": None}]
    for key, label in (("standard", "Standard edition"), ("enterprise", "Enterprise edition"), ("enterprise_plus", "Enterprise Plus edition")):
        ed = bq["editions"][key]
        sh = tib * A["slot_hours_per_tib"]
        compare.append({"model": label, "monthly": r2(sh * ed["payg"] * up), "commit1": r2(sh * ed["cud1"] * up), "commit3": r2(sh * ed["cud3"] * up)})

    return {
        "workload": W,
        "regions": {"data": regions[data_rid], "pipelines": regions[pipe_rid], "streaming": regions[strm_rid]},
        "totals": totals,
        "monthly": monthly,
        "by_category": category_rows,
        "lines": line_rows,
        "by_region": region_rows,
        "scan_tib_steady_month": round(tib, 3),
        "scan_lines_steady_month": scan_lines,
        "compute_comparison": compare,
        "assumptions": A,
        "ramp_months": ramp_months,
        "fx": pricing["fx"],
        "disclaimer": ("Workload-based ballpark from public list prices. Query cost depends heavily on bytes scanned - partitioning, "
                       "clustering, BI Engine and materialized views can reduce it substantially. Partner tools are not costed."),
    }
