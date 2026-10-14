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

  function platformStory(L, sources) {
    const blocks = [];
    const cdc = sources.filter((s) => (SOURCE_BY_ID[s.type] || {}).cdc && STREAMING.has(s.frequency)).map((s) => s.name || s.type);
    blocks.push({
      key: "lakehouse", title: "BigQuery lakehouse foundation", tools: ["dataform", "bqml", "reverse_etl"],
      points: [
        "Raw, curated and mart datasets in BigQuery; open Apache Iceberg tables through BigLake keep data portable across engines.",
        cdc.length ? "Continuous CDC from " + cdc.slice(0, 4).join(", ") + " keeps operational data fresh for analytics and agents." : "Add CDC sources (Datastream) when agents and dashboards need minute-level freshness.",
        "Dataform builds tested, version-controlled SQL models; BigQuery ML and AI functions bring Gemini and vector search into SQL.",
        "Reverse ETL syncs curated results back to AlloyDB or Spanner for applications and agent tools.",
      ],
    });
    const bi = L.bi;
    if (bi.enabled) {
      let pts;
      if (bi.tool === "looker") pts = ["Looker connects live to BigQuery (no extracts); LookML and BigQuery measures form one governed semantic layer.", "The same semantic model feeds Looker dashboards, Looker Studio, Sheets, and Conversational Analytics, so numbers match everywhere.", "Licensing is quote-based - enter the customer's annual quote in the settings to include it."];
      else if (bi.tool === "looker_studio_pro") pts = ["Looker Studio Pro dashboards on BigQuery with team workspaces and governance.", "Upgrade path to Looker when a governed semantic layer is needed."];
      else pts = ["Looker Studio dashboards on BigQuery at no licence cost.", "Upgrade to Looker for a governed semantic layer."];
      blocks.push({ key: "bi", title: "Business intelligence", tools: [bi.tool === "looker" ? "looker" : "looker_studio"], points: pts });
    }
    const aiTools = [], aiPts = [];
    if (L.agents.enabled) {
      aiTools.push("agent_platform", "conversational_analytics");
      aiPts.push("Agents built with the Agent Development Kit run on Agent Engine (managed sessions and Memory Bank) and call Gemini models.",
        "BigQuery is exposed to agents through MCP / BigQuery tools, with every query running under the end-user's IAM, policy tags and masking.",
        "Conversational Analytics and BigQuery data agents answer business questions in natural language with traceable SQL.");
    }
    if (L.gemini_enterprise.enabled) {
      aiTools.push("gemini_enterprise");
      aiPts.push(`Gemini Enterprise (${titleCase(L.gemini_enterprise.edition)}) puts these agents, Deep Research and grounded search in front of ${Math.trunc(num(L.gemini_enterprise.users))} employees.`);
    }
    if (L.gpu.enabled) {
      aiTools.push("gpu_endpoints");
      aiPts.push(`Custom or open models (Model Garden, vLLM) are served on Vertex AI endpoints with ${Math.trunc(num(L.gpu.replicas))} x ${L.gpu.gpu.toUpperCase()} replica(s); BigQuery calls them as remote models for batch scoring.`);
    }
    if (aiTools.length) blocks.push({ key: "ai", title: "Agentic AI on BigQuery", tools: aiTools, points: aiPts });
    if (L.governance.enabled) {
      blocks.push({
        key: "governance", title: "Governance with Knowledge Catalog (Dataplex)", tools: ["knowledge_catalog"],
        points: [
          "Automatic discovery and technical metadata for every BigQuery, Cloud Storage and AlloyDB / Spanner / Cloud SQL asset.",
          "End-to-end lineage from Datastream / Dataflow / Dataform jobs to Looker dashboards and agent answers.",
          `Data profiling and quality scans on about ${Math.trunc(num(L.governance.dq_share_pct))}% of tables, published as quality scores in the catalog.`,
          "Business glossary and semantic search give agents the business context they need to answer correctly.",
        ],
      });
    }
    if (L.security.enabled) {
      const tools = ["fine_grained", "vpc_sc", "scc"];
      const pts = ["Column-level policy tags, row access policies and dynamic data masking apply equally to SQL, Looker and agents.",
        "VPC Service Controls perimeter around ingestion, BigQuery and Vertex AI projects; Private Service Connect for endpoints.",
        "Security Command Center for posture management and threat detection, including AI workloads."];
      if (L.security.cmek) {
        tools.unshift("cmek");
        pts.unshift("Customer-managed encryption keys (Cloud KMS, optionally Cloud EKM) across BigQuery, Cloud Storage, Pub/Sub, Datastream and Vertex AI - relevant for data-residency regulations such as KSA PDPL / NCA ECC.");
      }
      if (L.security.sdp_discovery) {
        tools.unshift("sdp");
        pts.unshift("Sensitive Data Protection profiles every BigQuery table, classifies PII and can auto-apply policy tags.");
      }
      blocks.push({ key: "security", title: "Security & compliance", tools, points: pts });
    }
    return blocks;
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

  function mergedLayer(scenario) {
    const raw = scenario.platform || {};
    const out = {};
    for (const [k, v] of Object.entries(D.default_layer)) {
      const given = raw[k] || {};
      out[k] = { ...v };
      for (const [kk, vv] of Object.entries(given)) if (vv !== null && vv !== undefined) out[k][kk] = vv;
    }
    return out;
  }

  function estimate(scenario) {
    const pricing = D.pricing;
    const regions = Object.fromEntries(D.regions.map((r) => [r.id, r]));
    const region = regions[scenario.region || "us-central1"] || regions["us-central1"];
    const uplift = region.uplift;
    const growth = num(scenario.annual_growth_pct ?? 20) / 100;
    const prefs = { skill: scenario.skill || "sql", orchestration: scenario.orchestration || "auto", environment: scenario.environment || "production" };
    const bqModel = scenario.bq_model || "ondemand";
    const sources = (scenario.sources || []).filter((s) => s.type);
    const up = (k) => (pricing[k].regional ? uplift : 1);

    const recs = sources.map((s) => recommend(s, prefs));
    const platform = platformComponents(sources, recs, prefs);

    const payg = new Map(), cud1 = new Map(), cud3 = new Map();
    const key = (m, svc, sid) => `${m}\u0001${svc}\u0001${sid}`;
    const inc = (map, k, v) => map.set(k, (map.get(k) || 0) + v);
    function add(m, svc, sid, usd, c1, c3) {
      if (!usd) return;
      const k = key(m, svc, sid);
      inc(payg, k, usd);
      inc(cud1, k, c1 === undefined ? usd : c1);
      inc(cud3, k, c3 === undefined ? usd : c3);
    }

    const df = pricing.dataflow, ds = pricing.datastream, ps = pricing.pubsub, bq = pricing.bigquery;
    const z = () => new Array(37).fill(0);
    const dsCdc = z(), writeApi = z(), streamIns = z(), netGib = z(), ingGib = z(), landing = z();
    let dsBackfill = 0, initialTotal = 0;
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
      initialTotal += initial;
      meta.push({ id: sid, name });

      for (let m = 1; m <= 36; m++) {
        const daily = oneTime ? 0 : daily0 * growthFactor(m, growth);
        const monthly = daily * 30;
        ingGib[m] += monthly;
        netGib[m] += monthly * netRatio;
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
        if (m === 1 && initial > 0) {
          const pe = engines[0];
          if (pe === "datastream") dsBackfill += initial;
          else if (pe === "dataflow_batch" || pe === "dataflow_stream") {
            const vh = batchVcpuHours(initial, Math.max(1, Math.ceil(initial / 2000)), "light");
            add(1, "One-time initial load", sid, (vh * df.batch_vcpu_hr + vh * A.memory_gib_per_vcpu * df.memory_gib_hr) * up("dataflow"));
          } else if (pe === "datafusion") {
            const vh = Math.max(A.datafusion_min_vcpu_hr_per_run, initial / A.datafusion_gb_per_vcpu_hr);
            add(1, "One-time initial load", sid, vh * pricing.datafusion.pipeline_vcpu_hr_all_in * up("datafusion"));
          } else if (pe === "dataproc") {
            const dcu = Math.max(A.spark_min_dcu_hr_per_run, initial / A.spark_gb_per_dcu_hr.light);
            add(1, "One-time initial load", sid, dcu * pricing.dataproc_serverless.dcu_hr * up("dataproc_serverless"));
          } else if (pe === "files_transfer") {
            if (onPrem || cat === "mainframe") add(1, "One-time initial load", sid, initial * pricing.storage_transfer.agent_gib);
            add(1, "One-time initial load", sid, initial * pricing.gcs.standard_gib_month * up("gcs"));
          } else if (pe === "dts_migration" && src.type === "teradata") {
            add(1, "One-time initial load", sid, (initial / A.teradata_agent_gb_per_hr) * pricing.compute_engine.vm_standard_4vcpu_hr * up("compute_engine"));
          } else if (pe === "sap_connector") writeApi[1] += initial;
        }
      }
    });

    // Datastream tiers, shared across the billing account
    const dsVols = {};
    sources.forEach((s, i) => { if (recs[i].engine.split("+").includes("datastream") && s.frequency !== "one_time") dsVols[s.id || s.type] = num(s.daily_change_gb); });
    const dsTot = Object.values(dsVols).reduce((a, b) => a + b, 0) || 1;
    for (let m = 1; m <= 36; m++) {
      if (dsCdc[m]) {
        const total = tiered(dsCdc[m], ds.cdc_tiers_gib);
        for (const [sid, v] of Object.entries(dsVols)) add(m, "Datastream (CDC)", sid, total * (v / dsTot));
      }
    }
    if (dsBackfill) add(1, "One-time initial load", "_datastream_backfill", Math.max(0, dsBackfill - ds.backfill_free_gib) * ds.backfill_gib);

    // BigQuery
    const bqUp = up("bigquery");
    let stored = initialTotal;
    const history = [], storedBy = z();
    const analyticsIn = scenario.analytics_tib_month;
    const slots = num(scenario.bq_slots) || 100;
    const mult = 1 + A.curated_layers_overhead;
    for (let m = 1; m <= 36; m++) {
      history.push(netGib[m]);
      stored += netGib[m];
      storedBy[m] = stored;
      const recent = history.slice(-3).reduce((a, b) => a + b, 0) + (m <= 3 ? initialTotal : 0);
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
      else {
        const ed = bq.editions[bqModel], sh = slots * HOURS;
        add(m, "BigQuery compute", "_platform", sh * ed.payg * bqUp, sh * ed.cud1 * bqUp, sh * ed.cud3 * bqUp);
      }
    }

    const orch = platform.orchestration.tool;
    if (orch === "composer") {
      const cp = pricing.composer;
      const dcuH = cp[sources.length <= 10 ? "small_env_avg_dcu" : "medium_env_avg_dcu"] * HOURS;
      for (let m = 1; m <= 36; m++) add(m, "Composer (Airflow)", "_platform", dcuH * cp.dcu_hr * up("composer"), dcuH * cp.cud1_dcu_hr * up("composer"), dcuH * cp.cud3_dcu_hr * up("composer"));
    } else if (orch === "workflows") {
      for (let m = 1; m <= 36; m++) add(m, "Workflows + Scheduler", "_platform", sources.length * pricing.workflows.scheduler_job_month);
    }
    if (platform.datafusion_edition) {
      const dfp = pricing.datafusion;
      const inst = platform.datafusion_edition === "enterprise" ? HOURS * dfp.enterprise_hr : Math.max(0, HOURS - dfp.basic_free_hours) * dfp.basic_hr;
      const label = `Data Fusion instance (${titleCase(platform.datafusion_edition)})`;
      for (let m = 1; m <= 36; m++) add(m, label, "_platform", inst * up("datafusion"));
    }
    if (platform.connectivity === "ha_vpn") {
      const n = pricing.network;
      for (let m = 1; m <= 36; m++) add(m, "Network (HA VPN)", "_platform", n.ha_vpn_tunnel_hr * n.ha_vpn_tunnels * HOURS);
    } else if (platform.connectivity === "interconnect") {
      const ic = pricing.interconnect;
      for (let m = 1; m <= 36; m++) add(m, "Network (Interconnect)", "_platform", ic.dedicated_10g_port_month + ic.vlan_attachment_hr * ic.vlan_attachments * HOURS);
    }
    for (let m = 1; m <= 36; m++) if (landing[m]) add(m, "Cloud Storage (landing zone)", "_platform", landing[m] * pricing.gcs.standard_gib_month * up("gcs"));

    // analytics, AI, governance, security
    const L = mergedLayer(scenario);
    const tables = sources.reduce((a, s) => a + Math.trunc(num(s.tables) || 50), 0) * (1 + A.curated_layers_overhead * 3);
    for (let m = 1; m <= 36; m++) {
      if (L.bi.enabled) {
        if (L.bi.tool === "looker") add(m, "Looker licence (customer quote)", "_ai", num(L.bi.looker_annual_usd) / 12);
        else if (L.bi.tool === "looker_studio_pro") add(m, "Looker Studio Pro", "_ai", num(L.bi.users) * pricing.looker.studio_pro_user_month);
      }
      if (L.gemini_enterprise.enabled) add(m, "Gemini Enterprise", "_ai", num(L.gemini_enterprise.users) * pricing.gemini_enterprise[`${L.gemini_enterprise.edition}_user_month`]);
      if (L.agents.enabled) {
        const ag = L.agents, req = num(ag.requests_month), ae = pricing.agent_engine;
        const vcpuH = Math.max(0, (req * num(ag.agent_seconds)) / 3600 - ae.free_vcpu_hr);
        const gibH = Math.max(0, (req * num(ag.agent_seconds) * 2) / 3600 - ae.free_gib_hr);
        const u = up("agent_engine");
        add(m, "Agent Engine runtime", "_ai", (vcpuH * ae.vcpu_hr + gibH * ae.gib_hr) * u, (vcpuH * ae.cud1_vcpu_hr + gibH * ae.cud1_gib_hr) * u, (vcpuH * ae.cud3_vcpu_hr + gibH * ae.cud3_gib_hr) * u);
        const gm = pricing.gemini_models[ag.model];
        add(m, `${gm.name} tokens (agents)`, "_ai", (req * (num(ag.input_tokens) * gm.input_mtok + num(ag.output_tokens) * gm.output_mtok)) / 1e6);
        if (bqModel === "ondemand") add(m, "BigQuery queries from agents", "_ai", ((req * num(ag.bq_gb_per_request)) / GIB_PER_TIB) * pricing.bigquery.ondemand_tib * up("bigquery"));
      }
      if (L.gpu.enabled) {
        const node = pricing.vertex_prediction.nodes[L.gpu.gpu];
        add(m, `Vertex AI endpoint (${node.name})`, "_ai", num(L.gpu.replicas) * num(L.gpu.hours_per_day) * 30.4 * node.hr * up("vertex_prediction"));
      }
      if (L.governance.enabled) {
        const dp = pricing.dataplex;
        const dqTables = (tables * num(L.governance.dq_share_pct)) / 100;
        const dcu = dqTables * num(L.governance.dq_scans_per_month) * dp.dq_dcu_hr_per_table_scan + tables * dp.lineage_dcu_hr_per_table_month;
        const u = up("dataplex"), metaGib = Math.max(1, tables / 1000);
        add(m, "Knowledge Catalog (Dataplex) - quality, profiling, lineage", "_governance",
          (dcu * dp.premium_dcu_hr + metaGib * dp.metadata_gib_month) * u,
          (dcu * dp.premium_cud1_dcu_hr + metaGib * dp.metadata_gib_month) * u,
          (dcu * dp.premium_cud3_dcu_hr + metaGib * dp.metadata_gib_month) * u);
      }
      if (L.security.enabled) {
        if (L.security.sdp_discovery) add(m, "Sensitive Data Protection (discovery)", "_governance", (m === 1 ? storedBy[m] : netGib[m]) * pricing.sensitive_data_protection.discovery_gb);
        if (L.security.cmek) add(m, "Cloud KMS (CMEK)", "_governance", 20 * pricing.kms.key_version_month + 300 * pricing.kms.ops_per_10k);
      }
    }
    platform.layer = { settings: L, tables_estimated: Math.trunc(tables), story: platformStory(L, sources) };

    const cont = num(scenario.contingency_pct ?? A.contingency * 100) / 100;
    for (const view of [payg, cud1, cud3]) {
      const mt = z();
      for (const [k, v] of view) mt[+k.split("\u0001")[0]] += v;
      for (let m = 1; m <= 36; m++) if (mt[m]) inc(view, key(m, "Contingency & operations", "_platform"), mt[m] * cont);
    }
    return summarise(payg, cud1, cud3, recs, platform, meta, region);
  }

  const GROUP_ORDER = ["Data ingestion & CDC", "BigQuery", "Analytics & AI", "Governance & security", "Platform & network", "Contingency"];
  function serviceGroup(name) {
    const n = name.toLowerCase();
    if (n.startsWith("bigquery") && !n.includes("agents")) return "BigQuery";
    if (["looker", "gemini", "agent", "vertex ai"].some((k) => n.includes(k))) return "Analytics & AI";
    if (["knowledge catalog", "sensitive data", "kms"].some((k) => n.includes(k))) return "Governance & security";
    if (["composer", "workflows", "network", "landing", "data fusion instance"].some((k) => n.includes(k))) return "Platform & network";
    if (n.includes("contingency")) return "Contingency";
    return "Data ingestion & CDC";
  }

  function summarise(payg, cud1, cud3, recs, platform, meta, region) {
    const parse = (k) => { const [m, svc, sid] = k.split("\u0001"); return { m: +m, svc, sid }; };
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
      _ai: "Analytics & AI layer (BI, Gemini Enterprise, agents, GPU serving)",
      _governance: "Governance & security (Knowledge Catalog, SDP, KMS)",
    });
    const sourceRows = [...src3.keys()].sort((a, b) => (a.startsWith("_") - b.startsWith("_")) || (src3.get(b) - src3.get(a)))
      .map((k) => ({ id: k, name: nameOf[k] || k, year1: round2(src1.get(k) || 0), three_year: round2(src3.get(k) || 0) }));
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
      region, currency: "USD", fx: D.pricing.fx, totals: t, by_service: serviceRows, by_group: groupRows, by_source: sourceRows,
      monthly, recommendations: recs, platform, assumptions: A, pricing_meta: pm,
      disclaimer: `Ballpark estimate for discovery discussions only. Based on public list prices (reviewed ${pm.last_reviewed}) with an approximate regional uplift of x${region.uplift.toFixed(2)} for ${region.name}. Excludes taxes, support, egress from other clouds, partner licences and negotiated discounts. Validate with the Google Cloud Pricing Calculator.`,
    };
  }

  const api = {
    catalog: () => Promise.resolve(D.catalog),
    samples: () => Promise.resolve(D.samples),
    estimate: (scenario) => Promise.resolve(estimate(JSON.parse(JSON.stringify(scenario)))),
  };
  root.ADVISOR_ENGINE = { recommend, estimate };
  root.ADVISOR_API = api;
  root.ADVISOR_DEMO = true;
})(typeof window !== "undefined" ? window : globalThis);
