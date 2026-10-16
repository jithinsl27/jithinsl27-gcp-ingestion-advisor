/* Data Cloud Compass - icons.js: icons for the architecture diagram.
 *
 * Built-in: a small set of original line icons, one per kind of service (database, stream, storage …).
 * Official product icons: run tools/install_gcp_icons.py with Google's icon pack (cloud.google.com/icons);
 * it copies the matching icons to app/static/icons/ and writes manifest.json, which is loaded here and used
 * in place of the built-in icon for that product.
 */
import { S } from "./state.js";

// 24x24 line icons (stroke = currentColor)
const G = {
  db: '<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  stream: '<path d="M3 8c3-3 6 3 9 0s6 3 9 0M3 13c3-3 6 3 9 0s6 3 9 0M3 18c3-3 6 3 9 0s6 3 9 0"/>',
  files: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  app: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 8h18M8 21h8"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.3 1.5A3.3 3.3 0 0 0 7 18z"/>',
  transfer: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  cdc: '<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  bucket: '<path d="M4 6h16l-2 14H6z"/><path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3"/>',
  warehouse: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M7.5 12v-2M10.5 12V8M13.5 12v-3"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V8M16 16v-8"/>',
  ai: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/>',
  api: '<path d="M8 6l-5 6 5 6M16 6l5 6-5 6M14 4l-4 16"/>',
  shield: '<path d="M12 3l8 3v6c0 4.4-3.4 8.2-8 9-4.6-.8-8-4.6-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8" r="1.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  key: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M21 12v2"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2 .6 3.3 2.4 3.6 5.5"/>',
  doc: '<path d="M6 3h12v18H6z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  monitor: '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
};

// which built-in icon each product / tool / component uses, and its key in the official-icon manifest
const PRODUCT = {
  datastream: ["cdc", "datastream"], dataflow: ["gear", "dataflow"], pubsub: ["stream", "pubsub"], bq_dts: ["transfer", "bigquery"],
  bq_migration: ["transfer", "bigquery"], datafusion: ["gear", "datafusion"], dataproc_serverless: ["gear", "dataproc"],
  storage_transfer: ["transfer", "storage_transfer"], transfer_appliance: ["transfer", "transfer_appliance"], bq_omni: ["warehouse", "bigquery"],
  sap_connector: ["transfer", "bigquery"], mqtt_broker: ["stream", "gke"], litmus: ["stream", ""], clearblade: ["stream", ""], mde: ["gear", "mde"],
  dms: ["cdc", "dms"], mainframe_connector: ["transfer", "bigquery"], managed_kafka: ["stream", "managed_kafka"], federated: ["link", "bigquery"],
  log_sink: ["monitor", "logging"], cloud_run_jobs: ["gear", "cloud_run"], app_integration: ["api", "app_integration"], object_tables: ["bucket", "gcs"],
  gcs_load: ["bucket", "gcs"], gcs_raw: ["bucket", "gcs"], gcs_lake: ["bucket", "gcs"], op_db: ["db", "alloydb"],
  ha_vpn: ["link", "vpn"], interconnect: ["link", "interconnect"], bigquery: ["warehouse", "bigquery"], dataform: ["layers", "dataform"],
  composer: ["gear", "composer"], workflows: ["gear", "workflows"], apigee: ["api", "apigee"],
  // components
  looker: ["chart", "looker"], looker_studio: ["chart", "looker_studio"], looker_studio_pro: ["chart", "looker_studio"], power_bi: ["chart", ""],
  tableau: ["chart", ""], microstrategy: ["chart", ""], qlik: ["chart", ""], thoughtspot: ["chart", ""], agent_platform: ["ai", "vertex_ai"],
  gemini_enterprise: ["ai", "gemini"], vertex_gpu: ["ai", "vertex_ai"], bqml: ["ai", "bigquery"], alloydb: ["db", "alloydb"], cloudsql: ["db", "cloudsql"],
  spanner: ["db", "spanner"], bigtable: ["db", "bigtable"], firestore: ["db", "firestore"], memorystore: ["db", "memorystore"],
  knowledge_catalog: ["tag", "dataplex"], sdp: ["shield", "sdp"], cmek: ["key", "kms"], vpc_sc: ["shield", "vpc_sc"], policy_tags: ["shield", "bigquery"],
  scc: ["shield", "scc"], assured_workloads: ["shield", "assured_workloads"], collibra: ["tag", ""], alation: ["tag", ""], atlan: ["tag", ""],
  informatica_cdgc: ["tag", ""], databricks: ["ai", ""], dataiku: ["ai", ""], datarobot: ["ai", ""], sagemaker: ["ai", ""], azure_ai: ["ai", ""],
};
// source categories -> built-in icon
const SOURCE_ICON = { rdbms: "db", rdbms_gcp: "db", rdbms_nocdc: "db", dwh: "warehouse", hadoop: "files", sap: "app", mainframe: "app", nosql: "db",
  nosql_gcp: "db", files_onprem: "files", object_aws: "cloud", object_azure: "cloud", object_gcp: "bucket", kafka: "stream", stream_aws: "stream",
  stream_azure: "stream", events: "stream", logs: "monitor", saas_google: "app", saas_salesforce: "app", saas_other: "app", api: "api",
  unstructured: "doc", custom: "app" };

export async function loadIconManifest() {
  try {
    const r = await fetch("static/icons/manifest.json", { cache: "no-cache" });
    S.iconManifest = r.ok ? await r.json() : {};
  } catch (_) { S.iconManifest = {}; }
}

export const productIconKey = (id) => (PRODUCT[id] || [])[0] || "gear";
export const sourceIconKey = (cat) => SOURCE_ICON[cat] || "app";

/** SVG for an icon at (x, y), size s: the official product icon when installed, otherwise the built-in glyph. */
export function iconSvg(x, y, s, glyph, productKey, cls = "") {
  const file = productKey && S.iconManifest?.[productKey];
  if (file) return `<image class="dg-icon-img" href="${file}" x="${x}" y="${y}" width="${s}" height="${s}"/>`;
  const p = G[glyph] || G.gear;
  return `<g class="dg-icon ${cls}" transform="translate(${x},${y}) scale(${s / 24})" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</g>`;
}

export function productIcon(x, y, s, id, cls) {
  const [g, k] = PRODUCT[id] || ["gear", ""];
  return iconSvg(x, y, s, g, k, cls);
}
