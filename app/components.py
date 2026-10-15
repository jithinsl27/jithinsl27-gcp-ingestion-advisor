"""Consumption-layer component library: BI, AI/ML & agents, governance.

Each component is either a Google Cloud product (costed from pricing.json) or a
partner product (shown in the architecture with its BigQuery integration, but
never costed - partner licences are outside the GCP consumption estimate).

A scenario holds the architect's selection as a list:
    "components": [{"id": "c1", "type": "power_bi", "settings": {"users": 200}}, ...]
plus scenario-level security toggles:
    "security": {"enabled": true, "sdp_discovery": true, "cmek": true, "vpc_sc": true}
"""
from __future__ import annotations

from .catalog import SOURCE_BY_ID, STREAMING_FREQS

GIB_PER_TIB = 1024
HOURS = 730

CATEGORIES = [
    {"id": "bi", "name": "BI & analytics"},
    {"id": "ai", "name": "AI, ML & agents"},
    {"id": "integration", "name": "APIs & integration"},
    {"id": "database", "name": "Operational databases"},
    {"id": "governance", "name": "Governance & catalog"},
    {"id": "security", "name": "Security & compliance"},
]

# --------------------------------------------------------------------------- #
# Settings field helpers
# --------------------------------------------------------------------------- #
def num(key, label, default, step=1):
    return {"key": key, "label": label, "type": "number", "default": default, "step": step}


def sel(key, label, default, options):
    return {"key": key, "label": label, "type": "select", "default": default,
            "options": [{"id": i, "name": n} for i, n in options]}


USERS = num("users", "Users", 50, 10)

