"""Environments (production, dev, test, DR ...) with their own sizing.

The scenario's inputs (sources, components, workload) describe the *primary*
environment - normally production. Every other environment is sized as a
percentage of it, per capability:

    data_pct       BigQuery / Cloud Storage storage, initial loads
    ingestion_pct  CDC, pipelines, streaming, BigQuery ingestion, transfer
    compute_pct    BigQuery query compute (on-demand); editions use bq_slots
    ai_pct         BI licences, Gemini Enterprise, agents, GPU endpoints
    apps_pct       Apigee and operational databases
    platform_pct   orchestration, Data Fusion instance, governance & security

Shared network links (HA VPN / Interconnect) and customer-quoted licences
(Looker) are counted once - non-production environments reuse them.
"""
from __future__ import annotations

FACTORS = ["data_pct", "ingestion_pct", "compute_pct", "ai_pct", "apps_pct", "platform_pct"]

FACTOR_LABELS = {
    "data_pct": "Data volume %",
    "ingestion_pct": "Ingestion & pipelines %",
    "compute_pct": "BigQuery compute %",
    "ai_pct": "BI, AI & agents usage %",
    "apps_pct": "APIs & databases %",
    "platform_pct": "Platform, governance & security %",
}

ENV_PRESETS = [
    {"id": "prod", "name": "Production", "data_pct": 100, "ingestion_pct": 100, "compute_pct": 100, "ai_pct": 100, "apps_pct": 100, "platform_pct": 100},
    {"id": "preprod", "name": "Pre-production", "data_pct": 50, "ingestion_pct": 50, "compute_pct": 30, "ai_pct": 15, "apps_pct": 50, "platform_pct": 100},
    {"id": "uat", "name": "UAT / test", "data_pct": 25, "ingestion_pct": 25, "compute_pct": 20, "ai_pct": 10, "apps_pct": 50, "platform_pct": 50},
    {"id": "dev", "name": "Development", "data_pct": 10, "ingestion_pct": 10, "compute_pct": 10, "ai_pct": 5, "apps_pct": 25, "platform_pct": 50},
    {"id": "sandbox", "name": "Data science sandbox", "data_pct": 20, "ingestion_pct": 0, "compute_pct": 25, "ai_pct": 20, "apps_pct": 0, "platform_pct": 25},
    {"id": "dr", "name": "Disaster recovery", "data_pct": 100, "ingestion_pct": 10, "compute_pct": 5, "ai_pct": 0, "apps_pct": 50, "platform_pct": 50},
]
PRESET_BY_ID = {p["id"]: p for p in ENV_PRESETS}

DEFAULT_ENVIRONMENTS = [{"id": "prod", "name": "Production", "preset": "prod"}]

SHARED_SERVICES = ("Network (HA VPN)", "Network (Interconnect)", "Looker licence (customer quote)", "Contingency & operations")


def normalized_envs(scenario: dict) -> list[dict]:
    """Environments with every factor filled in. The first included one is the primary (100 %)."""
    raw = scenario.get("environments") or DEFAULT_ENVIRONMENTS
    out = []
    for i, e in enumerate(raw):
        if e.get("included") is False:
            continue
        preset = PRESET_BY_ID.get(e.get("preset") or "", PRESET_BY_ID["dev"] if out else PRESET_BY_ID["prod"])
        env = {"id": str(e.get("id") or f"env{i + 1}"), "name": e.get("name") or preset["name"],
               "preset": e.get("preset") or preset["id"]}
        for f in FACTORS:
            v = e.get(f)
            env[f] = max(0.0, float(preset[f] if v is None else v))
        env["bq_slots"] = None if e.get("bq_slots") in (None, "") else max(0.0, float(e["bq_slots"]))
        out.append(env)
    if not out:
        out = [{"id": "prod", "name": "Production", "preset": "prod", **{f: 100.0 for f in FACTORS}, "bq_slots": None}]
    primary = out[0]
    for f in FACTORS:
        primary[f] = 100.0
    return out


def factor_key(service: str, group: str) -> str | None:
    """Which sizing factor scales this service line (None = shared, counted once)."""
    if service in SHARED_SERVICES:
        return None
    s = service.lower()
    if service == "BigQuery storage" or s.startswith("cloud storage") or service == "One-time initial load":
        return "data_pct"
    if service == "BigQuery compute" or service.startswith("BigQuery queries from"):
        return "compute_pct"
    if service == "BigQuery ingestion (Write API / streaming)" or service == "Cross-region data transfer":
        return "ingestion_pct"
    return {
        "Data ingestion & CDC": "ingestion_pct",
        "Analytics & AI": "ai_pct",
        "APIs & databases": "apps_pct",
        "Governance & security": "platform_pct",
        "Platform & network": "platform_pct",
        "BigQuery & storage": "data_pct",
    }.get(group, "platform_pct")


def env_factor(env: dict, service: str, group: str, bq_model: str, base_slots: float) -> float:
    if service == "BigQuery compute" and bq_model != "ondemand" and env.get("bq_slots") is not None:
        return env["bq_slots"] / base_slots if base_slots else 0.0
    k = factor_key(service, group)
    return 0.0 if k is None else env[k] / 100.0


def replicate(views: list[dict], bom: dict, envs: list[dict], group_fn, bq_model: str, base_slots: float):
    """Add the non-primary environments to every ledger view (in place).

    views: dicts keyed (m, service, item, region) -> usd (PAYG, CUD1, CUD3)
    bom:   dict keyed (m, service, env_id) -> [usd, qty]
    Returns per-environment monthly totals: {env_id: {"payg": [37], "cud1": [37], "cud3": [37]}}.
    """
    names = ("payg", "cud1", "cud3")
    env_tot = {e["id"]: {n: [0.0] * 37 for n in names} for e in envs}
    primary = envs[0]["id"]
    for n, view in zip(names, views):
        for (m, svc, *_), v in view.items():
            env_tot[primary][n][m] += v
    if len(envs) > 1:
        for n, view in zip(names, views):
            base = list(view.items())
            for env in envs[1:]:
                for k, v in base:
                    f = env_factor(env, k[1], group_fn(k[1]), bq_model, base_slots)
                    if f:
                        view[k] += v * f
                        env_tot[env["id"]][n][k[0]] += v * f
        base_bom = [(k, list(v)) for k, v in bom.items() if k[2] == primary]
        for env in envs[1:]:
            for (m, svc, _), (usd, qty) in base_bom:
                f = env_factor(env, svc, group_fn(svc), bq_model, base_slots)
                if f:
                    row = bom.setdefault((m, svc, env["id"]), [0.0, 0.0])
                    row[0] += usd * f
                    row[1] += qty * f
    return env_tot


def env_summary(envs, env_tot, cont, contingency_on):
    """Year-1 / 3-year totals per environment (contingency applied pro rata)."""
    mult = 1 + (cont if contingency_on else 0.0)
    rows = []
    for e in envs:
        t = env_tot[e["id"]]
        y1 = sum(t["payg"][1:13]) * mult
        y3 = sum(t["payg"][1:37]) * mult
        rows.append({
            "id": e["id"], "name": e["name"], "preset": e["preset"],
            "factors": {f: e[f] for f in FACTORS}, "bq_slots": e["bq_slots"],
            "monthly_year1": round(y1 / 12 + 1e-12, 2),
            "year1": round(y1 + 1e-12, 2), "year1_cud": round(sum(t["cud1"][1:13]) * mult + 1e-12, 2),
            "three_year": round(y3 + 1e-12, 2), "three_year_cud": round(sum(t["cud3"][1:37]) * mult + 1e-12, 2),
        })
    return rows
