"""Use cases: the top 5 recommended from the customer's data, plus the customer's own.

Each use case lists the data it needs (source categories / types / data types) and the products that
deliver it. A use case scores higher the more of its data is already in scope; products already in the
architecture add a little. The result explains why each use case was picked, so the architect can
defend it in the room.
"""
from __future__ import annotations

from .catalog import SOURCE_BY_ID

# id, name, value statement, needs (any of these source categories / type ids / data types), products, industry hints
USE_CASES = [
    {"id": "customer360", "name": "Customer 360 and segmentation",
     "value": "One governed view of every customer across channels for targeting, service and retention.",
     "needs": {"saas_salesforce", "rdbms", "saas_google", "saas_other"}, "strong": {"saas_salesforce", "saas_google"}, "products": ["BigQuery", "Dataform", "Looker", "BigQuery ML"]},
    {"id": "churn", "name": "Churn prediction and next-best action",
     "value": "Predict who is likely to leave and recommend the offer or action that keeps them.",
     "needs": {"rdbms", "saas_salesforce", "saas_google"}, "strong": {"saas_salesforce"}, "products": ["BigQuery ML", "Vertex AI", "Looker"]},
    {"id": "fraud", "name": "Real-time fraud and anomaly detection",
     "value": "Score transactions and events as they happen and alert before losses grow.",
     "needs": {"kafka", "stream_aws", "stream_azure", "rdbms"}, "strong": {"kafka", "stream_aws", "stream_azure"}, "streaming": True, "products": ["Pub/Sub", "Dataflow", "BigQuery ML", "Vertex AI"]},
    {"id": "finance", "name": "Finance and regulatory reporting",
     "value": "Automated, auditable financial and regulatory reports from one reconciled source of truth.",
     "needs": {"sap", "rdbms", "dwh", "files_onprem", "mainframe"}, "strong": {"sap", "mainframe"}, "products": ["BigQuery", "Dataform", "Looker", "Knowledge Catalog"]},
    {"id": "supplychain", "name": "Supply chain and inventory optimisation",
     "value": "Demand forecasts and stock visibility to cut stock-outs and working capital.",
     "needs": {"sap", "rdbms", "files_onprem", "object_aws", "object_azure"}, "strong": {"sap"}, "products": ["BigQuery", "BigQuery ML (forecasting)", "Looker"]},
    {"id": "maintenance", "name": "Predictive maintenance and IoT monitoring",
     "value": "Spot equipment issues from sensor data before they cause downtime.",
     "needs": {"events", "kafka"}, "types": {"iot"}, "streaming": True, "products": ["Pub/Sub", "Dataflow", "BigQuery", "Vertex AI"]},
    {"id": "network", "name": "Network and operations analytics",
     "value": "Monitor service quality and capacity from network, log and probe data.",
     "needs": {"events", "logs", "kafka", "hadoop"}, "strong": {"logs", "hadoop"}, "products": ["Pub/Sub", "BigQuery", "Looker"]},
    {"id": "dwh_modern", "name": "Data warehouse modernisation",
     "value": "Retire the legacy warehouse, cut licence cost and open the data to AI.",
     "needs": {"dwh", "hadoop"}, "strong": {"dwh", "hadoop"}, "products": ["BigQuery Migration Service", "BigQuery", "Dataform"]},
    {"id": "genai_docs", "name": "Document intelligence and knowledge search",
     "value": "Let employees ask questions over contracts, policies and manuals with cited answers.",
     "needs": {"unstructured", "object_gcp", "files_onprem"}, "data_types": {"unstructured"}, "products": ["Cloud Storage object tables", "Gemini 3.8 Flash", "Gemini Enterprise"]},
    {"id": "data_agents", "name": "Conversational analytics (data agents)",
     "value": "Business users ask questions in plain language and get governed answers from BigQuery.",
     "needs": {"rdbms", "sap", "dwh", "saas_salesforce", "saas_other"}, "components": {"agent_platform", "gemini_enterprise", "looker"},
     "products": ["Agent Platform data agents", "Gemini 3.8 Flash", "Looker"]},
    {"id": "marketing", "name": "Marketing performance and attribution",
     "value": "Measure campaign ROI across channels and shift spend to what works.",
     "needs": {"saas_google", "saas_salesforce", "events"}, "strong": {"saas_google"}, "products": ["BigQuery Data Transfer Service", "BigQuery ML", "Looker"]},
    {"id": "selfservice", "name": "Self-service BI and executive dashboards",
     "value": "Trusted KPIs for leaders and teams, refreshed automatically.",
     "needs": {"rdbms", "sap", "dwh", "saas_other", "files_onprem", "saas_salesforce"}, "components": {"looker", "looker_studio_pro", "power_bi", "tableau"},
     "products": ["BigQuery", "Looker", "BI Engine"]},
    {"id": "governance", "name": "Data governance and data products",
     "value": "Catalogued, quality-checked data products with lineage and access policies.",
     "needs": {"rdbms", "sap", "dwh", "hadoop", "files_onprem"}, "components": {"knowledge_catalog", "policy_tags", "sdp"},
     "products": ["Knowledge Catalog", "Policy tags", "Sensitive Data Protection"]},
    {"id": "ops_apps", "name": "Operational apps and APIs on curated data",
     "value": "Serve curated data to apps and partners through low-latency databases and APIs.",
     "needs": {"rdbms", "api", "saas_other"}, "components": {"apigee", "alloydb", "cloudsql", "spanner"},
     "products": ["Apigee", "AlloyDB", "Reverse ETL"]},
]


