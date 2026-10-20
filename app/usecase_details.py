"""Use case details: what the use case is, the business benefits, KPIs, the data it needs and how it
is built on Google Cloud.

Each data requirement names specific data points and the source categories that usually hold them.
`details()` maps every requirement to the customer's own source systems in scope - so the architect
sees which data is already planned and which is a gap to raise with the customer.

Use cases the customer types in (not in this library) are described by Gemini with the same layout
(see app/main.py, /api/usecases/details).
"""
from __future__ import annotations

from .catalog import SOURCE_BY_ID

CRM = {"saas_salesforce", "saas_other"}
OLTP = {"rdbms", "rdbms_gcp", "rdbms_nocdc", "nosql", "nosql_gcp", "mainframe"}
ERP = {"sap"}
WEB = {"saas_google", "events"}
STREAM = {"kafka", "stream_aws", "stream_azure", "events"}
FILES = {"files_onprem", "object_aws", "object_azure", "object_gcp"}
DWH = {"dwh", "hadoop"}
DOCS = {"unstructured", "object_gcp", "files_onprem", "object_aws", "object_azure"}
LOGS = {"logs", "events", "kafka"}

DETAILS = {
    "customer360": {
        "summary": "Bring every customer interaction - accounts, orders, service cases, web and app behaviour - into one governed profile per customer in BigQuery, with segments that marketing, sales and service teams can use.",
        "benefits": ["Higher campaign conversion through better targeting", "Fewer duplicate and conflicting customer records", "Faster, more personal service with the full history in one place", "A reusable foundation for churn, next-best action and AI agents"],
        "kpis": ["Single-customer-view match rate", "Campaign conversion rate", "Customer lifetime value", "Time to build a new segment"],
        "data": [
            {"data": "Customer master", "categories": CRM | OLTP | ERP, "points": ["customer ID", "name, email, phone (masked)", "segment / tier", "country and region", "account open date", "consent flags"]},
            {"data": "Transactions or orders", "categories": OLTP | ERP | STREAM, "points": ["order / transaction ID", "customer ID", "date and time", "amount and currency", "product or plan", "channel"]},
            {"data": "Service interactions", "categories": CRM, "points": ["case ID", "customer ID", "case type and status", "opened / closed time", "satisfaction score"]},
            {"data": "Digital behaviour", "categories": WEB, "points": ["user / device ID", "sessions and page views", "campaign source (UTM)", "app events", "conversion events"]},
        ],
        "build": ["Datastream / BigQuery Data Transfer land source data in bronze", "Dataform matches and merges customers into a golden record in silver", "Segments and features in gold; Looker for teams; BigQuery ML for propensity scores"],
    },
    "churn": {
        "summary": "Predict which customers are likely to leave in the coming weeks and recommend the offer, contact or service action most likely to keep them - scored daily in BigQuery and delivered to CRM and service teams.",
        "benefits": ["Lower churn and higher recurring revenue", "Retention budget spent on customers who are really at risk", "Proactive service instead of reacting to cancellations", "Measurable lift from each retention action"],
        "kpis": ["Monthly churn rate", "Retention campaign save rate", "Model precision at the top 10% of scores", "Revenue retained"],
        "data": [
            {"data": "Subscription or account history", "categories": OLTP | CRM | ERP, "points": ["customer ID", "plan / product", "start and end dates", "contract renewal date", "price changes", "cancellation reason"]},
            {"data": "Usage and engagement", "categories": WEB | STREAM | OLTP, "points": ["customer ID", "logins or sessions per week", "feature or content usage", "last activity date", "usage trend"]},
            {"data": "Billing and payments", "categories": OLTP | ERP, "points": ["invoice amount", "payment method", "failed or late payments", "discounts applied"]},
            {"data": "Service and complaints", "categories": CRM, "points": ["number of cases in last 90 days", "case severity", "time to resolve", "satisfaction / NPS"]},
        ],
        "build": ["Features built in Dataform from the customer 360 tables", "BigQuery ML or Vertex AI trains and scores churn risk daily", "Scores pushed back to CRM with reverse ETL; Looker tracks saves"],
    },
    "fraud": {
        "summary": "Score payments, logins and other events as they happen, flag unusual behaviour within seconds and route alerts to investigators - combining streaming rules with machine-learning models.",
        "benefits": ["Lower fraud losses and chargebacks", "Fewer false positives blocking good customers", "Faster investigation with full event context", "Audit trail for regulators"],
        "kpis": ["Fraud loss as % of volume", "False positive rate", "Time from event to alert", "Investigator cases closed per day"],
        "data": [
            {"data": "Real-time transaction or event stream", "categories": STREAM, "points": ["event ID", "customer / account ID", "amount", "timestamp", "merchant or counterparty", "device and IP", "location"]},
            {"data": "Customer and account profile", "categories": OLTP | CRM, "points": ["account age", "usual spending pattern", "KYC status", "linked accounts"]},
            {"data": "Confirmed fraud labels", "categories": OLTP | FILES, "points": ["event ID", "fraud confirmed (yes/no)", "fraud type", "confirmation date"]},
        ],
        "build": ["Pub/Sub ingests events; Dataflow applies rules and features in flight", "BigQuery ML / Vertex AI model scores each event", "Alerts to case management; history in BigQuery for retraining"],
    },
    "finance": {
        "summary": "Produce financial, management and regulatory reports from one reconciled source of truth, with automated controls, lineage from report to source and far less spreadsheet work at month end.",
        "benefits": ["Faster month-end and quarter-end close", "Fewer manual reconciliations and errors", "Lineage and audit trail for auditors and regulators", "One version of the numbers for finance and the business"],
        "kpis": ["Days to close", "Manual adjustments per close", "Report preparation hours", "Audit findings"],
        "data": [
            {"data": "General ledger", "categories": ERP | OLTP, "points": ["company code", "GL account", "cost centre / profit centre", "posting date and period", "amount in local and group currency", "document number"]},
            {"data": "Sub-ledgers", "categories": ERP | OLTP, "points": ["accounts payable and receivable items", "fixed assets", "intercompany transactions", "open item status"]},
            {"data": "Reference and master data", "categories": ERP | FILES, "points": ["chart of accounts", "entity hierarchy", "exchange rates", "regulatory mapping tables"]},
        ],
        "build": ["SAP / database extracts land in bronze; Dataform reconciles to the ledger in silver", "Gold reporting marts with Knowledge Catalog lineage", "Looker reports with row-level security per entity"],
    },
    "supplychain": {
        "summary": "Forecast demand by product and location, see stock across the network and recommend replenishment - reducing stock-outs and excess inventory.",
        "benefits": ["Fewer stock-outs and lost sales", "Lower inventory and working capital", "Better supplier and logistics planning", "One view of stock across sites"],
        "kpis": ["Forecast accuracy (MAPE)", "Stock-out rate", "Inventory days on hand", "On-time, in-full deliveries"],
        "data": [
            {"data": "Sales or consumption history", "categories": ERP | OLTP | FILES, "points": ["product / SKU", "location", "date", "quantity sold or used", "price", "promotion flag"]},
            {"data": "Inventory positions", "categories": ERP | OLTP, "points": ["SKU", "warehouse / store", "on-hand quantity", "in-transit quantity", "snapshot date"]},
            {"data": "Purchase orders and suppliers", "categories": ERP, "points": ["PO number", "supplier", "order and delivery dates", "lead time", "quantity"]},
        ],
        "build": ["ERP and sales data land in bronze; Dataform builds daily SKU-location facts", "BigQuery ML ARIMA_PLUS / TimesFM forecasts demand", "Looker dashboards and replenishment exports"],
    },
    "maintenance": {
        "summary": "Collect sensor and machine data in real time, detect anomalies and predict failures before they happen, so maintenance is planned rather than reactive.",
        "benefits": ["Less unplanned downtime", "Lower maintenance and spare-parts cost", "Longer asset life", "Safer operations"],
        "kpis": ["Unplanned downtime hours", "Mean time between failures", "Maintenance cost per asset", "Prediction lead time"],
        "data": [
            {"data": "Sensor telemetry", "categories": STREAM, "types": {"iot"}, "points": ["asset / device ID", "timestamp", "temperature, vibration, pressure readings", "operating state", "location"]},
            {"data": "Maintenance and work orders", "categories": ERP | OLTP, "points": ["asset ID", "work order type", "failure code", "date", "parts used", "downtime duration"]},
            {"data": "Asset register", "categories": ERP | OLTP | FILES, "points": ["asset ID", "model and manufacturer", "install date", "site", "criticality"]},
        ],
        "build": ["Pub/Sub and Dataflow stream telemetry into BigQuery", "Anomaly detection and failure models in BigQuery ML / Vertex AI", "Alerts to maintenance systems; Looker asset health dashboards"],
    },
    "network": {
        "summary": "Monitor service quality, capacity and incidents from network, log and probe data - spotting degradation early and planning capacity with evidence.",
        "benefits": ["Faster detection and resolution of incidents", "Better customer experience and fewer complaints", "Capacity investment where it is needed", "Less time correlating logs by hand"],
        "kpis": ["Mean time to detect / resolve", "Service availability", "Capacity utilisation", "Incident volume"],
        "data": [
            {"data": "Logs and events", "categories": LOGS, "points": ["timestamp", "element / service ID", "event type", "severity", "message"]},
            {"data": "Performance counters", "categories": STREAM | DWH | FILES, "points": ["element ID", "interval", "throughput", "latency", "error rate", "utilisation"]},
            {"data": "Inventory and topology", "categories": OLTP | FILES, "points": ["element ID", "type", "site", "parent / child links", "capacity"]},
        ],
        "build": ["Log sinks and Pub/Sub into BigQuery", "Dataform aggregates KPIs per element and interval", "Looker operations dashboards; anomaly alerts"],
    },
    "dwh_modern": {
        "summary": "Move the legacy data warehouse to BigQuery - schema, SQL and history - retire licences and appliances, and open the data to self-service analytics and AI.",
        "benefits": ["Lower licence and infrastructure cost", "No more capacity limits at month end", "Faster queries and fresher data", "Data ready for BigQuery ML and Gemini"],
        "kpis": ["Total cost of ownership", "Query run time", "Data freshness", "Workloads migrated"],
        "data": [
            {"data": "Legacy warehouse tables and history", "categories": DWH, "points": ["schemas and tables", "row counts and sizes", "history depth", "partitioning keys"]},
            {"data": "SQL, ETL jobs and reports", "categories": DWH | FILES, "points": ["stored procedures and views", "ETL job schedules", "report and dashboard inventory", "query logs"]},
            {"data": "Upstream source feeds", "categories": OLTP | ERP | FILES, "points": ["feed name", "frequency", "volume per load", "owner"]},
        ],
        "build": ["BigQuery Migration Service assesses and translates SQL", "History moved with Data Transfer Service; feeds re-pointed", "Dataform replaces legacy ETL; parallel run then cut-over"],
    },
    "genai_docs": {
        "summary": "Let employees ask questions in plain language over contracts, policies, manuals and reports and get answers with citations to the source documents.",
        "benefits": ["Minutes instead of hours to find answers", "Consistent answers based on approved documents", "Faster onboarding of new staff", "Less load on expert teams"],
        "kpis": ["Time to answer", "Answer accuracy (sampled)", "Adoption (weekly users)", "Questions deflected from experts"],
        "data": [
            {"data": "Documents", "categories": DOCS, "points": ["PDF, Word, slides, web pages", "document owner", "version and date", "access group"]},
            {"data": "Document metadata", "categories": FILES | OLTP, "points": ["document type", "business unit", "language", "classification / sensitivity"]},
        ],
        "build": ["Documents in Cloud Storage; object tables in BigQuery", "Gemini 3.8 Flash with retrieval over the documents, citing sources", "Gemini Enterprise for employees, with existing access controls"],
    },
    "data_agents": {
        "summary": "Business users ask questions about their data in plain language and get governed answers, charts and explanations from BigQuery - through data agents in Gemini Enterprise or Looker.",
        "benefits": ["Self-service answers without waiting for analysts", "Same governed definitions as dashboards", "Analysts freed for deeper work", "Faster decisions in meetings"],
        "kpis": ["Questions answered per week", "Answer accuracy (sampled)", "Analyst ticket volume", "Weekly active users"],
        "data": [
            {"data": "Curated business tables (gold)", "categories": OLTP | ERP | DWH | CRM, "points": ["fact tables (sales, orders, usage)", "dimension tables (customer, product, time)", "documented column descriptions"]},
            {"data": "Business definitions", "categories": FILES | CRM | OLTP, "points": ["KPI definitions", "LookML / semantic model", "synonyms and example questions"]},
        ],
        "build": ["Gold tables with descriptions in Knowledge Catalog", "Agent Platform data agents with Gemini 3.8 Flash over BigQuery or Looker", "Published to Gemini Enterprise with user-level access"],
    },
    "marketing": {
        "summary": "Measure campaign performance and return on ad spend across channels, attribute conversions and move budget to what works.",
        "benefits": ["Higher return on ad spend", "Budget moved to the best channels faster", "One view of paid, owned and earned media", "Automated reporting for agencies and leadership"],
        "kpis": ["Return on ad spend", "Cost per acquisition", "Conversion rate by channel", "Reporting hours saved"],
        "data": [
            {"data": "Ad platform spend and performance", "categories": {"saas_google", "saas_other"}, "points": ["campaign / ad group", "date", "impressions, clicks", "cost", "conversions"]},
            {"data": "Web and app analytics", "categories": WEB, "points": ["session / user ID", "traffic source and campaign", "landing page", "conversion events", "revenue"]},
            {"data": "CRM leads and sales", "categories": CRM | OLTP, "points": ["lead / opportunity ID", "source campaign", "stage", "close date", "revenue"]},
        ],
        "build": ["BigQuery Data Transfer for Google Ads, GA4 and Salesforce", "Dataform joins spend to conversions and revenue", "BigQuery ML attribution; Looker marketing dashboards"],
    },
    "selfservice": {
        "summary": "Give leaders and teams trusted KPIs and dashboards on governed data, refreshed automatically, with the same numbers everywhere.",
        "benefits": ["One trusted set of KPIs", "Less time building reports by hand", "Faster, data-driven decisions", "Controlled access to sensitive data"],
        "kpis": ["Dashboard adoption", "Report requests to IT", "Data freshness", "KPI disputes"],
        "data": [
            {"data": "Operational data for KPIs", "categories": OLTP | ERP | CRM | DWH | FILES, "points": ["sales, orders or bookings", "costs and budgets", "customer and product dimensions", "dates and periods"]},
            {"data": "KPI definitions and targets", "categories": FILES | ERP, "points": ["KPI formulas", "targets and thresholds", "owners", "refresh frequency"]},
        ],
        "build": ["Gold marts in BigQuery modelled in Dataform", "Looker semantic layer (LookML) for governed metrics", "BI Engine for fast dashboards"],
    },
    "governance": {
        "summary": "Catalogue every dataset, check data quality, track lineage and apply access policies - and publish trusted data products that teams can find and reuse.",
        "benefits": ["Faster discovery of trusted data", "Compliance with privacy and residency rules", "Fewer data-quality incidents", "Reuse of data products instead of copies"],
        "kpis": ["Datasets with owners and descriptions", "Data-quality score", "Time to find data", "Policy violations"],
        "data": [
            {"data": "Technical metadata", "categories": OLTP | ERP | DWH | FILES | CRM, "points": ["tables and columns", "data types", "row counts", "refresh times"]},
            {"data": "Business metadata", "categories": FILES | CRM, "points": ["owners and stewards", "glossary terms", "classification (PII, confidential)", "retention rules"]},
            {"data": "Quality rules", "categories": FILES | OLTP, "points": ["completeness and validity rules", "thresholds", "issue owners"]},
        ],
        "build": ["Knowledge Catalog (Dataplex) harvests metadata and lineage", "Data-quality scans and profiling on key tables", "Policy tags and masking; Sensitive Data Protection discovery"],
    },
    "ops_apps": {
        "summary": "Serve curated data back to applications, partners and channels through low-latency databases and secure APIs - turning analytics into action.",
        "benefits": ["Personalised experiences in apps and channels", "One governed API for partners", "Less point-to-point integration", "Faster launch of data products"],
        "kpis": ["API calls and latency", "Partner integrations live", "Time to launch a data API", "Data freshness in apps"],
        "data": [
            {"data": "Curated entities to serve", "categories": OLTP | CRM | ERP, "points": ["entity ID (customer, product, account)", "attributes needed by the app", "scores or recommendations", "update frequency"]},
            {"data": "API consumers and access rules", "categories": {"api", "saas_other"} | FILES, "points": ["consumer / partner", "allowed fields", "rate limits", "authentication method"]},
        ],
        "build": ["Reverse ETL from BigQuery into AlloyDB / Cloud SQL", "Apigee publishes secure, monetisable APIs", "Monitoring and quotas per consumer"],
    },
}


