"""Static catalog: source system types, GCP ingestion tools and discovery options.

Everything the UI shows in pick-lists comes from here (served via /api/catalog),
so adding a new source type or tool is a one-file change.
"""

# --------------------------------------------------------------------------- #
# Discovery options
# --------------------------------------------------------------------------- #
FREQUENCIES = [
    {"id": "realtime", "name": "Real-time (seconds)", "runs_per_month": None},
    {"id": "near_realtime", "name": "Near real-time (minutes)", "runs_per_month": None},
    {"id": "hourly", "name": "Hourly", "runs_per_month": 730},
    {"id": "daily", "name": "Daily", "runs_per_month": 30},
    {"id": "weekly", "name": "Weekly", "runs_per_month": 4.3},
    {"id": "monthly", "name": "Monthly", "runs_per_month": 1},
    {"id": "one_time", "name": "One-time migration", "runs_per_month": 0},
]
STREAMING_FREQS = {"realtime", "near_realtime"}

DATA_TYPES = [
    {"id": "structured", "name": "Structured (tables)"},
    {"id": "semi_structured", "name": "Semi-structured (JSON, XML, Avro, Parquet)"},
    {"id": "unstructured", "name": "Unstructured (documents, images, audio)"},
    {"id": "events", "name": "Event streams / messages"},
]

LOCATIONS = [
    {"id": "on_prem", "name": "On-premises / private DC"},
    {"id": "gcp", "name": "Google Cloud"},
    {"id": "aws", "name": "AWS"},
    {"id": "azure", "name": "Azure"},
    {"id": "saas", "name": "SaaS (internet)"},
]

TRANSFORMS = [
    {"id": "none", "name": "None - land as-is (ELT later)"},
    {"id": "light", "name": "Light - filter, map, mask PII"},
    {"id": "heavy", "name": "Heavy - joins, enrichment, complex logic"},
]

SKILLS = [
    {"id": "sql", "name": "SQL-first (analysts / BI engineers)"},
    {"id": "low_code", "name": "Low-code / visual (ETL developers)"},
    {"id": "code", "name": "Code-first (Python / Java / Beam)"},
    {"id": "spark", "name": "Spark / Hadoop"},
]

