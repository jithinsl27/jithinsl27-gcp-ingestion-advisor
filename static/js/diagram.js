/* Data Cloud Compass - diagram.js (ES module, no build step). */
import { S } from "./state.js";
import { addComponent } from "./components.js";
import { $, $$, STREAMING, esc, toast } from "./core.js";
import { fmtGB } from "./cost.js";
import { changed } from "./events.js";
import { compMeta } from "./pricing.js";
import { flowClass, freqName, recFor, tool } from "./render.js";
import { iconSvg, productIcon, sourceIconKey } from "./icons.js";

// ---------------- architecture diagram
export const INTEGRATION_CATS = new Set(["api", "saas_other", "saas_salesforce", "sap"]);

export const GE_LABEL = { bigquery: "Grounded on BigQuery", looker: "Grounded on Looker semantic layer", both: "Grounded on BigQuery + Looker", agents: "Via data agents" };

export const APIGEE_LABEL = { integration: "Integration layer · data APIs", agents: "AI gateway & tools for agents", both: "Integration layer + AI gateway" };

// Short, presentation-friendly labels for the diagram: [title, subtitle]
const DG = {
  datastream: ["Datastream", "Serverless CDC"], dataflow: ["Dataflow", "Stream & batch pipelines"], pubsub: ["Pub/Sub", "Event streaming"],
  bq_dts: ["BigQuery Data Transfer", "Managed connectors"], bq_migration: ["BigQuery Migration", "DWH migration & SQL translation"],
  datafusion: ["Cloud Data Fusion", "Low-code pipelines"], dataproc_serverless: ["Dataproc Serverless", "Spark, no cluster to manage"],
  storage_transfer: ["Storage Transfer", "Agent-based file transfer"], transfer_appliance: ["Transfer Appliance", "Offline bulk seed"],
  bq_omni: ["BigQuery Omni", "Query in place via BigLake"], sap_connector: ["BQ Connector for SAP", "SLT replication to BigQuery"],
  mqtt_broker: ["MQTT broker", "HA pair on GKE"], litmus: ["Litmus Edge", "Partner (ISV) · not costed"], clearblade: ["ClearBlade IoT Core", "Partner (ISV) · not costed"],
  mde: ["Manufacturing Data Engine", "IoT contextualisation"], dms: ["Database Migration", "DMS · continuous CDC"],
  mainframe_connector: ["Mainframe Connector", "EBCDIC / copybook → ORC"], managed_kafka: ["Managed Kafka", "Apache Kafka on Google Cloud"],
  federated: ["Federated queries", "Query in place"], log_sink: ["Logging sink", "Cloud Logging → BigQuery"],
  cloud_run_jobs: ["Cloud Run jobs", "Scheduled API extracts"], app_integration: ["Application Integration", "Integration Connectors"],
  object_tables: ["Object tables", "Cloud Storage + BigQuery"], gcs_load: ["GCS landing + load", "Free batch load jobs"],
};
const LAND_TOOLS = new Set(["gcs_load", "object_tables", "gcs_raw"]);
// Controls every enterprise data platform should have - offered as one-click additions when missing
const RECOMMENDED_CONTROLS = ["knowledge_catalog", "policy_tags", "cmek", "vpc_sc", "sdp"];
// Platform foundation that is part of any enterprise landing zone (not separately priced)
const FOUNDATION = [
  ["Landing zone & org policies", "Folders and projects per environment, Shared VPC"],
  ["IAM & Workload Identity", "Groups, least privilege, no SA keys"],
  ["Terraform + Cloud Build", "IaC and CI/CD for pipelines and Dataform"],
  ["Cloud Logging & Monitoring", "Audit logs, pipeline SLOs and alerting"],
  ["Backup & DR", "Time travel, snapshots, cross-region replicas"],
  ["FinOps guardrails", "Budgets, quotas, labels, reservations"],
];

let _ctx = null, _family = null;
function textW(t, size, weight) {
  if (!_ctx) { try { _ctx = document.createElement("canvas").getContext("2d"); } catch (_) { _ctx = null; } }
  if (!_family) _family = (typeof getComputedStyle === "function" && getComputedStyle(document.body).fontFamily) || "Roboto, Arial, sans-serif";
  if (!_ctx) return String(t).length * size * 0.56;
  _ctx.font = `${weight} ${size}px ${_family}`;
  return _ctx.measureText(String(t)).width;
}
/** Fit text into maxW: shrink the font down to minSize, then clip with an ellipsis. */
export function fitText(t, maxW, size, minSize, weight = 500) {
  t = String(t ?? "");
  for (let fs = size; fs >= minSize - 1e-9; fs -= 0.5) if (textW(t, fs, weight) <= maxW) return { t, fs, cut: false };
  let lo = 1, hi = t.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (textW(t.slice(0, mid) + "…", minSize, weight) <= maxW) lo = mid; else hi = mid - 1; }
  return { t: t.slice(0, lo).trimEnd() + "…", fs: minSize, cut: true };
}

/** Place boxes near their wanted y without overlapping, inside [lo, hi]. */
function place(items, h, gap, lo, hi) {
  const sorted = [...items].sort((a, b) => a.want - b.want);
  let y = lo;
  sorted.forEach((it) => { it.y = Math.max(y, it.want); y = it.y + h + gap; });
  const over = sorted.length ? sorted[sorted.length - 1].y + h - hi : 0;
  if (over > 0) {
    let limit = hi;
    for (let i = sorted.length - 1; i >= 0; i--) { sorted[i].y = Math.min(sorted[i].y, limit - h); limit = sorted[i].y - gap; }
    if (sorted.length && sorted[0].y < lo) { const step = (hi - lo - h) / Math.max(1, sorted.length - 1); sorted.forEach((it, i) => (it.y = lo + step * i)); }
  }
  return Object.fromEntries(sorted.map((it) => [it.key, it.y]));
}