COMPONENTS = [
    # ------------------------------------------------------------------ BI (Google)
    {
        "id": "looker", "name": "Looker", "category": "bi", "vendor": "google", "costed": True,
        "method": "Native BigQuery connection, LookML semantic layer",
        "settings": [USERS, num("annual_quote_usd", "Annual licence quote (USD, 0 = not included)", 0, 1000)],
        "steps": [
            "Create a BigQuery connection in Looker using a service account (or OAuth for per-user credentials and row-level security).",
            "Model metrics once in LookML (or BigQuery measures); queries run live in BigQuery - no extracts.",
            "Persistent derived tables and aggregate awareness are built as BigQuery tables to cut query cost.",
            "Looker (Google Cloud core) can use private IP / Private Service Connect to stay inside the VPC perimeter.",
        ],
        "notes": ["The same semantic model feeds Looker Studio, Connected Sheets and Conversational Analytics, so metrics match everywhere.",
                  "Licensing is quote-based; enter the customer's annual quote to include it."],
        "doc": "https://cloud.google.com/looker/docs/db-config-google-bigquery",
    },
    {
        "id": "looker_studio_pro", "name": "Looker Studio Pro", "category": "bi", "vendor": "google", "costed": True,
        "method": "Native BigQuery connector, BI Engine acceleration",
        "settings": [num("users", "Users", 25, 5)],
        "steps": [
            "Add BigQuery as a data source (owner's or viewer's credentials).",
            "Enable BigQuery BI Engine reservations for sub-second dashboards.",
            "Pro adds team workspaces, asset ownership by the organisation and support SLAs.",
        ],
        "notes": ["Priced per user per project per month."],
        "doc": "https://cloud.google.com/looker/docs/studio/connect-to-google-bigquery",
    },
    {
        "id": "looker_studio", "name": "Looker Studio", "category": "bi", "vendor": "google", "costed": False,
        "method": "Native BigQuery connector",
        "settings": [USERS],
        "steps": ["Add BigQuery as a data source; dashboards query BigQuery live or with extracts.",
                  "Use BI Engine to accelerate and reduce query cost."],
        "notes": ["No licence cost; BigQuery query cost applies."],
        "doc": "https://cloud.google.com/looker/docs/studio/connect-to-google-bigquery",
    },
    # ------------------------------------------------------------------ BI (partners)
    {
        "id": "power_bi", "name": "Microsoft Power BI", "category": "bi", "vendor": "partner", "costed": False,
        "method": "Power BI Google BigQuery connector (ADBC / Storage Read API), Import or DirectQuery",
        "settings": [USERS],
        "steps": [
            "In Power BI Desktop or Fabric, choose Get Data → Google BigQuery; authenticate with a Google account or a service account key / workload identity federation.",
            "Pick a billing project and datasets; use Import for small models or DirectQuery for live data.",
            "Enable the Storage Read API option (ADBC driver) for much faster large imports.",
            "Publish to the Power BI Service; scheduled refresh connects directly to BigQuery (no on-premises gateway needed).",
        ],
        "notes": ["DirectQuery sends one SQL query per visual - use BI Engine, materialized views or aggregated marts to control BigQuery cost.",
                  "Data imported into Power BI leaves Google Cloud; internet egress may apply.",
                  "Partner licence - not included in the GCP estimate."],
        "doc": "https://learn.microsoft.com/power-query/connectors/google-bigquery",
    },
    {
        "id": "tableau", "name": "Tableau", "category": "bi", "vendor": "partner", "costed": False,
        "method": "Tableau Google BigQuery (JDBC) connector, Live or Extract",
        "settings": [USERS],
        "steps": [
            "Connect with the Google BigQuery connector in Tableau Desktop / Cloud / Server using OAuth or a service account.",
            "Use Live connections for fresh data (accelerated by BI Engine) or Extracts with the Storage Read API for large volumes.",
            "Publish data sources centrally and set the BigQuery billing project per workbook.",
        ],
        "notes": ["Tableau Cloud on Google Cloud keeps traffic on Google's network.",
                  "Partner licence - not included in the GCP estimate."],
        "doc": "https://help.tableau.com/current/pro/desktop/en-us/examples_googlebigquery_jdbc.htm",
    },
    {
        "id": "microstrategy", "name": "MicroStrategy (Strategy)", "category": "bi", "vendor": "partner", "costed": False,
        "method": "Native BigQuery gateway (JDBC/ODBC), SQL push-down",
        "settings": [USERS],
        "steps": [
            "Create a BigQuery database instance with a service account and the Google BigQuery JDBC/ODBC driver.",
            "Map the semantic graph (schema objects) to BigQuery tables; reports push SQL down to BigQuery.",
            "Use the Storage Read API option for fast in-memory cube publishing.",
        ],
        "notes": ["Partner licence - not included in the GCP estimate."],
        "doc": "https://www2.strategy.com/producthelp/Current/Gateway_Connections/WebHelp/Lang_1033/Content/gbq_native_api.htm",
    },
    {
        "id": "qlik", "name": "Qlik Sense / Qlik Cloud", "category": "bi", "vendor": "partner", "costed": False,
        "method": "Qlik Google BigQuery connector",
        "settings": [USERS],
        "steps": [
            "Add a Google BigQuery connection (service account or OAuth) in Qlik Cloud or Qlik Sense.",
            "Load data into Qlik apps or use Direct Query for live analysis.",
            "Qlik Replicate / Talend can also be used for CDC into BigQuery if the customer already owns them.",
        ],
        "notes": ["Partner licence - not included in the GCP estimate."],
        "doc": "https://help.qlik.com/en-US/cloud-services/Subsystems/Hub/Connectors_ODBC/GoogleBigQuery/Create-GBQ-Connection.htm",
    },
    {
        "id": "thoughtspot", "name": "ThoughtSpot", "category": "bi", "vendor": "partner", "costed": False,
        "method": "ThoughtSpot live query connection to BigQuery",
        "settings": [USERS],
        "steps": [
            "Create a BigQuery connection with a service account; ThoughtSpot queries BigQuery live.",
            "Natural-language search is translated to SQL and executed in BigQuery.",
        ],
        "notes": ["Every search runs a BigQuery query - size on-demand or slot capacity accordingly.",
                  "Partner licence - not included in the GCP estimate."],
        "doc": "https://docs.thoughtspot.com/cloud/latest/connections-gbq",
    },
    # ------------------------------------------------------------------ AI (Google)
    {
        "id": "agent_platform", "name": "Agent Platform (Vertex AI) data agents", "category": "ai", "vendor": "google", "costed": True,
        "method": "ADK + BigQuery tools / MCP, Agent Engine, Conversational Analytics API",
        "settings": [
            sel("model", "Gemini model", "flash", [("flash_lite", "Gemini Flash-Lite"), ("flash", "Gemini Flash"), ("pro", "Gemini Pro")]),
            num("requests_month", "Agent requests / month", 50000, 1000),
            num("input_tokens", "Input tokens / request", 4000, 500),
            num("output_tokens", "Output tokens / request", 800, 100),
            num("agent_seconds", "Runtime seconds / request", 6, 1),
            num("bq_gb_per_request", "BigQuery GB scanned / request", 0.2, 0.1),
        ],
        "steps": [
            "Build agents with the Agent Development Kit using the BigQuery toolset or MCP Toolbox for Databases.",
            "Deploy to Agent Engine (managed runtime with sessions and Memory Bank).",
            "Queries run with end-user credentials, so IAM, policy tags, row access policies and masking still apply.",
            "Conversational Analytics API answers natural-language questions over BigQuery and Looker models.",
        ],
        "notes": ["Costed: Agent Engine runtime, Gemini tokens and BigQuery queries issued by agents."],
        "doc": "https://cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/overview",
    },
    {
        "id": "gemini_enterprise", "name": "Gemini Enterprise", "category": "ai", "vendor": "google", "costed": True,
        "method": "BigQuery data store connector + agents registered from Agent Platform",
        "settings": [
            sel("edition", "Edition", "standard", [("business", "Business"), ("standard", "Standard"), ("plus", "Plus")]),
            num("users", "Users", 100, 10),
            sel("grounding", "Connects to", "bigquery", [("bigquery", "BigQuery (federated data store)"), ("looker", "Looker semantic layer"),
                                                        ("both", "BigQuery and Looker"), ("agents", "Data agents only")]),
            num("questions_per_user_month", "Data questions per user / month", 20, 5),
            num("gb_per_question", "BigQuery GB scanned per question", 0.5, 0.1),
        ],
        "modes": {"key": "grounding", "notes": {
            "bigquery": "Gemini Enterprise queries BigQuery directly through a federated BigQuery data store; answers respect each user's IAM, row and column policies.",
            "looker": "Gemini Enterprise is grounded on Looker: questions are answered from governed LookML metrics (Looker Conversational Analytics), so numbers match dashboards. Requires Looker in the architecture.",
            "both": "Structured questions go through the Looker semantic layer for governed metrics; open exploration and Deep Research use the BigQuery data store.",
            "agents": "Gemini Enterprise is the front door only; data access happens through data agents registered from Agent Platform.",
        }},
        "steps": [
            "Create a BigQuery data store - federated query (queries data in place, recommended) or data ingestion - so agents in Gemini Enterprise can analyse the tables.",
            "Register data agents built on Agent Platform so employees use them from Gemini Enterprise.",
            "Permission-aware: users only see data their identity can access.",
            "Deep Research and NotebookLM Enterprise work over the same governed data.",
        ],
        "notes": ["Per-user prices are indicative - confirm with a Google quote."],
        "doc": "https://docs.cloud.google.com/gemini/enterprise/docs/connectors/connect-bigquery",
    },
    {
        "id": "vertex_gpu", "name": "Vertex AI GPU endpoint", "category": "ai", "vendor": "google", "costed": True,
        "method": "BigQuery ML remote model → Vertex AI endpoint",
        "settings": [
            sel("gpu", "Accelerator", "l4", [("l4", "NVIDIA L4 (g2-standard-8)"), ("a100", "NVIDIA A100 40GB"), ("h100", "NVIDIA H100 80GB"), ("cpu", "CPU only (n1-standard-4)")]),
            num("replicas", "Replicas", 1, 1),
            num("hours_per_day", "Hours per day", 24, 1),
        ],
        "steps": [
            "Deploy an open, fine-tuned or custom model from Model Garden (e.g. vLLM) to an online endpoint.",
            "Create a BigQuery ML remote model (CREATE MODEL ... REMOTE WITH CONNECTION) pointing to the endpoint for batch scoring in SQL.",
            "Applications and agents call the endpoint directly for real-time inference; features can be served from BigQuery via Vertex AI Feature Store.",
        ],
        "notes": ["Costed per node-hour; autoscaling to zero is not available for GPU endpoints, so size hours per day realistically."],
        "doc": "https://cloud.google.com/bigquery/docs/bigquery-ml-remote-model-tutorial",
    },
    {
        "id": "bqml", "name": "BigQuery ML & AI functions", "category": "ai", "vendor": "google", "costed": False,
        "method": "Built into BigQuery (AI.GENERATE, embeddings, vector search)",
        "settings": [],
        "steps": ["Train and run models in SQL; call Gemini with AI.GENERATE / ML.GENERATE_TEXT; build embeddings and VECTOR_SEARCH indexes."],
        "notes": ["Charged through BigQuery compute and Gemini tokens; no separate line here."],
        "doc": "https://cloud.google.com/bigquery/docs/generative-ai-overview",
    },
    # ------------------------------------------------------------------ AI (partners)
    {
        "id": "datarobot", "name": "DataRobot", "category": "ai", "vendor": "partner", "costed": False,
        "method": "DataRobot BigQuery data connection (JDBC), batch prediction write-back",
        "settings": [USERS],
        "steps": [
            "Add a Google BigQuery data connection with a service account in DataRobot.",
            "Train from BigQuery tables; schedule batch prediction jobs that read from and write scores back to BigQuery.",
            "DataRobot can be deployed on Google Cloud (Marketplace) to keep data in-region.",
        ],
        "notes": ["Partner licence - not included in the GCP estimate."],
        "doc": "https://docs.datarobot.com/en/docs/reference/data-ref/connectivity/data-sources/dc-bigquery.html",
    },
    {
        "id": "dataiku", "name": "Dataiku", "category": "ai", "vendor": "partner", "costed": False,
        "method": "Dataiku BigQuery connection with SQL push-down",
        "settings": [USERS],
        "steps": [
            "Create a BigQuery connection (service account) in Dataiku DSS / Dataiku Cloud.",
            "Visual and SQL recipes run in-database in BigQuery (push-down); Python recipes use the BigQuery client or Spark connector.",
            "Available on Google Cloud Marketplace for in-region deployment.",
        ],
        "notes": ["Push-down recipes consume BigQuery compute.", "Partner licence - not included in the GCP estimate."],
        "doc": "https://doc.dataiku.com/dss/latest/connecting/sql/bigquery.html",
    },
    {
        "id": "sagemaker", "name": "AWS SageMaker", "category": "ai", "vendor": "partner", "costed": False,
        "method": "Workload identity federation + BigQuery Storage Read API (or BigQuery Omni / exports)",
        "settings": [USERS],
        "steps": [
            "Federate AWS IAM roles to Google Cloud with workload identity federation (no service-account keys).",
            "SageMaker notebooks and processing jobs read BigQuery with the BigQuery Storage Read API / Python client or the Spark BigQuery connector.",
            "For large training sets, export to Cloud Storage and replicate to S3 with Storage Transfer, or keep data in S3 and query it with BigQuery Omni.",
            "Write predictions back to BigQuery via the client library or load jobs.",
        ],
        "notes": ["Cross-cloud egress from Google Cloud applies to data read into AWS.",
                  "Partner licence and AWS compute - not included in the GCP estimate."],
        "doc": "https://cloud.google.com/iam/docs/workload-identity-federation-with-other-clouds",
    },
    {
        "id": "azure_ai", "name": "Azure ML / Azure AI Foundry", "category": "ai", "vendor": "partner", "costed": False,
        "method": "Azure Data Factory / Fabric BigQuery connector, or federated Python client",
        "settings": [USERS],
        "steps": [
            "Copy curated BigQuery tables to ADLS with the Azure Data Factory / Fabric Data Factory Google BigQuery connector.",
            "Or read directly from Azure ML compute with the BigQuery Python client using workload identity federation from Microsoft Entra ID.",
            "Write scores back with the BigQuery client or a Data Factory copy activity.",
        ],
        "notes": ["Cross-cloud egress from Google Cloud applies.", "Partner licence and Azure compute - not included in the GCP estimate."],
        "doc": "https://learn.microsoft.com/azure/data-factory/connector-google-bigquery",
    },
    {
        "id": "databricks", "name": "Databricks", "category": "ai", "vendor": "partner", "costed": False,
        "method": "Spark BigQuery connector / Lakehouse Federation",
        "settings": [USERS],
        "steps": [
            "Read and write BigQuery tables from Databricks with the Spark BigQuery connector (Storage Read/Write APIs).",
            "Or query BigQuery in place with Lakehouse Federation from Unity Catalog.",
            "Databricks on Google Cloud keeps traffic in-region; open Iceberg tables via BigLake can be shared both ways.",
        ],
        "notes": ["Partner licence - not included in the GCP estimate."],
        "doc": "https://docs.databricks.com/en/connect/external-systems/bigquery.html",
    },
    # ------------------------------------------------------------------ APIs & integration
    {
        "id": "apigee", "name": "Apigee API management & AI gateway", "category": "integration", "vendor": "google", "costed": True,
        "method": "API proxies in front of BigQuery-backed services, agents and LLM endpoints",
        "settings": [
            sel("environment", "Environment", "intermediate", [("base", "Base (up to 50 QPS)"), ("intermediate", "Intermediate (up to 100 QPS)"), ("comprehensive", "Comprehensive (autoscaled, HA)")]),
            num("api_calls_million", "API calls per month (millions)", 20, 1),
            sel("proxy_type", "Proxy type", "standard", [("standard", "Standard proxy"), ("extensible", "Extensible proxy (custom code / AI policies)")]),
            sel("analytics", "API Analytics add-on", "yes", [("yes", "Yes"), ("no", "No")]),
            sel("advanced_security", "Advanced API Security add-on", "no", [("yes", "Yes"), ("no", "No")]),
            sel("role", "Used as", "both", [("integration", "Integration layer (apps, SaaS, data APIs)"), ("agents", "AI gateway & tools for agents"),
                                           ("both", "Integration layer and AI gateway")]),
        ],
        "modes": {"key": "role", "notes": {
            "integration": "Integration layer: Apigee fronts source applications, SaaS and partner APIs feeding the platform, and publishes BigQuery / database-backed data products as managed APIs (OAuth, quotas, monetisation).",
            "agents": "AI gateway: agents reach Gemini and model endpoints through Apigee (token quotas, semantic caching, Model Armor) and discover approved MCP tools in API hub.",
            "both": "One Apigee estate does both: the integration layer for applications and data products, and the AI gateway / tool registry for agents.",
        }},
        "steps": [
            "Expose curated data products (Cloud Run / BigQuery-backed services) and agent endpoints as managed APIs with OAuth2, API keys and quotas.",
            "Use Apigee as the AI gateway in front of Gemini and model endpoints: token-based quotas, semantic caching and Model Armor screening of prompts and responses.",
            "Register APIs and MCP tools in Apigee API hub so agents discover approved tools only.",
            "Partners and apps consume data through versioned, monitored APIs instead of direct database access.",
        ],
        "notes": ["Best practice: keep agents calling tools through Apigee so every call is authenticated, rate-limited, logged and auditable.",
                  "Costed: environment fee plus API calls (tiered), optional analytics and Advanced API Security add-ons."],
        "doc": "https://cloud.google.com/apigee/docs/api-platform/get-started/what-apigee",
    },
    # ------------------------------------------------------------------ Operational databases
    {
        "id": "alloydb", "name": "AlloyDB for PostgreSQL", "category": "database", "vendor": "google", "costed": True,
        "method": "Reverse ETL from BigQuery + AlloyDB AI vector search; federated queries back to BigQuery",
        "settings": [num("vcpu", "vCPUs per node", 8, 2), num("memory_gib", "Memory per node (GiB)", 64, 8),
                     sel("ha", "High availability", "yes", [("yes", "Yes (2 nodes)"), ("no", "No")]),
                     num("read_pool_nodes", "Read pool nodes", 0, 1), num("storage_gib", "Storage (GiB)", 500, 50)],
        "steps": [
            "Serve low-latency application and agent queries from AlloyDB; sync curated BigQuery tables with reverse ETL.",
            "Use AlloyDB AI (embeddings, vector indexes, natural-language SQL) as the retrieval store for agents.",
            "BigQuery reads AlloyDB live through federated queries (EXTERNAL_QUERY) and Datastream replicates changes back for analytics.",
        ],
        "notes": ["Costed: vCPU and memory per node (HA uses 2 nodes) plus regional storage; CUD 25% (1-yr) / 52% (3-yr)."],
        "doc": "https://cloud.google.com/alloydb/docs/overview",
    },
    {
        "id": "cloudsql", "name": "Cloud SQL", "category": "database", "vendor": "google", "costed": True,
        "method": "Federated queries from BigQuery; Datastream CDC into BigQuery",
        "settings": [num("vcpu", "vCPUs", 4, 2), num("memory_gib", "Memory (GiB)", 16, 4),
                     sel("ha", "High availability", "yes", [("yes", "Yes"), ("no", "No")]), num("storage_gib", "SSD storage (GiB)", 250, 50)],
        "steps": ["Host application databases (PostgreSQL, MySQL, SQL Server) next to the data platform.",
                  "Query them from BigQuery with EXTERNAL_QUERY, or replicate with Datastream for analytics."],
        "notes": ["Costed: Enterprise edition vCPU, memory and SSD (HA rates when enabled); CUD on compute only."],
        "doc": "https://cloud.google.com/sql/docs/introduction",
    },
    {
        "id": "spanner", "name": "Spanner", "category": "database", "vendor": "google", "costed": True,
        "method": "Reverse ETL from BigQuery; Data Boost federated queries; change streams to BigQuery",
        "settings": [sel("edition", "Edition", "standard", [("standard", "Standard"), ("enterprise", "Enterprise"), ("enterprise_plus", "Enterprise Plus")]),
                     num("nodes", "Nodes (1 node = 1,000 processing units)", 1, 0.1), num("storage_gib", "Storage (GiB)", 500, 50)],
        "steps": ["Global, strongly consistent operational store for high-scale apps and agent memory.",
                  "BigQuery queries Spanner with Data Boost (no impact on OLTP) and receives changes via change streams / Datastream.",
                  "Export curated BigQuery results to Spanner with reverse ETL for serving."],
        "notes": ["Costed: node-hours by edition (regional) plus SSD storage; CUD 20% / 40%."],
        "doc": "https://cloud.google.com/spanner/docs/overview",
    },
    {
        "id": "bigtable", "name": "Bigtable", "category": "database", "vendor": "google", "costed": True,
        "method": "BigQuery external tables / Data Boost; reverse ETL for features and time series",
        "settings": [num("nodes", "Nodes", 3, 1), num("storage_gib", "SSD storage (GiB)", 1000, 100),
                     sel("edition", "Edition", "enterprise", [("enterprise", "Enterprise"), ("enterprise_plus", "Enterprise Plus")])],
        "steps": ["Low-latency store for IoT time series, features and personalisation at scale.",
                  "BigQuery queries Bigtable as an external table (Data Boost for isolation); continuous reverse ETL pushes features back."],
        "notes": ["Costed: node-hours plus SSD storage; CUD 20% / 40% on nodes."],
        "doc": "https://cloud.google.com/bigtable/docs/overview",
    },
    {
        "id": "firestore", "name": "Firestore", "category": "database", "vendor": "google", "costed": True,
        "method": "Change streams / export to BigQuery; serves app and agent session data",
        "settings": [num("reads_million", "Document reads per month (millions)", 50, 5), num("writes_million", "Document writes per month (millions)", 10, 1),
                     num("storage_gib", "Stored data (GiB)", 50, 10)],
        "steps": ["Serverless document database for mobile/web apps and agent session state.",
                  "Stream changes to BigQuery (Firestore change streams / Dataflow template) for analytics."],
        "notes": ["Costed: reads, writes and storage after the free tier; CUD 20% / 40% on operations."],
        "doc": "https://cloud.google.com/firestore/docs/overview",
    },
    {
        "id": "memorystore", "name": "Memorystore (Redis / Valkey)", "category": "database", "vendor": "google", "costed": True,
        "method": "Cache in front of APIs and agents (semantic / response caching)",
        "settings": [num("capacity_gib", "Capacity (GiB, Standard tier HA)", 8, 1)],
        "steps": ["Cache hot BigQuery results, API responses and agent context to cut latency and query cost."],
        "notes": ["Costed: Standard tier per GiB-hour by capacity band; CUD 20% / 40%."],
        "doc": "https://cloud.google.com/memorystore/docs/redis/memorystore-for-redis-overview",
    },
    # ------------------------------------------------------------------ Governance
    {
        "id": "knowledge_catalog", "name": "Knowledge Catalog (Dataplex)", "category": "governance", "vendor": "google", "costed": True,
        "method": "Automatic BigQuery metadata, lineage, profiling and quality scans",
        "settings": [num("dq_share_pct", "Tables with quality scans (%)", 20, 5), num("dq_scans_per_month", "Scans per month", 30, 1)],
        "steps": [
            "BigQuery, Cloud Storage, AlloyDB, Spanner and Cloud SQL metadata is harvested automatically.",
            "Lineage is captured from BigQuery jobs, Dataflow, Dataproc and Composer.",
            "Profiling and data quality scans publish quality scores; business glossary and semantic search give agents context.",
        ],
        "notes": ["Costed: premium processing DCUs for scans and lineage plus metadata storage."],
        "doc": "https://cloud.google.com/dataplex/docs/introduction",
    },
    {
        "id": "collibra", "name": "Collibra", "category": "governance", "vendor": "partner", "costed": False,
        "method": "Collibra Edge BigQuery connector + Dataplex lineage sync",
        "settings": [],
        "steps": ["Register BigQuery through Collibra Edge (service account) to ingest schemas, profiling and lineage.",
                  "Sync Dataplex lineage and policy tags so stewardship in Collibra is enforced in BigQuery."],
        "notes": ["Partner licence - not included in the GCP estimate."],
        "doc": "https://productresources.collibra.com/docs/collibra/latest/Content/CollibraDataLineage/DataSources/GoogleBigQuery/ref_bigquery-steps.htm",
    },
    {
        "id": "alation", "name": "Alation", "category": "governance", "vendor": "partner", "costed": False,
        "method": "Alation BigQuery OCF connector",
        "settings": [],
        "steps": ["Install the BigQuery OCF connector; extract metadata, query logs and lineage with a service account."],
        "notes": ["Partner licence - not included in the GCP estimate."],
        "doc": "https://docs.alation.com/en/latest/sources/OpenConnectorFramework/GBQOCFConnector/index.html",
    },
    {
        "id": "atlan", "name": "Atlan", "category": "governance", "vendor": "partner", "costed": False,
        "method": "Atlan BigQuery crawler + Dataplex integration",
        "settings": [],
        "steps": ["Crawl BigQuery with a service account; mine query history for lineage and popularity; sync tags with Dataplex."],
        "notes": ["Partner licence - not included in the GCP estimate."],
        "doc": "https://docs.atlan.com/apps/connectors/data-warehouses/google-bigquery",
    },
    {
        "id": "informatica_cdgc", "name": "Informatica CDGC", "category": "governance", "vendor": "partner", "costed": False,
        "method": "Informatica Cloud Data Governance & Catalog BigQuery scanner",
        "settings": [],
        "steps": ["Configure a BigQuery catalog source with a service account to scan metadata, profile data and build lineage."],
        "notes": ["Partner licence - not included in the GCP estimate."],
        "doc": "https://onlinehelp.informatica.com/IICS/prod/MCC/en/metadata-command-center-catalog-source-configuration/Google_BigQuery.html",
    },
    # ------------------------------------------------------------------ Security & compliance
    {
        "id": "sdp", "name": "Sensitive Data Protection", "category": "security", "vendor": "google", "costed": True,
        "method": "Automatic discovery and classification of PII in BigQuery and Cloud Storage",
        "settings": [],
        "steps": ["Turn on discovery for the organisation or project: every BigQuery table is profiled and PII infoTypes are classified.",
                  "Publish findings to Security Command Center and auto-apply policy tags to sensitive columns.",
                  "De-identify (mask, tokenise) data in pipelines with the DLP API where raw values are not needed."],
        "notes": ["Costed: $0.03 per GB profiled - all data at first load, then new data each month."],
        "doc": "https://cloud.google.com/sensitive-data-protection/docs/data-profiles",
    },
    {
        "id": "cmek", "name": "Cloud KMS (CMEK)", "category": "security", "vendor": "google", "costed": True,
        "method": "Customer-managed encryption keys for BigQuery, Cloud Storage, Pub/Sub, Datastream, Dataflow and Vertex AI",
        "settings": [num("key_versions", "Active key versions", 20, 5), num("operations_million", "Key operations per month (millions)", 3, 1)],
        "steps": ["Create key rings in the data region; set default CMEK on BigQuery datasets and Cloud Storage buckets.",
                  "Enforce CMEK with the organisation policy constraint gcp.restrictNonCmekServices.",
                  "Use Cloud EKM or Cloud HSM where keys must stay outside Google or in hardware (common for KSA PDPL / NCA ECC)."],
        "notes": ["Costed: key versions and cryptographic operations (Cloud HSM / EKM priced higher)."],
        "doc": "https://cloud.google.com/kms/docs/cmek",
    },
    {
        "id": "vpc_sc", "name": "VPC Service Controls", "category": "security", "vendor": "google", "costed": False,
        "method": "Service perimeter around BigQuery, Cloud Storage, Vertex AI and ingestion projects",
        "settings": [],
        "steps": ["Put data and AI projects in a service perimeter; start in dry-run mode to see what would be blocked.",
                  "Allow partner tools and on-prem networks with ingress rules and access levels.",
                  "Use Private Service Connect for Google APIs and partner endpoints."],
        "notes": ["No additional charge."],
        "doc": "https://cloud.google.com/vpc-service-controls/docs/overview",
    },
    {
        "id": "policy_tags", "name": "Policy tags, row access & data masking", "category": "security", "vendor": "google", "costed": False,
        "method": "Column- and row-level security enforced inside BigQuery",
        "settings": [],
        "steps": ["Define a taxonomy of policy tags (e.g. PII, Confidential) and attach them to columns.",
                  "Add dynamic data masking rules and row access policies per group.",
                  "Controls apply to every consumer - SQL, Looker, Power BI, partner platforms and agents."],
        "notes": ["No additional charge."],
        "doc": "https://cloud.google.com/bigquery/docs/column-level-security-intro",
    },
    {
        "id": "scc", "name": "Security Command Center", "category": "security", "vendor": "google", "costed": False,
        "method": "Posture management, threat detection and data security posture for the platform",
        "settings": [],
        "steps": ["Enable at organisation level; Standard tier is included.",
                  "Premium / Enterprise add threat detection for BigQuery and AI workloads, posture and compliance reporting (quote-based)."],
        "notes": ["Standard tier free; Premium and Enterprise are subscription / quote-based and not costed here."],
        "doc": "https://cloud.google.com/security-command-center/docs/security-command-center-overview",
    },
    {
        "id": "assured_workloads", "name": "Assured Workloads / Sovereign controls", "category": "security", "vendor": "google", "costed": False,
        "method": "Data residency, personnel access and key-control guardrails for regulated workloads",
        "settings": [],
        "steps": ["Create an Assured Workloads folder with the control package for the jurisdiction (e.g. KSA sovereign controls).",
                  "Resource-location and service-usage constraints keep BigQuery and AI services in approved regions.",
                  "Pair with CMEK / EKM and Access Transparency for auditability."],
        "notes": ["Pricing depends on the control package - quote-based, not costed here."],
        "doc": "https://cloud.google.com/assured-workloads/docs/overview",
    },
]
COMPONENT_BY_ID = {c["id"]: c for c in COMPONENTS}

