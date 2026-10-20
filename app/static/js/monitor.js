/* Data Cloud Compass - monitor.js: Product monitor - the four key products in one view.
 *
 * BigQuery (slots and cost), Looker (licences and cost), Apigee (API calls and cost) and
 * Gemini Enterprise (users and cost), each with Year 1, 2, 3 and the 3-year total for the chosen
 * pricing option. Costs come from the same monthly plan as Pricing (ramp-up or full scope), so the
 * two pages always agree. Figures are marked Draft until the environments are finalised. */
import { S } from "./state.js";
import { $, esc, toast } from "./core.js";
import { money } from "./cost.js";
import { addComponent, openComp } from "./components.js";
import { changed } from "./events.js";
import { compMeta } from "./pricing.js";
import { tip } from "./tips.js";
import { EDITION_NAME } from "./bigquery.js";
import { envFinal, envFinalInfo, envFinalStale } from "./envfinal.js";
import { plans, pp } from "./modules.js";

const OPTS = [["payg", "Pay as you go"], ["cud1", "1-year commitment"], ["cud3", "3-year commitment"]];
const ui = { opt: null };
const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? "-" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
const comp = (types) => S.scenario.components.find((c) => types.includes(c.type) && c.included !== false);
const opt = () => (ui.opt ||= ["payg", "cud1", "cud3"].includes(S.scenario.pricing_option) ? S.scenario.pricing_option : "payg");

/** Cost per year [y1, y2, y3] of every plan line whose service matches, for the chosen option. */
function years(match) {
  const rows = (pp()?.products || []).filter((p) => match(p.service));
  const o = opt();
  return [0, 1, 2].map((y) => rows.reduce((a, p) => a + (p[o] || p.payg || []).slice(y * 12, y * 12 + 12).reduce((s, v) => s + v, 0), 0));
}

const isBq = (s) => s.startsWith("BigQuery") && !s.startsWith("BigQuery queries from");
const isLooker = (s) => s.startsWith("Looker");
const isApigee = (s) => s.startsWith("Apigee");
const isGe = (s) => s.startsWith("Gemini Enterprise") || s.startsWith("BigQuery queries from Gemini Enterprise");

const TIPS = {
  cost: "Cost per year for the chosen pricing option, summed over every environment, following the Pricing page (ramp-up plan or full scope from month 1). Year 1 = months 1-12.",
  slots: "Sum over environments of each reservation's maximum slots (baseline + autoscaling) for the year, sized on that year's busiest hour. Details: BigQuery slot details.",
  commit: "Slots committed for the year under this option: none for pay as you go; 1-year commitments are re-sized each year; a 3-year commitment only grows.",
  bqsplit: "Compute = slots (or TiB scanned on-demand). Storage = active and long-term storage of bronze, silver and gold. Other = streaming inserts, Storage Write API.",
  looker: "Looker licences are quote-based: enter the customer's annual quote and it is spread over the months Looker is live. Looker Studio Pro is priced per user.",
  ge: "Per-user licence for the chosen edition, plus BigQuery queries Gemini Enterprise runs when it is grounded on BigQuery (on-demand pricing only).",
  apigee: "Environment fee by size plus API calls per month, analytics and advanced API security when chosen.",
};

