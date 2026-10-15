"""Rules engine: maps a discovered source system to GCP-native ingestion tooling.

Input  : one source dict (type, data_type, frequency, location, volumes, transform)
         plus scenario-level preferences (team skill).
Output : a Recommendation with a primary pattern, the chain of tools that make
         it up, alternatives, rationale and caveats. `engine` tells the cost
         estimator how to price the primary pattern.

The rules encode common Google Cloud reference architectures. They are
deliberately transparent (plain if/else) so architects can read and tune them.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict

from .catalog import SOURCE_BY_ID, STREAMING_FREQS

DATASTREAM_NATIVE = {"oracle", "sqlserver", "mysql", "postgresql", "cloudsql", "alloydb", "spanner"}
TB = 1024  # GB per TB


@dataclass
class Recommendation:
    source_id: str
    primary: str                      # headline tool id
    pattern: str                      # human readable pattern name
    chain: list[str]                  # ordered tool ids, source -> BigQuery
    engine: str                       # cost model key
    rationale: list[str] = field(default_factory=list)
    alternatives: list[dict] = field(default_factory=list)
    caveats: list[str] = field(default_factory=list)
    needs_connectivity: bool = False
    needs_datafusion: bool = False

    def to_dict(self):
        return asdict(self)


def _alt(tool, why):
    return {"tool": tool, "why": why}


def _iot(r, option):
    """Adapt the event pattern to the chosen IoT integration (Google-native or ISV)."""
    if option == "mqtt_broker":
        r.chain = ["mqtt_broker"] + r.chain
        r.engine += "+mqtt_broker"
        r.pattern = "Devices -> MQTT broker on GKE / Compute Engine -> " + r.pattern
        r.rationale.insert(0, "Devices keep speaking MQTT to a self-managed broker (EMQX, HiveMQ or Mosquitto) on GKE or Compute Engine, which bridges telemetry into Pub/Sub.")
        r.caveats.append("You operate the broker: size it for concurrent device connections, run it as an HA pair and manage device certificates.")
    elif option == "litmus":
        r.chain = ["litmus"] + r.chain
        r.primary = "litmus"
        r.pattern = "Litmus Edge -> " + r.pattern
        r.rationale.insert(0, "Litmus Edge (ISV) connects to PLCs, SCADA and historians with industrial drivers, normalises and contextualises data at the edge, and publishes to Pub/Sub; Litmus Edge Manager manages the fleet.")
        r.caveats.append("Litmus is a partner licence (edge devices / sites) - not included in the GCP estimate.")
    elif option == "clearblade":
        r.chain = ["clearblade"] + r.chain
        r.primary = "clearblade"
        r.pattern = "ClearBlade IoT Core -> " + r.pattern
        r.rationale.insert(0, "ClearBlade IoT Core (ISV) is the drop-in replacement for the retired Cloud IoT Core: MQTT / HTTP device registry, authentication and commands, forwarding telemetry to Pub/Sub.")
        r.caveats.append("ClearBlade is a partner subscription - not included in the GCP estimate.")
    elif option == "mde":
        r.chain = ["litmus", "pubsub", "mde"]
        r.primary = "mde"
        r.engine = "pubsub+dataflow_stream"
        r.pattern = "Manufacturing Connect (Litmus) -> Pub/Sub -> Manufacturing Data Engine -> BigQuery"
        r.rationale = ["Google Cloud Manufacturing Data Engine (MDE) with Manufacturing Connect edge (built with Litmus) ingests OT data, applies a common manufacturing data model and writes to BigQuery, Bigtable and Cloud Storage.",
                       "Best for plant-floor analytics, OEE and predictive maintenance at multi-site scale."]
        r.caveats.append("MDE is deployed with a Google partner; Manufacturing Connect edge licences are not included in this estimate.")
    else:
        r.rationale.insert(0, "Google Cloud native: devices (or a gateway) publish over HTTPS / gRPC with the Pub/Sub client libraries using service-account or workload-identity credentials.")
        r.caveats.append("Cloud IoT Core is retired - for MQTT devices choose an MQTT broker on GKE or an ISV such as ClearBlade or Litmus.")
    return r


def recommend(src: dict, prefs: dict | None = None) -> Recommendation:
    prefs = prefs or {}
    skill = prefs.get("skill", "sql")
    stype = src.get("type")
    meta = SOURCE_BY_ID.get(stype, {"category": "api", "name": stype})
    cat = meta["category"]
    freq = src.get("frequency", "daily")
    transform = src.get("transform", "none")
    location = src.get("location", "on_prem")
    daily_gb = float(src.get("daily_change_gb") or 0)
    initial_gb = float(src.get("initial_volume_gb") or 0)
    streaming = freq in STREAMING_FREQS
    one_time = freq == "one_time"
    heavy = transform == "heavy"
    sid = src.get("id", stype)

    r: Recommendation

    # ------------------------------------------------------------------ RDBMS
    if cat in ("rdbms", "rdbms_gcp"):
        if stype in DATASTREAM_NATIVE and (streaming or freq == "hourly" or not heavy):
            if heavy:
                r = Recommendation(sid, "datastream", "CDC via Datastream -> GCS -> Dataflow -> BigQuery",
                                   ["datastream", "gcs_load", "dataflow"], "datastream+dataflow_stream")
                r.rationale.append("Heavy in-flight transformation requested, so Datastream lands change files in Cloud Storage and the Google-provided 'Datastream to BigQuery' Dataflow template applies the logic before merge.")
            else:
                r = Recommendation(sid, "datastream", "Change Data Capture via Datastream -> BigQuery",
                                   ["datastream"], "datastream")
                r.rationale.append(f"{meta['name']} is a native Datastream source: log-based CDC replicates inserts/updates/deletes into BigQuery with seconds-to-minutes latency and no infrastructure to manage.")
                r.rationale.append("Backfill of existing tables is included, so the same stream handles the initial load and ongoing changes.")
                if not streaming:
                    r.rationale.append("Even for hourly/daily needs, CDC avoids heavy full-table extracts on the source and keeps BigQuery continuously fresh; set the BigQuery staleness ('max_staleness') to control merge cost.")
            r.alternatives.append(_alt("dataflow", "JDBC to BigQuery template for scheduled batch extracts when CDC/supplemental logging cannot be enabled on the source."))
            if cat == "rdbms_gcp":
                r.alternatives.append(_alt("federated", "EXTERNAL_QUERY + scheduled queries for small tables / reference data - zero pipeline."))
            r.alternatives.append(_alt("datafusion", "Low-code alternative with replication and batch plugins if the team prefers visual ETL."))
            if stype == "oracle":
                r.caveats.append("Oracle CDC uses LogMiner (or binary log reader): requires ARCHIVELOG mode and supplemental logging; check DBA approval early.")
            if stype == "sqlserver":
                r.caveats.append("SQL Server CDC requires either CDC tables or transaction-log reads to be enabled on the source.")
            if stype == "postgresql":
                r.caveats.append("PostgreSQL requires logical replication (pgoutput) and a replication slot/publication.")
        else:
            # batch from RDBMS (non-CDC preference or heavy batch)
            r = _batch_etl(sid, meta, skill, transform, daily_gb, freq)
            r.rationale.insert(0, f"{freq.replace('_', ' ').title()} batch extracts with transformation '{transform}' - a scheduled JDBC pipeline is simpler than continuous CDC here.")
            if stype in DATASTREAM_NATIVE:
                r.alternatives.insert(0, _alt("datastream", "Switch to CDC if near real-time freshness or reduced source load becomes a requirement."))
        r.needs_connectivity = location not in ("gcp", "saas") and cat != "rdbms_gcp"

    elif cat == "rdbms_nocdc":
        r = _batch_etl(sid, meta, skill, transform, daily_gb, freq)
        r.rationale.insert(0, f"{meta['name']} is not a native Datastream source, so ingestion uses JDBC-based pipelines.")
        if streaming:
            r.caveats.append("True real-time CDC for this database needs a third-party log reader (e.g. IBM IIDR, Debezium on Kafka) feeding Pub/Sub or Kafka; consider micro-batches every few minutes instead.")
            r.alternatives.insert(0, _alt("managed_kafka", "Debezium/IIDR -> Managed Kafka -> BigQuery sink for real-time CDC."))
        r.needs_connectivity = location not in ("gcp", "saas")

    # ------------------------------------------------- Warehouse migrations
    elif cat == "dwh":
        if stype in ("teradata", "redshift", "snowflake"):
            r = Recommendation(sid, "bq_dts", "Warehouse migration: BigQuery Migration Service + Data Transfer Service",
                               ["bq_migration", "bq_dts"], "dts_migration")
            r.rationale.append(f"BigQuery Data Transfer Service has a managed {meta['name']} migration connector (schema + data, incremental runs supported), and BigQuery Migration Service translates SQL/ETL code and validates results.")
        else:
            r = Recommendation(sid, "bq_migration", "Export -> Cloud Storage -> BigQuery load + SQL translation",
                               ["bq_migration", "storage_transfer", "gcs_load"], "files_transfer")
            r.rationale.append(f"No direct DTS connector for {meta['name']}: export tables to files (Parquet/CSV), move them with Storage Transfer Service, load to BigQuery; Migration Service translates the SQL.")
        r.rationale.append("Run an assessment first (BigQuery Migration Assessment) to size slots and plan waves.")
        r.alternatives.append(_alt("dataflow", "JDBC to BigQuery template for selective tables or continuous sync during parallel run."))
        if initial_gb >= 100 * TB:
            r.alternatives.append(_alt("transfer_appliance", "Initial volume >= 100 TB - consider an offline appliance if bandwidth is limited."))
        r.caveats.append("Plan a parallel-run period; ongoing incremental sync until cut-over drives most of the run cost.")
        r.needs_connectivity = location == "on_prem"

    elif cat == "hadoop":
        if skill in ("spark", "code"):
            r = Recommendation(sid, "dataproc_serverless", "HDFS -> Cloud Storage, Spark jobs on Dataproc Serverless -> BigQuery / BigLake",
                               ["storage_transfer", "dataproc_serverless"], "dataproc")
            r.rationale.append("Existing Spark/Hive code ports to Dataproc Serverless with minimal change; data lands in Cloud Storage and is exposed through BigLake or loaded to BigQuery.")
        else:
            r = Recommendation(sid, "storage_transfer", "HDFS -> Cloud Storage -> BigLake / BigQuery load + Dataform",
                               ["storage_transfer", "gcs_load"], "files_transfer")
            r.rationale.append("Move Hive/HDFS data to Cloud Storage (Storage Transfer Service supports HDFS), expose as BigLake Iceberg/Parquet tables, and rewrite HiveQL as BigQuery SQL with Migration Service.")
        r.alternatives.append(_alt("bq_migration", "Translate HiveQL / Spark SQL to BigQuery SQL automatically."))
        r.needs_connectivity = location == "on_prem"

    # --------------------------------------------------- Enterprise apps
    elif cat == "sap":
        if streaming or freq == "hourly":
            r = Recommendation(sid, "sap_connector", "SAP SLT -> BigQuery Connector for SAP -> BigQuery (+ Cortex Framework)",
                               ["sap_connector"], "sap_connector")
            r.rationale.append("BigQuery Connector for SAP plugs into SAP Landscape Transformation (SLT) and streams table changes into BigQuery in near real-time.")
            r.rationale.append("Google Cloud Cortex Framework provides ready data models (OTC, P2P, finance) on top of the replicated tables.")
            r.alternatives.append(_alt("datafusion", "Data Fusion SAP plugins (Table Batch Source, ODP/BW extractors) when SLT is not licensed."))
        else:
            r = Recommendation(sid, "datafusion", "SAP extractors / ODP via Cloud Data Fusion -> BigQuery",
                               ["datafusion"], "datafusion")
            r.needs_datafusion = True
            r.rationale.append("Cloud Data Fusion's SAP connectors (ODP, BW Open Hub, SLT, table batch) handle scheduled extracts with low-code pipelines.")
            r.alternatives.append(_alt("sap_connector", "BigQuery Connector for SAP if SLT is available and fresher data is needed."))
        r.caveats.append("Confirm SAP licensing (SLT / ODP / runtime licence) - indirect access rules can apply.")
        r.needs_connectivity = location == "on_prem"

    elif cat == "mainframe":
        r = Recommendation(sid, "mainframe_connector", "Mainframe Connector -> Cloud Storage (ORC) -> BigQuery",
                           ["mainframe_connector", "gcs_load"], "files_transfer")
        r.rationale.append("Mainframe Connector runs as a JCL step, transcodes EBCDIC/COBOL copybook data to ORC and loads to BigQuery - no custom parsing.")
        r.alternatives.append(_alt("datafusion", "Data Fusion mainframe/COBOL plugins for low-code parsing."))
        r.alternatives.append(_alt("dataflow", "Dataflow with copybook parsing for complex record layouts."))
        if streaming:
            r.caveats.append("Real-time mainframe CDC requires a partner log reader (e.g. Precisely, IBM IIDR) into Pub/Sub/Kafka.")
        r.needs_connectivity = True

    # ------------------------------------------------------------- NoSQL
    elif cat == "nosql":
        if streaming:
            r = Recommendation(sid, "dataflow", "Change streams via Dataflow (MongoDB/Cassandra template) -> BigQuery",
                               ["dataflow"], "dataflow_stream")
            r.rationale.append("Dataflow's Google-provided MongoDB-to-BigQuery (CDC) templates read change streams and write JSON documents to BigQuery; BigQuery's JSON type keeps nested structures queryable.")
        else:
            r = Recommendation(sid, "dataflow", "Scheduled Dataflow batch (MongoDB/Cassandra to BigQuery template)",
                               ["dataflow"], "dataflow_batch")
            r.rationale.append("Batch templates export collections to BigQuery on a schedule; documents land in a JSON column and are flattened with Dataform.")
        r.alternatives.append(_alt("datastream", "Check Datastream source support for MongoDB in your region - serverless CDC without templates."))
        r.needs_connectivity = location == "on_prem"

    elif cat == "nosql_gcp":
        r = Recommendation(sid, "dataflow", "Native export / change streams -> BigQuery",
                           ["dataflow"], "dataflow_stream" if streaming else "dataflow_batch")
        r.rationale.append("Firestore and Bigtable change streams feed Dataflow templates into BigQuery; Bigtable can also be queried in place as an external table.")
        r.alternatives.append(_alt("federated", "BigQuery external tables over Bigtable for low-volume / ad-hoc analysis."))

    # -------------------------------------------------------------- Files
    elif cat == "files_onprem":
        if initial_gb >= 100 * TB:
            chain = ["transfer_appliance", "storage_transfer", "gcs_load"]
        else:
            chain = ["storage_transfer", "gcs_load"]
        r = Recommendation(sid, "storage_transfer", "Storage Transfer Service (agent) -> Cloud Storage -> BigQuery load",
                           chain, "files_transfer")
        r.rationale.append("Storage Transfer Service agents copy new/changed files from NFS/SMB/HDFS on a schedule; event-driven BigQuery loads (or BigLake tables) make them queryable.")
        if initial_gb >= 100 * TB:
            r.rationale.append("Initial volume >= 100 TB: seed with Transfer Appliance, then switch to incremental online transfers.")
        if data_type_semi(src):
            r.rationale.append("Semi-structured files (JSON/Avro/Parquet) load natively; schema auto-detection or BigLake tables avoid custom parsers.")
        if heavy:
            r.chain.append("dataflow")
            r.engine = "files_transfer+dataflow_batch"
            r.rationale.append("Heavy transformations: a Dataflow batch job (GCS Text/Avro to BigQuery template) cleanses files on arrival.")
        r.alternatives.append(_alt("datafusion", "Low-code file pipelines with SFTP source plugin."))
        r.needs_connectivity = True

    elif cat in ("object_aws", "object_azure"):
        cloud = "S3" if cat == "object_aws" else "Azure Blob Storage"
        r = Recommendation(sid, "bq_dts", f"BigQuery Data Transfer Service ({cloud}) -> BigQuery",
                           ["bq_dts"], "dts_free")
        r.rationale.append(f"DTS has a native {cloud} connector: scheduled, incremental loads with no infrastructure (minimum interval is hourly).")
        r.alternatives.append(_alt("bq_omni", f"BigQuery Omni / BigLake to query data in place on {cloud} and avoid egress for large, rarely-used data."))
        r.alternatives.append(_alt("storage_transfer", "Storage Transfer Service to replicate files to Cloud Storage for multi-consumer data lakes."))
        r.caveats.append(f"Egress charges from {'AWS' if cat == 'object_aws' else 'Azure'} are billed by that cloud and are not included in this estimate.")
        if heavy:
            r.chain = ["storage_transfer", "gcs_load", "dataflow"]
            r.engine = "files_transfer+dataflow_batch"
            r.primary = "storage_transfer"
            r.pattern = f"{cloud} -> Storage Transfer -> Cloud Storage -> Dataflow -> BigQuery"
        if streaming:
            r.caveats.append("DTS runs at most hourly; for sub-hour freshness use event notifications -> Pub/Sub -> Dataflow.")

    elif cat == "object_gcp":
        r = Recommendation(sid, "gcs_load", "Cloud Storage -> BigQuery load jobs / BigLake tables",
                           ["gcs_load"], "dts_free")
        r.rationale.append("Data already in Cloud Storage: DTS for Cloud Storage or event-driven load jobs (free on the shared slot pool), or BigLake tables to query in place.")
        if heavy:
            r.chain.append("dataflow")
            r.engine = "dataflow_batch"

    # --------------------------------------------------------- Streaming
    elif cat == "kafka":
        r = Recommendation(sid, "dataflow", "Kafka -> Dataflow (Kafka to BigQuery template) -> BigQuery",
                           ["dataflow"], "dataflow_stream")
        r.rationale.append("The Google-provided Kafka-to-BigQuery Dataflow template consumes topics directly (Confluent/self-managed/Managed Kafka) and writes via the Storage Write API with exactly-once semantics.")
        r.alternatives.append(_alt("managed_kafka", "Migrate brokers to Managed Service for Apache Kafka and use a BigQuery sink connector on a Connect cluster."))
        r.alternatives.append(_alt("pubsub", "Pub/Sub import topic from Confluent Cloud / MSK + BigQuery subscription when no transformation is needed."))
        r.needs_connectivity = location == "on_prem"

    elif cat in ("stream_aws", "stream_azure"):
        svc = "Kinesis / MSK" if cat == "stream_aws" else "Event Hubs"
        if heavy or transform == "light":
            r = Recommendation(sid, "pubsub", f"{svc} -> Pub/Sub import topic -> Dataflow -> BigQuery",
                               ["pubsub", "dataflow"], "pubsub+dataflow_stream")
            r.rationale.append(f"Pub/Sub import topics ingest from {svc} without custom consumers; Dataflow applies transformations before BigQuery.")
        else:
            r = Recommendation(sid, "pubsub", f"{svc} -> Pub/Sub import topic -> BigQuery subscription",
                               ["pubsub"], "pubsub_bqsub")
            r.rationale.append(f"Pub/Sub import topics ingest from {svc}; a BigQuery subscription writes messages to a table with zero pipeline code.")
        r.alternatives.append(_alt("dataflow", f"Dataflow reading {svc} directly with Beam IO."))
        r.caveats.append("Cross-cloud egress from the source cloud is not included in this estimate.")

    elif cat == "events":
        if transform == "none":
            r = Recommendation(sid, "pubsub", "Pub/Sub -> BigQuery subscription (no-code streaming)",
                               ["pubsub"], "pubsub_bqsub")
            r.rationale.append("Events are published to Pub/Sub and a BigQuery subscription writes them straight into a table (schema-mapped or JSON) - lowest cost and zero ops.")
            r.alternatives.append(_alt("dataflow", "Add Dataflow when you need enrichment, windowed aggregations, deduplication or dead-letter routing."))
        else:
            r = Recommendation(sid, "pubsub", "Pub/Sub -> Dataflow streaming -> BigQuery",
                               ["pubsub", "dataflow"], "pubsub+dataflow_stream")
            r.rationale.append("Pub/Sub decouples producers; Dataflow streaming handles parsing, enrichment, windowing and exactly-once writes to BigQuery.")
            r.alternatives.append(_alt("pubsub", "Pub/Sub BigQuery subscription + Dataform/continuous queries if transformations can run after landing (ELT)."))
        if stype == "iot":
            r = _iot(r, src.get("iot_option") or "native")

    elif cat == "logs":
        r = Recommendation(sid, "log_sink", "Cloud Logging sink -> BigQuery (or Log Analytics)",
                           ["log_sink"], "log_sink")
        r.rationale.append("A log router sink with a filter streams matching entries into BigQuery tables; Log Analytics linked datasets avoid duplication.")
        r.alternatives.append(_alt("pubsub", "Sink to Pub/Sub when logs also feed SIEM or real-time alerting."))

    # -------------------------------------------------------------- SaaS
    elif cat == "saas_google":
        r = Recommendation(sid, "bq_dts", "BigQuery Data Transfer Service (Google Ads / YouTube / CM360 / Merchant Center) + GA4 native export",
                           ["bq_dts"], "dts_free")
        r.rationale.append("Google marketing sources have first-party DTS connectors with no transfer charge; GA4 exports natively to BigQuery (daily + streaming).")
        r.alternatives.append(_alt("datafusion", "Only if data must be merged with other sources in-flight."))

    elif cat == "saas_salesforce":
        r = Recommendation(sid, "bq_dts", "BigQuery Data Transfer Service (Salesforce connector) -> BigQuery",
                           ["bq_dts"], "dts_free")
        r.rationale.append("DTS provides a managed Salesforce connector for scheduled incremental object loads.")
        r.alternatives.append(_alt("datafusion", "Data Fusion Salesforce plugins (incl. streaming via PushTopic/CDC events)."))
        r.alternatives.append(_alt("app_integration", "Integration Connectors for event-driven or bidirectional flows."))
        r.caveats.append("Salesforce API call limits apply - size extract frequency against the org's daily API allowance.")
        if streaming:
            r.caveats.append("For sub-hour freshness use Salesforce Change Data Capture events -> Pub/Sub via Application Integration.")

    elif cat == "saas_other":
        if skill == "low_code" or heavy:
            r = Recommendation(sid, "datafusion", "Cloud Data Fusion SaaS plugins -> BigQuery", ["datafusion"], "datafusion")
            r.needs_datafusion = True
            r.rationale.append("Data Fusion Hub offers connectors for ServiceNow, Workday, Zendesk and others with visual mapping.")
        else:
            r = Recommendation(sid, "app_integration", "Integration Connectors / Application Integration -> BigQuery",
                               ["app_integration"], "app_integration")
            r.rationale.append("Integration Connectors expose 100+ SaaS apps as managed connections; Application Integration schedules extracts into BigQuery.")
        r.alternatives.append(_alt("cloud_run_jobs", "Custom extractor on Cloud Run jobs for APIs without a managed connector."))
        r.caveats.append("Check whether a DTS third-party connector exists for this specific SaaS - it is usually the cheapest option.")

    elif cat == "api":
        r = Recommendation(sid, "cloud_run_jobs", "Cloud Scheduler -> Cloud Run job (extractor) -> BigQuery Storage Write API",
                           ["cloud_run_jobs"], "cloud_run")
        if streaming:
            r.chain = ["cloud_run_jobs", "pubsub"]
            r.engine = "cloud_run+pubsub"
            r.pattern = "Webhook / push API -> Cloud Run service -> Pub/Sub -> BigQuery subscription"
            r.rationale.append("Push/webhook APIs land on a Cloud Run service that publishes to Pub/Sub; a BigQuery subscription persists the events.")
        else:
            r.rationale.append("A small Python/Node extractor packaged as a Cloud Run job handles auth, pagination and rate limits; scale-to-zero keeps cost near zero.")
        r.alternatives.append(_alt("app_integration", "Application Integration REST connector for no-code API pulls."))
        r.alternatives.append(_alt("datafusion", "Data Fusion HTTP plugin for low-code teams."))

    elif cat == "unstructured":
        r = Recommendation(sid, "object_tables", "Cloud Storage -> BigQuery object tables + Document AI / Gemini (BigQuery ML)",
                           ["storage_transfer", "object_tables"], "files_transfer")
        r.rationale.append("Store files in Cloud Storage, register them as BigQuery object tables and extract entities/text with ML.GENERATE_TEXT (Gemini) or Document AI remote models - all in SQL.")
        r.alternatives.append(_alt("dataflow", "Dataflow for high-volume pre-processing (OCR, transcoding) pipelines."))
        r.needs_connectivity = location == "on_prem"

    else:
        r = _batch_etl(sid, meta, skill, transform, daily_gb, freq)

    # ------------------------------------------------- cross-cutting caveats
    if one_time and r.engine not in ("dts_migration",):
        r.rationale.append("One-time migration: only the initial load is costed; ingestion services can be decommissioned afterwards.")
    if daily_gb >= TB and r.needs_connectivity:
        r.caveats.append("Sustained change volume >= 1 TB/day: size Cloud Interconnect rather than VPN.")
    return r


def data_type_semi(src):
    return src.get("data_type") == "semi_structured"


def _batch_etl(sid, meta, skill, transform, daily_gb, freq) -> Recommendation:
    """Batch ETL tool choice driven by team skill and complexity."""
    if skill == "low_code":
        r = Recommendation(sid, "datafusion", "Cloud Data Fusion batch pipeline -> BigQuery", ["datafusion"], "datafusion")
        r.needs_datafusion = True
        r.rationale.append("Team prefers low-code: Data Fusion's visual pipelines and JDBC plugins with built-in scheduling.")
        r.alternatives.append(_alt("dataflow", "Dataflow JDBC to BigQuery template - cheaper at scale with no always-on instance."))
    elif skill == "spark":
        r = Recommendation(sid, "dataproc_serverless", "Dataproc Serverless Spark (JDBC) -> BigQuery", ["dataproc_serverless"], "dataproc")
        r.rationale.append("Team has Spark skills: serverless Spark batches with the Spark-BigQuery connector, no clusters to manage.")
        r.alternatives.append(_alt("dataflow", "Dataflow JDBC template for a no-code alternative."))
    elif transform == "none" and skill == "sql":
        r = Recommendation(sid, "dataflow", "Dataflow JDBC-to-BigQuery template (ELT) + Dataform", ["dataflow"], "dataflow_batch")
        r.rationale.append("No in-flight transformation: the Google-provided JDBC to BigQuery template copies tables as-is and Dataform applies SQL transformations in BigQuery (ELT).")
        r.alternatives.append(_alt("datafusion", "Data Fusion if the team wants visual pipelines."))
    else:
        r = Recommendation(sid, "dataflow", "Dataflow batch pipeline (JDBC source) -> BigQuery", ["dataflow"], "dataflow_batch")
        r.rationale.append("Dataflow autoscaling batch jobs handle extraction and transformation with per-second billing.")
        r.alternatives.append(_alt("dataproc_serverless", "Dataproc Serverless if the logic already exists in Spark."))
        r.alternatives.append(_alt("datafusion", "Data Fusion for low-code development."))
    return r


def platform_components(sources: list[dict], recs: list[Recommendation], prefs: dict) -> dict:
    """Decide shared components: orchestration, transformation, connectivity, Data Fusion instance."""
    orch_pref = prefs.get("orchestration", "auto")
    # Pipelines that need an external scheduler; DTS, Datastream, Pub/Sub, log sinks,
    # SAP connector and Data Fusion (built-in scheduler) run on their own.
    self_running = {"datastream", "dts_free", "dts_migration", "pubsub_bqsub", "pubsub", "log_sink",
                    "sap_connector", "datafusion", "dataflow_stream", "app_integration"}
    orchestrated = [
        (s, r) for s, r in zip(sources, recs)
        if s.get("frequency") != "one_time" and not set(r.engine.split("+")) <= self_running
    ]
    n = len(orchestrated)
    heavy_count = sum(1 for s, _ in orchestrated if s.get("transform") == "heavy")

    if orch_pref == "auto":
        if n >= 3 or heavy_count >= 2:
            orchestration = "composer"
            orch_why = f"{n} scheduled pipelines with cross-source dependencies: Airflow gives one place for scheduling, retries, SLAs and lineage."
        elif n >= 1:
            orchestration = "workflows"
            orch_why = f"{n} scheduled pipeline(s): Workflows + Cloud Scheduler orchestrate them at near-zero cost; Dataform schedules the ELT."
        else:
            orchestration = "none"
            orch_why = "All sources are continuous (CDC/streaming) or self-scheduling (DTS, Data Fusion) - Dataform workflow schedules cover the ELT, no orchestrator required."
    else:
        orchestration = orch_pref
        orch_why = "Selected by the architect."

    connectivity = None
    on_prem_gb_day = sum(float(s.get("daily_change_gb") or 0) for s, r in zip(sources, recs) if r.needs_connectivity)
    if any(r.needs_connectivity for r in recs):
        connectivity = "interconnect" if on_prem_gb_day >= TB else "ha_vpn"

    df_edition = None
    if any(r.needs_datafusion for r in recs):
        sap = any(SOURCE_BY_ID.get(s.get("type"), {}).get("category") == "sap" for s in sources)
        df_edition = "enterprise" if (sap or prefs.get("environment") == "production_ha") else "basic"

    return {
        "transformation": {"tool": "dataform", "why": "ELT inside BigQuery with SQL, version control, tests (assertions) and scheduling - no extra licence cost."},
        "orchestration": {"tool": orchestration, "why": orch_why},
        "connectivity": connectivity,
        "connectivity_gb_day": on_prem_gb_day,
        "datafusion_edition": df_edition,
        "governance": ["Knowledge Catalog (Dataplex) for lineage, data quality and discovery", "Cloud KMS CMEK", "VPC Service Controls", "BigQuery column-level security & data masking"],
    }


def platform_story(L: dict, sources: list[dict]) -> list[dict]:
    """Narrative for the agentic data cloud layer built on top of BigQuery.

    Returns ordered blocks: {key, title, tools, points}. Used by the UI and the proposal export.
    """
    blocks = []
    cdc = [s.get("name") or s.get("type") for s in sources
           if SOURCE_BY_ID.get(s.get("type"), {}).get("cdc") and s.get("frequency") in STREAMING_FREQS]

    blocks.append({
        "key": "lakehouse", "title": "BigQuery lakehouse foundation",
        "tools": ["dataform", "bqml", "reverse_etl"],
        "points": [
            "Raw, curated and mart datasets in BigQuery; open Apache Iceberg tables through BigLake keep data portable across engines.",
            ("Continuous CDC from " + ", ".join(cdc[:4]) + " keeps operational data fresh for analytics and agents."
             if cdc else "Add CDC sources (Datastream) when agents and dashboards need minute-level freshness."),
            "Dataform builds tested, version-controlled SQL models; BigQuery ML and AI functions bring Gemini and vector search into SQL.",
            "Reverse ETL syncs curated results back to AlloyDB or Spanner for applications and agent tools.",
        ],
    })
    bi = L["bi"]
    if bi["enabled"]:
        if bi["tool"] == "looker":
            pts = ["Looker connects live to BigQuery (no extracts); LookML and BigQuery measures form one governed semantic layer.",
                   "The same semantic model feeds Looker dashboards, Looker Studio, Sheets, and Conversational Analytics, so numbers match everywhere.",
                   "Licensing is quote-based - enter the customer's annual quote in the settings to include it."]
        elif bi["tool"] == "looker_studio_pro":
            pts = ["Looker Studio Pro dashboards on BigQuery with team workspaces and governance.",
                   "Upgrade path to Looker when a governed semantic layer is needed."]
        else:
            pts = ["Looker Studio dashboards on BigQuery at no licence cost.", "Upgrade to Looker for a governed semantic layer."]
        blocks.append({"key": "bi", "title": "Business intelligence", "tools": ["looker" if bi["tool"] == "looker" else "looker_studio"], "points": pts})

    ai_tools, ai_pts = [], []
    if L["agents"]["enabled"]:
        ai_tools += ["agent_platform", "conversational_analytics"]
        ai_pts += [
            "Agents built with the Agent Development Kit run on Agent Engine (managed sessions and Memory Bank) and call Gemini models.",
            "BigQuery is exposed to agents through MCP / BigQuery tools, with every query running under the end-user's IAM, policy tags and masking.",
            "Conversational Analytics and BigQuery data agents answer business questions in natural language with traceable SQL.",
        ]
    if L["gemini_enterprise"]["enabled"]:
        ai_tools.append("gemini_enterprise")
        ai_pts.append(f"Gemini Enterprise ({L['gemini_enterprise']['edition'].title()}) puts these agents, Deep Research and grounded search in front of {int(L['gemini_enterprise']['users'])} employees.")
    if L["gpu"]["enabled"]:
        ai_tools.append("gpu_endpoints")
        ai_pts.append(f"Custom or open models (Model Garden, vLLM) are served on Vertex AI endpoints with {int(L['gpu']['replicas'])} x {L['gpu']['gpu'].upper()} replica(s); BigQuery calls them as remote models for batch scoring.")
    if ai_tools:
        blocks.append({"key": "ai", "title": "Agentic AI on BigQuery", "tools": ai_tools, "points": ai_pts})

    if L["governance"]["enabled"]:
        blocks.append({
            "key": "governance", "title": "Governance with Knowledge Catalog (Dataplex)",
            "tools": ["knowledge_catalog"],
            "points": [
                "Automatic discovery and technical metadata for every BigQuery, Cloud Storage and AlloyDB / Spanner / Cloud SQL asset.",
                "End-to-end lineage from Datastream / Dataflow / Dataform jobs to Looker dashboards and agent answers.",
                f"Data profiling and quality scans on about {int(L['governance']['dq_share_pct'])}% of tables, published as quality scores in the catalog.",
                "Business glossary and semantic search give agents the business context they need to answer correctly.",
            ],
        })
    if L["security"]["enabled"]:
        tools = ["fine_grained", "vpc_sc", "scc"]
        pts = ["Column-level policy tags, row access policies and dynamic data masking apply equally to SQL, Looker and agents.",
               "VPC Service Controls perimeter around ingestion, BigQuery and Vertex AI projects; Private Service Connect for endpoints.",
               "Security Command Center for posture management and threat detection, including AI workloads."]
        if L["security"].get("cmek"):
            tools.insert(0, "cmek")
            pts.insert(0, "Customer-managed encryption keys (Cloud KMS, optionally Cloud EKM) across BigQuery, Cloud Storage, Pub/Sub, Datastream and Vertex AI - relevant for data-residency regulations such as KSA PDPL / NCA ECC.")
        if L["security"].get("sdp_discovery"):
            tools.insert(0, "sdp")
            pts.insert(0, "Sensitive Data Protection profiles every BigQuery table, classifies PII and can auto-apply policy tags.")
        blocks.append({"key": "security", "title": "Security & compliance", "tools": tools, "points": pts})
    return blocks
