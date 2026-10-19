/* Data Cloud Compass - monitor.js: Product Monitor - one card per key Google Cloud product:
 * is it used in this project, how much of it (slots, users, calls, requests) and what it costs per month. */
import { S } from "./state.js";
import { $, esc } from "./core.js";
import { money } from "./cost.js";
import { addComponent, openComp } from "./components.js";
import { changed } from "./events.js";
import { bomCost, compMeta, optShort } from "./pricing.js";
import { tip } from "./tips.js";

const comp = (type) => S.scenario.components.find((c) => c.type === type && c.included !== false);
const anyComp = (types) => types.map(comp).find(Boolean);
const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? "-" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
const settingName = (type, key, id) => compMeta(type)?.settings?.find((f) => f.key === key)?.options?.find((o) => o.id === id)?.name || id;

/** Monthly cost at month 12 (selected pricing option) of every BOM line whose service matches. */
function cost(match) {
  const rows = (S.result?.bom || []).filter((b) => match(b.service));
  return { monthly: rows.reduce((a, b) => a + bomCost(b, "month12"), 0), envs: new Set(rows.map((b) => b.environment)).size };
}

function cards() {
  const r = S.result;
  const bq = r?.bigquery;
  const envs = r?.environments || [];
  const specs = bq?.env_specs || [];
  const out = [];

  // BigQuery
  const bqCost = cost((s) => s.startsWith("BigQuery"));
  const editions = S.scenario.bq?.mode === "editions";
  const pl = bq?.plan?.totals;
  const yrs = (f) => (pl ? pl.map(f).map((v) => fmt(v)).join(" / ") : "-");
  const gold = r?.platform?.lakehouse?.layers || [];
  out.push({ key: "bigquery", name: "BigQuery", used: !!(r && S.scenario.sources.some((s) => s.included !== false)),
    big: editions && pl ? `${fmt(pl[0].max)} → ${fmt(pl[2].max)} slots` : "On-demand",
    lines: [
      editions ? ["Max slots, year 1 / 2 / 3", yrs((t) => t.max)] : ["Pricing", "per TiB scanned"],
      editions ? ["Committed (3-yr), year 1 / 2 / 3", yrs((t) => t.commitment.cud3)] : ["Scanned / month (prod)", `${fmt(bq?.scan_tib_month, 1)} TiB`],
      ["Edition", editions ? (bq?.edition || "").replace("_", " ") : "-"],
      ["Average / peak demand (prod)", specs[0] ? `${fmt(specs[0].avg_slots, 1)} / ${fmt(specs[0].peak_slots)} slots` : "-"],
      ["Bronze / silver / gold (M12)", gold.length ? gold.map((l) => `${fmt(l.gib_month12 / 1024, 1)} TB`).join(" / ") : "-"],
      ["Environments", String(envs.length)],
    ], monthly: bqCost.monthly, goto: "slots", gotoLabel: "Slots by year ›" });

  // Looker family
  const lk = anyComp(["looker", "looker_studio_pro", "looker_studio"]);
  const lkCost = cost((s) => s.startsWith("Looker"));
  out.push({ key: "looker", name: "Looker", used: !!lk, add: "looker",
    big: lk ? `${fmt(lk.settings.users)} users` : "Not used",
    lines: lk ? [["Product", compMeta(lk.type).name], ["Users", fmt(lk.settings.users)],
      ["Licence", lk.type === "looker" ? (lk.settings.annual_quote_usd ? money(lk.settings.annual_quote_usd) + " / year (quote)" : "quote-based - not in the estimate") : lk.type === "looker_studio" ? "no cost" : "per user"]] : [],
    monthly: lkCost.monthly, id: lk?.id });

  // Apigee
  const ap = comp("apigee");
  const apCost = cost((s) => s.startsWith("Apigee"));
  out.push({ key: "apigee", name: "Apigee API management", used: !!ap, add: "apigee",
    big: ap ? `${fmt(ap.settings.api_calls_million)} M calls / month` : "Not used",
    lines: ap ? [["Role", { integration: "Integration layer", agents: "AI gateway for agents", both: "Integration layer + AI gateway" }[ap.settings.role] || ap.settings.role],
      ["Environment", settingName("apigee", "environment", ap.settings.environment)], ["Advanced API security", ap.settings.advanced_security === "yes" ? "Yes" : "No"]] : [],
    monthly: apCost.monthly, id: ap?.id });

  // Gemini Enterprise
  const ge = comp("gemini_enterprise");
  const geCost = cost((s) => s.startsWith("Gemini Enterprise") || s.startsWith("BigQuery queries from Gemini Enterprise"));
  out.push({ key: "gemini_enterprise", name: "Gemini Enterprise", used: !!ge, add: "gemini_enterprise",
    big: ge ? `${fmt(ge.settings.users)} users` : "Not used",
    lines: ge ? [["Edition", settingName("gemini_enterprise", "edition", ge.settings.edition)], ["Grounded on", { bigquery: "BigQuery", looker: "Looker semantic layer", both: "BigQuery + Looker", agents: "Data agents" }[ge.settings.grounding] || ge.settings.grounding],
      ["Questions / user / month", fmt(ge.settings.questions_per_user_month)]] : [],
    monthly: geCost.monthly, id: ge?.id });

  // Gemini Enterprise Agent Platform
  const ag = comp("agent_platform");
  const agCost = cost((s) => s.startsWith("Agent Engine") || s.includes("tokens (agents)") || s.startsWith("BigQuery queries from agents"));
  out.push({ key: "agent_platform", name: "Gemini Enterprise Agent Platform", used: !!ag, add: "agent_platform",
    big: ag ? `${fmt(ag.settings.requests_month)} requests / month` : "Not used",
    lines: ag ? [["Model", settingName("agent_platform", "model", ag.settings.model).replace(" (recommended)", "")], ["Tokens / request", `${fmt(ag.settings.input_tokens)} in · ${fmt(ag.settings.output_tokens)} out`],
      ["Runtime", "Agent Engine"]] : [],
    monthly: agCost.monthly, id: ag?.id });

  // Ingestion & other platform services found in the bill of materials
  const more = [
    ["datastream", "Datastream (CDC)", (s) => s.startsWith("Datastream")],
    ["dataflow", "Dataflow", (s) => s.startsWith("Dataflow")],
    ["pubsub", "Pub/Sub", (s) => s.startsWith("Pub/Sub")],
    ["gcs", "Cloud Storage", (s) => s.startsWith("Cloud Storage")],
    ["orchestration", "Composer / Workflows", (s) => s.startsWith("Composer") || s.startsWith("Workflows")],
    ["catalog", "Knowledge Catalog (Dataplex)", (s) => s.startsWith("Knowledge Catalog")],
    ["databases", "AlloyDB / Cloud SQL / Spanner", (s) => /^(AlloyDB|Cloud SQL|Spanner)/.test(s)],
    ["vertex", "Vertex AI endpoints", (s) => s.startsWith("Vertex AI")],
  ];
  more.forEach(([key, name, m]) => {
    const c = cost(m);
    out.push({ key, name, used: c.monthly > 0.005, big: c.monthly > 0.005 ? `${c.envs} environment${c.envs === 1 ? "" : "s"}` : "Not used", lines: [], monthly: c.monthly, small: true });
  });
  return out;
}