DEFAULT_COMPONENTS = [
    {"id": "c1", "type": "looker", "settings": {}},
    {"id": "c2", "type": "agent_platform", "settings": {}},
    {"id": "c3", "type": "gemini_enterprise", "settings": {}},
    {"id": "c4", "type": "knowledge_catalog", "settings": {}},
    {"id": "c5", "type": "sdp", "settings": {}},
    {"id": "c6", "type": "cmek", "settings": {}},
    {"id": "c7", "type": "vpc_sc", "settings": {}},
    {"id": "c8", "type": "policy_tags", "settings": {}},
    {"id": "c9", "type": "scc", "settings": {}},
]
SECURITY_TYPES = [c["id"] for c in COMPONENTS if c["category"] == "security"]
DEFAULT_SECURITY = {"enabled": True, "sdp_discovery": True, "cmek": True, "vpc_sc": True}


def component_defaults(ctype):
    meta = COMPONENT_BY_ID.get(ctype, {"settings": []})
    return {f["key"]: f["default"] for f in meta["settings"]}


def legacy_to_components(platform):
    """Convert the earlier fixed `platform` block into a component list + security."""
    comps, i = [], 0

    def push(ctype, settings):
        nonlocal i
        i += 1
        comps.append({"id": f"c{i}", "type": ctype, "settings": settings})

    bi = platform.get("bi") or {}
    if bi.get("enabled", True):
        tool = bi.get("tool", "looker")
        s = {"users": bi.get("users", 50)}
        if tool == "looker":
            s["annual_quote_usd"] = bi.get("looker_annual_usd", 0)
        push(tool, s)
    ag = platform.get("agents") or {}
    if ag.get("enabled", True):
        push("agent_platform", {k: v for k, v in ag.items() if k != "enabled"})
    ge = platform.get("gemini_enterprise") or {}
    if ge.get("enabled", True):
        push("gemini_enterprise", {k: v for k, v in ge.items() if k != "enabled"})
    gp = platform.get("gpu") or {}
    if gp.get("enabled", False):
        push("vertex_gpu", {k: v for k, v in gp.items() if k != "enabled"})
    gv = platform.get("governance") or {}
    if gv.get("enabled", True):
        push("knowledge_catalog", {k: v for k, v in gv.items() if k != "enabled"})
    sec = {**DEFAULT_SECURITY, **(platform.get("security") or {})}
    return comps, sec