# words in a source's name that suggest it holds this data (matched together with the category)
KEYWORDS = {'Customer master': 'customer subscriber member account crm client user profile', 'Transactions or orders': 'order transaction sales billing payment ticket booking purchase pos', 'Service interactions': 'crm service case support salesforce contact complaint', 'Digital behaviour': 'web app mobile analytics ga4 click event session digital', 'Subscription or account history': 'subscriber subscription account billing member contract plan crm', 'Usage and engagement': 'usage playback stream event analytics app web session activity', 'Billing and payments': 'billing payment invoice card finance subscriber', 'Service and complaints': 'crm service case support salesforce complaint', 'Real-time transaction or event stream': 'transaction payment event kafka stream card', 'Customer and account profile': 'customer account subscriber kyc crm member', 'Confirmed fraud labels': 'fraud case chargeback dispute', 'General ledger': 'finance ledger gl sap erp accounting royalt', 'Sub-ledgers': 'finance sap erp payable receivable asset accounting', 'Reference and master data': 'reference master finance sap rates mapping', 'Sales or consumption history': 'sales order pos consumption ticket booking', 'Inventory positions': 'inventory stock warehouse sap erp', 'Purchase orders and suppliers': 'purchase supplier procurement sap erp vendor', 'Sensor telemetry': 'sensor iot telemetry device machine', 'Maintenance and work orders': 'maintenance work order asset sap erp', 'Asset register': 'asset equipment register sap erp', 'Logs and events': 'log event syslog network kafka', 'Performance counters': 'performance counter network probe metric', 'Inventory and topology': 'inventory topology network element', 'Legacy warehouse tables and history': 'warehouse teradata netezza redshift snowflake synapse hadoop dwh', 'SQL, ETL jobs and reports': 'etl warehouse report hadoop dwh', 'Upstream source feeds': 'feed source', 'Documents': 'document contract policy manual pdf file', 'Document metadata': 'document metadata', 'Curated business tables (gold)': 'sales order finance customer subscriber billing', 'Business definitions': 'kpi definition glossary', 'Ad platform spend and performance': 'ads google campaign marketing ad', 'Web and app analytics': 'web app mobile analytics ga4', 'CRM leads and sales': 'crm salesforce lead campaign opportunity', 'Operational data for KPIs': 'sales order finance billing ticket subscriber', 'KPI definitions and targets': 'kpi target budget', 'Technical metadata': '', 'Business metadata': '', 'Quality rules': '', 'Curated entities to serve': 'customer subscriber product account', 'API consumers and access rules': 'api partner'}


