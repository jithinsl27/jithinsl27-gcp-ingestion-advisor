/* Data Cloud Compass - integrations.js (ES module, no build step). */
import { S } from "./state.js";
import { $, esc } from "./core.js";
import { fmtGB, money } from "./cost.js";
import { opt, regionName } from "./main.js";
import { compMeta } from "./pricing.js";
import { flowClass, freqName, recFor, tool } from "./render.js";

// ---------------- recommendations
export function renderRecs() {
  const host = $("#recsBody");
  if (!S.result || !S.scenario.sources.length) { host.innerHTML = `<p class="empty-note">Add source systems to see recommended GCP-native ingestion patterns.</p>`; return; }
  const p = S.result.platform;
  const orchTool = p.orchestration.tool === "none" ? "None required" : tool(p.orchestration.tool).name;
  const procReg = p.processing_region && p.processing_region !== S.scenario.region ? ` (runs in ${esc(regionName(p.processing_region))})` : "";
  let html = `<div class="platform-block"><h3>Platform blueprint</h3><dl>
    <dt>Transformation</dt><dd><a href="${tool("dataform").doc}" target="_blank" rel="noopener">Dataform</a>: ${esc(p.transformation.why)}</dd>
    <dt>Orchestration</dt><dd>${esc(orchTool)}${procReg}: ${esc(p.orchestration.why)}</dd>
    <dt>Connectivity</dt><dd>${p.connectivity ? `${esc(tool(p.connectivity).name)} for ~${fmtGB(p.connectivity_gb_day)}/day from private networks.` : "Public / Google-managed endpoints only."}</dd>
    ${p.datafusion_edition ? `<dt>Data Fusion</dt><dd>One shared ${esc(p.datafusion_edition)} edition instance for all low-code pipelines.</dd>` : ""}
    <dt>Governance</dt><dd>${p.governance.map(esc).join("; ")}.</dd>
  </dl></div>`;
  html += S.scenario.sources.map((s) => {
    const r = recFor(s.id);
    if (!r) return "";
    const fc = flowClass(s.frequency);
    const chain = r.chain.map((t) => `<a href="${esc(tool(t).doc)}" target="_blank" rel="noopener" title="${esc(tool(t).summary)}">${esc(tool(t).name)}</a>`).join(`<span class="arrow">→</span>`)
      + `<span class="arrow">→</span><a href="https://cloud.google.com/bigquery/docs/introduction" target="_blank" rel="noopener">BigQuery</a>`;
    const cross = s.region && s.region !== S.scenario.region
      ? `<li>Processing runs in ${esc(regionName(s.region))} while BigQuery is in ${esc(regionName(S.scenario.region))}: cross-region transfer is costed; confirm data-residency rules allow it.</li>` : "";
    return `<article class="rec">
      <div class="rec-src"><b>${esc(s.name)}</b><span>${esc(S.catalog.source_types.find((t) => t.id === s.type)?.name || s.type)}</span>
        <span>${fmtGB(s.initial_volume_gb)} initial, ${fmtGB(s.daily_change_gb)}/day</span>
        <span>Region: ${esc(s.region || S.scenario.region)}</span>
        <span class="chip ${fc}">${esc(freqName(s.frequency))}</span></div>
      <div class="rec-main">
        <h3>${esc(r.pattern)}</h3>
        <div class="chain">${chain}</div>
        <ul>${r.rationale.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        ${r.alternatives.length ? `<p class="sub">Alternatives</p><ul class="alt">${r.alternatives.map((a) => `<li><b>${esc(tool(a.tool).name)}</b>: ${esc(a.why)}</li>`).join("")}</ul>` : ""}
        ${r.caveats.length || cross ? `<p class="sub">Check during discovery</p><ul class="caveat">${cross}${r.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
        ${s.notes ? `<p class="sub">Notes</p><p>${esc(s.notes)}</p>` : ""}
      </div></article>`;
  }).join("");
  host.innerHTML = html;
}

// ---------------- integrations (components)
export const COMP_COST = {
  looker: /Looker licence/, looker_studio_pro: /Looker Studio Pro/, gemini_enterprise: /^Gemini Enterprise$/,
  agent_platform: /Agent Engine|tokens \(agents\)|queries from agents/, vertex_gpu: /Vertex AI endpoint/,
  knowledge_catalog: /Knowledge Catalog/, apigee: /^Apigee/, alloydb: /^AlloyDB$/, cloudsql: /^Cloud SQL$/, spanner: /^Spanner$/,
  bigtable: /^Bigtable$/, firestore: /^Firestore$/, memorystore: /^Memorystore$/,
};

export function compCost(type) {
  const re = COMP_COST[type];
  if (!re || !S.result) return null;
  const rows = S.result.by_service.filter((r) => re.test(r.service));
  return { y1: rows.reduce((a, r) => a + r.year1, 0), y3: rows.reduce((a, r) => a + r.three_year, 0) };
}

export function renderPlatform() {
  const host = $("#platformBody");
  if (!S.result) { host.innerHTML = ""; return; }
  const chips = (ids) => ids.map((t) => `<a href="${esc(tool(t).doc)}" target="_blank" rel="noopener" title="${esc(tool(t).summary)}">${esc(tool(t).name)}</a>`).join("");
  const story = S.result.platform.layer.story;
  const block = (b) => `<section class="story-block ${esc(b.key)}"><h3>${esc(b.title)}</h3><div class="tool-chips">${chips(b.tools)}</div>
    <ul>${b.points.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>`;
  let html = `<p class="lede">How each tool the customer chose connects to BigQuery. Google Cloud components are costed; partner products are shown with their integration path but not costed. Click a card to configure it, or add tools from the library on the Architecture tab.</p>`;
  const lake = story.find((b) => b.key === "lakehouse");
  if (lake) html += `<div class="story">${block(lake)}</div>`;
  for (const cat of S.catalog.component_categories) {
    const items = S.scenario.components.filter((c) => compMeta(c.type).category === cat.id);
    if (!items.length) continue;
    html += `<h3 class="cat-head">${esc(cat.name)}</h3><div class="story">`;
    html += items.map((c) => {
      const m = compMeta(c.type);
      const cost = compCost(c.type);
      let note;
      if (m.vendor === "partner") note = "";
      else if (c.type === "looker" && !c.settings.annual_quote_usd) note = "Licence is quote-based - add the customer's quote to include it.";
      else if (cost && cost.y3 > 0) note = `Estimated ${money(cost.y1)} in year 1, ${money(cost.y3)} over 3 years${c.settings.region ? ` (${esc(c.settings.region)})` : ""}.`;
      else note = "No separate charge; consumption appears under BigQuery.";
      return `<section class="story-block comp ${m.vendor} ${m.category}">
        <div class="comp-head"><h3>${esc(m.name)}</h3><span class="vendor-badge ${m.vendor}">${m.vendor === "google" ? "Google Cloud" : "Partner"}</span></div>
        <p class="comp-method">${esc(m.method)}</p>
        ${m.modes ? `<div class="mode-box"><label>${esc(m.settings.find((f) => f.key === m.modes.key).label)}
          <select data-mode-comp="${esc(c.id)}">${opt(m.settings.find((f) => f.key === m.modes.key).options, c.settings[m.modes.key])}</select></label>
          <p>${esc(m.modes.notes[c.settings[m.modes.key]] || "")}</p></div>` : ""}
        <ol>${m.steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
        ${m.notes.length ? `<ul class="comp-notes">${m.notes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${note ? `<p class="story-cost">${note}</p>` : ""}
        <div class="comp-actions"><button type="button" class="btn ghost small" data-comp="${esc(c.id)}">Configure</button>
        <a href="${esc(m.doc)}" target="_blank" rel="noopener">Integration docs</a></div></section>`;
    }).join("");
    html += `</div>`;
  }
  const has = (t) => S.scenario.components.some((c) => c.type === t);
  const partners = S.scenario.components.filter((c) => compMeta(c.type).vendor === "partner").map((c) => compMeta(c.type).name);
  const demo = [
    "Walk the architecture from source systems to BigQuery, pointing out CDC (dashed) versus batch flows.",
    "Drag the customer's own tools from the component library onto the diagram and show how each connects to BigQuery.",
  ];
  if (partners.length) demo.push(`Show how ${partners.join(", ")} ${partners.length > 1 ? "connect" : "connects"} to BigQuery through native connectors, under the same IAM, policy tags and masking as Google tools.`);
  if (has("looker")) demo.push("Show Looker's semantic layer giving one set of governed metrics to dashboards, Sheets and Conversational Analytics.");
  if (has("agent_platform")) demo.push("Explain how agents on Agent Platform query BigQuery through MCP tools under the user's own permissions.");
  const geC = S.scenario.components.find((c) => c.type === "gemini_enterprise");
  if (geC) demo.push(`Close with Gemini Enterprise: employees ask business questions and run Deep Research ${({ bigquery: "grounded in BigQuery", looker: "answered from Looker's governed metrics", both: "over BigQuery and Looker's governed metrics", agents: "through the registered data agents" })[geC.settings.grounding || "bigquery"]}.`);
  const apC = S.scenario.components.find((c) => c.type === "apigee");
  if (apC) demo.push(`Show Apigee as ${({ integration: "the integration layer that exposes data products as governed APIs", agents: "the AI gateway agents use for models and MCP tools", both: "both the integration layer for data APIs and the AI gateway for agents" })[apC.settings.role || "both"]}; drag it on the canvas to switch roles.`);
  if (has("knowledge_catalog")) demo.push("Show lineage and quality scores in Knowledge Catalog as the trust layer for every consumer.");
  demo.push("Use Workload sizing to price the customer's pipelines, queries and dashboards, then export the proposal.");
  html += `<h3 class="cat-head">Suggested demo storyline</h3><ol class="demo-steps">${demo.map((d) => `<li>${esc(d)}</li>`).join("")}</ol>`;
  host.innerHTML = html;
}