def security_components(sec, start_index=100):
    """Legacy security toggles -> security components."""
    if not sec.get("enabled", True):
        return []
    out, i = [], start_index
    for flag, ctype in (("sdp_discovery", "sdp"), ("cmek", "cmek"), ("vpc_sc", "vpc_sc")):
        if sec.get(flag, True):
            i += 1
            out.append({"id": f"c{i}", "type": ctype, "settings": {}})
    for ctype in ("policy_tags", "scc"):
        i += 1
        out.append({"id": f"c{i}", "type": ctype, "settings": {}})
    return out


def normalized(scenario):
    """Return (components, security_summary) with defaults filled in.

    Security controls are components (category "security"). Older scenarios that carry a
    `security` dict of toggles - or the even older fixed `platform` block - are converted.
    """
    if scenario.get("components") is not None:
        comps = list(scenario["components"])
        has_sec = any(COMPONENT_BY_ID.get(c.get("type"), {}).get("category") == "security" for c in comps)
        if scenario.get("security") is not None and not has_sec:
            comps += security_components({**DEFAULT_SECURITY, **scenario["security"]})
    elif scenario.get("platform"):
        comps, legacy_sec = legacy_to_components(scenario["platform"])
        comps += security_components(legacy_sec)
    else:
        comps = [dict(c) for c in DEFAULT_COMPONENTS]
    out = []
    for c in comps:
        if c.get("type") not in COMPONENT_BY_ID:
            continue
        settings = component_defaults(c["type"])
        settings.update({k: v for k, v in (c.get("settings") or {}).items() if v is not None})
        out.append({"id": c.get("id") or c["type"], "type": c["type"], "settings": settings,
                    "start_month": int(c.get("start_month") or 1), "included": c.get("included") is not False})
    types = {c["type"] for c in out}
    sec = {"enabled": any(t in SECURITY_TYPES for t in types), "sdp_discovery": "sdp" in types,
           "cmek": "cmek" in types, "vpc_sc": "vpc_sc" in types}
    return out, sec