def _sources_by_category(scenario):
    out = {}
    for s in scenario.get("sources", []) or []:
        if s.get("included", True) is False:
            continue
        t = s.get("like_type") if s.get("type") == "custom" else s.get("type")
        cat = SOURCE_BY_ID.get(t, {}).get("category", "")
        out.setdefault(cat, []).append({"name": s.get("custom_name") or s.get("name") or t, "type": t})
    return out


def details(uc_id: str, scenario: dict) -> dict | None:
    """Curated details for one library use case, with each data need mapped to the customer's sources."""
    from .usecases import USE_CASES
    base = next((u for u in USE_CASES if u["id"] == uc_id), None)
    d = DETAILS.get(uc_id)
    if not base or not d:
        return None
    by_cat = _sources_by_category(scenario)
    data = []
    for req in d["data"]:
        cands = []
        for cat in req["categories"]:
            cands += by_cat.get(cat, [])
        if req.get("types"):
            cands += [x for v in by_cat.values() for x in v if x["type"] in req["types"]]
        seen, likely, possible = set(), [], []
        kws = [k for k in KEYWORDS.get(req["data"], "").split() if k]
        for x in cands:
            if x["name"] in seen:
                continue
            seen.add(x["name"])
            n = x["name"].lower()
            hit = (req.get("types") and x["type"] in req["types"]) or any(k in n for k in kws)
            (likely if hit or not kws else possible).append(x["name"])
        data.append({"data": req["data"], "points": req["points"], "sources": likely, "possible": possible[:3],
                     "covered": bool(likely), "partial": not likely and bool(possible)})
    covered = sum(1 for x in data if x["covered"])
    return {"id": uc_id, "name": base["name"], "value": base["value"], "summary": d["summary"], "benefits": d["benefits"],
            "kpis": d["kpis"], "data": data, "build": d["build"], "products": base["products"],
            "coverage": {"covered": covered, "total": len(data)}, "method": "curated"}