# --------------------------------------------------------------------------- #
# Source system catalog
# category drives the rule set in recommender.py
# --------------------------------------------------------------------------- #
SOURCE_TYPES = [
    # Relational / OLTP
    {"id": "oracle", "name": "Oracle Database", "category": "rdbms", "icon": "db", "cdc": True},
    {"id": "sqlserver", "name": "Microsoft SQL Server", "category": "rdbms", "icon": "db", "cdc": True},
    {"id": "mysql", "name": "MySQL / MariaDB", "category": "rdbms", "icon": "db", "cdc": True},
    {"id": "postgresql", "name": "PostgreSQL", "category": "rdbms", "icon": "db", "cdc": True},
    {"id": "cloudsql", "name": "Cloud SQL (MySQL / PostgreSQL / SQL Server)", "category": "rdbms_gcp", "icon": "db", "cdc": True},
    {"id": "alloydb", "name": "AlloyDB", "category": "rdbms_gcp", "icon": "db", "cdc": True},
    {"id": "spanner", "name": "Cloud Spanner", "category": "rdbms_gcp", "icon": "db", "cdc": True},
    {"id": "db2", "name": "IBM Db2", "category": "rdbms_nocdc", "icon": "db", "cdc": False},
    {"id": "other_jdbc", "name": "Other JDBC database", "category": "rdbms_nocdc", "icon": "db", "cdc": False},
    # Data warehouses / big data (migration)
    {"id": "teradata", "name": "Teradata", "category": "dwh", "icon": "dwh"},
    {"id": "redshift", "name": "Amazon Redshift", "category": "dwh", "icon": "dwh"},
    {"id": "snowflake", "name": "Snowflake", "category": "dwh", "icon": "dwh"},
    {"id": "netezza", "name": "IBM Netezza", "category": "dwh", "icon": "dwh"},
    {"id": "synapse", "name": "Azure Synapse", "category": "dwh", "icon": "dwh"},
    {"id": "hadoop", "name": "Hadoop / Hive / HDFS", "category": "hadoop", "icon": "dwh"},
    # Enterprise apps
    {"id": "sap", "name": "SAP ECC / S/4HANA / BW", "category": "sap", "icon": "app"},
    {"id": "mainframe", "name": "Mainframe (z/OS, VSAM, Db2 z)", "category": "mainframe", "icon": "app"},
    # NoSQL
    {"id": "mongodb", "name": "MongoDB", "category": "nosql", "icon": "db"},
    {"id": "cassandra", "name": "Cassandra", "category": "nosql", "icon": "db"},
    {"id": "firestore", "name": "Firestore / Bigtable", "category": "nosql_gcp", "icon": "db"},
    # Files & object storage
    {"id": "files_onprem", "name": "Files - on-prem (NFS / SMB / SFTP)", "category": "files_onprem", "icon": "file"},
    {"id": "s3", "name": "Amazon S3", "category": "object_aws", "icon": "file"},
    {"id": "azure_blob", "name": "Azure Blob / ADLS Gen2", "category": "object_azure", "icon": "file"},
    {"id": "gcs", "name": "Cloud Storage files", "category": "object_gcp", "icon": "file"},
    # Streaming
    {"id": "kafka", "name": "Apache Kafka / Confluent", "category": "kafka", "icon": "stream"},
    {"id": "kinesis", "name": "Amazon Kinesis / MSK", "category": "stream_aws", "icon": "stream"},
    {"id": "event_hubs", "name": "Azure Event Hubs", "category": "stream_azure", "icon": "stream"},
    {"id": "iot", "name": "IoT devices / telemetry", "category": "events", "icon": "stream"},
    {"id": "clickstream", "name": "Web / app clickstream events", "category": "events", "icon": "stream"},
    {"id": "logs", "name": "Application & infra logs (Cloud Logging)", "category": "logs", "icon": "stream"},
    # SaaS
    {"id": "google_marketing", "name": "Google Ads / GA4 / YouTube / Campaign Manager", "category": "saas_google", "icon": "saas"},
    {"id": "salesforce", "name": "Salesforce", "category": "saas_salesforce", "icon": "saas"},
    {"id": "saas_other", "name": "Other SaaS (ServiceNow, Workday, HubSpot, ...)", "category": "saas_other", "icon": "saas"},
    {"id": "rest_api", "name": "Custom REST / GraphQL API", "category": "api", "icon": "saas"},
    # Unstructured
    {"id": "documents", "name": "Documents / images / media", "category": "unstructured", "icon": "file"},
    {"id": "custom", "name": "Other - not in this list (enter the product name)", "category": "custom", "icon": "db"},
]