# --------------------------------------------------------------------------- #
# Costing
# --------------------------------------------------------------------------- #
def cost_components(comps, sec, pricing, up, sources, new_by_month, bq_model, add, curated_overhead,
                    set_region=lambda r: None, home_region=None, sec_start=1):
    """Add monthly line items for costed Google components and security controls.

    Each component may carry its own `region` setting; partner components are never costed.
    """
    tables = sum(int(s.get("tables") or 50) for s in sources) * (1 + curated_overhead * 3)
    for m in range(1, 37):
        for c in comps:
            t, s = c["type"], c["settings"]
            if m < int(c.get("start_month") or 1) or c.get("included") is False:
                continue
            set_region(s.get("region") or home_region)
            if t == "looker":
                add(m, "Looker licence (customer quote)", "_ai", float(s.get("annual_quote_usd") or 0) / 12, q=(1, "licence-months"))
            elif t == "looker_studio_pro":
                add(m, "Looker Studio Pro", "_ai", float(s["users"]) * pricing["looker"]["studio_pro_user_month"], q=(float(s["users"]), "user-months"))
            elif t == "gemini_enterprise":
                add(m, "Gemini Enterprise", "_ai", float(s["users"]) * pricing["gemini_enterprise"][f"{s['edition']}_user_month"], q=(float(s["users"]), "user-months"))
                if bq_model == "ondemand" and s.get("grounding", "bigquery") != "agents":
                    tib = float(s["users"]) * float(s.get("questions_per_user_month") or 0) * float(s.get("gb_per_question") or 0) / GIB_PER_TIB
                    set_region(home_region)
                    add(m, "BigQuery queries from Gemini Enterprise", "_ai", tib * pricing["bigquery"]["ondemand_tib"] * up("bigquery"), q=(tib, "TiB scanned"))
            elif t == "agent_platform":
                req = float(s["requests_month"])
                ae = pricing["agent_engine"]
                vcpu_h = max(0.0, req * float(s["agent_seconds"]) / 3600 - ae["free_vcpu_hr"])
                gib_h = max(0.0, req * float(s["agent_seconds"]) * 2 / 3600 - ae["free_gib_hr"])
                u = up("agent_engine")
                add(m, "Agent Engine runtime", "_ai", (vcpu_h * ae["vcpu_hr"] + gib_h * ae["gib_hr"]) * u,
                    cud1=(vcpu_h * ae["cud1_vcpu_hr"] + gib_h * ae["cud1_gib_hr"]) * u,
                    cud3=(vcpu_h * ae["cud3_vcpu_hr"] + gib_h * ae["cud3_gib_hr"]) * u, q=(vcpu_h, "vCPU-hours"))
                gm = pricing["gemini_models"][s["model"]]
                add(m, f"{gm['name']} tokens (agents)", "_ai",
                    req * (float(s["input_tokens"]) * gm["input_mtok"] + float(s["output_tokens"]) * gm["output_mtok"]) / 1e6,
                    q=(req * (float(s["input_tokens"]) + float(s["output_tokens"])) / 1e6, "M tokens"))
                if bq_model == "ondemand":
                    tib = req * float(s["bq_gb_per_request"]) / GIB_PER_TIB
                    set_region(home_region)
                    add(m, "BigQuery queries from agents", "_ai", tib * pricing["bigquery"]["ondemand_tib"] * up("bigquery"), q=(tib, "TiB scanned"))
            elif t == "vertex_gpu":
                node = pricing["vertex_prediction"]["nodes"][s["gpu"]]
                add(m, f"Vertex AI endpoint ({node['name']})", "_ai",
                    float(s["replicas"]) * float(s["hours_per_day"]) * 30.4 * node["hr"] * up("vertex_prediction"),
                    q=(float(s["replicas"]) * float(s["hours_per_day"]) * 30.4, "node-hours"))
            elif t == "apigee":
                ap = pricing["apigee"]
                calls = float(s["api_calls_million"])
                add(m, "Apigee (environment)", "_ai", ap["environment_month"][s["environment"]], q=(1, "environment-months"))
                add(m, "Apigee (API calls)", "_ai", tiered_m(calls, ap["calls_per_million"][s["proxy_type"]]), q=(calls, "M API calls"))
                if s.get("analytics") == "yes" and s["environment"] != "base":
                    add(m, "Apigee (API calls)", "_ai", calls * ap["analytics_per_million"])
                if s.get("advanced_security") == "yes" and s["environment"] != "base":
                    add(m, "Apigee (Advanced API Security)", "_ai", calls * ap["advanced_security_per_million"], q=(calls, "M API calls"))
            elif t == "alloydb":
                a = pricing["alloydb"]
                nodes = (2 if s.get("ha") == "yes" else 1) + float(s["read_pool_nodes"])
                v, g = float(s["vcpu"]) * nodes * HOURS, float(s["memory_gib"]) * nodes * HOURS
                u = up("alloydb")
                add(m, "AlloyDB", "_db", (v * a["vcpu_hr"] + g * a["mem_gib_hr"]) * u,
                    cud1=(v * a["cud1_vcpu_hr"] + g * a["cud1_mem_gib_hr"]) * u, cud3=(v * a["cud3_vcpu_hr"] + g * a["cud3_mem_gib_hr"]) * u, q=(nodes * HOURS, "node-hours"))
                add(m, "AlloyDB", "_db", float(s["storage_gib"]) * a["storage_gib_month"] * u)
            elif t == "cloudsql":
                q = pricing["cloudsql"]
                ha = s.get("ha") == "yes"
                comp = (float(s["vcpu"]) * (q["ha_vcpu_hr"] if ha else q["vcpu_hr"]) + float(s["memory_gib"]) * (q["ha_mem_gib_hr"] if ha else q["mem_gib_hr"])) * HOURS
                u = up("cloudsql")
                add(m, "Cloud SQL", "_db", comp * u, cud1=comp * q["cud1_factor"] * u, cud3=comp * q["cud3_factor"] * u, q=(HOURS, "instance-hours"))
                add(m, "Cloud SQL", "_db", float(s["storage_gib"]) * (q["ha_ssd_gib_month"] if ha else q["ssd_gib_month"]) * u)
            elif t == "spanner":
                sp = pricing["spanner"]
                comp = float(s["nodes"]) * sp["node_hr"][s["edition"]] * HOURS
                u = up("spanner")
                add(m, "Spanner", "_db", comp * u, cud1=comp * sp["cud1_factor"] * u, cud3=comp * sp["cud3_factor"] * u, q=(float(s["nodes"]) * HOURS, "node-hours"))
                add(m, "Spanner", "_db", float(s["storage_gib"]) * sp["ssd_gib_month"] * u)
            elif t == "bigtable":
                bt = pricing["bigtable"]
                comp = float(s["nodes"]) * bt["node_hr"][s["edition"]] * HOURS
                u = up("bigtable")
                add(m, "Bigtable", "_db", comp * u, cud1=comp * bt["cud1_factor"] * u, cud3=comp * bt["cud3_factor"] * u, q=(float(s["nodes"]) * HOURS, "node-hours"))
                add(m, "Bigtable", "_db", float(s["storage_gib"]) * bt["ssd_gib_month"] * u)
            elif t == "firestore":
                fs = pricing["firestore"]
                ops = (max(0.0, float(s["reads_million"]) * 1e6 - fs["free_reads_month"]) / 1e5 * fs["reads_per_100k"]
                       + max(0.0, float(s["writes_million"]) * 1e6 - fs["free_writes_month"]) / 1e5 * fs["writes_per_100k"])
                u = up("firestore")
                add(m, "Firestore", "_db", ops * u, cud1=ops * fs["cud1_factor"] * u, cud3=ops * fs["cud3_factor"] * u,
                    q=(float(s["reads_million"]) + float(s["writes_million"]), "M operations"))
                add(m, "Firestore", "_db", max(0.0, float(s["storage_gib"]) - fs["free_storage_gib"]) * fs["storage_gib_month"] * u)
            elif t == "memorystore":
                ms = pricing["memorystore"]
                cap = float(s["capacity_gib"])
                rate = next(p for lim, p in ms["standard_tier_gib_hr"] if lim is None or cap <= lim)
                c = cap * rate * HOURS * up("memorystore")
                add(m, "Memorystore", "_db", c, cud1=c * ms["cud1_factor"], cud3=c * ms["cud3_factor"], q=(cap * HOURS, "GiB-hours"))
            elif t == "sdp":
                add(m, "Sensitive Data Protection (discovery)", "_governance", new_by_month[m] * pricing["sensitive_data_protection"]["discovery_gb"], q=(new_by_month[m], "GB profiled"))
            elif t == "cmek":
                k = pricing["kms"]
                add(m, "Cloud KMS (CMEK)", "_governance",
                    float(s["key_versions"]) * k["key_version_month"] + float(s["operations_million"]) * 100 * k["ops_per_10k"], q=(float(s["key_versions"]), "key versions"))
            elif t == "knowledge_catalog":
                dp = pricing["dataplex"]
                dq_tables = tables * float(s["dq_share_pct"]) / 100
                dcu = dq_tables * float(s["dq_scans_per_month"]) * dp["dq_dcu_hr_per_table_scan"] + tables * dp["lineage_dcu_hr_per_table_month"]
                u = up("dataplex")
                meta_gib = max(1.0, tables / 1000)
                add(m, "Knowledge Catalog (Dataplex) - quality, profiling, lineage", "_governance",
                    (dcu * dp["premium_dcu_hr"] + meta_gib * dp["metadata_gib_month"]) * u,
                    cud1=(dcu * dp["premium_cud1_dcu_hr"] + meta_gib * dp["metadata_gib_month"]) * u,
                    cud3=(dcu * dp["premium_cud3_dcu_hr"] + meta_gib * dp["metadata_gib_month"]) * u, q=(dcu, "DCU-hours"))
        set_region(home_region)
    return int(tables)