function cards() {
  const r = S.result;
  const bq = r?.bigquery;
  const pl = bq?.plan;
  const ed = S.scenario.bq?.mode === "editions";
  const o = opt();
  const out = [];

  // BigQuery
  {
    const compute = years((s) => s === "BigQuery compute"), storage = years((s) => s === "BigQuery storage");
    const all = years(isBq);
    const other = all.map((v, i) => v - compute[i] - storage[i]);
    const used = !!(r && S.scenario.sources.some((s) => s.included !== false));
    const rows = [];
    if (ed && pl) {
      rows.push(["Max slots", pl.totals.map((t) => fmt(t.max)), TIPS.slots]);
      rows.push([o === "payg" ? "Committed slots" : "Committed slots", pl.totals.map((t) => (o === "payg" ? "-" : fmt(t.commitment[o]))), TIPS.commit]);
    } else if (bq) {
      rows.push(["TiB scanned / month (prod)", [fmt(bq.scan_tib_month, 1), "", ""], "On-demand bills per TiB scanned, so there are no slots to reserve. Switch to Editions in BigQuery slot details to size slots."]);
    }
    rows.push(["Compute", compute.map((v) => money(v)), TIPS.bqsplit], ["Storage", storage.map((v) => money(v)), TIPS.bqsplit]);
    if (other.some((v) => v > 0.5)) rows.push(["Other", other.map((v) => money(v)), TIPS.bqsplit]);
    out.push({ key: "bigquery", name: "BigQuery", used,
      big: ed && pl ? `${fmt(pl.totals[0].max)} → ${fmt(pl.totals[2].max)} slots` : "On-demand (per TiB)",
      sub: ed && pl ? `${EDITION_NAME[bq.edition] || ""} edition · max slots, year 1 → 3` : "Pay per TiB scanned",
      rows, cost: all, goto: true });
  }
  // Looker
  {
    const c = comp(["looker", "looker_studio_pro", "looker_studio"]);
    const cost = years(isLooker);
    const quoteMissing = c && c.type === "looker" && !(+c.settings.annual_quote_usd > 0);
    out.push({ key: "looker", name: "Looker", used: !!c, add: "looker", id: c?.id,
      big: c ? `${fmt(c.settings.users)} licences` : "Not in the architecture",
      sub: c ? (compMeta(c.type)?.name || "Looker") + (c.type === "looker" ? " · quote-based" : c.type === "looker_studio" ? " · no licence cost" : " · per user") : "",
      rows: c ? [["Licences (users)", [fmt(c.settings.users), "", ""], TIPS.looker],
        ["Licence cost", quoteMissing ? ["quote needed", "quote needed", "quote needed"] : cost.map((v) => money(v)), TIPS.looker]] : [],
      cost, quoteMissing, quote: c?.settings.annual_quote_usd });
  }
  // Apigee
  {
    const c = comp(["apigee"]);
    const cost = years(isApigee);
    const envName = compMeta("apigee")?.settings?.find((f) => f.key === "environment")?.options?.find((x) => x.id === c?.settings.environment)?.name;
    out.push({ key: "apigee", name: "Apigee", used: !!c, add: "apigee", id: c?.id,
      big: c ? `${fmt(c.settings.api_calls_million)} M API calls / month` : "Not in the architecture",
      sub: c ? `${envName || c.settings.environment} environment` : "",
      rows: c ? [["API calls / month", [`${fmt(c.settings.api_calls_million)} M`, "", ""], TIPS.apigee], ["Cost", cost.map((v) => money(v)), TIPS.apigee]] : [], cost });
  }
  // Gemini Enterprise
  {
    const c = comp(["gemini_enterprise"]);
    const cost = years(isGe);
    const edName = compMeta("gemini_enterprise")?.settings?.find((f) => f.key === "edition")?.options?.find((x) => x.id === c?.settings.edition)?.name;
    out.push({ key: "gemini_enterprise", name: "Gemini Enterprise", used: !!c, add: "gemini_enterprise", id: c?.id,
      big: c ? `${fmt(c.settings.users)} users` : "Not in the architecture",
      sub: c ? `${edName || c.settings.edition} edition` : "",
      rows: c ? [["Users", [fmt(c.settings.users), "", ""], TIPS.ge], ["Cost", cost.map((v) => money(v)), TIPS.ge]] : [], cost });
  }
  return out;
}

function status() {
  if (envFinal()) {
    const f = envFinalInfo();
    return `<span class="mon-status final">Final</span><span class="muted">Environments finalised${f.by ? ` by ${esc(f.by)}` : ""} on ${new Date(f.at).toLocaleDateString()}</span>`;
  }
  return `<span class="mon-status draft">Draft</span><span class="muted">${envFinalStale() ? "Environments changed after they were finalised." : "Environments are not finalised yet."}</span>
    <button type="button" class="link-btn" data-goto-tab="env">Finalise on Environments ›</button>`;
}