# --------------------------------------------------------------------------- #
# GCP tool catalog (what the recommender can pick)
# layer: ingest | process | land | orchestrate | connect
# --------------------------------------------------------------------------- #
TOOLS = {
    "datastream": {
        "name": "Datastream",
        "layer": "ingest",
        "summary": "Serverless CDC replication from Oracle, MySQL, PostgreSQL, SQL Server, AlloyDB, Spanner straight into BigQuery.",
        "doc": "https://cloud.google.com/datastream/docs/overview",
    },
    "dataflow": {
        "name": "Dataflow",
        "layer": "process",
        "summary": "Serverless Apache Beam for batch and streaming ETL; Google-provided templates (JDBC, Kafka, MongoDB, Pub/Sub to BigQuery).",
        "doc": "https://cloud.google.com/dataflow/docs/guides/templates/provided-templates",
    },
    "pubsub": {
        "name": "Pub/Sub",
        "layer": "ingest",
        "summary": "Global messaging; BigQuery subscriptions write messages to tables with no pipeline code. Import topics can pull from Kinesis, MSK, Event Hubs, Confluent.",
        "doc": "https://cloud.google.com/pubsub/docs/bigquery",
    },
    "bq_dts": {
        "name": "BigQuery Data Transfer Service",
        "layer": "ingest",
        "summary": "Managed, scheduled loads from Google SaaS, S3, Azure Blob, Cloud Storage, Salesforce and warehouse migrations (Teradata, Redshift, Snowflake).",
        "doc": "https://cloud.google.com/bigquery/docs/dts-introduction",
    },
    "bq_migration": {
        "name": "BigQuery Migration Service",
        "layer": "ingest",
        "summary": "Assessment, batch + interactive SQL translation and data validation for warehouse migrations.",
        "doc": "https://cloud.google.com/bigquery/docs/migration-intro",
    },
    "datafusion": {
        "name": "Cloud Data Fusion",
        "layer": "process",
        "summary": "Visual, low-code ETL (CDAP) with 150+ connectors incl. SAP, Db2, mainframe, SaaS; executes on Dataproc.",
        "doc": "https://cloud.google.com/data-fusion/docs/concepts/overview",
    },
    "dataproc_serverless": {
        "name": "Dataproc Serverless (Spark)",
        "layer": "process",
        "summary": "Run Spark batch jobs without clusters - best for existing Spark/Hadoop skills and code.",
        "doc": "https://cloud.google.com/dataproc-serverless/docs/overview",
    },
    "storage_transfer": {
        "name": "Storage Transfer Service",
        "layer": "ingest",
        "summary": "Scheduled, incremental file transfer from on-prem file systems (agent), S3, Azure and HTTP into Cloud Storage.",
        "doc": "https://cloud.google.com/storage-transfer/docs/overview",
    },
    "transfer_appliance": {
        "name": "Transfer Appliance",
        "layer": "ingest",
        "summary": "Physical appliance for offline transfer of 100s of TB when network bandwidth is the bottleneck.",
        "doc": "https://cloud.google.com/transfer-appliance/docs/4.0/overview",
    },
    "bq_omni": {
        "name": "BigQuery Omni / BigLake",
        "layer": "ingest",
        "summary": "Query data in place on S3 / Azure Blob, or as BigLake external tables, without copying it first.",
        "doc": "https://cloud.google.com/bigquery/docs/omni-introduction",
    },
    "sap_connector": {
        "name": "BigQuery Connector for SAP",
        "layer": "ingest",
        "summary": "Near real-time replication from SAP (via SLT) into BigQuery; pairs with Google Cloud Cortex Framework data models.",
        "doc": "https://cloud.google.com/solutions/sap/docs/bq-connector/latest/planning",
    },
    "mqtt_broker": {
        "name": "MQTT broker (GKE)",
        "layer": "ingest",
        "summary": "Self-managed MQTT broker (EMQX, HiveMQ, Mosquitto) on GKE or Compute Engine bridging device telemetry to Pub/Sub.",
        "doc": "https://cloud.google.com/architecture/connected-devices",
    },
    "litmus": {
        "name": "Litmus Edge",
        "layer": "ingest",
        "summary": "Partner industrial edge platform: connects PLCs, SCADA and historians, normalises OT data and publishes to Pub/Sub (Manufacturing Connect).",
        "doc": "https://litmus.io/litmus-edge",
    },
    "clearblade": {
        "name": "ClearBlade IoT Core",
        "layer": "ingest",
        "summary": "Partner IoT device management and MQTT/HTTP bridge - the drop-in replacement for the retired Cloud IoT Core.",
        "doc": "https://www.clearblade.com/iot-core/",
    },
    "mde": {
        "name": "Manufacturing Data Engine",
        "layer": "process",
        "summary": "Google Cloud Manufacturing Data Engine: common manufacturing data model and pipelines to BigQuery, Bigtable and Cloud Storage.",
        "doc": "https://cloud.google.com/solutions/manufacturing-data-engine",
    },
    "gcs_lake": {
        "name": "Cloud Storage data lake",
        "layer": "land",
        "summary": "Data lake in Cloud Storage in open formats (Parquet, Avro, Iceberg); BigQuery reads it through BigLake tables.",
        "doc": "https://cloud.google.com/bigquery/docs/biglake-intro",
    },
    "dms": {
        "name": "Database Migration Service",
        "layer": "ingest",
        "summary": "Serverless migration and continuous replication into Cloud SQL and AlloyDB, with schema conversion for Oracle and SQL Server.",
        "doc": "https://cloud.google.com/database-migration/docs",
    },
    "op_db": {
        "name": "AlloyDB / Cloud SQL",
        "layer": "target",
        "summary": "Managed operational database target (PostgreSQL / MySQL compatible).",
        "doc": "https://cloud.google.com/alloydb/docs/overview",
    },
    "gcs_raw": {
        "name": "Cloud Storage raw zone",
        "layer": "land",
        "summary": "Immutable copies of source extracts and files for replay, audit and reprocessing before the BigQuery bronze layer.",
        "doc": "https://cloud.google.com/storage/docs/storage-classes",
    },
    "mainframe_connector": {
        "name": "Mainframe Connector",
        "layer": "ingest",
        "summary": "Moves mainframe datasets (incl. EBCDIC/COBOL copybooks) to Cloud Storage/BigQuery and transcodes to ORC.",
        "doc": "https://cloud.google.com/mainframe-connector/docs/overview",
    },
    "managed_kafka": {
        "name": "Managed Service for Apache Kafka",
        "layer": "ingest",
        "summary": "Fully managed Kafka on GCP with Connect clusters (BigQuery sink) - for teams standardising on Kafka.",
        "doc": "https://cloud.google.com/managed-service-for-apache-kafka/docs/overview",
    },
    "federated": {
        "name": "BigQuery federated queries",
        "layer": "ingest",
        "summary": "EXTERNAL_QUERY against Cloud SQL / AlloyDB / Spanner + scheduled queries - zero pipeline for low volumes.",
        "doc": "https://cloud.google.com/bigquery/docs/federated-queries-intro",
    },
    "log_sink": {
        "name": "Cloud Logging sink to BigQuery",
        "layer": "ingest",
        "summary": "Route logs to BigQuery datasets (or Log Analytics linked datasets) with a filter - no pipeline needed.",
        "doc": "https://cloud.google.com/logging/docs/export/bigquery",
    },
    "cloud_run_jobs": {
        "name": "Cloud Run jobs + Cloud Scheduler",
        "layer": "process",
        "summary": "Lightweight Python/Node extractors for REST APIs and niche SaaS, loading via the Storage Write API.",
        "doc": "https://cloud.google.com/run/docs/create-jobs",
    },
    "app_integration": {
        "name": "Application Integration / Integration Connectors",
        "layer": "ingest",
        "summary": "100+ managed SaaS connectors (ServiceNow, Workday, HubSpot ...) with visual integration flows.",
        "doc": "https://cloud.google.com/integration-connectors/docs/connector-reference-overview",
    },
    "object_tables": {
        "name": "Cloud Storage + BigQuery object tables",
        "layer": "land",
        "summary": "Land files in Cloud Storage and expose them as object tables; enrich with Document AI / Gemini via BigQuery ML.",
        "doc": "https://cloud.google.com/bigquery/docs/object-table-introduction",
    },
    "gcs_load": {
        "name": "Cloud Storage landing + BigQuery load jobs",
        "layer": "land",
        "summary": "Batch loads from a GCS landing bucket are free on the shared slot pool; or expose as BigLake tables.",
        "doc": "https://cloud.google.com/bigquery/docs/loading-data-cloud-storage",
    },
    # Platform-level components
    "dataform": {
        "name": "Dataform",
        "layer": "transform",
        "summary": "SQL-based ELT inside BigQuery with version control, dependencies, assertions and scheduling. No extra charge.",
        "doc": "https://cloud.google.com/dataform/docs/overview",
    },
    "composer": {
        "name": "Managed Service for Apache Airflow (Cloud Composer)",
        "layer": "orchestrate",
        "summary": "Managed Airflow to orchestrate cross-system pipelines, dependencies, retries and SLAs.",
        "doc": "https://cloud.google.com/composer/docs/composer-3/composer-overview",
    },
    "workflows": {
        "name": "Workflows + Cloud Scheduler",
        "layer": "orchestrate",
        "summary": "Serverless, low-cost orchestration for a handful of simple pipelines.",
        "doc": "https://cloud.google.com/workflows/docs/overview",
    },
    # ---------------- Agentic data cloud: consume, AI, governance, security
    "looker": {
        "name": "Looker",
        "layer": "consume",
        "summary": "Governed BI and semantic layer (LookML / BigQuery measures) directly on BigQuery; also powers Conversational Analytics and Looker Studio.",
        "doc": "https://cloud.google.com/looker/docs/intro",
    },
    "looker_studio": {
        "name": "Looker Studio",
        "layer": "consume",
        "summary": "Self-service dashboards on BigQuery; Pro adds team workspaces, governance and SLA.",
        "doc": "https://cloud.google.com/looker-studio",
    },
    "conversational_analytics": {
        "name": "Conversational Analytics & BigQuery data agents",
        "layer": "ai",
        "summary": "Natural-language questions over BigQuery and Looker with traceable answers; Data Engineering and Data Science agents in BigQuery Studio.",
        "doc": "https://cloud.google.com/gemini/docs/conversational-analytics-api/overview",
    },
    "gemini_enterprise": {
        "name": "Gemini Enterprise",
        "layer": "ai",
        "summary": "Agentic workspace for every employee: grounded search, Deep Research, no-code and custom agents over BigQuery and enterprise apps.",
        "doc": "https://cloud.google.com/gemini-enterprise",
    },
    "agent_platform": {
        "name": "Gemini Enterprise Agent Platform (Vertex AI)",
        "layer": "ai",
        "summary": "Build agents with ADK, host them on Agent Engine (sessions, Memory Bank), call Gemini models, and expose BigQuery via MCP tools.",
        "doc": "https://cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/overview",
    },
    "gpu_endpoints": {
        "name": "Vertex AI GPU endpoints",
        "layer": "ai",
        "summary": "Deploy open, fine-tuned or custom models (Model Garden, vLLM) to autoscaling online endpoints on L4, A100 or H100 GPUs.",
        "doc": "https://cloud.google.com/vertex-ai/docs/predictions/overview",
    },
    "bqml": {
        "name": "BigQuery ML & AI functions",
        "layer": "ai",
        "summary": "AI.GENERATE / ML.GENERATE_TEXT, embeddings and vector search in SQL; remote models call Gemini or your own Vertex endpoint.",
        "doc": "https://cloud.google.com/bigquery/docs/generative-ai-overview",
    },
    "reverse_etl": {
        "name": "Reverse ETL to AlloyDB / Spanner",
        "layer": "consume",
        "summary": "Sync curated BigQuery results back into operational databases that serve applications and agents.",
        "doc": "https://cloud.google.com/bigquery/docs/export-to-spanner",
    },
    "knowledge_catalog": {
        "name": "Knowledge Catalog (Dataplex)",
        "layer": "govern",
        "summary": "Successor to Dataplex Universal Catalog: semantic search, business glossary, lineage, data profiling and quality scans - the context layer for agents.",
        "doc": "https://cloud.google.com/dataplex/docs/introduction",
    },
    "sdp": {
        "name": "Sensitive Data Protection",
        "layer": "security",
        "summary": "Discovers and classifies PII across BigQuery and Cloud Storage; de-identifies data and drives policy tags.",
        "doc": "https://cloud.google.com/sensitive-data-protection/docs/sensitive-data-protection-overview",
    },
    "cmek": {
        "name": "Cloud KMS (CMEK)",
        "layer": "security",
        "summary": "Customer-managed encryption keys for BigQuery, Cloud Storage, Pub/Sub, Datastream, Dataflow and Vertex AI.",
        "doc": "https://cloud.google.com/kms/docs/cmek",
    },
    "vpc_sc": {
        "name": "VPC Service Controls",
        "layer": "security",
        "summary": "Service perimeter around data and AI projects to prevent exfiltration.",
        "doc": "https://cloud.google.com/vpc-service-controls/docs/overview",
    },
    "fine_grained": {
        "name": "BigQuery policy tags, row access & data masking",
        "layer": "security",
        "summary": "Column- and row-level security and dynamic masking enforced for SQL, Looker and agents alike.",
        "doc": "https://cloud.google.com/bigquery/docs/column-level-security-intro",
    },
    "scc": {
        "name": "Security Command Center",
        "layer": "security",
        "summary": "Posture management and threat detection, including AI workload protection and data security posture.",
        "doc": "https://cloud.google.com/security-command-center/docs/security-command-center-overview",
    },
    "ha_vpn": {
        "name": "Cloud HA VPN",
        "layer": "connect",
        "summary": "Encrypted private connectivity from on-prem / other clouds (up to ~3 Gbps per tunnel).",
        "doc": "https://cloud.google.com/network-connectivity/docs/vpn/concepts/overview",
    },
    "interconnect": {
        "name": "Cloud Interconnect",
        "layer": "connect",
        "summary": "Dedicated or Partner Interconnect for sustained high-volume transfer with SLA.",
        "doc": "https://cloud.google.com/network-connectivity/docs/interconnect/concepts/overview",
    },
}


