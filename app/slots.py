"""BigQuery editions: slot sizing and pricing shared by the estimate and workload sizing.

How BigQuery editions are billed (and modelled here)
-----------------------------------------------------
* A reservation has a **baseline** (always allocated, billed every hour, the only
  part a 1- or 3-year commitment can cover) and a **max** (baseline + autoscale).
* **Autoscaling** adds slots in 50-slot steps only while queries need them and is
  always billed at the pay-as-you-go rate.
* Standard edition has no baseline and no commitments; one reservation can reach
  at most 1,600 slots.

Demand is built as an average 24-hour profile: pipelines (ELT) and heavy periodic
jobs run in an overnight batch window; dashboards, interactive and ad-hoc queries
run in business hours, with a busiest-hour factor. Slot-hours come from TiB
scanned x slot-hours per TiB (editable / calibrated from INFORMATION_SCHEMA).
"""
from __future__ import annotations

import math

SLOT_STEP = 50
SLOT_MIN = 100        # a reservation baseline / capacity commitment starts at 100 slots, then grows in steps of 50
STANDARD_MAX_SLOTS = 1600
HOURS = 730
EDITIONS = ("standard", "enterprise", "enterprise_plus")
EDITION_NAME = {"standard": "Standard", "enterprise": "Enterprise", "enterprise_plus": "Enterprise Plus"}

DEFAULT_SHAPE = {
    "batch_window_hours": 6,     # pipelines and heavy periodic jobs run in this overnight window
    "business_hours": 10,        # dashboards, interactive and ad-hoc queries run in these hours
    "peak_concurrency": 1.5,     # busiest business hour vs. the business-hours average
    "heavy_target_minutes": 30,  # one heavy / periodic query should finish within this time
}

CLASS_LABELS = {"pipelines": "ELT pipelines", "interactive": "Dashboards & interactive queries",
                "adhoc": "Ad-hoc reports", "heavy": "Heavy / periodic queries"}


def ceil_step(x, step=SLOT_STEP):
    return int(math.ceil(max(0.0, x) / step - 1e-9) * step)


def floor_step(x, step=SLOT_STEP):
    return int(math.floor(max(0.0, x) / step + 1e-9) * step)


def res_max(x):
    """Max reservation size: 0, or at least SLOT_MIN in steps of 50."""
    return 0 if x <= 1e-9 else max(SLOT_MIN, ceil_step(x))


def res_baseline(x):
    """Baseline / commitment: 0, or at least SLOT_MIN in steps of 50 (smaller amounts are left to autoscaling)."""
    b = floor_step(x)
    return b if b >= SLOT_MIN else 0


def snap_baseline(x):
    """An architect-entered baseline: 0 stays 0, 1-99 becomes 100, otherwise rounded up to a 50-slot step."""
    return 0 if x <= 1e-9 else max(SLOT_MIN, ceil_step(x))


def shape_settings(s: dict | None) -> dict:
    out = {**DEFAULT_SHAPE, **{k: v for k, v in (s or {}).items() if k in DEFAULT_SHAPE and v not in (None, "")}}
    out["batch_window_hours"] = max(1, min(24, int(float(out["batch_window_hours"]))))
    out["business_hours"] = max(1, min(24, int(float(out["business_hours"]))))
    out["peak_concurrency"] = max(1.0, float(out["peak_concurrency"]))
    out["heavy_target_minutes"] = max(1.0, float(out["heavy_target_minutes"]))
    return out


def profile(slot_hours: dict, S: dict) -> list[float]:
    """Average slots by hour of day (busiest-hour factor applied in business hours)."""
    window, biz, peak = S["batch_window_hours"], S["business_hours"], S["peak_concurrency"]
    p = [0.0] * 24
    for h in range(window):
        p[h] += (slot_hours.get("pipelines", 0.0) + slot_hours.get("heavy", 0.0)) / 30 / window
    start = 8
    for h in range(start, min(24, start + biz)):
        p[h] += (slot_hours.get("interactive", 0.0) + slot_hours.get("adhoc", 0.0)) / 30 / biz * peak
    return p


AUTOSCALE_OVERHEAD = 1.25   # 50-slot increments, 1-minute minimum and scale-down lag on top of the slots queries use


