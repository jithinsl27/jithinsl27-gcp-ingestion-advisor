/* Data Cloud Compass - diagram.js (ES module, no build step). */
import { S } from "./state.js";
import { addComponent } from "./components.js";
import { $, $$, STREAMING, esc, toast } from "./core.js";
import { fmtGB } from "./cost.js";
import { changed } from "./events.js";
import { compMeta } from "./pricing.js";
import { flowClass, freqName, recFor, tool } from "./render.js";

// ---------------- architecture diagram
export const INTEGRATION_CATS = new Set(["api", "saas_other", "saas_salesforce", "sap"]);

export const GE_LABEL = { bigquery: "Grounded on BigQuery", looker: "Grounded on Looker semantic layer", both: "Grounded on BigQuery + Looker", agents: "Via data agents" };

export const APIGEE_LABEL = { integration: "Integration layer · data APIs", agents: "AI gateway & tools for agents", both: "Integration layer + AI gateway" };

export function renderDiagram() {
  const host = $("#diagram");
  const srcs = S.scenario.sources;
  const W = 1440;
  if (!srcs.length || !S.result) {
    host.innerHTML = `<svg viewBox="0 0 ${W} 220" role="img" aria-label="Empty architecture"><text class="dg-empty" x="${W / 2}" y="110" text-anchor="middle">Add a source system to start drawing the target architecture.</text></svg>`;
    return;
  }
  const plat = S.result.platform;
  const lake = plat.lakehouse || { raw_zone: false, layers: [] };
  const rowH = 66, top = 46, nodeH = 48;
  const col = { src: 16, conn: 234, ing: 354, proc: 544, raw: 734, bq: 872, out: 1112 };
  const cw = { src: 204, conn: 108, ing: 172, proc: 172, raw: 118, bq: 222, out: 290 };

  const comps = S.scenario.components.map((c) => ({ c, m: compMeta(c.type) }));
  const CONSUME_CATS = ["bi", "ai", "integration", "database"];
  const consume = CONSUME_CATS.flatMap((cat) => comps.filter((x) => x.m.category === cat));
  const govComps = [...comps.filter((x) => x.m.category === "governance"), ...comps.filter((x) => x.m.category === "security")];
  const groupGap = 22;
  const nGroups = CONSUME_CATS.filter((cat) => comps.some((x) => x.m.category === cat)).length;
  const apigee = comps.find((x) => x.c.type === "apigee");
  const apigeeRole = apigee ? apigee.c.settings.role || "both" : null;
  const ge = comps.find((x) => x.c.type === "gemini_enterprise");
  const geMode = ge ? ge.c.settings.grounding || "bigquery" : null;

  const nTargets = new Set(srcs.map((x) => recFor(x.id)?.target).filter(Boolean)).size;
  const flowH = Math.max(400 + (nTargets > 1 ? (nTargets - 1) * 62 : 0), top + srcs.length * rowH + 30, top + consume.length * 58 + groupGap * Math.max(0, nGroups - 1) + 40);
  const H = flowH + 100;

  const srcNodes = srcs.map((s, i) => ({ s, x: col.src, y: top + i * rowH, r: recFor(s.id) }));
  const ingKeys = [], procKeys = [];
  srcNodes.forEach((n) => {
    if (!n.r) return;
    const ch = n.r.chain.filter((t) => t !== "gcs_lake" && t !== "op_db");
    n.ing = ch[0] || n.r.chain[0];
    n.proc = ch.length > 1 ? ch.slice(1).join(">") : null;
    if (!ingKeys.includes(n.ing)) ingKeys.push(n.ing);
    if (n.proc && !procKeys.includes(n.proc)) procKeys.push(n.proc);
  });
  const spread = (keys, x, w) => {
    const gap = (flowH - top - 20) / Math.max(keys.length, 1);
    return Object.fromEntries(keys.map((k, i) => [k, { x, w, y: top + gap * i + (gap - nodeH) / 2 }]));
  };
  const ingPos = spread(ingKeys, col.ing, cw.ing);
  const procPos = spread(procKeys, col.proc, cw.proc);
  const tgtOf = (n) => n.r?.target || "data_platform";
  const hasBQ = srcNodes.some((n) => n.r && tgtOf(n) === "data_platform");
  const hasLake = srcNodes.some((n) => n.r && tgtOf(n) === "data_lake");
  const hasOpdb = srcNodes.some((n) => n.r && tgtOf(n) === "operational_db");
  const extraH = (hasLake ? nodeH + 14 : 0) + (hasOpdb ? nodeH + 14 : 0);
  const bqY = top, bqH = flowH - top - 20 - extraH;
  let ey = bqY + bqH + 14;
  const lakePos = hasLake ? { x: col.bq, y: ey } : null;
  if (hasLake) ey += nodeH + 14;
  const opdbPos = hasOpdb ? { x: col.bq, y: ey } : null;
  const midY = (p) => p.y + nodeH / 2;
  const avgY = (list) => list.reduce((a, n) => a + n.y, 0) / list.length;
  const connSrc = srcNodes.filter((n) => n.r?.needs_connectivity);
  const connPos = { x: col.conn, y: connSrc.length ? avgY(connSrc) : top };
  // Apigee as the integration layer in front of application / SaaS / API sources
  const apiSrc = apigee && apigeeRole !== "agents" ? srcNodes.filter((n) => n.r && !n.r.needs_connectivity && INTEGRATION_CATS.has(S.catalog.source_types.find((t) => t.id === n.s.type)?.category)) : [];
  const apiPos = { x: col.conn, y: apiSrc.length ? avgY(apiSrc) : 0 };
  if (apiSrc.length && connSrc.length && Math.abs(apiPos.y - connPos.y) < nodeH + 10) apiPos.y = Math.min(flowH - nodeH - 24, connPos.y + nodeH + 14);
  const apiSet = new Set(apiSrc.map((n) => n.s.id));
  const curve = (x1, y1, x2, y2) => { const dx = (x2 - x1) / 2; return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`; };

  let edges = "", nodes = "", over = "";
  const node = (x, y, w, title, sub, cls = "", attrs = "", tag = "", h = nodeH) =>
    `<g class="dg-node ${cls}" ${attrs}><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>
      <text x="${x + 12}" y="${y + (sub ? 20 : 29)}">${esc(clip(title, (w - (tag ? 60 : 0)) / 7.2))}</text>
      ${sub ? `<text class="sub" x="${x + 12}" y="${y + 37}">${esc(clip(sub, w / 6.1))}</text>` : ""}
      ${tag ? `<text class="tag" x="${x + w - 10}" y="${y + 17}" text-anchor="end">${esc(tag)}</text>` : ""}</g>`;

  // which flows land in the Cloud Storage raw zone first
  const RAW_ENG = ["files_transfer", "dataflow_batch", "datafusion", "dataproc", "cloud_run", "app_integration", "dts_migration"];
  const inRaw = (s) => lake.raw_zone && s.included !== false && recFor(s.id)?.target === "data_platform" && (lake.raw_scope === "all" || (!STREAMING.has(s.frequency) && (recFor(s.id)?.engine || "").split("+").some((e) => RAW_ENG.includes(e))));
  const flows = [];
  srcNodes.forEach((n) => {
    const fc = flowClass(n.s.frequency);
    const reg = n.s.region && n.s.region !== S.scenario.region ? ` · ${n.s.region}` : "";
    const off = n.s.included === false;
    const iotOpt = n.s.type === "iot" ? S.catalog.iot_options.find((o) => o.id === (n.s.iot_option || "native")) : null;
    const sub = off ? "Later phase - not in this estimate" : `${freqName(n.s.frequency)} · ${fmtGB(n.s.daily_change_gb)}/day${reg}`;
    nodes += node(n.x, n.y, cw.src, n.s.name, iotOpt && !off ? `${iotOpt.vendor === "partner" ? "ISV" : "Native"} · ${fmtGB(n.s.daily_change_gb)}/day` : sub,
      `src clickable${off ? " excluded" : ""}`, `data-src="${esc(n.s.id)}" data-drop="sources" tabindex="0" role="button" aria-label="Edit ${esc(n.s.name)}"`);
    if (!n.r) return;
    const hops = [];
    if (n.r.needs_connectivity) hops.push({ x: connPos.x, w: cw.conn, y: midY(connPos) });
    else if (apiSet.has(n.s.id)) hops.push({ x: apiPos.x, w: cw.conn, y: midY(apiPos), cls: "ai" });
    const ip = ingPos[n.ing];
    hops.push({ x: ip.x, w: ip.w, y: midY(ip) });
    if (n.proc) { const pp = procPos[n.proc]; hops.push({ x: pp.x, w: pp.w, y: midY(pp) }); }
    if (n.r.target === "operational_db") hops.length = 0, hops.push({ x: ingPos[n.ing].x, w: ingPos[n.ing].w, y: midY(ingPos[n.ing]) });
    flows.push({ n, fc, hops, raw: inRaw(n.s), tgt: tgtOf(n) });
  });
  const rawFlows = flows.filter((f) => f.raw);
  let rawPos = null;
  if (rawFlows.length) {
    const ys = rawFlows.map((f) => f.hops[f.hops.length - 1].y);
    const y0 = Math.max(top, Math.min(...ys) - nodeH / 2 - 8), y1 = Math.min(flowH - 20, Math.max(...ys) + nodeH / 2 + 8);
    const h = Math.max(104, y1 - y0);
    rawPos = { x: col.raw, y: Math.min(y0, flowH - 20 - h), h };
  }
  flows.forEach((f) => {
    let x = f.n.x + cw.src, y = f.n.y + nodeH / 2;
    f.hops.forEach((h) => { edges += `<path class="dg-edge ${h.cls || f.fc}" d="${curve(x, y, h.x, h.y)}"/>`; x = h.x + h.w; y = h.y; });
    if (f.raw && rawPos) {
      const ry = Math.max(rawPos.y + 12, Math.min(rawPos.y + rawPos.h - 12, y));
      edges += `<path class="dg-edge ${f.fc}" d="${curve(x, y, col.raw, ry)}"/>`;
      edges += `<path class="dg-edge ${f.fc}" d="${curve(col.raw + cw.raw, ry, col.bq, ry)}"/>`;
    } else if (f.tgt === "data_lake") {
      over += `<path class="dg-edge ${f.fc}" d="${curve(x, y, col.bq, midY(lakePos))}"/>`;
    } else if (f.tgt === "operational_db") {
      over += `<path class="dg-edge ${f.fc}" d="${curve(x, y, col.bq, midY(opdbPos))}"/>`;
    } else {
      over += `<path class="dg-edge ${f.fc}" d="${curve(x, y, col.bq, Math.min(y, bqY + bqH - 10))}"/>`;  // bypasses the raw zone (CDC / streaming)
    }
  });
  if (connSrc.length) nodes += node(connPos.x, connPos.y, cw.conn, tool(plat.connectivity).name.replace("Cloud ", ""), "Private link", "");
  if (apiSrc.length) nodes += node(apiPos.x, apiPos.y, cw.conn, "Apigee", "Integration layer", "comp clickable google integration", `data-comp="${esc(apigee.c.id)}" data-dragmode="apigee" tabindex="0" role="button" aria-label="Configure Apigee"`);
  ingKeys.forEach((k) => { const p = ingPos[k]; nodes += node(p.x, p.y, p.w, tool(k).name, k === "datastream" ? "Change data capture" : ["litmus", "clearblade"].includes(k) ? "Partner (ISV) · not costed" : "Ingest", ["litmus", "clearblade"].includes(k) ? "partner" : "", `data-drop="sources"`); });
  procKeys.forEach((k) => {
    const p = procPos[k];
    const names = k.split(">").map((t) => tool(t).name);
    nodes += node(p.x, p.y, p.w, names[names.length - 1], names.length > 1 ? "via " + names.slice(0, -1).join(", ") : "Process / land", "");
  });
  if (rawPos) {
    const cls = S.catalog.storage_classes.find((c) => c.id === lake.raw_storage_class)?.name.split(" (")[0] || lake.raw_storage_class;
    nodes += `<g class="dg-node raw clickable" data-lake="1" tabindex="0" role="button" aria-label="Configure the raw zone"><rect x="${rawPos.x}" y="${rawPos.y}" width="${cw.raw}" height="${rawPos.h}" rx="8"/>
      <text x="${rawPos.x + 10}" y="${rawPos.y + 20}" style="font-weight:700">Cloud Storage</text>
      <text class="sub" x="${rawPos.x + 10}" y="${rawPos.y + 37}">Raw zone</text>
      <text class="sub" x="${rawPos.x + 10}" y="${rawPos.y + 54}">${esc(cls)} · ${esc(lake.raw_retention_months)} mo</text>
      <text class="sub" x="${rawPos.x + 10}" y="${rawPos.y + 71}">${esc(fmtGB(lake.raw_gib_month12))} (M12)</text></g>`;
  }

  // BigQuery: medallion layers + built-in capabilities
  const orch = plat.orchestration.tool;
  const inside = ["Dataform ELT", "BigQuery ML & AI", "Reverse ETL"];
  if (orch !== "none") inside.splice(1, 0, orch === "composer" ? "Cloud Composer" : "Workflows");
  const bandH = 30, bandY = bqY + 56;
  const layers = (lake.layers || []).map((l, i) => `<g class="bq-layer ${esc(l.id)}"><rect x="${col.bq + 12}" y="${bandY + i * (bandH + 4)}" width="${cw.bq - 24}" height="${bandH}" rx="5"/>
      <text x="${col.bq + 22}" y="${bandY + i * (bandH + 4) + 19}"><tspan style="font-weight:700">${esc(l.name)}</tspan> · ${esc(fmtGB(l.gib_month12))}</text><title>${esc(l.name)}: ${esc(l.role)} (${esc(l.pct)}% of bronze)</title></g>`).join("");
  const chipY = bandY + (lake.layers || []).length * (bandH + 4) + 10;
  const chipH = Math.min(24, Math.max(18, (bqY + bqH - 34 - chipY) / inside.length - 4));
  inside.splice(Math.max(0, Math.floor((bqY + bqH - 30 - chipY) / (chipH + 4))));
  if (hasLake) nodes += node(lakePos.x, lakePos.y, cw.bq, "Cloud Storage data lake", `Target · ${fmtGB(plat.data_lake_gib_month12 || 0)} at M12 · BigLake`, "raw", "");
  if (hasOpdb) nodes += node(opdbPos.x, opdbPos.y, cw.bq, "AlloyDB / Cloud SQL", "Target · operational database (DMS)", "comp google database", "");
  if (!hasBQ) nodes += `<g class="dg-node bq-empty" data-drop="bigquery"><rect x="${col.bq}" y="${bqY}" width="${cw.bq}" height="${bqH}" rx="10"/>
    <text x="${col.bq + cw.bq / 2}" y="${bqY + bqH / 2 - 8}" text-anchor="middle">No source targets the</text>
    <text x="${col.bq + cw.bq / 2}" y="${bqY + bqH / 2 + 10}" text-anchor="middle">BigQuery data platform yet</text></g>`;
  else nodes += `<g class="dg-node bq" data-drop="bigquery"><rect x="${col.bq}" y="${bqY}" width="${cw.bq}" height="${bqH}" rx="10"/>
    <text x="${col.bq + 14}" y="${bqY + 26}" style="font-weight:700">BigQuery</text>
    <text class="sub" x="${col.bq + 14}" y="${bqY + 44}">${esc(S.result.region.id)} · Iceberg lakehouse</text>
    ${layers}
    ${inside.map((t, i) => `<g class="bq-chip"><rect x="${col.bq + 12}" y="${chipY + i * (chipH + 4)}" width="${cw.bq - 24}" height="${chipH}" rx="5"/><text x="${col.bq + 22}" y="${chipY + i * (chipH + 4) + chipH / 2 + 4}">${esc(t)}</text></g>`).join("")}
    <text class="sub" x="${col.bq + 14}" y="${bqY + bqH - 12}">${esc(clip(bqModelName(), 34))}</text></g>`;

  // consume column: BI, AI, APIs, databases
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
      if (c.type === "gemini_enterprise") sub = (off ? "Not priced · " : "") + GE_LABEL[geMode] + (geMode !== "bigquery" && geMode !== "agents" && !comps.some((x) => x.c.type === "looker") ? " (add Looker)" : "");
      if (c.type === "apigee") sub = (off ? "Not priced · " : "") + APIGEE_LABEL[apigeeRole];
      const fromBq = !(c.type === "gemini_enterprise" && (geMode === "looker" || geMode === "agents")) && !(c.type === "apigee" && apigeeRole === "agents");
      if (fromBq) edges += `<path class="dg-edge ${m.vendor === "partner" ? "partner" : m.category === "ai" || m.category === "integration" ? "ai" : "plain"}" d="${curve(col.bq + cw.bq, y + nodeH / 2, col.out, y + nodeH / 2)}"/>`;
      let attrs = `data-comp="${esc(c.id)}" tabindex="0" role="button" aria-label="Configure ${esc(m.name)}"`;
      if (c.type === "looker") attrs += ` data-drop="looker"`;
      if (c.type === "agent_platform") attrs += ` data-drop="agents"`;
      if (c.type === "gemini_enterprise") attrs += ` data-dragmode="gemini_enterprise"`;
      if (c.type === "apigee") attrs += ` data-dragmode="apigee"`;
      nodes += node(col.out, y, cw.out, m.name, sub, cls, attrs, m.vendor === "partner" ? "Partner" : "");
      if (!(c.type in pos)) pos[c.type] = y;
      y += step;
    });
    // side connectors (outside the column, to the right)
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

  let band = "";
  {
    const by = flowH + 6, bh = 84;
    const chips = govComps.map(({ c, m }) => ({ t: m.name, s: c.included === false ? "Not priced" : m.category === "security" ? "Security & compliance" : m.vendor === "partner" ? "Partner catalog" : "Lineage, quality, glossary",
      cls: `gov clickable ${m.vendor} ${m.category}${c.included === false ? " excluded" : ""}`, attrs: `data-comp="${esc(c.id)}" tabindex="0" role="button" aria-label="Configure ${esc(m.name)}"`, tag: m.vendor === "partner" ? "Partner" : "" }));
    band = `<g class="dg-band"><rect x="16" y="${by}" width="${W - 32}" height="${bh}" rx="12"/>
      <text class="band-title" x="30" y="${by + 20}">Governance & security across every layer</text></g>`;
    if (chips.length) {
      const cw2 = Math.min(220, (W - 48 - (chips.length - 1) * 8) / chips.length);
      chips.forEach((ch, i) => { band += node(30 + i * (cw2 + 8), by + 28, cw2, ch.t, ch.s, ch.cls, ch.attrs, ch.tag); });
    } else {
      band += `<text class="dg-band-hint" x="${W / 2}" y="${by + 54}" text-anchor="middle">Search for governance or security products (Knowledge Catalog, CMEK, VPC Service Controls, Collibra …) to add them here</text>`;
    }
    edges += `<path class="dg-edge plain" stroke-dasharray="3 4" d="M${col.bq + cw.bq / 2},${bqY + bqH} L${col.bq + cw.bq / 2},${by}"/>`;
  }

  const heads = [["Source systems", col.src], connSrc.length || apiSrc.length ? ["Connect", col.conn] : null, ["Ingestion & CDC", col.ing], ["Processing", col.proc],
    rawPos ? ["Raw zone", col.raw] : null, ["Lakehouse", col.bq],
    [consume.length ? S.catalog.component_categories.find((k) => k.id === consume[0].m.category).name : "Consumers", col.out]].filter(Boolean);
  const headSvg = heads.map(([t, x]) => `<text class="dg-col-title" x="${x}" y="22">${esc(t)}</text>`).join("");

  host.innerHTML = `<svg id="archSvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Target data and AI architecture on Google Cloud" xmlns="http://www.w3.org/2000/svg">${headSvg}${edges}${band}${nodes}${over}</svg>`;
  $("#canvasTip").hidden = !(ge || apigee);
}

// ---------------- drag Gemini Enterprise / Apigee onto a target to change how they connect
export const DROP_MODES = {
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
    drag = { type: g.dataset.dragmode, id: g.dataset.comp, x: e.clientX, y: e.clientY, active: false, ghost: null };
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
    if (comp && over && !applyDropMode(comp, over.dataset.drop)) toast("Drop it on Looker, BigQuery, an agent or the source systems");
  });
}

export function bqModelName() {
  const b = S.scenario.bq || {};
  if (b.mode !== "editions") return "On-demand (per TiB)";
  const r = S.result?.bigquery;
  const ed = r?.edition || (b.edition !== "auto" ? b.edition : "enterprise");
  return `${{ standard: "Standard", enterprise: "Enterprise", enterprise_plus: "Enterprise Plus" }[ed]} edition${r ? ` (${r.baseline} → ${r.max} slots)` : ""}`;
}

export function clip(s, n) { s = String(s); n = Math.floor(n); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
