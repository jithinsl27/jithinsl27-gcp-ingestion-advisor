/* Data Cloud Compass - pricing.js (ES module, no build step). */
import { S } from "./state.js";
import { $, clone, esc } from "./core.js";
import { GROUP_COLORS, money, moneyShort, unitPrice } from "./cost.js";
import { fmtSpecQty } from "./environments.js";
import { renderAll } from "./render.js";
import { save } from "./scenario.js";
import { ed, openBomEditor, renderBomEditor } from "./bomedit.js";

// ------------------------------------------------------------------ headline drill-down: products and pricing
export const GROUP_ORDER_UI = ["Data ingestion & CDC", "BigQuery & storage", "Analytics & AI", "APIs & databases", "Governance & security", "Platform & network", "Contingency"];

export const SHARED_UI = new Set(["Network (HA VPN)", "Network (Interconnect)", "Looker licence (customer quote)"]);

export const DRILL = {
  month: { label: () => "Average per month, year 1", note: "Year-1 quantity and cost divided by 12.", cost: (b) => bomCost(b, "year1") / 12, qty: (b) => b.qty_year1 == null ? null : b.qty_year1 / 12, total: () => OV().totals.avg_monthly_year1 },
  year1: { label: () => `1-year, ${optShort()}`, note: "Months 1-12.", cost: (b) => bomCost(b, "year1"), qty: (b) => b.qty_year1, total: () => OV().totals.year1 },
  three: { label: () => `3-year, ${optShort()}`, note: "Months 1-36 including data growth.", cost: (b) => bomCost(b, "three_year"), qty: (b) => b.qty_three_year, total: () => OV().totals.three_year },
};

export const drill = { view: "year1", env: "all" };

export const OPT_NOTE = {
  payg: "List prices, no commitments.",
  cud1: "1-year committed-use discounts on eligible services: BigQuery editions, Dataflow streaming, Composer, Agent Engine, AlloyDB, Cloud SQL, Spanner, Bigtable, Firestore, Memorystore, Knowledge Catalog premium. Everything else stays at list price.",
  cud3: "3-year committed-use discounts on eligible services: BigQuery editions, Dataflow streaming, Composer, Agent Engine, AlloyDB, Cloud SQL, Spanner, Bigtable, Firestore, Memorystore, Knowledge Catalog premium. Everything else stays at list price.",
};

export function openDrill(view) {
  // every headline figure opens the editable bill of materials for the matching plan
  const o = OPT();
  openBomEditor(view === "three" ? (o === "cud3" ? "commit_3y" : "payg_3y") : o === "cud1" ? "commit_1y" : o === "cud3" ? "commit_3y" : "payg_1y");
}

export function openLegacyDrill(view) {
  drill.view = DRILL[view] ? view : "year1";
  if (drill.env !== "all" && !(S.result.environments || []).some((e) => e.id === drill.env)) drill.env = "all";
  renderDrill();
  if (!$("#drillDialog").open) $("#drillDialog").showModal();
}

export function renderDrill() {
  const d = DRILL[drill.view];
  const envs = S.result.environments || [];
  const rows = (S.result.bom || []).filter((b) => drill.env === "all" || b.environment === drill.env);
  // collapse to one row per product (summing environments when "all")
  const by = new Map();
  rows.forEach((b) => {
    const r = by.get(b.service) || { service: b.service, group: b.group, unit: b.unit, why: b.why, cost: 0, qty: 0, hasQty: false, envs: [] };
    const c = d.cost(b), q = d.qty(b);
    r.cost += c;
    if (q != null) { r.qty += q; r.hasQty = true; }
    r.envs.push({ name: b.environment_name, cost: c });
    by.set(b.service, r);
  });
  const list = [...by.values()].filter((r) => r.cost > 0.004)
    .sort((a, b) => (GROUP_ORDER_UI.indexOf(a.group) - GROUP_ORDER_UI.indexOf(b.group)) || (b.cost - a.cost));
  const total = list.reduce((a, r) => a + r.cost, 0);
  const groupTot = {};
  list.forEach((r) => (groupTot[r.group] = (groupTot[r.group] || 0) + r.cost));
  let last = null;
  const multi = envs.length > 1 && drill.env === "all";
  const body = list.map((r) => {
    let head = "";
    if (r.group !== last) head = `<tr class="bom-group"><th colspan="4"><i style="background:${GROUP_COLORS[r.group] || "#9AA0A6"}"></i>${esc(r.group)}</th><th class="num">${money(groupTot[r.group])}</th><th class="num">${total ? Math.round(1000 * groupTot[r.group] / total) / 10 : 0}%</th></tr>`;
    last = r.group;
    const unitP = r.hasQty && r.qty ? r.cost / r.qty : null;
    const split = multi && r.envs.length > 1 ? `<span class="env-split">${r.envs.map((x) => `${esc(x.name)} ${moneyShort(x.cost)}`).join(" · ")}</span>` : "";
    return head + `<tr><td class="bom-prod"><b>${esc(r.service)}</b><span>${esc(r.why)}</span>${split}</td>
      <td class="num">${r.hasQty ? fmtSpecQty(r.qty) : "-"}</td><td class="bom-unit">${esc(r.unit || "-")}</td><td class="num">${unitPrice(unitP)}</td>
      <td class="num"><b>${money(r.cost)}</b></td><td class="num">${total ? (Math.round(1000 * r.cost / total) / 10) : 0}%</td></tr>`;
  }).join("");
  const envName = drill.env === "all" ? "All environments" : envs.find((e) => e.id === drill.env)?.name || "";
  const head = d.total();
  $("#drillBody").innerHTML = `
    <div class="drill-views" role="group" aria-label="Figure">${Object.entries(DRILL).map(([k, v]) =>
      `<button type="button" class="drill-view${drill.view === k ? " on" : ""}" data-drill-view="${k}"><span>${esc(v.label())}</span><b>${money(v.total())}</b></button>`).join("")}</div>
    <div class="opt-row">${optionSwitch()}<span class="hint">${esc(OPT_NOTE[OPT()])}</span></div>
    ${envs.length > 1 ? `<div class="bom-filter" role="group" aria-label="Environment">${[{ id: "all", name: "All environments", c: null }, ...envs].map((e) =>
      `<button type="button" class="chip-btn${drill.env === e.id ? " on" : ""}" data-drill-env="${esc(e.id)}">${esc(e.name)}${e.id === "all" ? "" : ` · ${moneyShort(envOpt(e)[drill.view === "three" ? "three_year" : drill.view === "year1" ? "year1" : "monthly_year1"])}`}</button>`).join("")}</div>` : ""}
    <p class="hint">${esc(d.note)} Unit price is the blended effective price under ${esc(optShort())} (tiers, free allowances and regional uplift for ${esc(S.result.region.name)}).${drill.env === "all" ? "" : ` Showing ${esc(envName)} only.`}</p>
    <div class="drill-scroll"><table class="bom-table drill-table"><thead><tr><th>Product &amp; why it is needed</th><th class="num">Quantity</th><th>Unit</th><th class="num">Unit price</th><th class="num">Cost</th><th class="num">Share</th></tr></thead>
    <tbody>${body || `<tr><td colspan="6">Nothing priced in this environment.</td></tr>`}</tbody>
    <tfoot><tr><td colspan="4">Total · ${esc(envName)}</td><td class="num">${money(total)}</td><td class="num">100%</td></tr></tfoot></table></div>
    ${drill.env === "all" && Math.abs(total - head) > 1 ? `<p class="hint">Rounding difference vs headline: ${money(head - total)}.</p>` : ""}`;
  $("#drillTitle").textContent = `${d.label()} - products and pricing`;
}