export function renderMonitor() {
  const host = $("#monitorBody");
  if (!host) return;
  if (!S.result) { host.innerHTML = `<p class="empty-note">Calculating…</p>`; return; }
  const cs = cards();
  const used = cs.filter((c) => c.used).length;
  const card = (c) => `<article class="mon-card${c.used ? " on" : " off"}${c.small ? " small" : ""}" data-mon="${c.key}">
      <header><h3>${esc(c.name)}</h3><span class="pill ${c.used ? "used" : "unused"}">${c.used ? "Used" : "Not used"}</span></header>
      <p class="mon-big">${esc(c.big)}</p>
      ${c.lines.length ? `<dl>${c.lines.map(([k, v]) => `<div><dt>${esc(k)}${tip(MON_TIPS[k])}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
      <footer><span>${c.used ? `<b>${money(c.monthly)}</b> / month at month 12` : "&nbsp;"}</span>
        ${c.used && c.id ? `<button type="button" class="link-btn" data-mon-open="${esc(c.id)}">Configure ›</button>`
          : c.used && c.goto ? `<button type="button" class="link-btn" data-mon-goto="${c.goto}">${esc(c.gotoLabel || "Details ›")}</button>`
          : !c.used && c.add ? `<button type="button" class="btn small" data-mon-add="${c.add}">Add to the architecture</button>` : ""}</footer>
    </article>`;
  host.innerHTML = `<p class="lede">${used} of ${cs.length} key products are used in this project. Costs follow the selected pricing option (${esc(optShort())}) and include every environment.</p>
    <div class="mon-grid">${cs.filter((c) => !c.small).map(card).join("")}</div>
    <h3 class="sec-title">Ingestion, storage and platform services</h3>
    <div class="mon-grid small">${cs.filter((c) => c.small).map(card).join("")}</div>`;
}

export function monitorSummary() {
  if (!S.result) return null;
  const cs = cards();
  return { used: cs.filter((c) => c.used).length, total: cs.length, slots: cs[0].big };
}

/** The BigQuery card's figures, with how each is derived (shown on hover). */
export const MON_TIPS = {
  "Max slots, year 1 / 2 / 3": "Sum over environments of each reservation's maximum (baseline + autoscaling) for the year, sized on that year's busiest hour.",
  "Committed (3-yr), year 1 / 2 / 3": "Slots under the 3-year commitment in each year (it can only grow). See BigQuery slots for 1-year and pay-as-you-go.",
  "Average / peak demand (prod)": "Production slots in use in the steady-state month: average over the month, and the busiest hour of an average day.",
  "Bronze / silver / gold (M12)": "Data stored in each BigQuery layer at month 12; silver and gold are set as a share of bronze in Settings.",
}

export function bindMonitor(showTab) {
  const host = $("#monitorBody");
  if (!host) return;
  host.addEventListener("click", (e) => {
    const a = e.target.closest("[data-mon-add]");
    if (a) { addComponent(a.dataset.monAdd); changed(); return; }
    const o = e.target.closest("[data-mon-open]");
    if (o) { openComp(o.dataset.monOpen); return; }
    const g = e.target.closest("[data-mon-goto]");
    if (g) showTab(g.dataset.monGoto);
  });
}