IOT_OPTIONS = [
    {"id": "native", "name": "Google Cloud native - devices publish to Pub/Sub (HTTPS / gRPC)", "vendor": "google"},
    {"id": "mqtt_broker", "name": "Google Cloud native - MQTT broker on GKE / Compute Engine -> Pub/Sub", "vendor": "google"},
    {"id": "litmus", "name": "ISV - Litmus Edge (industrial OT) -> Pub/Sub", "vendor": "partner"},
    {"id": "clearblade", "name": "ISV - ClearBlade IoT Core -> Pub/Sub", "vendor": "partner"},
    {"id": "mde", "name": "Google Manufacturing Data Engine + Manufacturing Connect (Litmus)", "vendor": "google"},
]

# Volume units for inputs; stored internally in GB (binary multiples, as billed: GiB / TiB ...).
VOLUME_UNITS = [
    {"id": "KB", "gb": 1 / 1024 ** 2}, {"id": "MB", "gb": 1 / 1024}, {"id": "GB", "gb": 1.0},
    {"id": "TB", "gb": 1024.0}, {"id": "PB", "gb": 1024.0 ** 2}, {"id": "EB", "gb": 1024.0 ** 3}, {"id": "ZB", "gb": 1024.0 ** 4},
]


def catalog_payload(regions):
    from .components import CATEGORIES, COMPONENTS, DEFAULT_COMPONENTS, DEFAULT_SECURITY
    from .workload import DEFAULT_WORKLOAD, FREQ_RUNS
    from .environments import DEFAULT_ENVIRONMENTS, ENV_PRESETS, FACTOR_HELP, FACTOR_LABELS
    from .estimator import LAKEHOUSE_DEFAULTS
    from .recommender import TARGETS, allowed_targets
    return {
        "components": COMPONENTS,
        "component_categories": CATEGORIES,
        "default_components": DEFAULT_COMPONENTS,
        "default_security": DEFAULT_SECURITY,
        "default_workload": DEFAULT_WORKLOAD,
        "query_frequencies": [{"id": k, "name": k.title()} for k in FREQ_RUNS],
        "source_types": SOURCE_TYPES,
        "frequencies": FREQUENCIES,
        "data_types": DATA_TYPES,
        "locations": LOCATIONS,
        "transforms": TRANSFORMS,
        "skills": SKILLS,
        "tools": TOOLS,
        "regions": regions,
        "iot_options": IOT_OPTIONS,
        "targets": TARGETS,
        "allowed_targets": {s["id"]: allowed_targets(s["id"]) for s in SOURCE_TYPES if s["id"] != "custom"},
        "volume_units": VOLUME_UNITS,
        "environment_presets": ENV_PRESETS,
        "environment_factors": [{"id": k, "name": v, "help": FACTOR_HELP[k]} for k, v in FACTOR_LABELS.items()],
        "default_environments": DEFAULT_ENVIRONMENTS,
        "lakehouse_defaults": LAKEHOUSE_DEFAULTS,
        "storage_classes": [{"id": "standard", "name": "Standard"}, {"id": "nearline", "name": "Nearline (30-day minimum)"},
                            {"id": "coldline", "name": "Coldline (90-day minimum)"}, {"id": "archive", "name": "Archive (365-day minimum)"}],
        "bq_models": [
            {"id": "ondemand", "name": "On-demand (per TiB scanned)"},
            {"id": "standard", "name": "Editions - Standard"},
            {"id": "enterprise", "name": "Editions - Enterprise"},
            {"id": "enterprise_plus", "name": "Editions - Enterprise Plus"},
        ],
        "bi_options": [
            {"id": "looker", "name": "Looker (quote-based licence)"},
            {"id": "looker_studio_pro", "name": "Looker Studio Pro"},
            {"id": "looker_studio", "name": "Looker Studio (no cost)"},
        ],
        "gemini_enterprise_editions": [
            {"id": "business", "name": "Business"},
            {"id": "standard", "name": "Standard"},
            {"id": "plus", "name": "Plus"},
        ],
        "gemini_models": [
            {"id": "flash_lite", "name": "Gemini Flash-Lite"},
            {"id": "flash", "name": "Gemini Flash"},
            {"id": "pro", "name": "Gemini Pro"},
        ],
        "gpu_types": [
            {"id": "l4", "name": "NVIDIA L4 (g2-standard-8)"},
            {"id": "a100", "name": "NVIDIA A100 40GB"},
            {"id": "h100", "name": "NVIDIA H100 80GB"},
            {"id": "cpu", "name": "CPU only (n1-standard-4)"},
        ],
        "orchestration": [
            {"id": "auto", "name": "Auto-select"},
            {"id": "composer", "name": "Cloud Composer (Airflow)"},
            {"id": "workflows", "name": "Workflows + Scheduler"},
            {"id": "none", "name": "None / built-in schedules"},
        ],
    }


SOURCE_BY_ID = {s["id"]: s for s in SOURCE_TYPES}