export function renderMonitor() {
  const host = $("#monitorBody");
  if (!host) return;
  if (!S.result || !pp()) { host.innerHTML = `<p class="empty-note">Calculating…</p>`; return; }
  const cs = cards();
  const o = opt();
  const total = [0, 1, 2].map((y) => cs.reduce((a, c) => a + (c.used ? c.cost[y] : 0), 0));
  const card = (c) => `<article class="mon-card p4${c.used ? " on" : " off"}" data-mon="${c.key}">
      <header><h3>${esc(c.name)}</h3><span class="pill ${c.used ? "used" : "unused"}">${c.used ? "Used" : "Not used"}</span></header>
      <p class="mon-big">${esc(c.big)}</p>${c.sub ? `<p class="mon-sub-line">${esc(c.sub)}</p>` : ""}
      ${c.used && c.rows.length ? `<table class="mon-yrs"><thead><tr><th></th><th>Year 1</th><th>Year 2</th><th>Year 3</th></tr></thead><tbody>
        ${c.rows.map(([k, v, t]) => `<tr><th scope="row">${esc(k)}${tip(t)}</th>${v.map((x) => `<td>${x}</td>`).join("")}</tr>`).join("")}
        <tr class="tot"><th scope="row">Total cost${tip(TIPS.cost)}</th>${c.cost.map((x) => `<td>${c.quoteMissing ? "-" : money(x)}</td>`).join("")}</tr></tbody></table>
        <p class="mon-3y">3-year total <b>${c.quoteMissing ? "quote needed" : money(c.cost.reduce((a, b) => a + b, 0))}</b></p>` : ""}
      ${c.quoteMissing ? `<div class="mon-warn" role="alert"><b>Looker quote needed.</b> Looker is quote-based and not in the totals yet.
          <label>Annual licence quote (USD)<input type="number" min="0" step="1000" data-mon-quote="${esc(c.id)}" placeholder="e.g. 120000"></label></div>` : ""}
      <footer>${c.used && c.goto ? `<button type="button" class="link-btn" data-mon-goto="slots">BigQuery slot details ›</button>`
        : c.used && c.id ? `<button type="button" class="link-btn" data-mon-open="${esc(c.id)}">Configure ›</button>`
        : !c.used && c.add ? `<button type="button" class="btn small" data-mon-add="${c.add}">Add to the architecture</button>` : ""}</footer>
    </article>`;
  host.innerHTML = `<div class="mon-head">
      <div class="mon-state">${status()}</div>
      <div class="seg small" role="radiogroup" aria-label="Pricing option">${OPTS.map(([k, n]) => `<button type="button" role="radio" aria-selected="${o === k}" aria-checked="${o === k}" data-mon-opt="${k}">${n}</button>`).join("")}</div></div>
    <p class="lede">The four key products in this design: what is used, how much, and what it costs each year - ${esc(OPTS.find(([k]) => k === o)[1].toLowerCase())}, ${plans.basis === "steady" ? "full scope from month 1" : "following the ramp-up plan"}, all environments.</p>
    <div class="mon-grid four">${cs.map(card).join("")}</div>
    <div class="mon-total"><span>These four products together</span>${total.map((v, i) => `<div><small>Year ${i + 1}</small><b>${money(v)}</b></div>`).join("")}<div><small>3 years</small><b>${money(total.reduce((a, b) => a + b, 0))}</b></div></div>
    <p class="hint">Other products and services (Agent Platform, Datastream, Dataflow, Cloud Storage, governance…) are in Pricing → Detailed breakdown.</p>`;
}

export function monitorSummary() {
  if (!S.result || !pp()) return null;
  const cs = cards();
  return { used: cs.filter((c) => c.used).length, total: cs.length, slots: cs[0].big, cards: cs, final: envFinal() };
}

export function bindMonitor(showTab) {
  const host = $("#monitorBody");
  if (!host) return;
  host.addEventListener("click", (e) => {
    const a = e.target.closest("[data-mon-add]");
    if (a) { addComponent(a.dataset.monAdd); changed(); return; }
    const op = e.target.closest("[data-mon-open]");
    if (op) { openComp(op.dataset.monOpen); return; }
    const g = e.target.closest("[data-mon-goto]");
    if (g) { showTab(g.dataset.monGoto); return; }
    const k = e.target.closest("[data-mon-opt]");
    if (k) { ui.opt = k.dataset.monOpt; renderMonitor(); }
  });
  host.addEventListener("change", (e) => {
    const q = e.target.closest("[data-mon-quote]");
    if (!q) return;
    const c = S.scenario.components.find((x) => x.id === q.dataset.monQuote);
    const v = Math.max(0, Number(q.value) || 0);
    if (c && v > 0) { c.settings.annual_quote_usd = v; changed(); toast(`Looker quote of ${money(v)} a year added to every total`); }
  });
}