def autoscale_slot_hours(prof: list[float], baseline: float, max_slots: float, overhead: float = AUTOSCALE_OVERHEAD) -> float:
    """Monthly autoscaled slot-hours: average demand above the baseline (capped at max) x billing overhead."""
    head = max(0.0, max_slots - baseline)
    return sum(min(head, max(0.0, p - baseline)) for p in prof) * 30 * overhead


def recommend_edition(comp_types: set, max_slots: float, dashboards: bool = False):
    reasons, edition, ent = [], "standard", []
    if "vpc_sc" in comp_types:
        ent.append("VPC Service Controls")
    if "cmek" in comp_types:
        ent.append("customer-managed encryption keys")
    if "policy_tags" in comp_types:
        ent.append("column / row-level security and data masking")
    if comp_types & {"bqml", "agent_platform", "gemini_enterprise"}:
        ent.append("BigQuery ML and AI functions")
    if dashboards or comp_types & {"looker", "looker_studio", "power_bi", "tableau"}:
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
        reasons.append(f"Peak demand of {max_slots:,.0f} slots exceeds Standard edition's {STANDARD_MAX_SLOTS:,}-slot limit.")
    return edition, reasons


def edition_prices(pricing, edition, uplift):
    ed = pricing["bigquery"]["editions"][edition]
    return ed["payg"] * uplift, ed["cud1"] * uplift, ed["cud3"] * uplift


def best_baseline(prof, max_slots, prices, edition, option="cud1"):
    """Baseline that minimises (baseline at the option's rate + autoscaling) per month.

    option: "payg" (no commitment), "cud1" or "cud3". Candidates are 0 or 100, 150, 200 … up to max.
    """
    payg, c1, c3 = prices
    rate = {"payg": payg, "cud1": c1, "cud3": c3}[option]
    if edition == "standard":
        return 0
    best_b, best = 0, None
    for b in [0] + list(range(SLOT_MIN, int(max_slots) + SLOT_STEP, SLOT_STEP)):
        if b > max_slots:
            break
        c = b * HOURS * rate + autoscale_slot_hours(prof, b, max_slots) * payg
        if best is None or c < best - 1e-9:
            best_b, best = b, c
    return best_b


def month_cost(prof, baseline, max_slots, prices):
    """(payg, cud1, cud3, slot_hours) for one month. Commitments only apply to the baseline."""
    payg, c1, c3 = prices
    auto = autoscale_slot_hours(prof, baseline, max_slots)
    base_h = baseline * HOURS
    return (base_h * payg + auto * payg, base_h * c1 + auto * payg, base_h * c3 + auto * payg, base_h + auto)