def _profile(scenario, recs):
    cats, types, dtypes, streaming = set(), set(), set(), False
    for s in scenario.get("sources", []):
        if s.get("included", True) is False:
            continue
        t = s.get("like_type") if s.get("type") == "custom" else s.get("type")
        cats.add(SOURCE_BY_ID.get(t, {}).get("category", ""))
        types.add(t)
        dtypes.add(s.get("data_type") or "")
        if s.get("frequency") in ("realtime", "near_realtime"):
            streaming = True
    comps = {c.get("type") for c in scenario.get("components") or [] if c.get("included") is not False}
    return cats, types, dtypes, streaming, comps


def recommend_use_cases(scenario: dict, recs=None, top: int = 5) -> list[dict]:
    cats, types, dtypes, streaming, comps = _profile(scenario, recs)
    names = {}
    for s in scenario.get("sources", []):
        t = s.get("like_type") if s.get("type") == "custom" else s.get("type")
        names.setdefault(SOURCE_BY_ID.get(t, {}).get("category", ""), []).append(s.get("custom_name") or s.get("name") or t)
    out = []
    for uc in USE_CASES:
        hit = cats & uc["needs"]
        score = 2.0 * len(hit) + 2.5 * len(cats & uc.get("strong", set()))
        why = []
        if hit:
            srcs = [n for c in hit for n in names.get(c, [])]
            why.append("Uses " + ", ".join(srcs[:4]) + (f" and {len(srcs) - 4} more" if len(srcs) > 4 else ""))
        if uc.get("types") and types & uc["types"]:
            score += 3
            why.append("IoT / sensor data is in scope")
        if uc.get("data_types") and dtypes & uc["data_types"]:
            score += 3
            why.append("Unstructured documents are in scope")
        if uc.get("streaming"):
            if streaming:
                score += 1.5
                why.append("Real-time feeds are already planned")
            else:
                score -= 2
        cm = comps & uc.get("components", set())
        if cm:
            score += 1.0
            why.append("Products already in the architecture support it")
        if score <= 0:
            continue
        out.append({"id": uc["id"], "name": uc["name"], "value": uc["value"], "products": uc["products"],
                    "score": round(score, 1), "why": "; ".join(why) + "." if why else ""})
    out.sort(key=lambda x: (-x["score"], x["name"]))
    return out[:top]


def catalog_use_cases():
    return [{"id": u["id"], "name": u["name"], "value": u["value"], "products": u["products"]} for u in USE_CASES]
