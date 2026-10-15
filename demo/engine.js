/* In-browser port of app/recommender.py + app/estimator.py for the static demo.
 *
 * Data (catalog, pricing, regions, assumptions, samples) is injected by
 * demo/build_demo.py as window.ADVISOR_DATA, generated from the Python sources,
 * so only the logic lives here. tests/test_demo_parity.py runs this file under
 * Node against every sample and compares it with the Python engine.
 */
(function (root) {
  "use strict";
  const D = root.ADVISOR_DATA;
  const SOURCE_BY_ID = Object.fromEntries(D.catalog.source_types.map((s) => [s.id, s]));
  const STREAMING = new Set(["realtime", "near_realtime"]);
  const DATASTREAM_NATIVE = new Set(["oracle", "sqlserver", "mysql", "postgresql", "cloudsql", "alloydb", "spanner"]);
  const TB = 1024, GIB_PER_TIB = 1024, HOURS = 730;
  const A = D.assumptions;
  const CDC_CATEGORIES = new Set(D.cdc_categories);
  const RUNS = Object.fromEntries(D.catalog.frequencies.map((f) => [f.id, f.runs_per_month]));

  const titleCase = (s) => s.replace(/_/g, " ").replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  const num = (v) => Number(v || 0);

  function Rec(sid, primary, pattern, chain, engine) {
    return { source_id: sid, primary, pattern, chain: chain.slice(), engine, rationale: [], alternatives: [], caveats: [], needs_connectivity: false, needs_datafusion: false };
  }
  const alt = (tool, why) => ({ tool, why });

  // ------------------------------------------------------------------ recommender
  function recommend(src, prefs) {
    prefs = prefs || {};
    const skill = prefs.skill || "sql";
    const stype = src.type;
    const meta = SOURCE_BY_ID[stype] || { category: "api", name: stype };
    const cat = meta.category;
    const freq = src.frequency || "daily";
    const transform = src.transform || "none";
    const location = src.location || "on_prem";
    const dailyGb = num(src.daily_change_gb);
    const initialGb = num(src.initial_volume_gb);
    const streaming = STREAMING.has(freq);
    const oneTime = freq === "one_time";
    const heavy = transform === "heavy";
    const sid = src.id !== undefined ? src.id : stype;
    let r;

    if (cat === "rdbms" || cat === "rdbms_gcp") {
      if (DATASTREAM_NATIVE.has(stype) && (streaming || freq === "hourly" || !heavy)) {
        if (heavy) {
          r = Rec(sid, "datastream", "CDC via Datastream -> GCS -> Dataflow -> BigQuery", ["datastream", "gcs_load", "dataflow"], "datastream+dataflow_stream");
          r.rationale.push("Heavy in-flight transformation requested, so Datastream lands change files in Cloud Storage and the Google-provided 'Datastream to BigQuery' Dataflow template applies the logic before merge.");
        } else {
          r = Rec(sid, "datastream", "Change Data Capture via Datastream -> BigQuery", ["datastream"], "datastream");
          r.rationale.push(`${meta.name} is a native Datastream source: log-based CDC replicates inserts/updates/deletes into BigQuery with seconds-to-minutes latency and no infrastructure to manage.`);
          r.rationale.push("Backfill of existing tables is included, so the same stream handles the initial load and ongoing changes.");
          if (!streaming) r.rationale.push("Even for hourly/daily needs, CDC avoids heavy full-table extracts on the source and keeps BigQuery continuously fresh; set the BigQuery staleness ('max_staleness') to control merge cost.");
        }
        r.alternatives.push(alt("dataflow", "JDBC to BigQuery template for scheduled batch extracts when CDC/supplemental logging cannot be enabled on the source."));
        if (cat === "rdbms_gcp") r.alternatives.push(alt("federated", "EXTERNAL_QUERY + scheduled queries for small tables / reference data - zero pipeline."));
        r.alternatives.push(alt("datafusion", "Low-code alternative with replication and batch plugins if the team prefers visual ETL."));
        if (stype === "oracle") r.caveats.push("Oracle CDC uses LogMiner (or binary log reader): requires ARCHIVELOG mode and supplemental logging; check DBA approval early.");
        if (stype === "sqlserver") r.caveats.push("SQL Server CDC requires either CDC tables or transaction-log reads to be enabled on the source.");
        if (stype === "postgresql") r.caveats.push("PostgreSQL requires logical replication (pgoutput) and a replication slot/publication.");
      } else {
        r = batchEtl(sid, meta, skill, transform);
        r.rationale.unshift(`${titleCase(freq)} batch extracts with transformation '${transform}' - a scheduled JDBC pipeline is simpler than continuous CDC here.`);
        if (DATASTREAM_NATIVE.has(stype)) r.alternatives.unshift(alt("datastream", "Switch to CDC if near real-time freshness or reduced source load becomes a requirement."));
      }
      r.needs_connectivity = !["gcp", "saas"].includes(location) && cat !== "rdbms_gcp";
    } else if (cat === "rdbms_nocdc") {
      r = batchEtl(sid, meta, skill, transform);
      r.rationale.unshift(`${meta.name} is not a native Datastream source, so ingestion uses JDBC-based pipelines.`);
      if (streaming) {
        r.caveats.push("True real-time CDC for this database needs a third-party log reader (e.g. IBM IIDR, Debezium on Kafka) feeding Pub/Sub or Kafka; consider micro-batches every few minutes instead.");
        r.alternatives.unshift(alt("managed_kafka", "Debezium/IIDR -> Managed Kafka -> BigQuery sink for real-time CDC."));
      }
      r.needs_connectivity = !["gcp", "saas"].includes(location);
    } else if (cat === "dwh") {
      if (["teradata", "redshift", "snowflake"].includes(stype)) {
        r = Rec(sid, "bq_dts", "Warehouse migration: BigQuery Migration Service + Data Transfer Service", ["bq_migration", "bq_dts"], "dts_migration");
        r.rationale.push(`BigQuery Data Transfer Service has a managed ${meta.name} migration connector (schema + data, incremental runs supported), and BigQuery Migration Service translates SQL/ETL code and validates results.`);
      } else {
        r = Rec(sid, "bq_migration", "Export -> Cloud Storage -> BigQuery load + SQL translation", ["bq_migration", "storage_transfer", "gcs_load"], "files_transfer");
        r.rationale.push(`No direct DTS connector for ${meta.name}: export tables to files (Parquet/CSV), move them with Storage Transfer Service, load to BigQuery; Migration Service translates the SQL.`);
      }
      r.rationale.push("Run an assessment first (BigQuery Migration Assessment) to size slots and plan waves.");
      r.alternatives.push(alt("dataflow", "JDBC to BigQuery template for selective tables or continuous sync during parallel run."));
      if (initialGb >= 100 * TB) r.alternatives.push(alt("transfer_appliance", "Initial volume >= 100 TB - consider an offline appliance if bandwidth is limited."));
      r.caveats.push("Plan a parallel-run period; ongoing incremental sync until cut-over drives most of the run cost.");
      r.needs_connectivity = location === "on_prem";
    } else if (cat === "hadoop") {
      if (skill === "spark" || skill === "code") {
        r = Rec(sid, "dataproc_serverless", "HDFS -> Cloud Storage, Spark jobs on Dataproc Serverless -> BigQuery / BigLake", ["storage_transfer", "dataproc_serverless"], "dataproc");
        r.rationale.push("Existing Spark/Hive code ports to Dataproc Serverless with minimal change; data lands in Cloud Storage and is exposed through BigLake or loaded to BigQuery.");
      } else {
        r = Rec(sid, "storage_transfer", "HDFS -> Cloud Storage -> BigLake / BigQuery load + Dataform", ["storage_transfer", "gcs_load"], "files_transfer");
        r.rationale.push("Move Hive/HDFS data to Cloud Storage (Storage Transfer Service supports HDFS), expose as BigLake Iceberg/Parquet tables, and rewrite HiveQL as BigQuery SQL with Migration Service.");
      }
      r.alternatives.push(alt("bq_migration", "Translate HiveQL / Spark SQL to BigQuery SQL automatically."));
      r.needs_connectivity = location === "on_prem";
    } else if (cat === "sap") {
      if (streaming || freq === "hourly") {
        r = Rec(sid, "sap_connector", "SAP SLT -> BigQuery Connector for SAP -> BigQuery (+ Cortex Framework)", ["sap_connector"], "sap_connector");
        r.rationale.push("BigQuery Connector for SAP plugs into SAP Landscape Transformation (SLT) and streams table changes into BigQuery in near real-time.");
        r.rationale.push("Google Cloud Cortex Framework provides ready data models (OTC, P2P, finance) on top of the replicated tables.");
        r.alternatives.push(alt("datafusion", "Data Fusion SAP plugins (Table Batch Source, ODP/BW extractors) when SLT is not licensed."));
      } else {
        r = Rec(sid, "datafusion", "SAP extractors / ODP via Cloud Data Fusion -> BigQuery", ["datafusion"], "datafusion");
        r.needs_datafusion = true;
        r.rationale.push("Cloud Data Fusion's SAP connectors (ODP, BW Open Hub, SLT, table batch) handle scheduled extracts with low-code pipelines.");
        r.alternatives.push(alt("sap_connector", "BigQuery Connector for SAP if SLT is available and fresher data is needed."));
      }
      r.caveats.push("Confirm SAP licensing (SLT / ODP / runtime licence) - indirect access rules can apply.");
      r.needs_connectivity = location === "on_prem";
    } else if (cat === "mainframe") {
      r = Rec(sid, "mainframe_connector", "Mainframe Connector -> Cloud Storage (ORC) -> BigQuery", ["mainframe_connector", "gcs_load"], "files_transfer");
      r.rationale.push("Mainframe Connector runs as a JCL step, transcodes EBCDIC/COBOL copybook data to ORC and loads to BigQuery - no custom parsing.");
      r.alternatives.push(alt("datafusion", "Data Fusion mainframe/COBOL plugins for low-code parsing."));
      r.alternatives.push(alt("dataflow", "Dataflow with copybook parsing for complex record layouts."));
      if (streaming) r.caveats.push("Real-time mainframe CDC requires a partner log reader (e.g. Precisely, IBM IIDR) into Pub/Sub/Kafka.");
      r.needs_connectivity = true;
    } else if (cat === "nosql") {
      if (streaming) {
        r = Rec(sid, "dataflow", "Change streams via Dataflow (MongoDB/Cassandra template) -> BigQuery", ["dataflow"], "dataflow_stream");
        r.rationale.push("Dataflow's Google-provided MongoDB-to-BigQuery (CDC) templates read change streams and write JSON documents to BigQuery; BigQuery's JSON type keeps nested structures queryable.");
      } else {
        r = Rec(sid, "dataflow", "Scheduled Dataflow batch (MongoDB/Cassandra to BigQuery template)", ["dataflow"], "dataflow_batch");
        r.rationale.push("Batch templates export collections to BigQuery on a schedule; documents land in a JSON column and are flattened with Dataform.");
      }
      r.alternatives.push(alt("datastream", "Check Datastream source support for MongoDB in your region - serverless CDC without templates."));
      r.needs_connectivity = location === "on_prem";
    } else if (cat === "nosql_gcp") {
      r = Rec(sid, "dataflow", "Native export / change streams -> BigQuery", ["dataflow"], streaming ? "dataflow_stream" : "dataflow_batch");
      r.rationale.push("Firestore and Bigtable change streams feed Dataflow templates into BigQuery; Bigtable can also be queried in place as an external table.");
      r.alternatives.push(alt("federated", "BigQuery external tables over Bigtable for low-volume / ad-hoc analysis."));
    } else if (cat === "files_onprem") {
      const chain = initialGb >= 100 * TB ? ["transfer_appliance", "storage_transfer", "gcs_load"] : ["storage_transfer", "gcs_load"];
      r = Rec(sid, "storage_transfer", "Storage Transfer Service (agent) -> Cloud Storage -> BigQuery load", chain, "files_transfer");
      r.rationale.push("Storage Transfer Service agents copy new/changed files from NFS/SMB/HDFS on a schedule; event-driven BigQuery loads (or BigLake tables) make them queryable.");
      if (initialGb >= 100 * TB) r.rationale.push("Initial volume >= 100 TB: seed with Transfer Appliance, then switch to incremental online transfers.");
      if (src.data_type === "semi_structured") r.rationale.push("Semi-structured files (JSON/Avro/Parquet) load natively; schema auto-detection or BigLake tables avoid custom parsers.");
      if (heavy) {
        r.chain.push("dataflow");
        r.engine = "files_transfer+dataflow_batch";
        r.rationale.push("Heavy transformations: a Dataflow batch job (GCS Text/Avro to BigQuery template) cleanses files on arrival.");
      }
      r.alternatives.push(alt("datafusion", "Low-code file pipelines with SFTP source plugin."));
      r.needs_connectivity = true;
    } else if (cat === "object_aws" || cat === "object_azure") {
      const cloud = cat === "object_aws" ? "S3" : "Azure Blob Storage";
      r = Rec(sid, "bq_dts", `BigQuery Data Transfer Service (${cloud}) -> BigQuery`, ["bq_dts"], "dts_free");
      r.rationale.push(`DTS has a native ${cloud} connector: scheduled, incremental loads with no infrastructure (minimum interval is hourly).`);
      r.alternatives.push(alt("bq_omni", `BigQuery Omni / BigLake to query data in place on ${cloud} and avoid egress for large, rarely-used data.`));
      r.alternatives.push(alt("storage_transfer", "Storage Transfer Service to replicate files to Cloud Storage for multi-consumer data lakes."));
      r.caveats.push(`Egress charges from ${cat === "object_aws" ? "AWS" : "Azure"} are billed by that cloud and are not included in this estimate.`);
      if (heavy) {
        r.chain = ["storage_transfer", "gcs_load", "dataflow"];
        r.engine = "files_transfer+dataflow_batch";
        r.primary = "storage_transfer";
        r.pattern = `${cloud} -> Storage Transfer -> Cloud Storage -> Dataflow -> BigQuery`;
      }
      if (streaming) r.caveats.push("DTS runs at most hourly; for sub-hour freshness use event notifications -> Pub/Sub -> Dataflow.");
    } else if (cat === "object_gcp") {
      r = Rec(sid, "gcs_load", "Cloud Storage -> BigQuery load jobs / BigLake tables", ["gcs_load"], "dts_free");
      r.rationale.push("Data already in Cloud Storage: DTS for Cloud Storage or event-driven load jobs (free on the shared slot pool), or BigLake tables to query in place.");
      if (heavy) { r.chain.push("dataflow"); r.engine = "dataflow_batch"; }
    } else if (cat === "kafka") {
      r = Rec(sid, "dataflow", "Kafka -> Dataflow (Kafka to BigQuery template) -> BigQuery", ["dataflow"], "dataflow_stream");
      r.rationale.push("The Google-provided Kafka-to-BigQuery Dataflow template consumes topics directly (Confluent/self-managed/Managed Kafka) and writes via the Storage Write API with exactly-once semantics.");
      r.alternatives.push(alt("managed_kafka", "Migrate brokers to Managed Service for Apache Kafka and use a BigQuery sink connector on a Connect cluster."));
      r.alternatives.push(alt("pubsub", "Pub/Sub import topic from Confluent Cloud / MSK + BigQuery subscription when no transformation is needed."));
      r.needs_connectivity = location === "on_prem";
    } else if (cat === "stream_aws" || cat === "stream_azure") {
      const svc = cat === "stream_aws" ? "Kinesis / MSK" : "Event Hubs";
      if (heavy || transform === "light") {
        r = Rec(sid, "pubsub", `${svc} -> Pub/Sub import topic -> Dataflow -> BigQuery`, ["pubsub", "dataflow"], "pubsub+dataflow_stream");
        r.rationale.push(`Pub/Sub import topics ingest from ${svc} without custom consumers; Dataflow applies transformations before BigQuery.`);
      } else {
        r = Rec(sid, "pubsub", `${svc} -> Pub/Sub import topic -> BigQuery subscription`, ["pubsub"], "pubsub_bqsub");
        r.rationale.push(`Pub/Sub import topics ingest from ${svc}; a BigQuery subscription writes messages to a table with zero pipeline code.`);
      }
      r.alternatives.push(alt("dataflow", `Dataflow reading ${svc} directly with Beam IO.`));
      r.caveats.push("Cross-cloud egress from the source cloud is not included in this estimate.");
    } else if (cat === "events") {
      if (transform === "none") {
        r = Rec(sid, "pubsub", "Pub/Sub -> BigQuery subscription (no-code streaming)", ["pubsub"], "pubsub_bqsub");
        r.rationale.push("Events are published to Pub/Sub and a BigQuery subscription writes them straight into a table (schema-mapped or JSON) - lowest cost and zero ops.");
        r.alternatives.push(alt("dataflow", "Add Dataflow when you need enrichment, windowed aggregations, deduplication or dead-letter routing."));
      } else {
        r = Rec(sid, "pubsub", "Pub/Sub -> Dataflow streaming -> BigQuery", ["pubsub", "dataflow"], "pubsub+dataflow_stream");
        r.rationale.push("Pub/Sub decouples producers; Dataflow streaming handles parsing, enrichment, windowing and exactly-once writes to BigQuery.");
        r.alternatives.push(alt("pubsub", "Pub/Sub BigQuery subscription + Dataform/continuous queries if transformations can run after landing (ELT)."));
      }
      if (stype === "iot") r.caveats.push("IoT Core is retired: devices publish via MQTT broker partners or HTTPS to Pub/Sub.");
    } else if (cat === "logs") {
      r = Rec(sid, "log_sink", "Cloud Logging sink -> BigQuery (or Log Analytics)", ["log_sink"], "log_sink");
      r.rationale.push("A log router sink with a filter streams matching entries into BigQuery tables; Log Analytics linked datasets avoid duplication.");
      r.alternatives.push(alt("pubsub", "Sink to Pub/Sub when logs also feed SIEM or real-time alerting."));
    } else if (cat === "saas_google") {
      r = Rec(sid, "bq_dts", "BigQuery Data Transfer Service (Google Ads / YouTube / CM360 / Merchant Center) + GA4 native export", ["bq_dts"], "dts_free");
      r.rationale.push("Google marketing sources have first-party DTS connectors with no transfer charge; GA4 exports natively to BigQuery (daily + streaming).");
      r.alternatives.push(alt("datafusion", "Only if data must be merged with other sources in-flight."));
    } else if (cat === "saas_salesforce") {
      r = Rec(sid, "bq_dts", "BigQuery Data Transfer Service (Salesforce connector) -> BigQuery", ["bq_dts"], "dts_free");
      r.rationale.push("DTS provides a managed Salesforce connector for scheduled incremental object loads.");
      r.alternatives.push(alt("datafusion", "Data Fusion Salesforce plugins (incl. streaming via PushTopic/CDC events)."));
      r.alternatives.push(alt("app_integration", "Integration Connectors for event-driven or bidirectional flows."));
      r.caveats.push("Salesforce API call limits apply - size extract frequency against the org's daily API allowance.");
      if (streaming) r.caveats.push("For sub-hour freshness use Salesforce Change Data Capture events -> Pub/Sub via Application Integration.");
    } else if (cat === "saas_other") {
      if (skill === "low_code" || heavy) {
        r = Rec(sid, "datafusion", "Cloud Data Fusion SaaS plugins -> BigQuery", ["datafusion"], "datafusion");
        r.needs_datafusion = true;
        r.rationale.push("Data Fusion Hub offers connectors for ServiceNow, Workday, Zendesk and others with visual mapping.");
      } else {
        r = Rec(sid, "app_integration", "Integration Connectors / Application Integration -> BigQuery", ["app_integration"], "app_integration");
        r.rationale.push("Integration Connectors expose 100+ SaaS apps as managed connections; Application Integration schedules extracts into BigQuery.");
      }
      r.alternatives.push(alt("cloud_run_jobs", "Custom extractor on Cloud Run jobs for APIs without a managed connector."));
      r.caveats.push("Check whether a DTS third-party connector exists for this specific SaaS - it is usually the cheapest option.");
    } else if (cat === "api") {
      r = Rec(sid, "cloud_run_jobs", "Cloud Scheduler -> Cloud Run job (extractor) -> BigQuery Storage Write API", ["cloud_run_jobs"], "cloud_run");
      if (streaming) {
        r.chain = ["cloud_run_jobs", "pubsub"];
        r.engine = "cloud_run+pubsub";
        r.pattern = "Webhook / push API -> Cloud Run service -> Pub/Sub -> BigQuery subscription";
        r.rationale.push("Push/webhook APIs land on a Cloud Run service that publishes to Pub/Sub; a BigQuery subscription persists the events.");
      } else {
        r.rationale.push("A small Python/Node extractor packaged as a Cloud Run job handles auth, pagination and rate limits; scale-to-zero keeps cost near zero.");
      }
      r.alternatives.push(alt("app_integration", "Application Integration REST connector for no-code API pulls."));
      r.alternatives.push(alt("datafusion", "Data Fusion HTTP plugin for low-code teams."));
    } else if (cat === "unstructured") {
      r = Rec(sid, "object_tables", "Cloud Storage -> BigQuery object tables + Document AI / Gemini (BigQuery ML)", ["storage_transfer", "object_tables"], "files_transfer");
      r.rationale.push("Store files in Cloud Storage, register them as BigQuery object tables and extract entities/text with ML.GENERATE_TEXT (Gemini) or Document AI remote models - all in SQL.");
      r.alternatives.push(alt("dataflow", "Dataflow for high-volume pre-processing (OCR, transcoding) pipelines."));
      r.needs_connectivity = location === "on_prem";
    } else {
      r = batchEtl(sid, meta, skill, transform);
    }

    if (oneTime && r.engine !== "dts_migration") r.rationale.push("One-time migration: only the initial load is costed; ingestion services can be decommissioned afterwards.");
    if (dailyGb >= TB && r.needs_connectivity) r.caveats.push("Sustained change volume >= 1 TB/day: size Cloud Interconnect rather than VPN.");
    return r;
  }

  function batchEtl(sid, meta, skill, transform) {
    let r;
    if (skill === "low_code") {
      r = Rec(sid, "datafusion", "Cloud Data Fusion batch pipeline -> BigQuery", ["datafusion"], "datafusion");
      r.needs_datafusion = true;
      r.rationale.push("Team prefers low-code: Data Fusion's visual pipelines and JDBC plugins with built-in scheduling.");
      r.alternatives.push(alt("dataflow", "Dataflow JDBC to BigQuery template - cheaper at scale with no always-on instance."));
    } else if (skill === "spark") {
      r = Rec(sid, "dataproc_serverless", "Dataproc Serverless Spark (JDBC) -> BigQuery", ["dataproc_serverless"], "dataproc");
      r.rationale.push("Team has Spark skills: serverless Spark batches with the Spark-BigQuery connector, no clusters to manage.");
      r.alternatives.push(alt("dataflow", "Dataflow JDBC template for a no-code alternative."));
    } else if (transform === "none" && skill === "sql") {
      r = Rec(sid, "dataflow", "Dataflow JDBC-to-BigQuery template (ELT) + Dataform", ["dataflow"], "dataflow_batch");
      r.rationale.push("No in-flight transformation: the Google-provided JDBC to BigQuery template copies tables as-is and Dataform applies SQL transformations in BigQuery (ELT).");
      r.alternatives.push(alt("datafusion", "Data Fusion if the team wants visual pipelines."));
    } else {
      r = Rec(sid, "dataflow", "Dataflow batch pipeline (JDBC source) -> BigQuery", ["dataflow"], "dataflow_batch");
      r.rationale.push("Dataflow autoscaling batch jobs handle extraction and transformation with per-second billing.");
      r.alternatives.push(alt("dataproc_serverless", "Dataproc Serverless if the logic already exists in Spark."));
      r.alternatives.push(alt("datafusion", "Data Fusion for low-code development."));
    }
    return r;
  }

  function platformComponents(sources, recs, prefs) {
    const orchPref = prefs.orchestration || "auto";
    const selfRunning = new Set(["datastream", "dts_free", "dts_migration", "pubsub_bqsub", "pubsub", "log_sink", "sap_connector", "datafusion", "dataflow_stream", "app_integration"]);
    const orchestrated = sources.map((s, i) => [s, recs[i]]).filter(([s, r]) => s.frequency !== "one_time" && !r.engine.split("+").every((e) => selfRunning.has(e)));
    const n = orchestrated.length;
    const heavyCount = orchestrated.filter(([s]) => s.transform === "heavy").length;
    let orchestration, why;
    if (orchPref === "auto") {
      if (n >= 3 || heavyCount >= 2) { orchestration = "composer"; why = `${n} scheduled pipelines with cross-source dependencies: Airflow gives one place for scheduling, retries, SLAs and lineage.`; }
      else if (n >= 1) { orchestration = "workflows"; why = `${n} scheduled pipeline(s): Workflows + Cloud Scheduler orchestrate them at near-zero cost; Dataform schedules the ELT.`; }
      else { orchestration = "none"; why = "All sources are continuous (CDC/streaming) or self-scheduling (DTS, Data Fusion) - Dataform workflow schedules cover the ELT, no orchestrator required."; }
    } else { orchestration = orchPref; why = "Selected by the architect."; }
    let connectivity = null;
    const onPremGbDay = sources.reduce((a, s, i) => a + (recs[i].needs_connectivity ? num(s.daily_change_gb) : 0), 0);
    if (recs.some((r) => r.needs_connectivity)) connectivity = onPremGbDay >= TB ? "interconnect" : "ha_vpn";
    let dfEdition = null;
    if (recs.some((r) => r.needs_datafusion)) {
      const sap = sources.some((s) => (SOURCE_BY_ID[s.type] || {}).category === "sap");
      dfEdition = sap || prefs.environment === "production_ha" ? "enterprise" : "basic";
    }
    return {
      transformation: { tool: "dataform", why: "ELT inside BigQuery with SQL, version control, tests (assertions) and scheduling - no extra licence cost." },
      orchestration: { tool: orchestration, why },
      connectivity,
      connectivity_gb_day: onPremGbDay,
      datafusion_edition: dfEdition,
      governance: ["Knowledge Catalog (Dataplex) for lineage, data quality and discovery", "Cloud KMS CMEK", "VPC Service Controls", "BigQuery column-level security & data masking"],
    };
  }

  // ------------------------------------------------------------------ components (port of app/components.py)
  const COMPONENT_BY_ID = Object.fromEntries(D.catalog.components.map((c) => [c.id, c]));
  const componentDefaults = (t) => Object.fromEntries(((COMPONENT_BY_ID[t] || {}).settings || []).map((f) => [f.key, f.default]));

  function legacyToComponents(p) {
    const comps = [];
    let i = 0;
    const push = (type, settings) => comps.push({ id: `c${++i}`, type, settings });
    const strip = (o) => { const c = { ...(o || {}) }; delete c.enabled; return c; };
    const bi = p.bi || {};
    if (bi.enabled !== false) {
      const tool = bi.tool || "looker";
      const s = { users: bi.users !== undefined ? bi.users : 50 };
      if (tool === "looker") s.annual_quote_usd = bi.looker_annual_usd !== undefined ? bi.looker_annual_usd : 0;
      push(tool, s);
    }
    if ((p.agents || {}).enabled !== false) push("agent_platform", strip(p.agents));
    if ((p.gemini_enterprise || {}).enabled !== false) push("gemini_enterprise", strip(p.gemini_enterprise));
    if ((p.gpu || {}).enabled === true) push("vertex_gpu", strip(p.gpu));
    if ((p.governance || {}).enabled !== false) push("knowledge_catalog", strip(p.governance));
    return { comps, sec: { ...D.catalog.default_security, ...(p.security || {}) } };
  }

  const SECURITY_TYPES = D.catalog.components.filter((c) => c.category === "security").map((c) => c.id);
  function securityComponents(sec, startIndex = 100) {
    if (sec.enabled === false) return [];
    const out = [];
    let i = startIndex;
    for (const [flag, type] of [["sdp_discovery", "sdp"], ["cmek", "cmek"], ["vpc_sc", "vpc_sc"]]) if (sec[flag] !== false) out.push({ id: `c${++i}`, type, settings: {} });
    for (const type of ["policy_tags", "scc"]) out.push({ id: `c${++i}`, type, settings: {} });
    return out;
  }

  function normalizedComponents(scenario) {
    let comps;
    if (scenario.components !== undefined && scenario.components !== null) {
      comps = [...scenario.components];
      const hasSec = comps.some((c) => (COMPONENT_BY_ID[c.type] || {}).category === "security");
      if (scenario.security !== undefined && scenario.security !== null && !hasSec) comps = comps.concat(securityComponents({ ...D.catalog.default_security, ...scenario.security }));
    } else if (scenario.platform) {
      const lg = legacyToComponents(scenario.platform);
      comps = lg.comps.concat(securityComponents(lg.sec));
    } else {
      comps = D.catalog.default_components.map((c) => ({ ...c }));
    }
    const out = [];
    for (const c of comps) {
      if (!COMPONENT_BY_ID[c.type]) continue;
      const settings = componentDefaults(c.type);
      for (const [k, v] of Object.entries(c.settings || {})) if (v !== null && v !== undefined) settings[k] = v;
      out.push({ id: c.id || c.type, type: c.type, settings, start_month: Math.trunc(num(c.start_month) || 1), included: c.included !== false });
    }
    const types = new Set(out.map((c) => c.type));
    const sec = { enabled: [...types].some((t) => SECURITY_TYPES.includes(t)), sdp_discovery: types.has("sdp"), cmek: types.has("cmek"), vpc_sc: types.has("vpc_sc") };
    return { comps: out, sec };
  }

  function tieredM(qty, tiers) {
    let cost = 0, prev = 0;
    for (const [limit, price] of tiers) {
      const top = limit === null ? qty : Math.min(qty, limit);
      if (top > prev) { cost += (top - prev) * price; prev = top; }
      if (limit !== null && qty <= limit) break;
    }
    return cost;
  }

  function costComponents(comps, sec, pricing, up, sources, newBy, bqModel, add, curated, setRegion, home) {
    const tables = sources.reduce((a, s) => a + Math.trunc(num(s.tables) || 50), 0) * (1 + curated * 3);
    for (let m = 1; m <= 36; m++) {
      for (const c of comps) {
        const t = c.type, s = c.settings;
        if (m < Math.trunc(num(c.start_month) || 1) || c.included === false) continue;
        setRegion(s.region || home);
        if (t === "looker") add(m, "Looker licence (customer quote)", "_ai", num(s.annual_quote_usd) / 12);
        else if (t === "looker_studio_pro") add(m, "Looker Studio Pro", "_ai", num(s.users) * pricing.looker.studio_pro_user_month);
        else if (t === "gemini_enterprise") add(m, "Gemini Enterprise", "_ai", num(s.users) * pricing.gemini_enterprise[`${s.edition}_user_month`]);
        else if (t === "agent_platform") {
          const req = num(s.requests_month), ae = pricing.agent_engine;
          const vcpuH = Math.max(0, (req * num(s.agent_seconds)) / 3600 - ae.free_vcpu_hr);
          const gibH = Math.max(0, (req * num(s.agent_seconds) * 2) / 3600 - ae.free_gib_hr);
          const u = up("agent_engine");
          add(m, "Agent Engine runtime", "_ai", (vcpuH * ae.vcpu_hr + gibH * ae.gib_hr) * u, (vcpuH * ae.cud1_vcpu_hr + gibH * ae.cud1_gib_hr) * u, (vcpuH * ae.cud3_vcpu_hr + gibH * ae.cud3_gib_hr) * u);
          const gm = pricing.gemini_models[s.model];
          add(m, `${gm.name} tokens (agents)`, "_ai", (req * (num(s.input_tokens) * gm.input_mtok + num(s.output_tokens) * gm.output_mtok)) / 1e6);
          if (bqModel === "ondemand") add(m, "BigQuery queries from agents", "_ai", ((req * num(s.bq_gb_per_request)) / GIB_PER_TIB) * pricing.bigquery.ondemand_tib * up("bigquery"));
        } else if (t === "vertex_gpu") {
          const node = pricing.vertex_prediction.nodes[s.gpu];
          add(m, `Vertex AI endpoint (${node.name})`, "_ai", num(s.replicas) * num(s.hours_per_day) * 30.4 * node.hr * up("vertex_prediction"));
        } else if (t === "apigee") {
          const ap = pricing.apigee, calls = num(s.api_calls_million);
          add(m, "Apigee (environment)", "_ai", ap.environment_month[s.environment]);
          add(m, "Apigee (API calls)", "_ai", tieredM(calls, ap.calls_per_million[s.proxy_type]));
          if (s.analytics === "yes" && s.environment !== "base") add(m, "Apigee (API calls)", "_ai", calls * ap.analytics_per_million);
          if (s.advanced_security === "yes" && s.environment !== "base") add(m, "Apigee (Advanced API Security)", "_ai", calls * ap.advanced_security_per_million);
        } else if (t === "alloydb") {
          const a = pricing.alloydb;
          const nodes = (s.ha === "yes" ? 2 : 1) + num(s.read_pool_nodes);
          const v = num(s.vcpu) * nodes * HOURS, g = num(s.memory_gib) * nodes * HOURS, u = up("alloydb");
          add(m, "AlloyDB", "_db", (v * a.vcpu_hr + g * a.mem_gib_hr) * u, (v * a.cud1_vcpu_hr + g * a.cud1_mem_gib_hr) * u, (v * a.cud3_vcpu_hr + g * a.cud3_mem_gib_hr) * u);
          add(m, "AlloyDB", "_db", num(s.storage_gib) * a.storage_gib_month * u);
        } else if (t === "cloudsql") {
          const q = pricing.cloudsql, ha = s.ha === "yes";
          const comp = (num(s.vcpu) * (ha ? q.ha_vcpu_hr : q.vcpu_hr) + num(s.memory_gib) * (ha ? q.ha_mem_gib_hr : q.mem_gib_hr)) * HOURS;
          const u = up("cloudsql");
          add(m, "Cloud SQL", "_db", comp * u, comp * q.cud1_factor * u, comp * q.cud3_factor * u);
          add(m, "Cloud SQL", "_db", num(s.storage_gib) * (ha ? q.ha_ssd_gib_month : q.ssd_gib_month) * u);
        } else if (t === "spanner") {
          const sp = pricing.spanner, comp = num(s.nodes) * sp.node_hr[s.edition] * HOURS, u = up("spanner");
          add(m, "Spanner", "_db", comp * u, comp * sp.cud1_factor * u, comp * sp.cud3_factor * u);
          add(m, "Spanner", "_db", num(s.storage_gib) * sp.ssd_gib_month * u);
        } else if (t === "bigtable") {
          const bt = pricing.bigtable, comp = num(s.nodes) * bt.node_hr[s.edition] * HOURS, u = up("bigtable");
          add(m, "Bigtable", "_db", comp * u, comp * bt.cud1_factor * u, comp * bt.cud3_factor * u);
          add(m, "Bigtable", "_db", num(s.storage_gib) * bt.ssd_gib_month * u);
        } else if (t === "firestore") {
          const fs = pricing.firestore;
          const ops = (Math.max(0, num(s.reads_million) * 1e6 - fs.free_reads_month) / 1e5) * fs.reads_per_100k + (Math.max(0, num(s.writes_million) * 1e6 - fs.free_writes_month) / 1e5) * fs.writes_per_100k;
          const u = up("firestore");
          add(m, "Firestore", "_db", ops * u, ops * fs.cud1_factor * u, ops * fs.cud3_factor * u);
          add(m, "Firestore", "_db", Math.max(0, num(s.storage_gib) - fs.free_storage_gib) * fs.storage_gib_month * u);
        } else if (t === "memorystore") {
          const ms = pricing.memorystore, cap = num(s.capacity_gib);
          const rate = ms.standard_tier_gib_hr.find(([lim]) => lim === null || cap <= lim)[1];
          const c2 = cap * rate * HOURS * up("memorystore");
          add(m, "Memorystore", "_db", c2, c2 * ms.cud1_factor, c2 * ms.cud3_factor);
        } else if (t === "sdp") {
          add(m, "Sensitive Data Protection (discovery)", "_governance", newBy[m] * pricing.sensitive_data_protection.discovery_gb);
        } else if (t === "cmek") {
          add(m, "Cloud KMS (CMEK)", "_governance", num(s.key_versions) * pricing.kms.key_version_month + num(s.operations_million) * 100 * pricing.kms.ops_per_10k);
        } else if (t === "knowledge_catalog") {
          const dp = pricing.dataplex;
          const dqTables = (tables * num(s.dq_share_pct)) / 100;
          const dcu = dqTables * num(s.dq_scans_per_month) * dp.dq_dcu_hr_per_table_scan + tables * dp.lineage_dcu_hr_per_table_month;
          const u = up("dataplex"), metaGib = Math.max(1, tables / 1000);
          add(m, "Knowledge Catalog (Dataplex) - quality, profiling, lineage", "_governance",
            (dcu * dp.premium_dcu_hr + metaGib * dp.metadata_gib_month) * u,
            (dcu * dp.premium_cud1_dcu_hr + metaGib * dp.metadata_gib_month) * u,
            (dcu * dp.premium_cud3_dcu_hr + metaGib * dp.metadata_gib_month) * u);
        }
      }
      setRegion(home);
    }
    return Math.trunc(tables);
  }

  function componentView(c) {
    const m = COMPONENT_BY_ID[c.type];
    return { id: c.id, type: c.type, start_month: Math.trunc(num(c.start_month) || 1), included: c.included !== false, name: m.name, category: m.category, vendor: m.vendor, costed: m.costed, method: m.method,
      steps: m.steps, notes: m.notes, doc: m.doc, settings: c.settings };
  }

  function platformStory(comps, sec, sources) {
    const blocks = [];
    const cdc = sources.filter((s) => (SOURCE_BY_ID[s.type] || {}).cdc && STREAMING.has(s.frequency)).map((s) => s.name || s.type);
    blocks.push({
      key: "lakehouse", title: "BigQuery lakehouse foundation", tools: ["dataform", "bqml", "reverse_etl"],
      points: [
        "Raw, curated and mart datasets in BigQuery; open Apache Iceberg tables through BigLake keep data portable across engines.",
        cdc.length ? "Continuous CDC from " + cdc.slice(0, 4).join(", ") + " keeps operational data fresh for analytics and agents." : "Add CDC sources (Datastream) when agents and dashboards need minute-level freshness.",
        "Dataform builds tested, version-controlled SQL models; BigQuery ML and AI functions bring Gemini and vector search into SQL.",
        "Every connected BI, AI and governance tool reads the same governed tables, so metrics and permissions stay consistent.",
      ],
    });
    const secComps = comps.filter((c) => COMPONENT_BY_ID[c.type].category === "security");
    if (secComps.length) {
      const toolFor = { sdp: "sdp", cmek: "cmek", vpc_sc: "vpc_sc", policy_tags: "fine_grained", scc: "scc" };
      const tools = secComps.filter((c) => toolFor[c.type]).map((c) => toolFor[c.type]);
      const pts = secComps.map((c) => `${COMPONENT_BY_ID[c.type].name}: ${COMPONENT_BY_ID[c.type].method}.`);
      if (comps.some((c) => COMPONENT_BY_ID[c.type].vendor === "partner")) pts.push("Partner tools connect with service accounts or workload identity federation (no long-lived keys); keep them inside the perimeter with VPC-SC ingress rules.");
      blocks.push({ key: "security", title: "Security & compliance", tools, points: pts });
    }
    return blocks;
  }

  function interRegionRate(regions, a, b, pricing) {
    if (a === b) return 0;
    const ra = regions[a], rb = regions[b];
    if ((ra.multi || rb.multi) && ra.geo === rb.geo) return 0;
    const n = pricing.network;
    return ra.geo === rb.geo ? n.inter_region_same_geo_gib : n.inter_region_cross_geo_gib;
  }

  // ------------------------------------------------------------------ estimator
  function tiered(gib, tiers) {
    let cost = 0, prev = 0;
    for (const [limit, price] of tiers) {
      const top = limit === null ? gib : Math.min(gib, limit);
      if (top > prev) { cost += (top - prev) * price; prev = top; }
      if (limit !== null && gib <= limit) break;
    }
    return cost;
  }
  const growthFactor = (m, g) => Math.pow(1 + g, (m - 1) / 12);
  function batchVcpuHours(gb, runs, transform) {
    if (runs <= 0) return 0;
    return runs * Math.max(A.batch_min_vcpu_hr_per_run, gb / runs / A.batch_gb_per_vcpu_hr[transform]);
  }
  const streamVcpus = (daily, transform) => Math.max(A.stream_min_vcpu, Math.ceil(daily / A.stream_gb_per_vcpu_day[transform]));
  const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

  function estimate(scenario, keepItems) {
    const pricing = D.pricing;
    const regions = Object.fromEntries(D.regions.map((r) => [r.id, r]));
    const regionId = regions[scenario.region] ? scenario.region : "us-central1";
    const region = regions[regionId];
    const procRegion = regions[scenario.processing_region] ? scenario.processing_region : regionId;
    const ctx = { rid: regionId };
    const ridOf = (r) => (regions[r] ? r : regionId);
    const growth = num(scenario.annual_growth_pct ?? 20) / 100;
    const prefs = { skill: scenario.skill || "sql", orchestration: scenario.orchestration || "auto", environment: scenario.environment || "production" };
    const bqModel = scenario.bq_model || "ondemand";
    const sources = (scenario.sources || []).filter((s) => s.type && s.included !== false);
    const up = (k) => (pricing[k].regional ? regions[ctx.rid].uplift : 1);

    const recs = sources.map((s) => recommend(s, prefs));
    const platform = platformComponents(sources, recs, prefs);

    const payg = new Map(), cud1 = new Map(), cud3 = new Map();
    const key = (m, svc, sid, rid) => `${m}\u0001${svc}\u0001${sid}\u0001${rid}`;
    const inc = (map, k, v) => map.set(k, (map.get(k) || 0) + v);
    const excluded = new Set(scenario.excluded_services || []);
    function add(m, svc, sid, usd, c1, c3) {
      if (!usd || excluded.has(svc)) return;
      const k = key(m, svc, sid, ctx.rid);
      inc(payg, k, usd);
      inc(cud1, k, c1 === undefined ? usd : c1);
      inc(cud3, k, c3 === undefined ? usd : c3);
    }

    const df = pricing.dataflow, ds = pricing.datastream, ps = pricing.pubsub, bq = pricing.bigquery;
    const z = () => new Array(37).fill(0);
    const dsCdc = z(), writeApi = z(), streamIns = z(), netGib = z(), ingGib = z(), landing = z();
    const initialBy = z(), backfillBy = z();
    const srcStart = {};
    const meta = [];

    sources.forEach((src, i) => {
      const rec = recs[i];
      const sid = src.id || src.type;
      const name = src.name || (SOURCE_BY_ID[src.type] || {}).name || src.type;
      const cat = (SOURCE_BY_ID[src.type] || {}).category || "api";
      const freq = src.frequency || "daily";
      const transform = src.transform || "none";
      const daily0 = num(src.daily_change_gb), initial = num(src.initial_volume_gb);
      const oneTime = freq === "one_time";
      const runs = RUNS[freq] || 0;
      const netRatio = A.net_new_ratio[CDC_CATEGORIES.has(cat) ? "cdc" : "append"];
      const engines = rec.engine.split("+");
      const onPrem = (src.location || "on_prem") === "on_prem";
      const start = Math.max(1, Math.min(36, Math.trunc(num(src.start_month) || 1)));
      srcStart[sid] = start;
      initialBy[start] += initial;
      const srcRid = ridOf(src.region || regionId);
      ctx.rid = srcRid;
      meta.push({ id: sid, name, region: srcRid });
      const xfer = interRegionRate(regions, srcRid, regionId, pricing);

      for (let m = 1; m <= 36; m++) {
        if (m < start) continue;
        const daily = oneTime ? 0 : daily0 * growthFactor(m, growth);
        const monthly = daily * 30;
        ingGib[m] += monthly;
        netGib[m] += monthly * netRatio;
        if (xfer) {
          add(m, "Cross-region data transfer", sid, monthly * xfer);
          if (m === start && initial) add(m, "Cross-region data transfer", sid, initial * xfer);
        }
        for (const eng of engines) {
          if (eng === "datastream") dsCdc[m] += monthly;
          else if (eng === "dataflow_batch") {
            const vh = batchVcpuHours(monthly, runs, transform);
            let usd = (vh * df.batch_vcpu_hr + vh * A.memory_gib_per_vcpu * df.memory_gib_hr) * up("dataflow");
            if (transform === "heavy") usd += monthly * df.shuffle_gib * up("dataflow");
            add(m, "Dataflow (batch)", sid, usd);
          } else if (eng === "dataflow_stream") {
            if (oneTime) continue;
            const v = streamVcpus(daily, transform);
            const c = (v * HOURS * df.streaming_vcpu_hr + v * HOURS * A.memory_gib_per_vcpu * df.memory_gib_hr + v * HOURS * A.streaming_engine_cu_per_vcpu_hr * df.streaming_engine_cu_hr) * up("dataflow");
            add(m, "Dataflow (streaming)", sid, c, c * (1 - df.cud1_discount), c * (1 - df.cud3_discount));
          } else if (eng === "pubsub_bqsub") add(m, "Pub/Sub", sid, (monthly / GIB_PER_TIB) * (ps.throughput_tib + ps.bq_subscription_tib));
          else if (eng === "pubsub") add(m, "Pub/Sub", sid, (monthly / GIB_PER_TIB) * ps.throughput_tib * 2);
          else if (eng === "datafusion") {
            let vh = 0;
            if (runs > 0 && monthly > 0) vh = runs * Math.max(A.datafusion_min_vcpu_hr_per_run, monthly / runs / A.datafusion_gb_per_vcpu_hr);
            else if (!oneTime && monthly > 0) vh = HOURS * 4;
            add(m, "Data Fusion pipelines (Dataproc)", sid, vh * pricing.datafusion.pipeline_vcpu_hr_all_in * up("datafusion"));
          } else if (eng === "dataproc") {
            if (runs > 0 && monthly > 0) {
              const dcu = runs * Math.max(A.spark_min_dcu_hr_per_run, monthly / runs / A.spark_gb_per_dcu_hr[transform]);
              add(m, "Dataproc Serverless", sid, dcu * pricing.dataproc_serverless.dcu_hr * up("dataproc_serverless"));
            }
          } else if (eng === "files_transfer") {
            if (onPrem || cat === "mainframe") add(m, "Storage Transfer Service", sid, monthly * pricing.storage_transfer.agent_gib);
            landing[m] += daily * A.landing_retention_days;
          } else if (eng === "dts_migration") {
            if (src.type === "teradata" && !oneTime) add(m, "Compute Engine (migration agent)", sid, HOURS * pricing.compute_engine.vm_standard_4vcpu_hr * up("compute_engine"));
          } else if (eng === "sap_connector") writeApi[m] += monthly;
          else if (eng === "log_sink") streamIns[m] += monthly;
          else if (eng === "app_integration") {
            const ic = pricing.integration_connectors;
            add(m, "Integration Connectors", sid, HOURS * ic.third_party_node_hr + Math.max(0, monthly - ic.free_gib) * ic.data_processed_gib);
          } else if (eng === "cloud_run") {
            const cr = pricing.cloud_run;
            const secs = (runs || 30) * A.cloud_run_minutes_per_run * 60;
            add(m, "Cloud Run jobs", sid, secs * (cr.vcpu_second + 2 * cr.gib_second) * up("cloud_run"));
            writeApi[m] += monthly;
          }
        }
        if (m === start && initial > 0) {
          const pe = engines[0];
          if (pe === "datastream") backfillBy[m] += initial;
          else if (pe === "dataflow_batch" || pe === "dataflow_stream") {
            const vh = batchVcpuHours(initial, Math.max(1, Math.ceil(initial / 2000)), "light");
            add(m, "One-time initial load", sid, (vh * df.batch_vcpu_hr + vh * A.memory_gib_per_vcpu * df.memory_gib_hr) * up("dataflow"));
          } else if (pe === "datafusion") {
            const vh = Math.max(A.datafusion_min_vcpu_hr_per_run, initial / A.datafusion_gb_per_vcpu_hr);
            add(m, "One-time initial load", sid, vh * pricing.datafusion.pipeline_vcpu_hr_all_in * up("datafusion"));
          } else if (pe === "dataproc") {
            const dcu = Math.max(A.spark_min_dcu_hr_per_run, initial / A.spark_gb_per_dcu_hr.light);
            add(m, "One-time initial load", sid, dcu * pricing.dataproc_serverless.dcu_hr * up("dataproc_serverless"));
          } else if (pe === "files_transfer") {
            if (onPrem || cat === "mainframe") add(m, "One-time initial load", sid, initial * pricing.storage_transfer.agent_gib);
            add(m, "One-time initial load", sid, initial * pricing.gcs.standard_gib_month * up("gcs"));
          } else if (pe === "dts_migration" && src.type === "teradata") {
            add(m, "One-time initial load", sid, (initial / A.teradata_agent_gb_per_hr) * pricing.compute_engine.vm_standard_4vcpu_hr * up("compute_engine"));
          } else if (pe === "sap_connector") writeApi[m] += initial;
        }
      }
    });

    // Datastream tiers, shared across the billing account
    const srcRegion = Object.fromEntries(meta.map((x) => [x.id, x.region]));
    for (let m = 1; m <= 36; m++) {
      if (dsCdc[m]) {
        const total = tiered(dsCdc[m], ds.cdc_tiers_gib);
        const dsVols = {};
        sources.forEach((s, i) => { const id = s.id || s.type; if (recs[i].engine.split("+").includes("datastream") && s.frequency !== "one_time" && (srcStart[id] || 1) <= m) dsVols[id] = num(s.daily_change_gb); });
        const dsTot = Object.values(dsVols).reduce((a, b) => a + b, 0) || 1;
        for (const [sid, v] of Object.entries(dsVols)) { ctx.rid = srcRegion[sid] || regionId; add(m, "Datastream (CDC)", sid, total * (v / dsTot)); }
      }
    }
    ctx.rid = regionId;
    let freeBackfill = ds.backfill_free_gib;
    for (let m = 1; m <= 36; m++) {
      if (backfillBy[m]) {
        const billable = Math.max(0, backfillBy[m] - freeBackfill);
        freeBackfill = Math.max(0, freeBackfill - backfillBy[m]);
        add(m, "One-time initial load", "_datastream_backfill", billable * ds.backfill_gib);
      }
    }

    // BigQuery (home region)
    const platStart = Object.keys(srcStart).length ? Math.min(...Object.values(srcStart)) : 1;
    ctx.rid = regionId;
    const bqUp = up("bigquery");
    let stored = 0;
    const history = [], newBy = z();
    const analyticsIn = scenario.analytics_tib_month;
    const slots = num(scenario.bq_slots) || 100;
    const mult = 1 + A.curated_layers_overhead;
    for (let m = 1; m <= 36; m++) {
      newBy[m] = initialBy[m] + netGib[m];
      history.push(newBy[m]);
      stored += newBy[m];
      const recent = history.slice(-3).reduce((a, b) => a + b, 0);
      const older = Math.max(0, stored - recent);
      const lt = older * A.longterm_share_after_90d;
      const active = stored - lt;
      const activeB = Math.max(0, active * mult - bq.storage_free_gib);
      add(m, "BigQuery storage", "_platform", (activeB * bq.storage_active_gib_month + lt * mult * bq.storage_longterm_gib_month) * bqUp);
      const wa = Math.max(0, writeApi[m] - bq.storage_write_api_free_tib * GIB_PER_TIB);
      add(m, "BigQuery ingestion (Write API / streaming)", "_platform", (wa * bq.storage_write_api_gib + streamIns[m] * bq.streaming_inserts_gib) * bqUp);
      const storedTib = (stored * mult) / GIB_PER_TIB;
      const eltTib = (ingGib[m] * A.elt_scan_multiplier) / GIB_PER_TIB;
      const analyticsTib = analyticsIn ? num(analyticsIn) * growthFactor(m, growth) : storedTib * A.auto_analytics_scan_multiplier;
      if (bqModel === "ondemand") add(m, "BigQuery compute", "_platform", Math.max(0, eltTib + analyticsTib - bq.ondemand_free_tib) * bq.ondemand_tib * bqUp);
      else if (m >= platStart) {
        const ed = bq.editions[bqModel], sh = slots * HOURS;
        add(m, "BigQuery compute", "_platform", sh * ed.payg * bqUp, sh * ed.cud1 * bqUp, sh * ed.cud3 * bqUp);
      }
    }

    ctx.rid = procRegion;
    const orch = platform.orchestration.tool;
    if (orch === "composer") {
      const cp = pricing.composer;
      const dcuH = cp[sources.length <= 10 ? "small_env_avg_dcu" : "medium_env_avg_dcu"] * HOURS;
      for (let m = platStart; m <= 36; m++) add(m, "Composer (Airflow)", "_platform", dcuH * cp.dcu_hr * up("composer"), dcuH * cp.cud1_dcu_hr * up("composer"), dcuH * cp.cud3_dcu_hr * up("composer"));
    } else if (orch === "workflows") {
      for (let m = platStart; m <= 36; m++) add(m, "Workflows + Scheduler", "_platform", sources.length * pricing.workflows.scheduler_job_month);
    }
    if (platform.datafusion_edition) {
      const dfp = pricing.datafusion;
      const inst = platform.datafusion_edition === "enterprise" ? HOURS * dfp.enterprise_hr : Math.max(0, HOURS - dfp.basic_free_hours) * dfp.basic_hr;
      const label = `Data Fusion instance (${titleCase(platform.datafusion_edition)})`;
      for (let m = platStart; m <= 36; m++) add(m, label, "_platform", inst * up("datafusion"));
    }
    if (platform.connectivity === "ha_vpn") {
      const n = pricing.network;
      for (let m = platStart; m <= 36; m++) add(m, "Network (HA VPN)", "_platform", n.ha_vpn_tunnel_hr * n.ha_vpn_tunnels * HOURS);
    } else if (platform.connectivity === "interconnect") {
      const ic = pricing.interconnect;
      for (let m = platStart; m <= 36; m++) add(m, "Network (Interconnect)", "_platform", ic.dedicated_10g_port_month + ic.vlan_attachment_hr * ic.vlan_attachments * HOURS);
    }
    for (let m = 1; m <= 36; m++) if (landing[m]) add(m, "Cloud Storage (landing zone)", "_platform", landing[m] * pricing.gcs.standard_gib_month * up("gcs"));

    // analytics, AI, governance, security
    const { comps, sec } = normalizedComponents(scenario);
    const tables = costComponents(comps, sec, pricing, up, sources, newBy, bqModel, add, A.curated_layers_overhead, (r) => (ctx.rid = ridOf(r || regionId)), regionId);
    ctx.rid = regionId;
    platform.layer = { components: comps.map(componentView), security: sec, tables_estimated: tables, story: platformStory(comps, sec, sources) };
    platform.processing_region = procRegion;

    const cont = num(scenario.contingency_pct ?? A.contingency * 100) / 100;
    for (const view of [payg, cud1, cud3]) {
      const mt = z();
      for (const [k, v] of view) mt[+k.split("\u0001")[0]] += v;
      for (let m = 1; m <= 36; m++) if (mt[m] && !excluded.has("Contingency & operations")) inc(view, key(m, "Contingency & operations", "_platform", regionId), mt[m] * cont);
    }
    const out = summarise(payg, cud1, cud3, recs, platform, meta, region);
    out.excluded_services = [...excluded].sort();
    if (keepItems) out._items = payg;
    return out;
  }

  const GROUP_ORDER = ["Data ingestion & CDC", "BigQuery", "Analytics & AI", "APIs & databases", "Governance & security", "Platform & network", "Contingency"];
  function serviceGroup(name) {
    const n = name.toLowerCase();
    if (n.startsWith("bigquery") && !n.includes("agents")) return "BigQuery";
    if (["apigee", "alloydb", "cloud sql", "spanner", "bigtable", "firestore", "memorystore"].some((k) => n.includes(k))) return "APIs & databases";
    if (["looker", "gemini", "agent", "vertex ai"].some((k) => n.includes(k))) return "Analytics & AI";
    if (["knowledge catalog", "sensitive data", "kms"].some((k) => n.includes(k))) return "Governance & security";
    if (["composer", "workflows", "network", "landing", "data fusion instance", "cross-region"].some((k) => n.includes(k))) return "Platform & network";
    if (n.includes("contingency")) return "Contingency";
    return "Data ingestion & CDC";
  }

  function summarise(payg, cud1, cud3, recs, platform, meta, region) {
    const parse = (k) => { const [m, svc, sid, rid] = k.split("\u0001"); return { m: +m, svc, sid, rid }; };
    const inYears = (m, y) => y === 0 ? true : m > (y - 1) * 12 && m <= y * 12;
    const sumBy = (view, y, field) => {
      const out = new Map();
      for (const [k, v] of view) { const p = parse(k); if (inYears(p.m, y)) out.set(p[field], (out.get(p[field]) || 0) + v); }
      return out;
    };
    const tot = (view, y) => { let t = 0; for (const [k, v] of view) if (inYears(parse(k).m, y)) t += v; return round2(t); };

    const monthly = [];
    for (let m = 1; m <= 36; m++) {
      let a = 0, b = 0;
      for (const [k, v] of payg) if (parse(k).m === m) a += v;
      for (const [k, v] of cud3) if (parse(k).m === m) b += v;
      monthly.push({ month: m, payg: round2(a), cud3: round2(b) });
    }
    const s1 = sumBy(payg, 1, "svc"), s3 = sumBy(payg, 0, "svc"), s1c = sumBy(cud1, 1, "svc"), s3c = sumBy(cud3, 0, "svc");
    const services = [...s3.keys()].sort((a, b) => s3.get(b) - s3.get(a));
    const serviceRows = services.map((s) => ({ service: s, group: serviceGroup(s), year1: round2(s1.get(s) || 0), year1_cud: round2(s1c.get(s) || 0), three_year: round2(s3.get(s) || 0), three_year_cud: round2(s3c.get(s) || 0) }));
    const groups = {};
    for (const r of serviceRows) {
      const g = groups[r.group] || (groups[r.group] = { group: r.group, year1: 0, three_year: 0 });
      g.year1 = round2(g.year1 + r.year1); g.three_year = round2(g.three_year + r.three_year);
    }
    const groupRows = Object.values(groups).sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
    const src1 = sumBy(payg, 1, "sid"), src3 = sumBy(payg, 0, "sid");
    const nameOf = Object.fromEntries(meta.map((m) => [m.id, m.name]));
    Object.assign(nameOf, {
      _platform: "Shared platform (BigQuery, orchestration, network, contingency)",
      _datastream_backfill: "Datastream backfill (all CDC sources)",
      _ai: "Analytics, AI & APIs (BI, Gemini Enterprise, agents, GPU serving, Apigee)",
      _db: "Operational databases",
      _governance: "Governance & security (Knowledge Catalog, SDP, KMS)",
    });
    const sourceRows = [...src3.keys()].sort((a, b) => (a.startsWith("_") - b.startsWith("_")) || (src3.get(b) - src3.get(a)))
      .map((k) => ({ id: k, name: nameOf[k] || k, year1: round2(src1.get(k) || 0), three_year: round2(src3.get(k) || 0) }));
    const r1 = sumBy(payg, 1, "rid"), r3 = sumBy(payg, 0, "rid");
    const regionNames = Object.fromEntries(D.regions.map((r) => [r.id, r.name]));
    const regionRows = [...r3.keys()].sort((a, b) => r3.get(b) - r3.get(a))
      .map((k) => ({ region: k, name: regionNames[k] || k, year1: round2(r1.get(k) || 0), three_year: round2(r3.get(k) || 0) }));
    const t = {
      year1_payg: tot(payg, 1), year1_cud1: tot(cud1, 1), year2_payg: tot(payg, 2), year3_payg: tot(payg, 3),
      three_year_payg: tot(payg, 0), three_year_cud3: tot(cud3, 0),
    };
    t.avg_monthly_year1 = round2(t.year1_payg / 12);
    t.range_low_3y = round2(t.three_year_cud3 * 0.75);
    t.range_high_3y = round2(t.three_year_payg * 1.3);
    t.range_low_1y = round2(t.year1_cud1 * 0.75);
    t.range_high_1y = round2(t.year1_payg * 1.3);
    const pm = D.pricing._meta;
    return {
      region, currency: "USD", fx: D.pricing.fx, totals: t, by_service: serviceRows, by_group: groupRows, by_source: sourceRows, by_region: regionRows,
      monthly, recommendations: recs, platform, assumptions: A, pricing_meta: pm,
      disclaimer: `Ballpark estimate for discovery discussions only. Based on public list prices (reviewed ${pm.last_reviewed}) with an approximate regional uplift of x${region.uplift.toFixed(2)} for ${region.name}. Excludes taxes, support, egress from other clouds, partner licences (Power BI, Tableau, SageMaker and other non-Google tools are not costed) and negotiated discounts. Validate with the Google Cloud Pricing Calculator.`,
    };
  }

  // ------------------------------------------------------------------ workload sizing (port of app/workload.py)
  const FREQ_RUNS = { hourly: 730, daily: 30, weekly: 4.3, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
  const QUERY_LABELS = { simple: "Simple queries", complex: "Complex queries", heavy: "Heavy / periodic queries", adhoc: "Ad-hoc reports" };
  const WL_CATEGORY = {
    "BigQuery storage": "Storage", "Cloud Storage": "Storage", "BigQuery compute": "Query & ELT compute",
    "Dataflow (batch)": "Pipelines", "Composer (Airflow)": "Orchestration", "Workflows + Scheduler": "Orchestration",
    "Pub/Sub": "Streaming", "Dataflow (streaming)": "Streaming", "Cross-region data transfer": "Network",
    "Contingency & operations": "Contingency",
  };
  for (const svc of ["Apigee (environment)", "Apigee (API calls)", "Apigee (Advanced API Security)", "AlloyDB", "Cloud SQL", "Spanner", "Bigtable", "Firestore", "Memorystore"]) WL_CATEGORY[svc] = "APIs & databases";
  const WL_ORDER = ["Storage", "Query & ELT compute", "Pipelines", "Streaming", "Orchestration", "Network", "APIs & databases", "Analytics, AI & governance", "Contingency"];

  function mergedWorkload(w) {
    w = w || {};
    const out = {};
    for (const [k, v] of Object.entries(D.default_workload)) {
      if (k === "queries") {
        const q = w.queries || {};
        out[k] = {};
        for (const [qk, qv] of Object.entries(v)) {
          out[k][qk] = { ...qv };
          for (const [kk, vv] of Object.entries(q[qk] || {})) if (vv !== null && vv !== undefined) out[k][qk][kk] = vv;
        }
      } else if (v !== null && typeof v === "object") {
        out[k] = { ...v };
        for (const [kk, vv] of Object.entries(w[k] || {})) if (vv !== null && vv !== undefined) out[k][kk] = vv;
      } else {
        out[k] = w[k] !== null && w[k] !== undefined ? w[k] : v;
      }
    }
    return out;
  }

  function workloadEstimate(scenario) {
    const pricing = D.pricing;
    const regions = Object.fromEntries(D.regions.map((r) => [r.id, r]));
    const home = regions[scenario.region] ? scenario.region : "us-central1";
    const W = mergedWorkload(scenario.workload);
    const dataRid = regions[W.data_region] ? W.data_region : home;
    const pipeRid = regions[W.pipelines_region] ? W.pipelines_region : dataRid;
    const strmRid = regions[W.streaming_region] ? W.streaming_region : dataRid;
    const bq = pricing.bigquery, df = pricing.dataflow;
    const WA = { ...D.workload_assumptions, slot_hours_per_tib: num(W.slot_hours_per_tib) };
    const ctx = { rid: dataRid };
    const up = (k) => (pricing[k].regional ? regions[ctx.rid].uplift : 1);
    const payg = new Map(), cud1 = new Map(), cud3 = new Map();
    const inc = (map, k, v) => map.set(k, (map.get(k) || 0) + v);
    const key = (m, svc, item, rid) => `${m}\u0001${svc}\u0001${item}\u0001${rid}`;
    const excludedW = new Set(scenario.excluded_services || []);
    function add(m, svc, item, usd, c1, c3) {
      if (!usd || excludedW.has(svc)) return;
      const k = key(m, svc, item, ctx.rid);
      inc(payg, k, usd); inc(cud1, k, c1 === undefined ? usd : c1); inc(cud3, k, c3 === undefined ? usd : c3);
    }
    const d = W.data, tel = W.telemetry, pipes = W.pipelines, dash = W.dashboards, ramp = W.ramp;
    const rampMonths = Math.max(0, Math.trunc(num(ramp.months)));
    const growth = num(d.annual_growth_pct) / 100;
    const bqTb = num(d.structured_tb) + num(d.semi_structured_tb), gcsTb = num(d.unstructured_tb), totalTb = bqTb + gcsTb;
    const telDay = num(tel.volume_gb) / (tel.per === "month" ? 30 : 1);
    const nPipes = { simple: num(pipes.simple), medium: num(pipes.medium), complex: num(pipes.complex) };
    const runsMonth = num(pipes.runs_per_day) * 30;
    const storedBy = new Array(37).fill(0), ingestedBy = new Array(37).fill(0), scansBy = {};
    let scanLines = [];
    const addCompute = (m, item, tib) => {
      ctx.rid = dataRid;
      const u = up("bigquery");
      if (W.bq_model === "ondemand") add(m, "BigQuery compute", item, tib * bq.ondemand_tib * u);
      else {
        const ed = bq.editions[W.bq_model], sh = tib * WA.slot_hours_per_tib;
        add(m, "BigQuery compute", item, sh * ed.payg * u, sh * ed.cud1 * u, sh * ed.cud3 * u);
      }
    };
    for (let m = 1; m <= 36; m++) {
      const inRamp = m <= rampMonths;
      const steadyIdx = Math.max(0, m - rampMonths - 1);
      const g = Math.pow(1 + growth, steadyIdx / 12);
      const scans = [];
      ctx.rid = dataRid;
      let bqGib, gcsGib, telStored;
      if (inRamp) {
        const share = totalTb ? bqTb / totalTb : 1;
        bqGib = num(ramp.data_gb) * share; gcsGib = num(ramp.data_gb) - bqGib; telStored = 0;
      } else {
        bqGib = bqTb * GIB_PER_TIB * g; gcsGib = gcsTb * GIB_PER_TIB * g;
        telStored = telDay * 30 * Math.min(steadyIdx + 1, Math.trunc(num(tel.retention_months))) * g;
      }
      const bqTotal = bqGib + telStored;
      const lt = m <= 3 || inRamp ? 0 : bqTotal * WA.longterm_share_after_90d;
      const active = Math.max(0, bqTotal - lt - bq.storage_free_gib);
      add(m, "BigQuery storage", "Structured, semi-structured & telemetry data", (active * bq.storage_active_gib_month + lt * bq.storage_longterm_gib_month) * up("bigquery"));
      add(m, "Cloud Storage", "Unstructured data (object tables)", gcsGib * pricing.gcs.standard_gib_month * up("gcs"));
      storedBy[m] = bqTotal + gcsGib;
      ingestedBy[m] = inRamp ? 0 : telDay * 30 * g + (bqGib * growth) / 12;
      if (!inRamp && telDay > 0) {
        ctx.rid = strmRid;
        const mg = telDay * 30 * g, tib = mg / GIB_PER_TIB, ps = pricing.pubsub;
        if (tel.transform) {
          add(m, "Pub/Sub", "Telemetry streaming", tib * ps.throughput_tib * 2);
          const v = Math.max(2, Math.ceil((telDay * g) / WA.telemetry_gb_per_vcpu_day));
          const c = (v * HOURS * df.streaming_vcpu_hr + v * HOURS * WA.memory_gib_per_vcpu * df.memory_gib_hr + v * HOURS * 0.5 * df.streaming_engine_cu_hr) * up("dataflow");
          add(m, "Dataflow (streaming)", "Telemetry streaming", c, c * (1 - df.cud1_discount), c * (1 - df.cud3_discount));
        } else add(m, "Pub/Sub", "Telemetry streaming", tib * (ps.throughput_tib + ps.bq_subscription_tib));
        const rate = interRegionRate(regions, strmRid, dataRid, pricing);
        if (rate) add(m, "Cross-region data transfer", "Telemetry to data region", mg * rate);
      }
      const counts = inRamp ? { simple: 0, medium: num(ramp.pipelines), complex: 0 } : nPipes;
      if (W.pipelines.engine === "etl") {
        ctx.rid = pipeRid;
        for (const [k, n] of Object.entries(counts)) {
          const vh = n * runsMonth * WA.etl_vcpu_hr_per_run[k] * (inRamp ? 1 : g);
          add(m, "Dataflow (batch)", `${titleCase(k)} pipelines`, (vh * df.batch_vcpu_hr + vh * WA.memory_gib_per_vcpu * df.memory_gib_hr) * up("dataflow"));
        }
      } else {
        for (const [k, n] of Object.entries(counts)) {
          const tib = (n * runsMonth * WA.elt_gb_scanned_per_run[k] * (inRamp ? 1 : g)) / GIB_PER_TIB;
          if (tib) scans.push([`${titleCase(k)} pipelines (ELT)`, tib]);
        }
      }
      const totalPipes = Object.values(counts).reduce((a, b) => a + b, 0);
      if (totalPipes) {
        ctx.rid = pipeRid;
        if (totalPipes > WA.composer_threshold_pipelines) {
          const cp = pricing.composer;
          const dcuH = cp[totalPipes <= 150 ? "small_env_avg_dcu" : "medium_env_avg_dcu"] * HOURS;
          add(m, "Composer (Airflow)", "Pipeline orchestration", dcuH * cp.dcu_hr * up("composer"), dcuH * cp.cud1_dcu_hr * up("composer"), dcuH * cp.cud3_dcu_hr * up("composer"));
        } else add(m, "Workflows + Scheduler", "Pipeline orchestration", totalPipes * pricing.workflows.scheduler_job_month);
      }
      let nDash;
      if (inRamp) {
        scans.push(["Development & exploration", (num(ramp.data_gb) * WA.ramp_dev_scan_multiplier) / GIB_PER_TIB]);
        nDash = num(ramp.reports);
      } else {
        for (const [qk, q] of Object.entries(W.queries)) {
          const tib = (num(q.count) * (FREQ_RUNS[q.frequency] !== undefined ? FREQ_RUNS[q.frequency] : 30) * num(q.gb) * g) / GIB_PER_TIB;
          if (tib) scans.push([QUERY_LABELS[qk], tib]);
        }
        nDash = num(dash.count);
      }
      const dashTib = (nDash * num(dash.refreshes_per_day) * 30 * num(dash.queries_per_refresh) * num(dash.gb_per_query) * (1 - num(dash.cache_pct) / 100) * (inRamp ? 1 : g)) / GIB_PER_TIB;
      if (dashTib) scans.push(["Dashboards / reports", dashTib]);
      const totalTib = scans.reduce((a, [, t]) => a + t, 0);
      const free = W.bq_model === "ondemand" ? bq.ondemand_free_tib : 0;
      for (const [item, tib] of scans) addCompute(m, item, totalTib ? tib * Math.max(0, 1 - free / totalTib) : 0);
      if (m === rampMonths + 1) scanLines = scans.map(([i, t]) => ({ item: i, tib: Math.round(t * 1000) / 1000 }));
      scansBy[m] = totalTib;
    }
    if (W.include_components) {
      const { comps, sec } = normalizedComponents(scenario);
      const newByW = new Array(37).fill(0);
      for (let m = 1; m <= 36; m++) newByW[m] = m === 1 ? storedBy[1] : ingestedBy[m];
      costComponents(comps, sec, pricing, up, [{ tables: Math.trunc(num(d.tables) / 2.5) }], newByW, W.bq_model, add, 0.5, (r) => (ctx.rid = regions[r] ? r : dataRid), dataRid);
    }
    const cont = num(W.contingency_pct) / 100;
    ctx.rid = dataRid;
    for (const view of [payg, cud1, cud3]) {
      const mt = new Array(37).fill(0);
      for (const [k, v] of view) mt[+k.split("\u0001")[0]] += v;
      for (let m = 1; m <= 36; m++) if (mt[m] && !excludedW.has("Contingency & operations")) inc(view, key(m, "Contingency & operations", "Contingency", dataRid), mt[m] * cont);
    }

    // summary
    const parse = (k) => { const [m, svc, item, rid] = k.split("\u0001"); return { m: +m, svc, item, rid }; };
    const r2 = (x) => round2(x + 1e-12);
    const tot = (view, lo, hi) => { let t = 0; for (const [k, v] of view) { const p = parse(k); if (p.m >= lo && p.m <= hi) t += v; } return r2(t); };
    const monthTotal = (view, m) => { let t = 0; for (const [k, v] of view) if (parse(k).m === m) t += v; return t; };
    const monthly = [];
    for (let m = 1; m <= 36; m++) monthly.push({ month: m, payg: r2(monthTotal(payg, m)), cud3: r2(monthTotal(cud3, m)) });
    let rampSum = 0;
    for (let m = 1; m <= rampMonths; m++) rampSum += monthTotal(payg, m);
    const steadyM = Math.min(rampMonths + 1, 36);
    const totals = {
      year1_payg: tot(payg, 1, 12), year1_cud1: tot(cud1, 1, 12), year2_payg: tot(payg, 13, 24), year3_payg: tot(payg, 25, 36),
      three_year_payg: tot(payg, 1, 36), three_year_cud3: tot(cud3, 1, 36),
      ramp_monthly: rampMonths ? r2(rampSum / rampMonths) : 0, steady_monthly: r2(monthTotal(payg, steadyM)),
    };
    const cats = new Map(), lines = new Map(), regs = new Map();
    const bucket = (map, k, init) => { if (!map.has(k)) map.set(k, init()); return map.get(k); };
    for (const [k, v] of payg) {
      const p = parse(k);
      const c = WL_CATEGORY[p.svc] || "Analytics, AI & governance";
      for (const b of [bucket(cats, c, () => ({ year1: 0, three_year: 0, steady_month: 0 })), bucket(lines, `${c}\u0002${p.svc}\u0002${p.item}`, () => ({ year1: 0, three_year: 0, steady_month: 0 }))]) {
        if (p.m <= 12) b.year1 += v;
        b.three_year += v;
        if (p.m === steadyM) b.steady_month += v;
      }
      const rb = bucket(regs, p.rid, () => ({ year1: 0, three_year: 0 }));
      if (p.m <= 12) rb.year1 += v;
      rb.three_year += v;
    }
    const rnd = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r2(v)]));
    const categoryRows = WL_ORDER.filter((c) => cats.has(c)).map((c) => ({ category: c, ...rnd(cats.get(c)) }));
    const lineRows = [...lines.entries()].map(([k, v]) => { const [c, svc, item] = k.split("\u0002"); return { category: c, service: svc, item, ...rnd(v) }; })
      .sort((a, b) => (WL_ORDER.indexOf(a.category) - WL_ORDER.indexOf(b.category)) || (b.three_year - a.three_year));
    const regionRows = [...regs.entries()].map(([k, v]) => ({ region: k, name: regions[k].name, ...rnd(v) })).sort((a, b) => b.three_year - a.three_year);
    const tib = scansBy[steadyM] || 0;
    const u = regions[dataRid].uplift;
    const compare = [{ model: "On-demand", monthly: r2(Math.max(0, tib - bq.ondemand_free_tib) * bq.ondemand_tib * u), commit1: null, commit3: null }];
    for (const [k, label] of [["standard", "Standard edition"], ["enterprise", "Enterprise edition"], ["enterprise_plus", "Enterprise Plus edition"]]) {
      const ed = bq.editions[k], sh = tib * WA.slot_hours_per_tib;
      compare.push({ model: label, monthly: r2(sh * ed.payg * u), commit1: r2(sh * ed.cud1 * u), commit3: r2(sh * ed.cud3 * u) });
    }
    return {
      workload: W, regions: { data: regions[dataRid], pipelines: regions[pipeRid], streaming: regions[strmRid] },
      totals, monthly, by_category: categoryRows, lines: lineRows, by_region: regionRows,
      scan_tib_steady_month: Math.round(tib * 1000) / 1000, scan_lines_steady_month: scanLines, compute_comparison: compare,
      assumptions: WA, ramp_months: rampMonths, fx: pricing.fx,
      disclaimer: "Workload-based ballpark from public list prices. Query cost depends heavily on bytes scanned - partitioning, clustering, BI Engine and materialized views can reduce it substantially. Partner tools are not costed.",
    };
  }

  // ------------------------------------------------------------------ ramp-up plan (port of app/plan.py)
  const WEEKS_PER_MONTH = 4.33, FOUNDATION_WEEKS = 4;
  const EFFORT_WEEKS = { dts_free: 2, log_sink: 1, pubsub_bqsub: 2, pubsub: 3, datastream: 3, cloud_run: 3, app_integration: 3, files_transfer: 3,
    dataflow_batch: 4, dataflow_stream: 4, datafusion: 5, dataproc: 6, sap_connector: 8, dts_migration: 10 };
  const CATEGORY_EXTRA = { mainframe: 4, dwh: 0, hadoop: 4 };

  function sourceEffort(src, rec) {
    const engines = rec.engine.split("+");
    let weeks = Math.max(...engines.map((e) => (EFFORT_WEEKS[e] !== undefined ? EFFORT_WEEKS[e] : 4))) + (engines.length - 1);
    weeks += CATEGORY_EXTRA[(SOURCE_BY_ID[src.type] || {}).category] || 0;
    if (src.transform === "heavy") weeks += 2;
    if (num(src.initial_volume_gb) >= 100 * 1024) weeks += 4;
    return weeks;
  }

  function buildPlan(scenario) {
    const teams = Math.max(1, Math.trunc(num((scenario.plan || {}).teams) || 2));
    const prefs = { skill: scenario.skill || "sql", orchestration: scenario.orchestration || "auto", environment: scenario.environment || "production" };
    const sources = (scenario.sources || []).filter((s) => s.type && s.included !== false);
    const recs = sources.map((s) => recommend(s, prefs));
    const items = sources.map((s, i) => ({ idx: i, id: s.id || s.type, name: s.name || s.type, pattern: recs[i].pattern, primary: recs[i].primary, effort_weeks: sourceEffort(s, recs[i]) }));
    const order = [...items].sort((a, b) => a.effort_weeks - b.effort_weeks || a.idx - b.idx);
    const freeAt = new Array(teams).fill(FOUNDATION_WEEKS);
    for (const it of order) {
      let t = 0;
      for (let k = 1; k < teams; k++) if (freeAt[k] < freeAt[t]) t = k;
      it.team = t + 1; it.start_week = freeAt[t]; it.end_week = freeAt[t] + it.effort_weeks; freeAt[t] = it.end_week;
      it.build_start_month = Math.floor(it.start_week / WEEKS_PER_MONTH) + 1;
      it.go_live_month = Math.min(36, Math.max(2, Math.ceil(it.end_week / WEEKS_PER_MONTH)));
    }
    const waves = [...order].sort((a, b) => a.go_live_month - b.go_live_month || a.idx - b.idx);
    const goLives = waves.map((w) => w.go_live_month).sort((a, b) => a - b);
    const firstLive = goLives.length ? goLives[0] : 2;
    const halfLive = goLives.length ? goLives[Math.floor((goLives.length - 1) / 2)] : 2;
    const allLive = goLives.length ? goLives[goLives.length - 1] : 2;
    const { comps, sec } = normalizedComponents(scenario);
    const agentsMonth = Math.min(36, halfLive + 1);
    const compRows = comps.map((c) => {
      const meta = COMPONENT_BY_ID[c.type], cat = meta.category, t = c.type;
      let start;
      if (cat === "governance" || cat === "security") start = 1;
      else if (cat === "bi") start = firstLive;
      else if (["agent_platform", "vertex_gpu", "bqml"].includes(t) || (cat === "ai" && meta.vendor === "partner")) start = agentsMonth;
      else if (t === "gemini_enterprise") start = Math.min(36, agentsMonth + 1);
      else if (cat === "integration") start = agentsMonth;
      else if (cat === "database") start = Math.min(36, firstLive + 1);
      else start = firstLive;
      return { id: c.id, type: t, name: meta.name, category: cat, vendor: meta.vendor, start_month: start };
    });
    let horizon = Math.max(allLive + 2, ...compRows.map((c) => c.start_month + 1), 6);
    horizon = Math.min(horizon, 24);
    const phases = [{ key: "foundation", name: "Foundation & landing zone", start: 1, end: 1,
      items: ["Projects, IAM and org policies", "Networking" + (recs.some((r) => r.needs_connectivity) ? " and private connectivity" : ""),
        compRows.some((c) => c.category === "security") ? "Security controls: " + compRows.filter((c) => c.category === "security").map((c) => c.name).join(", ") : "Security baseline", "BigQuery datasets (raw / curated / marts)", "Dataform repo and CI/CD", "Monitoring and cost controls (budgets, quotas)"] }];
    for (const w of waves) phases.push({ key: "source", id: w.id, name: w.name, start: w.build_start_month, end: w.go_live_month, items: [w.pattern, `${w.effort_weeks} weeks, team ${w.team}`] });
    if (goLives.length) phases.push({ key: "elt", name: "Curated models & data quality (Dataform)", start: firstLive, end: allLive, items: ["Curated and mart layers per source as it lands", "Assertions and quality scans"] });
    for (const c of compRows) phases.push({ key: "component", id: c.id, category: c.category, vendor: c.vendor, name: c.name, start: c.start_month,
      end: Math.min(horizon, c.start_month + (c.category === "governance" || c.category === "security" ? 0 : 1)), items: [c.vendor === "google" ? "Rollout and enablement" : "Connect partner tool to BigQuery (not costed)"] });
    phases.push({ key: "hypercare", name: "Optimisation & hypercare", start: Math.min(horizon, allLive + 1), end: horizon, items: ["Partitioning, clustering, BI Engine", "Slot / commitment right-sizing", "FinOps review"] });
    const milestones = [{ month: 1, name: "Landing zone ready" }];
    if (goLives.length) { milestones.push({ month: firstLive, name: "First data live in BigQuery" }); milestones.push({ month: allLive, name: "All sources live" }); }
    if (compRows.some((c) => c.category === "bi")) milestones.push({ month: firstLive, name: "First dashboards" });
    if (compRows.some((c) => ["agent_platform", "gemini_enterprise"].includes(c.type))) milestones.push({ month: agentsMonth, name: "First data agents" });
    milestones.sort((a, b) => a.month - b.month);

    const ramped = JSON.parse(JSON.stringify(scenario));
    const startById = Object.fromEntries(waves.map((w) => [w.id, w.go_live_month]));
    (ramped.sources || []).forEach((s) => { s.start_month = startById[s.id || s.type] || 1; });
    const compStart = Object.fromEntries(compRows.map((c) => [c.id, c.start_month]));
    ramped.components = comps.map((c) => ({ ...c, start_month: compStart[c.id] || 1 }));
    delete ramped.platform;
    const est = estimate(ramped, true);
    const steady = estimate(JSON.parse(JSON.stringify(scenario)));
    const months = [];
    for (let m = 1; m <= horizon; m++) {
      const groups = {};
      for (const [k, v] of est._items) {
        const [mm, svc] = k.split("\u0001");
        if (+mm === m) { const g = serviceGroup(svc); groups[g] = (groups[g] || 0) + v; }
      }
      months.push({ month: m, total: round2(est.monthly[m - 1].payg), steady: round2(steady.monthly[m - 1].payg),
        by_group: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, round2(v)])),
        sources_live: waves.filter((w) => w.go_live_month === m).map((w) => w.name),
        components_started: compRows.filter((c) => c.start_month === m).map((c) => c.name) });
    }
    return {
      teams, horizon, phases, waves, components: compRows, milestones, months,
      totals: { ramped_year1: est.totals.year1_payg, steady_year1: steady.totals.year1_payg, ramped_three_year: est.totals.three_year_payg,
        steady_three_year: steady.totals.three_year_payg, ramped_year1_cud1: est.totals.year1_cud1, ramped_three_year_cud3: est.totals.three_year_cud3 },
      group_order: GROUP_ORDER,
      assumptions: { foundation_weeks: FOUNDATION_WEEKS, effort_weeks: EFFORT_WEEKS, weeks_per_month: WEEKS_PER_MONTH },
    };
  }

  const api = {
    catalog: () => Promise.resolve(D.catalog),
    samples: () => Promise.resolve(D.samples),
    estimate: (scenario) => Promise.resolve(estimate(JSON.parse(JSON.stringify(scenario)))),
    workload: (scenario) => Promise.resolve(workloadEstimate(JSON.parse(JSON.stringify(scenario)))),
    plan: (scenario) => Promise.resolve(buildPlan(JSON.parse(JSON.stringify(scenario)))),
  };
  root.ADVISOR_ENGINE = { recommend, estimate, workloadEstimate, buildPlan };
  root.ADVISOR_API = api;
  root.ADVISOR_DEMO = true;
})(typeof window !== "undefined" ? window : globalThis);