AI_PROMPT = """You are a Google Cloud data and AI architect helping a seller explain a customer's use case.
Describe the use case below for a business reader. Return JSON with:
- summary: 2 sentences on what it is and how it works on Google Cloud.
- benefits: 3-4 short business benefits.
- kpis: 3-4 measurable KPIs.
- data: 2-4 data requirements, each with "data" (name of the dataset) and "points" (4-6 specific fields or data points),
  and "sources" (names from the customer's source list below that would provide it; empty if none fits).
- build: 3 short steps describing how it is built with Google Cloud products (BigQuery, Dataform, Dataflow, Pub/Sub,
  BigQuery ML, Vertex AI, Gemini, Looker, Knowledge Catalog, Apigee …).
Be specific and practical. Do not invent customer facts or numbers.
"""


def ai_schema():
    s = {"type": "STRING"}
    arr = {"type": "ARRAY", "items": s}
    return {"type": "OBJECT", "properties": {
        "summary": s, "benefits": arr, "kpis": arr, "build": arr,
        "data": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {"data": s, "points": arr, "sources": arr}, "required": ["data", "points"]}}},
        "required": ["summary", "benefits", "kpis", "data", "build"]}


def ai_prompt(name: str, notes: str, scenario: dict) -> str:
    srcs = [f"- {x['name']} ({SOURCE_BY_ID.get(x['type'], {}).get('name', x['type'])})" for v in _sources_by_category(scenario).values() for x in v]
    return (AI_PROMPT + f"\nUse case: {name[:200]}\nNotes from the seller: {notes[:800] or '-'}\n"
            f"Customer: {scenario.get('customer') or '-'}\nCustomer's source systems:\n" + ("\n".join(srcs[:40]) or "- none yet"))


def clean_ai(name: str, data: dict, scenario: dict) -> dict:
    names = {x["name"] for v in _sources_by_category(scenario).values() for x in v}
    rows = []
    for r in (data.get("data") or [])[:5]:
        src = [x for x in (r.get("sources") or []) if x in names]
        rows.append({"data": str(r.get("data") or "")[:120], "points": [str(p)[:80] for p in (r.get("points") or [])[:8]],
                     "sources": src, "covered": bool(src)})
    lst = lambda k, n=5: [str(x)[:200] for x in (data.get(k) or [])[:n]]  # noqa: E731
    covered = sum(1 for x in rows if x["covered"])
    return {"id": None, "name": name, "value": "", "summary": str(data.get("summary") or "")[:800], "benefits": lst("benefits"),
            "kpis": lst("kpis"), "data": rows, "build": lst("build", 4), "products": [], "coverage": {"covered": covered, "total": len(rows)},
            "method": "gemini"}