# --------------------------------------------------------------------------- #
# Narrative
# --------------------------------------------------------------------------- #
def tiered_m(qty, tiers):
    """Graduated pricing: tiers = [[upper_limit_or_None, price_per_unit], ...]."""
    cost, prev = 0.0, 0.0
    for limit, price in tiers:
        top = qty if limit is None else min(qty, limit)
        if top > prev:
            cost += (top - prev) * price
            prev = top
        if limit is not None and qty <= limit:
            break
    return cost


def component_view(c):
    meta = COMPONENT_BY_ID[c["type"]]
    return {"id": c["id"], "type": c["type"], "start_month": int(c.get("start_month") or 1), "included": c.get("included") is not False, "name": meta["name"], "category": meta["category"],
            "vendor": meta["vendor"], "costed": meta["costed"], "method": meta["method"],
            "steps": meta["steps"], "notes": meta["notes"], "doc": meta["doc"], "settings": c["settings"],
            "mode_note": (meta.get("modes") or {}).get("notes", {}).get(c["settings"].get((meta.get("modes") or {}).get("key", ""), ""), "")}


def platform_story(comps, sec, sources):
    blocks = []
    cdc = [s.get("name") or s.get("type") for s in sources
           if SOURCE_BY_ID.get(s.get("type"), {}).get("cdc") and s.get("frequency") in STREAMING_FREQS]
    blocks.append({
        "key": "lakehouse", "title": "BigQuery lakehouse foundation",
        "tools": ["dataform", "bqml", "reverse_etl"],
        "points": [
            "Medallion lakehouse: a Cloud Storage raw zone keeps immutable source extracts; BigQuery bronze (as ingested), silver (cleansed, conformed) and gold (curated marts) datasets are built by Dataform; Apache Iceberg tables through BigLake keep data portable across engines.",
            ("Continuous CDC from " + ", ".join(cdc[:4]) + " keeps operational data fresh for analytics and agents."
             if cdc else "Add CDC sources (Datastream) when agents and dashboards need minute-level freshness."),
            "Dataform builds tested, version-controlled SQL models; BigQuery ML and AI functions bring Gemini and vector search into SQL.",
            "Every connected BI, AI and governance tool reads the same governed tables, so metrics and permissions stay consistent.",
        ],
    })
    sec_comps = [c for c in comps if COMPONENT_BY_ID[c["type"]]["category"] == "security"]
    if sec_comps:
        tool_for = {"sdp": "sdp", "cmek": "cmek", "vpc_sc": "vpc_sc", "policy_tags": "fine_grained", "scc": "scc"}
        tools = [tool_for[c["type"]] for c in sec_comps if c["type"] in tool_for]
        pts = [COMPONENT_BY_ID[c["type"]]["name"] + ": " + COMPONENT_BY_ID[c["type"]]["method"] + "." for c in sec_comps]
        if any(COMPONENT_BY_ID[c["type"]]["vendor"] == "partner" for c in comps):
            pts.append("Partner tools connect with service accounts or workload identity federation (no long-lived keys); keep them inside the perimeter with VPC-SC ingress rules.")
        blocks.append({"key": "security", "title": "Security & compliance", "tools": tools, "points": pts})
    return blocks