export function renderDiagram() {
  const host = $("#diagram");
  const srcs = S.scenario.sources;
  let W = 1580;
  if (!srcs.length || !S.result) {
    host.innerHTML = `<svg viewBox="0 0 ${W} 220" role="img" aria-label="Empty architecture"><text class="dg-empty" x="${W / 2}" y="110" text-anchor="middle">Add a source system to start drawing the target architecture.</text></svg>`;
    return;
  }
  const plat = S.result.platform;
  const lake = plat.lakehouse || { raw_zone: false, layers: [] };
  const rowH = 66, top = 46, nodeH = 48;
  const cw = { src: 220, conn: 112, ing: 190, raw: 120, proc: 190, bq: 236, out: 272 };
  const col = {};  // x positions are laid out once we know which columns are needed

  const comps = S.scenario.components.map((c) => ({ c, m: compMeta(c.type) })).filter((x) => x.m);
  const CONSUME_CATS = ["bi", "ai", "integration", "database"];
  const consume = CONSUME_CATS.flatMap((cat) => comps.filter((x) => x.m.category === cat));
  const govComps = [...comps.filter((x) => x.m.category === "governance"), ...comps.filter((x) => x.m.category === "security")];
  const groupGap = 22;
  const nGroups = CONSUME_CATS.filter((cat) => comps.some((x) => x.m.category === cat)).length;
  const apigee = comps.find((x) => x.c.type === "apigee");
  const apigeeRole = apigee ? apigee.c.settings.role || "both" : null;
  const ge = comps.find((x) => x.c.type === "gemini_enterprise");
  const geMode = ge ? ge.c.settings.grounding || "bigquery" : null;
  const short = (id) => DG[id] || [tool(id).name, ""];

  // which flows land in the Cloud Storage raw zone first (batch / file engines, or everything)
  const RAW_ENG = ["files_transfer", "dataflow_batch", "datafusion", "dataproc", "cloud_run", "app_integration", "dts_migration"];
  const inRaw = (s) => lake.raw_zone && s.included !== false && recFor(s.id)?.target === "data_platform" && (lake.raw_scope === "all" || (!STREAMING.has(s.frequency) && (recFor(s.id)?.engine || "").split("+").some((e) => RAW_ENG.includes(e))));
  const apiCat = (s) => INTEGRATION_CATS.has(S.catalog.source_types.find((t) => t.id === s.type)?.category);
  const useApigee = apigee && apigeeRole !== "agents";

  // 1. classify every source, then order them so related flows sit together (fewer crossings)
  const info = srcs.map((s, i) => {
    const r = recFor(s.id);
    const o = { s, r, i, raw: r ? inRaw(s) : false };
    if (r) {
      let ch = r.chain.filter((t) => t !== "gcs_lake" && t !== "op_db");
      if (o.raw) { const noLand = ch.filter((t) => !LAND_TOOLS.has(t)); if (noLand.length) ch = noLand; }
      o.ing = ch[0] || r.chain[0];
      o.proc = ch.length > 1 ? ch.slice(1).join(">") : null;
      if (r.target === "operational_db") o.proc = null;
      o.grp = r.needs_connectivity ? 0 : useApigee && apiCat(s) ? 1 : 2;
    } else o.grp = 3;
    return o;
  });
  const firstIng = {};
  info.forEach((o) => { if (o.ing && !(o.ing in firstIng)) firstIng[o.ing] = o.i; });
  info.sort((a, b) => (a.grp - b.grp) || ((a.grp === 0 ? +a.raw : -a.raw) - (b.grp === 0 ? +b.raw : -b.raw)) || ((firstIng[a.ing] ?? 999) - (firstIng[b.ing] ?? 999)) || (a.i - b.i));

  {
    const need = { conn: info.some((o) => o.r && o.grp <= 1), raw: info.some((o) => o.r && o.raw), proc: info.some((o) => o.r && o.proc) };
    let x = 16;
    ["src", "conn", "ing", "raw", "proc", "bq", "out"].forEach((k) => {
      if (k in need && !need[k]) return;
      col[k] = x; x += cw[k] + (k === "proc" || k === "bq" || (k === "raw" && !need.proc) || (k === "ing" && !need.raw && !need.proc) ? 36 : 30);
    });
    W = col.out + cw.out + 34;
    col.conn ??= col.src; col.raw ??= col.ing; col.proc ??= col.ing;
  }
  const nTargets = new Set(info.map((o) => o.r?.target).filter(Boolean)).size;
  const flowH = Math.max(400 + (nTargets > 1 ? (nTargets - 1) * 62 : 0), top + srcs.length * rowH + 30, top + consume.length * 58 + groupGap * Math.max(0, nGroups - 1) + 40);
  const lo = top, hi = flowH - 20;
  info.forEach((o, k) => { o.x = col.src; o.y = top + k * rowH; o.my = o.y + nodeH / 2; });

  const tgtOf = (o) => o.r?.target || "data_platform";
  const hasMesh = info.some((o) => o.r && tgtOf(o) === "data_mesh");
  const hasBQ = info.some((o) => o.r && (tgtOf(o) === "data_platform" || tgtOf(o) === "data_mesh"));
  const hasLake = info.some((o) => o.r && tgtOf(o) === "data_lake");
  const hasOpdb = info.some((o) => o.r && tgtOf(o) === "operational_db");
  const meshH = nodeH + 16;
  const extraH = (hasMesh ? meshH + 14 : 0) + (hasLake ? nodeH + 14 : 0) + (hasOpdb ? nodeH + 14 : 0);
  const bqY = top, bqH = flowH - top - 20 - extraH;
  let ey = bqY + bqH + 14;
  const meshPos = hasMesh ? { x: col.bq, y: ey } : null;
  if (hasMesh) ey += meshH + 14;
  const lakePos = hasLake ? { x: col.bq, y: ey } : null;
  if (hasLake) ey += nodeH + 14;
  const opdbPos = hasOpdb ? { x: col.bq, y: ey } : null;
  const avg = (a) => a.reduce((x, v) => x + v, 0) / a.length;

  // 2. connectivity and Apigee hops sit at the centre of the sources they serve
  const connSrc = info.filter((o) => o.r && o.grp === 0);
  const apiSrc = info.filter((o) => o.r && o.grp === 1);
  const hopItems = [];
  if (connSrc.length) hopItems.push({ key: "conn", want: avg(connSrc.map((o) => o.y)) });
  if (apiSrc.length) hopItems.push({ key: "api", want: avg(apiSrc.map((o) => o.y)) });
  const hopY = place(hopItems, nodeH, 14, lo, hi);

  // 3. ingestion nodes at the barycentre of their sources
  const ingKeys = [...new Set(info.filter((o) => o.r).map((o) => o.ing))];
  const ingY = place(ingKeys.map((k) => ({ key: k, want: avg(info.filter((o) => o.ing === k).map((o) => o.my)) - nodeH / 2 })), nodeH, 14, lo, hi);
  info.forEach((o) => { if (o.r) o.ingY = ingY[o.ing] + nodeH / 2; });

  // 4. raw zone spans the flows that land in it
  const rawFlows = info.filter((o) => o.r && o.raw);
  let rawPos = null;
  if (rawFlows.length) {
    const ys = rawFlows.map((o) => o.ingY);
    const h = Math.max(84, Math.max(...ys) - Math.min(...ys) + 40);
    let y = avg([Math.min(...ys), Math.max(...ys)]) - h / 2;
    y = Math.max(lo, Math.min(hi - h, y));
    rawPos = { x: col.raw, y, h };
    rawFlows.forEach((o) => { o.rawY = Math.max(y + 14, Math.min(y + h - 14, o.ingY)); });
  }
  const procX = col.proc;

  // 5. processing nodes at the barycentre of the flows that reach them
  const procKeys = [...new Set(info.filter((o) => o.r && o.proc).map((o) => o.proc))];
  const procY = place(procKeys.map((k) => ({ key: k, want: avg(info.filter((o) => o.proc === k).map((o) => (o.raw ? o.rawY : o.ingY))) - nodeH / 2 })), nodeH, 14, lo, hi);

  const curve = (x1, y1, x2, y2) => { const dx = (x2 - x1) / 2; return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`; };
  let edges = "", nodes = "", over = "";
  const node = (x, y, w, title, sub, cls = "", attrs = "", tag = "", h = nodeH, icon = "") => {
    const ix = icon ? 30 : 0;
    const ft = fitText(title, w - 24 - ix - (tag ? 56 : 0), 12.5, 11, 500);
    const fs = sub ? fitText(sub, w - 24 - ix, 11, 10, 400) : null;
    const full = sub ? `${title} - ${sub}` : title;
    return `<g class="dg-node ${cls}" ${attrs}><title>${esc(full)}</title><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>
      ${icon ? `<g class="dg-ico">${icon(x + 10, y + h / 2 - 10)}</g>` : ""}
      <text x="${x + 12 + ix}" y="${y + (sub ? 20 : 29)}"${ft.fs !== 12.5 ? ` style="font-size:${ft.fs}px"` : ""}>${esc(ft.t)}</text>
      ${fs ? `<text class="sub" x="${x + 12 + ix}" y="${y + 37}"${fs.fs !== 11 ? ` style="font-size:${fs.fs}px"` : ""}>${esc(fs.t)}</text>` : ""}
      ${tag ? `<text class="tag" x="${x + w - 10}" y="${y + 17}" text-anchor="end">${esc(tag)}</text>` : ""}</g>`;
  };
  const pi = (id) => (X, Y) => productIcon(X, Y, 20, id);
  const si = (glyph) => (X, Y) => iconSvg(X, Y, 20, glyph, "");
  const srcCat = (s) => S.catalog.source_types.find((t) => t.id === (s.type === "custom" ? s.like_type : s.type))?.category || "custom";
  const crossesRaw = (y1, y2) => rawPos && Math.max(y1, y2) > rawPos.y - 4 && Math.min(y1, y2) < rawPos.y + rawPos.h + 4;

  // 6. sources and their flows
  info.forEach((o) => {
    const fc = flowClass(o.s.frequency);
    const reg = o.s.region && o.s.region !== S.scenario.region ? ` · ${o.s.region}` : "";
    const off = o.s.included === false;
    const iotOpt = o.s.type === "iot" ? S.catalog.iot_options.find((x) => x.id === (o.s.iot_option || "native")) : null;
    const sub = off ? "Later phase - not in this estimate" : `${freqName(o.s.frequency)} · ${fmtGB(o.s.daily_change_gb)}/day${reg}`;
    nodes += node(o.x, o.y, cw.src, o.s.name, iotOpt && !off ? `${iotOpt.vendor === "partner" ? "ISV" : "Native"} IoT · ${fmtGB(o.s.daily_change_gb)}/day` : sub,
      `src clickable${off ? " excluded" : ""}`, `data-src="${esc(o.s.id)}" data-drop="sources" tabindex="0" role="button" aria-label="Edit ${esc(o.s.name)}"`, "", nodeH, si(sourceIconKey(srcCat(o.s))));
    if (!o.r) return;
    let x = o.x + cw.src, y = o.my;
    const seg = (x2, y2, cls = fc) => { edges += `<path class="dg-edge ${cls}" d="${curve(x, y, x2, y2)}"/>`; };
    if (o.grp === 0) { const hy = hopY.conn + nodeH / 2; seg(col.conn, hy); x = col.conn + cw.conn; y = hy; }
    else if (o.grp === 1) { const hy = hopY.api + nodeH / 2; seg(col.conn, hy, "ai"); x = col.conn + cw.conn; y = hy; }
    seg(col.ing, o.ingY); x = col.ing + cw.ing; y = o.ingY;
    if (o.raw && rawPos) { seg(col.raw, o.rawY); x = col.raw + cw.raw; y = o.rawY; }
    if (o.proc) {
      const py = procY[o.proc] + nodeH / 2;
      const d = `<path class="dg-edge ${fc}" d="${curve(x, y, procX, py)}"/>`;
      if (!o.raw && crossesRaw(y, py)) over += d; else edges += d;
      x = procX + cw.proc; y = py;
    }
    let tx = col.bq, ty;
    if (tgtOf(o) === "data_lake") ty = lakePos.y + nodeH / 2;
    else if (tgtOf(o) === "data_mesh") ty = meshPos.y + meshH / 2;
    else if (tgtOf(o) === "operational_db") ty = opdbPos.y + nodeH / 2;
    else ty = Math.max(bqY + 14, Math.min(y, bqY + bqH - 14));
    const d = `<path class="dg-edge ${fc}" d="${curve(x, y, tx, ty)}"/>`;
    if (!o.raw && !o.proc && crossesRaw(y, ty)) over += d; else edges += d;  // CDC / streaming bypass the raw zone
  });
  if (connSrc.length) nodes += node(col.conn, hopY.conn, cw.conn, tool(plat.connectivity).name.replace("Cloud ", ""), "Private link", "", "", "", nodeH, pi(plat.connectivity));
  if (apiSrc.length) nodes += node(col.conn, hopY.api, cw.conn, "Apigee", "Integration layer", "comp clickable google integration", `data-comp="${esc(apigee.c.id)}" data-dragmode="apigee" tabindex="0" role="button" aria-label="Configure Apigee"`, "", nodeH, pi("apigee"));
  ingKeys.forEach((k) => {
    const [t, sub] = short(k);
    const partner = ["litmus", "clearblade"].includes(k);
    nodes += node(col.ing, ingY[k], cw.ing, t, sub || "Ingest", partner ? "partner" : "ing", `data-drop="sources"`, "", nodeH, pi(k));
  });
  procKeys.forEach((k) => {
    const ids = k.split(">");
    const [t, sub] = short(ids[ids.length - 1]);
    nodes += node(procX, procY[k], cw.proc, t, ids.length > 1 ? "after " + ids.slice(0, -1).map((i) => short(i)[0]).join(", ") : sub || "Process", "proc", "", "", nodeH, pi(ids[ids.length - 1]));
  });
  if (rawPos) {
    const cls = S.catalog.storage_classes.find((c) => c.id === lake.raw_storage_class)?.name.split(" (")[0] || lake.raw_storage_class;
    const lines = [`${cls} · ${lake.raw_retention_months} months`, `${fmtGB(lake.raw_gib_month12)} at M12`, "Immutable source extracts"];
    nodes += `<g class="dg-node raw clickable" data-lake="1" tabindex="0" role="button" aria-label="Configure the raw zone"><title>Cloud Storage raw zone - immutable copies of batch extracts and files, replayable into BigQuery</title><rect x="${rawPos.x}" y="${rawPos.y}" width="${cw.raw}" height="${rawPos.h}" rx="8"/>
      <g class="dg-ico">${productIcon(rawPos.x + cw.raw - 28, rawPos.y + 8, 18, "gcs_raw")}</g>
      <text x="${rawPos.x + 10}" y="${rawPos.y + 20}" style="font-weight:700">Raw zone</text>
      <text class="sub" x="${rawPos.x + 10}" y="${rawPos.y + 36}">Cloud Storage</text>
      ${lines.slice(0, rawPos.h >= 100 ? 3 : 2).map((l, i) => { const f = fitText(l, cw.raw - 18, 11, 9.5, 400); return `<text class="sub" x="${rawPos.x + 10}" y="${rawPos.y + 52 + i * 15}" style="font-size:${f.fs}px">${esc(f.t)}</text>`; }).join("")}</g>`;
  }

  // 7. BigQuery: medallion layers + built-in capabilities
  const modelName = (c) => { const m = compMeta(c.type); const f = m?.settings?.find((x) => x.key === "model"); return f?.options?.find((x) => x.id === c.settings.model)?.name.replace(/ \((recommended|preview)\)/, "") || "Gemini"; };
  const agent = comps.find((x) => x.c.type === "agent_platform");
  const orch = plat.orchestration.tool;
  const inside = ["Dataform ELT (bronze → silver → gold)", `BigQuery ML & ${agent ? modelName(agent.c) : "Gemini 3.8 Flash"}`, "Reverse ETL"];
  if (orch !== "none") inside.splice(1, 0, orch === "composer" ? "Cloud Composer orchestration" : "Workflows + Cloud Scheduler");
  const bandH = 30, bandY = bqY + 56;
  const layers = (lake.layers || []).map((l, i) => `<g class="bq-layer ${esc(l.id)}"><rect x="${col.bq + 12}" y="${bandY + i * (bandH + 4)}" width="${cw.bq - 24}" height="${bandH}" rx="5"/>
      <text x="${col.bq + 22}" y="${bandY + i * (bandH + 4) + 19}"><tspan style="font-weight:700">${esc(l.name)}</tspan> · ${esc(fmtGB(l.gib_month12))}</text><title>${esc(l.name)}: ${esc(l.role)} (${esc(l.pct)}% of bronze)</title></g>`).join("");
  const chipY = bandY + (lake.layers || []).length * (bandH + 4) + 10;
  const chipH = Math.min(24, Math.max(18, (bqY + bqH - 34 - chipY) / inside.length - 4));
  inside.splice(Math.max(0, Math.floor((bqY + bqH - 30 - chipY) / (chipH + 4))));
  if (hasMesh) {
    const doms = (S.result.domains || []).map((d) => d.domain);
    const f = fitText(doms.join(" · "), cw.bq - 24, 11, 9.5, 600);
    nodes += `<g class="dg-node mesh" data-drop="mesh"><title>Data mesh - each domain owns its BigQuery project and publishes data products through BigQuery sharing (Analytics Hub), governed by Dataplex: ${esc(doms.join(", "))}</title>
      <rect x="${meshPos.x}" y="${meshPos.y}" width="${cw.bq}" height="${meshH}" rx="8"/>
      <g class="dg-ico">${productIcon(meshPos.x + cw.bq - 30, meshPos.y + 8, 18, "bigquery")}</g>
      <text x="${meshPos.x + 12}" y="${meshPos.y + 19}" style="font-weight:700">Data mesh · ${doms.length} domain${doms.length === 1 ? "" : "s"}</text>
      <text class="sub" x="${meshPos.x + 12}" y="${meshPos.y + 36}" style="font-size:${f.fs}px;font-weight:600">${esc(f.t)}</text>
      <text class="sub" x="${meshPos.x + 12}" y="${meshPos.y + 52}">Data products · BigQuery sharing</text></g>`;
  }
  if (hasLake) nodes += node(lakePos.x, lakePos.y, cw.bq, "Cloud Storage data lake", `Target · ${fmtGB(plat.data_lake_gib_month12 || 0)} at M12 · BigLake`, "raw", `data-drop="lake"`, "", nodeH, pi("gcs_lake"));
  if (hasOpdb) nodes += node(opdbPos.x, opdbPos.y, cw.bq, "AlloyDB / Cloud SQL", "Target · operational database (DMS)", "comp google database", "", "", nodeH, pi("op_db"));
  const bqFoot = fitText(bqModelName(), cw.bq - 28, 11, 9.5, 400);
  const bqSub = fitText(`${S.result.region.id} · medallion lakehouse · month 12`, cw.bq - 54, 11, 9.5, 400);
  if (!hasBQ) nodes += `<g class="dg-node bq-empty" data-drop="bigquery"><rect x="${col.bq}" y="${bqY}" width="${cw.bq}" height="${bqH}" rx="10"/>
    <text x="${col.bq + cw.bq / 2}" y="${bqY + bqH / 2 - 8}" text-anchor="middle">No source targets the</text>
    <text x="${col.bq + cw.bq / 2}" y="${bqY + bqH / 2 + 10}" text-anchor="middle">BigQuery data platform yet</text></g>`;
  else nodes += `<g class="dg-node bq" data-drop="bigquery"><title>BigQuery lakehouse in ${esc(S.result.region.name || S.result.region.id)} - ${esc(bqModelName())}</title><rect x="${col.bq}" y="${bqY}" width="${cw.bq}" height="${bqH}" rx="10"/>
    <g class="dg-ico">${productIcon(col.bq + 12, bqY + 10, 22, "bigquery")}</g>
    <text x="${col.bq + 42}" y="${bqY + 26}" style="font-weight:700">BigQuery</text>
    <text class="sub" x="${col.bq + 42}" y="${bqY + 44}" style="font-size:${bqSub.fs}px">${esc(bqSub.t)}</text>
    ${layers}
    ${inside.map((t, i) => { const f = fitText(t, cw.bq - 44, 11.5, 10, 500); return `<g class="bq-chip"><rect x="${col.bq + 12}" y="${chipY + i * (chipH + 4)}" width="${cw.bq - 24}" height="${chipH}" rx="5"/><text x="${col.bq + 22}" y="${chipY + i * (chipH + 4) + chipH / 2 + 4}" style="font-size:${f.fs}px">${esc(f.t)}</text></g>`; }).join("")}
    <text class="sub" x="${col.bq + 14}" y="${bqY + bqH - 12}" style="font-size:${bqFoot.fs}px">${esc(bqFoot.t)}</text></g>`;

  // 8. consume column: BI, AI, APIs, databases
  if (consume.length) {
    const avail = flowH - top - 20 - groupGap * Math.max(0, nGroups - 1);
    const step = Math.min(64, avail / consume.length);
    let y = top + 4;
    const pos = {};
    let prevCat = null;
    consume.forEach(({ c, m }) => {
      if (prevCat && m.category !== prevCat) {
        y += groupGap - 6;
        nodes += `<text class="dg-group-label" x="${col.out}" y="${y + 4}">${esc(S.catalog.component_categories.find((k) => k.id === m.category).name)}</text>`;
        y += 6;
      }
      prevCat = m.category;
      const reg = m.costed && c.settings.region ? ` · ${c.settings.region}` : "";
      const off = c.included === false;
      const cls = `comp clickable ${m.vendor} ${m.category}${off ? " excluded" : ""}`;
      let sub = (off ? "Not priced · " : "") + "via " + m.method + reg;
      if (c.type === "agent_platform") sub = (off ? "Not priced · " : "") + `${modelName(c)} · ADK, Agent Engine, MCP tools${reg}`;
      if (c.type === "gemini_enterprise") sub = (off ? "Not priced · " : "") + GE_LABEL[geMode] + (geMode !== "bigquery" && geMode !== "agents" && !comps.some((x) => x.c.type === "looker") ? " (add Looker)" : "");
      if (c.type === "apigee") sub = (off ? "Not priced · " : "") + APIGEE_LABEL[apigeeRole];
      const fromBq = !(c.type === "gemini_enterprise" && (geMode === "looker" || geMode === "agents")) && !(c.type === "apigee" && apigeeRole === "agents");
      if (fromBq) edges += `<path class="dg-edge ${m.vendor === "partner" ? "partner" : m.category === "ai" || m.category === "integration" ? "ai" : "plain"}" d="${curve(col.bq + cw.bq, Math.max(bqY + 14, Math.min(bqY + bqH - 14, y + nodeH / 2)), col.out, y + nodeH / 2)}"/>`;
      let attrs = `data-comp="${esc(c.id)}" tabindex="0" role="button" aria-label="Configure ${esc(m.name)}"`;
      if (c.type === "looker") attrs += ` data-drop="looker"`;
      if (c.type === "agent_platform") attrs += ` data-drop="agents"`;
      if (c.type === "gemini_enterprise") attrs += ` data-dragmode="gemini_enterprise"`;
      if (c.type === "apigee") attrs += ` data-dragmode="apigee"`;
      nodes += node(col.out, y, cw.out, m.name.replace("Agent Platform (Vertex AI) data agents", "Agent Platform data agents"), sub, cls, attrs, m.vendor === "partner" ? "Partner" : "", nodeH, pi(c.type));
      if (!(c.type in pos)) pos[c.type] = y;
      y += step;
    });
    let lane = 0;
    const side = (ya, yb, title) => {
      const xr = col.out + cw.out, x = xr + 7 + lane++ * 7;
      edges += `<path class="dg-edge ai side" d="M${xr},${ya + nodeH / 2} H${x} V${yb + nodeH / 2} H${xr}"><title>${esc(title)}</title></path>`;
    };
    if (pos.agent_platform !== undefined && pos.gemini_enterprise !== undefined) side(pos.agent_platform, pos.gemini_enterprise, "Data agents are registered in Gemini Enterprise");
    if (pos.looker !== undefined && pos.gemini_enterprise !== undefined && (geMode === "looker" || geMode === "both")) side(pos.looker, pos.gemini_enterprise, "Gemini Enterprise answers from Looker's governed semantic layer");
    if (pos.agent_platform !== undefined && pos.apigee !== undefined && (apigeeRole === "agents" || apigeeRole === "both")) side(pos.agent_platform, pos.apigee, "Agents call models and tools through Apigee (AI gateway)");
  } else {
    nodes += `<g class="dg-hint"><rect x="${col.out}" y="${top}" width="${cw.out}" height="${flowH - top - 20}" rx="10"/>
      <text x="${col.out + cw.out / 2}" y="${top + (flowH - top) / 2 - 8}" text-anchor="middle">Drop BI, AI, API, database</text>
      <text x="${col.out + cw.out / 2}" y="${top + (flowH - top) / 2 + 12}" text-anchor="middle">or governance components here</text></g>`;
  }

  // 9. governance & security band - with the recommended enterprise controls offered when missing
  let band = "";
  const by = flowH + 6, bh = 84;
  {
    const have = new Set(comps.map((x) => x.c.type));
    const scope = plat.dataplex_scope || [];
    const chips = govComps.map(({ c, m }) => {
      const kc = c.type === "knowledge_catalog";
      const sub = c.included === false ? "Not priced" : kc ? "Governs " + (scope.map((l) => LAYER_SHORT[l]).join(" + ") || "BigQuery") : m.category === "security" ? "Security & compliance" : m.vendor === "partner" ? "Partner catalog" : "Lineage, quality, glossary";
      return { t: m.name, s: sub, cls: `gov clickable ${m.vendor} ${m.category}${c.included === false ? " excluded" : ""}${kc ? " draggable" : ""}`,
        attrs: `data-comp="${esc(c.id)}"${kc ? ` data-dragmode="knowledge_catalog"` : ""} tabindex="0" role="button" aria-label="Configure ${esc(m.name)}${kc ? " - or drag it onto BigQuery, the data mesh, the data lake or the sources to choose what it governs" : ""}"`,
        tag: m.vendor === "partner" ? "Partner" : "", icon: pi(c.type) };
    });
    RECOMMENDED_CONTROLS.filter((t) => !have.has(t) && compMeta(t)).forEach((t) => chips.push({ t: "+ " + compMeta(t).name,
      s: t === "knowledge_catalog" ? "Recommended - click, or drag onto a layer" : "Recommended - click to add",
      cls: `gov ghost clickable${t === "knowledge_catalog" ? " draggable" : ""}`,
      attrs: `data-addcomp="${t}"${t === "knowledge_catalog" ? ` data-dragmode="knowledge_catalog"` : ""} tabindex="0" role="button" aria-label="Add ${esc(compMeta(t).name)}"`, tag: "" }));
    band = `<g class="dg-band"><rect x="16" y="${by}" width="${W - 32}" height="${bh}" rx="12"/>
      <text class="band-title" x="30" y="${by + 20}">Governance & security across every layer</text></g>`;
    const cw2 = Math.min(230, (W - 48 - (chips.length - 1) * 8) / Math.max(1, chips.length));
    chips.forEach((ch, i) => { band += node(30 + i * (cw2 + 8), by + 28, cw2, ch.t, ch.s, ch.cls, ch.attrs, ch.tag, nodeH, cw2 >= 150 ? ch.icon || "" : ""); });
    edges += `<path class="dg-edge plain" stroke-dasharray="3 4" d="M${col.bq + cw.bq / 2},${bqY + bqH + (extraH ? extraH : 0)} L${col.bq + cw.bq / 2},${by}"/>`;
  }
  // 10. platform foundation band (enterprise landing zone - not separately priced)
  const fy = by + bh + 10, fh = 80;
  {
    band += `<g class="dg-band found"><rect x="16" y="${fy}" width="${W - 32}" height="${fh}" rx="12"/>
      <text class="band-title" x="30" y="${fy + 20}">Platform foundation & operations</text>
      <text class="band-note" x="${W - 30}" y="${fy + 20}" text-anchor="end">Enterprise landing-zone practice · not separately priced</text></g>`;
    const cw3 = (W - 48 - (FOUNDATION.length - 1) * 8) / FOUNDATION.length;
    const FG = ["layers", "people", "gear", "monitor", "shield", "chart"];
    FOUNDATION.forEach(([t, s], i) => { band += node(30 + i * (cw3 + 8), fy + 28, cw3, t, s, "found", "", "", 44, si(FG[i])); });
  }
  // 11. legend
  const ly = fy + fh + 22;
  const legend = [["batch", "Batch"], ["stream", "Streaming / CDC"], ["once", "One-time load"], ["ai", "AI, API & agent flows"], ["partner", "Partner product (not costed)"], ["plain", "Consumption"]];
  let lx = 30, legendSvg = `<g class="dg-legend">`;
  legend.forEach(([c, t]) => { legendSvg += `<path class="dg-edge ${c}" d="M${lx},${ly} H${lx + 34}"/><text x="${lx + 42}" y="${ly + 4}">${esc(t)}</text>`; lx += 42 + textW(t, 11.5, 500) + 30; });
  legendSvg += `<text x="${W - 30}" y="${ly + 4}" text-anchor="end">BigQuery ${esc(S.result.region.id)} · ${esc(bqModelName())}</text></g>`;
  const H = ly + 16;

  const heads = [["Source systems", col.src], connSrc.length || apiSrc.length ? ["Connect", col.conn] : null, ["Ingestion & CDC", col.ing],
    rawPos ? ["Land (raw zone)", col.raw] : null, procKeys.length ? ["Processing", procX] : null, ["Lakehouse", col.bq],
    [consume.length ? S.catalog.component_categories.find((k) => k.id === consume[0].m.category).name : "Consumers", col.out]].filter(Boolean);
  const headSvg = heads.map(([t, x]) => `<text class="dg-col-title" x="${x}" y="22">${esc(t)}</text>`).join("");

  renderArchInventory();
  // layers governed by Knowledge Catalog (Dataplex) carry a small badge, so the drag-and-drop scope is visible
  const govd = new Set(comps.some((x) => x.c.type === "knowledge_catalog" && x.c.included !== false) ? plat.dataplex_scope || [] : []);
  const badge = (x, y) => `<g class="dg-gov-badge"><title>Governed by Knowledge Catalog (Dataplex): catalog, lineage, profiling and quality</title><rect x="${x}" y="${y}" width="66" height="17" rx="8.5"/><text x="${x + 33}" y="${y + 12}" text-anchor="middle">Dataplex</text></g>`;
  let govSvg = "";
  if (govd.has("bigquery") && info.some((o) => o.r && tgtOf(o) === "data_platform")) govSvg += badge(col.bq + cw.bq - 76, bqY + 12);
  if (govd.has("mesh") && meshPos) govSvg += badge(meshPos.x + cw.bq - 106, meshPos.y + 8);
  if (govd.has("lake") && lakePos) govSvg += badge(lakePos.x + cw.bq - 76, lakePos.y + 6);
  if (govd.has("sources")) govSvg += badge(col.src + 112, 9);
  host.innerHTML = `<svg id="archSvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Target data and AI architecture on Google Cloud" xmlns="http://www.w3.org/2000/svg">${headSvg}${edges}${band}${nodes}${over}${govSvg}${legendSvg}</svg>`;
  $("#canvasTip").hidden = !(ge || apigee);
}

// ---------------- drag Gemini Enterprise / Apigee onto a target to change how they connect
const LAYER_SHORT = { bigquery: "BigQuery", mesh: "data mesh", lake: "data lake", sources: "sources" };
export const DROP_MODES = {
  knowledge_catalog: { key: "governs", toggle: true, map: { bigquery: "bigquery", mesh: "mesh", lake: "lake", sources: "sources" },
    msg: { bigquery: "Dataplex now governs the BigQuery data platform", mesh: "Dataplex now governs the data mesh domains", lake: "Dataplex now governs the Cloud Storage data lake", sources: "Dataplex now harvests metadata from the source systems" } },
  gemini_enterprise: { key: "grounding", map: { looker: "looker", bigquery: "bigquery", agents: "agents" },
    msg: { looker: "Gemini Enterprise now answers from Looker's semantic layer", bigquery: "Gemini Enterprise now grounded on BigQuery", agents: "Gemini Enterprise now reaches data through agents" } },
  apigee: { key: "role", map: { sources: "integration", bigquery: "integration", agents: "agents" },
    msg: { integration: "Apigee is now the integration layer for applications and data APIs", agents: "Apigee is now the AI gateway for agents" } },
};

export function modeForDrop(type, target) {
  const d = DROP_MODES[type];
  return d && target ? d.map[target] : null;
}

export function applyDropMode(comp, target) {
  const d = DROP_MODES[comp.type];
  const v = modeForDrop(comp.type, target);
  if (!d || !v) return false;
  const prev = comp.settings[d.key];
  if (d.toggle) {
    // a set of layers: dropping on a layer adds it, dropping again removes it (at least one stays)
    const cur = String(prev || (S.result?.platform?.dataplex_scope || []).join(",")).split(",").filter(Boolean);
    const on = cur.includes(v);
    if (on && cur.length === 1) { toast("Dataplex must govern at least one layer"); return true; }
    const order = Object.keys(d.map);
    const next = (on ? cur.filter((x) => x !== v) : [...cur, v]).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    comp.settings[d.key] = next.join(",");
    changed();
    toast(on ? `Dataplex no longer governs the ${LAYER_SHORT[v]}` : d.msg[v], 5000, { label: "Undo", run: () => { comp.settings[d.key] = prev; changed(); } });
    return true;
  }
  if (prev === v) { toast("Already connected that way"); return true; }
  comp.settings[d.key] = v;
  if (comp.type === "gemini_enterprise" && v !== "bigquery" && v !== "agents" && !S.scenario.components.some((c) => c.type === "looker")) addComponent("looker", null, true);
  changed();
  toast(d.msg[v], 5000, { label: "Undo", run: () => { comp.settings[d.key] = prev; changed(); } });
  return true;
}

export function bindDiagramDrag() {
  const diagram = $("#diagram");
  let drag = null;
  diagram.addEventListener("pointerdown", (e) => {
    const g = e.target.closest("[data-dragmode]");
    if (!g || e.button !== 0) return;
    e.preventDefault();                  // no text selection while dragging
    drag = { type: g.dataset.dragmode, id: g.dataset.comp, add: !!g.dataset.addcomp, x: e.clientX, y: e.clientY, active: false, ghost: null };
  });
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      drag.active = true;
      drag.ghost = document.createElement("div");
      drag.ghost.className = "drag-ghost";
      drag.ghost.textContent = compMeta(drag.type).name.split(" API")[0];
      document.body.appendChild(drag.ghost);
      const valid = Object.keys(DROP_MODES[drag.type].map);
      $$("[data-drop]", diagram).forEach((n) => n.classList.toggle("drop-target", valid.includes(n.dataset.drop)));
      diagram.classList.add("dragging-mode");
    }
    drag.ghost.style.left = e.clientX + 12 + "px";
    drag.ghost.style.top = e.clientY + 12 + "px";
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-drop]");
    $$(".drop-hover", diagram).forEach((n) => n.classList.remove("drop-hover"));
    if (over && over.classList.contains("drop-target")) over.classList.add("drop-hover");
  });
  window.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.active) return;
    d.ghost.remove();
    diagram.classList.remove("dragging-mode");
    $$(".drop-target,.drop-hover", diagram).forEach((n) => n.classList.remove("drop-target", "drop-hover"));
    S.suppressClick = true;
    setTimeout(() => (S.suppressClick = false), 50);
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-drop]");
    const comp = S.scenario.components.find((c) => c.id === d.id);
    if (!comp && d.add && over && modeForDrop(d.type, over.dataset.drop)) { addComponent(d.type, modeForDrop(d.type, over.dataset.drop)); return; }
    if (comp && over && !applyDropMode(comp, over.dataset.drop)) toast(d.type === "knowledge_catalog" ? "Drop Dataplex on BigQuery, the data mesh, the data lake or a source" : "Drop it on Looker, BigQuery, an agent or the source systems");
  });
}

export function bqModelName() {
  const b = S.scenario.bq || {};
  if (b.mode !== "editions") return "On-demand (per TiB)";
  const r = S.result?.bigquery;
  const ed = r?.edition || (b.edition !== "auto" ? b.edition : "enterprise");
  const t = r?.plan?.totals;
  return `${{ standard: "Standard", enterprise: "Enterprise", enterprise_plus: "Enterprise Plus" }[ed]} edition${t ? ` · up to ${t[0].max} → ${t[2].max} slots (Y1 → Y3)` : r ? ` (${r.baseline} → ${r.max} slots)` : ""}`;
}

export function clip(s, n) { s = String(s); n = Math.floor(n); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

// ---------------- every product in the architecture (ingestion, storage, platform, consumption, governance)
export function archInventory() {
  const r = S.result;
  if (!r) return { groups: [], google: 0, partner: 0, total: 0 };
  const recs = r.recommendations || [];
  const plat = r.platform || {};
  const lake = plat.lakehouse || {};
  const targets = new Set(recs.map((x) => x.target || "data_platform"));
  const add = (map, id, name, vendor = "google", priced = true) => { if (!map.has(name)) map.set(name, { id, name, vendor, priced }); };
  const G = { conn: new Map(), ing: new Map(), store: new Map(), plat: new Map(), use: new Map(), gov: new Map(), found: new Map() };
  if (recs.some((x) => x.needs_connectivity) && plat.connectivity) add(G.conn, plat.connectivity, tool(plat.connectivity).name);
  recs.forEach((x) => x.chain.forEach((t) => {
    if (t === "gcs_lake" || t === "op_db" || (lake.raw_zone && LAND_TOOLS.has(t))) return;
    const partner = ["litmus", "clearblade"].includes(t);
    add(G.ing, t, tool(t).name, partner ? "partner" : "google", !partner);
  }));
  if (targets.has("data_platform")) add(G.store, "bigquery", "BigQuery (bronze, silver, gold)");
  if (lake.raw_zone) add(G.store, "gcs_raw", "Cloud Storage - raw zone");
  if (targets.has("data_lake")) add(G.store, "gcs_lake", "Cloud Storage - data lake");
  if (targets.has("operational_db")) add(G.store, "op_db", "AlloyDB / Cloud SQL (target)");
  if (targets.has("data_platform")) add(G.plat, "dataform", "Dataform");
  const orch = plat.orchestration?.tool;
  if (orch && orch !== "none") add(G.plat, orch, orch === "composer" ? "Cloud Composer" : "Workflows + Cloud Scheduler");
  if (plat.datafusion_edition) add(G.plat, "datafusion", "Cloud Data Fusion instance");
  S.scenario.components.forEach((c) => {
    const m = compMeta(c.type);
    if (!m) return;
    const g = ["governance", "security"].includes(m.category) ? G.gov : G.use;
    add(g, c.type, m.name, m.vendor, m.costed && c.included !== false);
  });
  [["logging", "Cloud Logging"], ["monitoring", "Cloud Monitoring"], ["iam", "IAM & Workload Identity"], ["build", "Cloud Build (CI/CD)"], ["secret", "Secret Manager"]]
    .forEach(([id, n]) => add(G.found, id, n, "google", false));
  const groups = [["Connectivity", G.conn], ["Ingestion & processing", G.ing], ["Storage & lakehouse", G.store], ["Transformation & orchestration", G.plat],
    ["Analytics, AI, APIs & databases", G.use], ["Governance & security", G.gov], ["Platform foundation (not separately priced)", G.found]]
    .map(([name, m]) => ({ name, items: [...m.values()] })).filter((g) => g.items.length);
  const all = groups.flatMap((g) => g.items);
  return { groups, total: all.length, google: all.filter((x) => x.vendor === "google").length, partner: all.filter((x) => x.vendor !== "google").length,
    priced: all.filter((x) => x.priced).length };
}

function renderArchInventory() {
  const host = $("#archProducts");
  if (!host || !S.result) return;
  const inv = archInventory();
  const lake = S.result.platform?.lakehouse || {};
  const recs = S.result.recommendations || [];
  const dp = new Set(recs.filter((x) => (x.target || "data_platform") === "data_platform").map((x) => x.source_id));
  const src = S.scenario.sources.filter((s) => s.included !== false && dp.has(s.id));
  const init = src.reduce((a, s) => a + (+s.initial_volume_gb || 0), 0), daily = src.reduce((a, s) => a + (+s.daily_change_gb || 0), 0);
  const L = Object.fromEntries((lake.layers || []).map((l) => [l.id, l]));
  host.innerHTML = `<div class="inv-head"><h3>Products in this architecture <small class="muted">${inv.total} products · ${inv.google} Google Cloud · ${inv.partner} partner</small></h3></div>
    <div class="inv-grid">${inv.groups.map((g) => `<div class="inv-group"><h4>${esc(g.name)} <small>${g.items.length}</small></h4><ul>${g.items.map((x) => `<li class="${x.vendor !== "google" ? "partner" : ""}">${esc(x.name)}${x.vendor !== "google" ? ' <span class="tag">partner</span>' : ""}</li>`).join("")}</ul></div>`).join("")}</div>
    ${L.bronze ? `<details class="vol-explain"><summary>How the bronze, silver and gold sizes are calculated</summary>
      <ul><li><b>Bronze ${esc(fmtGB(L.bronze.gib_month12))}</b> = everything landed in BigQuery by month 12 from the ${src.length} data-platform source${src.length === 1 ? "" : "s"}: initial loads (${esc(fmtGB(init))}) plus the daily change (${esc(fmtGB(daily))}/day) for each month a source has been live, grown by ${+S.scenario.annual_growth_pct}% a year, and compressed as BigQuery stores it.</li>
      <li><b>Silver ${esc(fmtGB(L.silver?.gib_month12 || 0))}</b> = bronze × ${+(L.silver?.pct || 0)}% - cleansed, de-duplicated and conformed tables.</li>
      <li><b>Gold ${esc(fmtGB(L.gold?.gib_month12 || 0))}</b> = bronze × ${+(L.gold?.pct || 0)}% - curated marts and semantic models for BI and AI.</li>
      ${lake.raw_zone ? `<li><b>Raw zone ${esc(fmtGB(lake.raw_gib_month12 || 0))}</b> = files and batch extracts kept for ${lake.raw_retention_months} months in Cloud Storage ${esc(lake.raw_storage_class)}.</li>` : ""}
      <li>Change the silver and gold shares, retention and storage class in <b>Settings › Lakehouse layers</b>; change volumes on each source.</li></ul></details>` : ""}`;
}