def size(slot_hours: dict, S: dict, pricing: dict, uplift: float, comp_types: set, *, edition_choice="auto",
         baseline_override=None, max_override=None, heavy_query_tib=0.0, adhoc_query_tib=0.0,
         dashboards=False, ondemand_tib=None, slot_hours_per_tib=60.0):
    """Recommend edition, baseline and max for one month of demand (normally the steady-state month)."""
    prof = profile(slot_hours, S)
    sph_total = sum(slot_hours.values())
    peak = max(prof) if prof else 0.0
    target_h = S["heavy_target_minutes"] / 60
    sph_per_tib = float(slot_hours_per_tib)
    heavy_burst = heavy_query_tib * sph_per_tib / target_h if heavy_query_tib else 0.0
    adhoc_burst = adhoc_query_tib * sph_per_tib / target_h if adhoc_query_tib else 0.0
    auto_max = res_max(max(peak, heavy_burst, adhoc_burst, SLOT_MIN if sph_total else 0))
    rec_edition, reasons = recommend_edition(comp_types, auto_max, dashboards)
    edition = edition_choice if edition_choice in EDITIONS else rec_edition
    if edition != rec_edition:
        reasons = reasons + [f"Edition set to {EDITION_NAME[edition]} by the architect (recommended: {EDITION_NAME[rec_edition]})."]
    prices = edition_prices(pricing, edition, uplift)
    max_slots = float(res_max(float(max_override))) if max_override not in (None, "") else auto_max
    if edition == "standard":
        max_slots = min(max_slots, STANDARD_MAX_SLOTS)
    auto_baseline = best_baseline(prof, max_slots, prices, edition)
    baseline = float(snap_baseline(float(baseline_override))) if baseline_override not in (None, "") else auto_baseline
    by_option = {o: (baseline if baseline_override not in (None, "") else best_baseline(prof, max_slots, prices, edition, o))
                 for o in ("payg", "cud1", "cud3")}
    if edition == "standard":
        baseline = 0.0
    baseline = min(baseline, max_slots) if max_slots else baseline
    by_option = {o: min(0.0 if edition == "standard" else float(v), max_slots) for o, v in by_option.items()}
    warnings = []
    if baseline_override not in (None, "") and edition == "standard" and float(baseline_override) > 0:
        warnings.append("Standard edition has no baseline - the baseline was set to 0 (autoscaling only).")
    if max_override not in (None, "") and edition == "standard" and float(max_override) > STANDARD_MAX_SLOTS:
        warnings.append(f"Standard edition is capped at {STANDARD_MAX_SLOTS:,} slots.")
    if peak > max_slots + 1e-9 and sph_total:
        warnings.append(f"Busiest-hour demand (~{peak:,.0f} slots) is above the max of {max_slots:,.0f}: queries will queue at peak.")
    payg, c1, c3, sh = month_cost(prof, baseline, max_slots, prices)
    payg = month_cost(prof, by_option["payg"], max_slots, prices)[0]
    c3 = month_cost(prof, by_option["cud3"], max_slots, prices)[2]
    comparison = []
    for e in EDITIONS:
        pr = edition_prices(pricing, e, uplift)
        mx = min(auto_max, STANDARD_MAX_SLOTS) if e == "standard" else auto_max
        b = best_baseline(prof, mx, pr, e)
        p_, c1_, c3_, _ = month_cost(prof, b, mx, pr)
        comparison.append({"edition": e, "name": EDITION_NAME[e], "baseline": b, "max": mx,
                           "payg": round(p_, 2), "cud1": round(c1_, 2), "cud3": round(c3_, 2),
                           "fits": not (e == "standard" and auto_max > STANDARD_MAX_SLOTS)})
    if ondemand_tib is not None:
        bq = pricing["bigquery"]
        od = max(0.0, ondemand_tib - bq["ondemand_free_tib"]) * bq["ondemand_tib"] * uplift
        comparison.insert(0, {"edition": "ondemand", "name": "On-demand", "baseline": None, "max": None,
                              "payg": round(od, 2), "cud1": round(od, 2), "cud3": round(od, 2), "fits": True})
    rec_mode = "editions"
    if ondemand_tib is not None:
        od_cost = comparison[0]["payg"]
        best_ed = min((c for c in comparison[1:] if c["edition"] == edition), key=lambda c: c["cud1"], default=None)
        if best_ed is None or od_cost <= best_ed["cud1"] * 1.1:
            rec_mode = "ondemand"
    return {
        "recommended_mode": rec_mode,
        "edition": edition, "recommended_edition": rec_edition, "edition_reasons": reasons,
        "baseline": baseline, "max": max_slots, "auto_baseline": auto_baseline, "auto_max": auto_max,
        "baseline_by_option": by_option, "slot_min": SLOT_MIN, "slot_step": SLOT_STEP,
        "profile": [round(p, 1) for p in prof], "avg_slots": round(sph_total / HOURS, 1), "peak_slots": round(peak, 1),
        "heavy_burst_slots": round(heavy_burst, 1), "adhoc_burst_slots": round(adhoc_burst, 1), "slot_hours_month": round(sph_total, 1),
        "autoscale_slot_hours_month": round(sh - baseline * HOURS, 1), "autoscale_overhead": AUTOSCALE_OVERHEAD,
        "month_cost": {"payg": round(payg, 2), "cud1": round(c1, 2), "cud3": round(c3, 2)},
        "comparison": comparison, "warnings": warnings,
    }


# --------------------------------------------------------------------------- year-by-year plan (1-yr and 3-yr commitments)
OPT_IDX = {"payg": 0, "cud1": 1, "cud3": 2}


def year_of(month: int) -> int:
    return (month - 1) // 12 + 1