export function legacySecurityComponents(sec) {
  if (sec.enabled === false) return [];
  const out = [];
  [["sdp_discovery", "sdp"], ["cmek", "cmek"], ["vpc_sc", "vpc_sc"]].forEach(([flag, type]) => { if (sec[flag] !== false) out.push(type); });
  out.push("policy_tags", "scc");
  return out.map((type) => ({ id: uid("c"), type, settings: compDefaults(type) }));
}

export const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

export const compMeta = (type) => S.catalog.components.find((c) => c.id === type);

export const compDefaults = (type) => Object.fromEntries((compMeta(type)?.settings || []).map((f) => [f.key, f.default]));

// Nothing is priced until the architecture has at least one included source or costed Google product.
export const designed = () => !!S.catalog && (S.scenario.sources.some((s) => s.included !== false)
  || S.scenario.components.some((c) => c.included !== false && compMeta(c.type)?.costed));

export const hasEstimate = () => !!S.result && designed() && (S.result.totals?.three_year_payg || 0) > 0;

// ------------------------------------------------------------------ pricing option: pay-as-you-go / 1-yr / 3-yr commitments
export const OPTIONS = [
  { id: "payg", name: "Pay-as-you-go", short: "pay-as-you-go" },
  { id: "cud1", name: "1-year commitment", short: "1-yr commitment" },
  { id: "cud3", name: "3-year commitment", short: "3-yr commitment" },
];

export const OPT = () => S.scenario.pricing_option || "payg";

export const optShort = (id = OPT()) => OPTIONS.find((o) => o.id === id).short;

export const OV = (id = OPT()) => S.result.by_option[id];

// cost of a bill-of-materials row under the chosen option (field: month12 | year1 | three_year)
export const bomCost = (b, field, id = OPT()) => (id === "payg" ? b[field] : b[id][field]);

export const envOpt = (e) => ({ ...e, ...(e.by_option?.[OPT()] || {}) });

export function optionSwitch() {
  return `<div class="opt-switch" role="radiogroup" aria-label="Consumption pricing">${OPTIONS.map((o) =>
    `<button type="button" role="radio" aria-checked="${OPT() === o.id}" class="${OPT() === o.id ? "on" : ""}" data-opt="${o.id}">${esc(o.name)}</button>`).join("")}</div>`;
}

export function setOption(id) {
  if (id === OPT()) return;
  S.scenario.pricing_option = id;
  save();
  renderAll();
  if ($("#drillDialog").open) (ed.open ? renderBomEditor() : renderDrill());
}

export function emptyWorkload() {
  const w = clone(S.catalog.default_workload);
  Object.assign(w.data, { structured_tb: 0, semi_structured_tb: 0, unstructured_tb: 0, tables: 0 });
  w.telemetry.volume_gb = 0;
  Object.assign(w.pipelines, { simple: 0, medium: 0, complex: 0 });
  Object.values(w.queries).forEach((q) => { q.count = 0; });
  w.dashboards.count = 0;
  Object.assign(w.ramp, { months: 0, data_gb: 0, pipelines: 0, reports: 0 });
  return w;
}