def _year_cost(profs, baseline, max_slots, prices, idx):
    """Cost of one year's live months at a fixed baseline (commitment billed only once BigQuery is live)."""
    return sum(month_cost(p, baseline, max_slots, prices)[idx] for p in profs)


def best_year_baseline(profs, max_slots, prices, option, floor=0):
    """Baseline that minimises the whole year's cost - ramp-up months included - for one pricing option.

    floor: a 3-year commitment can only grow, so later years never go below the earlier commitment.
    """
    idx = OPT_IDX[option]
    cands = [b for b in [0] + list(range(SLOT_MIN, int(max_slots) + SLOT_STEP, SLOT_STEP)) if b <= max_slots and b >= floor]
    if floor and floor not in cands:
        cands = [floor] + cands
    best_b, best = (cands[0] if cands else floor), None
    for b in cands:
        c = _year_cost(profs, b, max(max_slots, b), prices, idx)
        if best is None or c < best - 1e-9:
            best_b, best = b, c
    return best_b


def plan_years(profs_by_year: dict, max_by_year: dict, prices, *, allow_baseline=True, baseline_override=None, strategy="optimal"):
    """Slots and cost for years 1-3 under pay as you go, 1-year commitments (renewed each year) and one 3-year commitment.

    profs_by_year: {year: [24-hour profile per live month]}; max_by_year: {year: max reservation slots}.
    Returns {year: {...}} with demand, max, baseline per option, the 3-year top-up and the cost per option.
    """
    out, c3_prev = {}, 0
    for y in (1, 2, 3):
        profs = profs_by_year.get(y) or []
        mx = float(max_by_year.get(y) or 0)
        sh = [sum(p) * 30 for p in profs]
        if baseline_override not in (None, ""):
            b = float(min(snap_baseline(float(baseline_override)), mx)) if allow_baseline else 0.0
            base = {"payg": b, "cud1": b, "cud3": max(b, c3_prev) if profs else c3_prev}
        elif not allow_baseline or not profs or not mx:
            base = {"payg": 0.0, "cud1": 0.0, "cud3": float(c3_prev)}
        else:
            base = {"payg": float(best_year_baseline(profs, mx, prices, "payg")),
                    "cud1": float(best_year_baseline(profs, mx, prices, "cud1")),
                    "cud3": float(best_year_baseline(profs, mx, prices, "cud3", floor=c3_prev))}
            if strategy == "average":
                # an environment averaging under 100 slots is left to autoscaling (the minimum commitment would sit idle)
                a = float(min(mx, res_baseline(sum(sh) / (len(profs) * HOURS))))
                base["cud1"], base["cud3"] = a, max(a, float(c3_prev))
        n = len(profs)
        # the alternative the architect may prefer: commit to the average demand (at least 100 slots)
        avg_c = float(min(mx, max(SLOT_MIN, floor_step(sum(sh) / (n * HOURS))))) if (n and mx and allow_baseline) else 0.0
        alt = None
        if avg_c:
            a3 = max(avg_c, float(c3_prev))
            alt = {"slots": {"cud1": avg_c, "cud3": a3},
                   "cost": {"cud1": round(_year_cost(profs, avg_c, max(mx, avg_c), prices, 1), 2),
                            "cud3": round(_year_cost(profs, a3, max(mx, a3), prices, 2), 2)}}
        cost = {o: round(_year_cost(profs, base[o], max(mx, base[o]), prices, OPT_IDX[o]), 2) for o in OPT_IDX}
        auto = {o: round(sum(autoscale_slot_hours(p, base[o], max(mx, base[o])) for p in profs), 1) for o in OPT_IDX}
        out[y] = {"year": y, "live_months": n, "max": max(mx, base["cud3"]),
                  "avg_slots": round(sum(sh) / (n * HOURS), 1) if n else 0.0,
                  "peak_slots": round(max((max(p) for p in profs), default=0.0), 1),
                  "slot_hours": round(sum(sh), 1),
                  "baseline": base, "commitment": {"payg": 0.0, "cud1": base["cud1"], "cud3": base["cud3"]},
                  "cud3_topup": max(0.0, base["cud3"] - c3_prev),
                  "autoscale_slot_hours": auto, "cost": cost, "at_average": alt}
        c3_prev = base["cud3"]
    return out
