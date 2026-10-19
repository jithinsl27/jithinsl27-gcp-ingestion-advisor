/* Data Cloud Compass - modules.js: module navigation, insights, overview, pricing plans,
 * environments module and the proposal generator (ES module, no build step). */
import { S } from "./state.js";
import { $, $$, esc } from "./core.js";
import { GROUP_COLORS, fmtGB, fmtQty, fx, money, moneyShort, unitPrice } from "./cost.js";
import { compMeta } from "./pricing.js";
import { freqName, renderSummary, tool } from "./render.js";
import { regionName } from "./main.js";
import { archInventory, bqModelName } from "./diagram.js";
import { EDITION_NAME } from "./bigquery.js";
import { NO_DOWNLOAD, diagramPng, download, googleClientId, slug } from "./exports.js";
import { envSizingSection } from "./environments.js";
import { save, syncForm, withDefaults } from "./scenario.js";
import { bindMonitor, monitorSummary, renderMonitor } from "./monitor.js";
import { bindEnquiry, enquiryCount, renderEnquiry } from "./enquiry.js";
import { forgetCloud } from "./account.js";
import { changed } from "./events.js";
import { clone, toast } from "./core.js";
import { bindReadiness, readiness, readinessProgress, renderReadiness } from "./readiness.js";
import { bindBomEditor, ed as bomEd, envSpecSection, renderBomEditor } from "./bomedit.js";
import { bindSlotsPage, renderSlotsPage } from "./slotspage.js";
import { showBeta } from "./beta.js";
import { bindUseCases, renderUseCases } from "./usecases.js";
import { bindChargeback, loadChargeback, renderChargeback } from "./cbpage.js";
import { bindUsage, loadUsage, renderUsage } from "./usagepage.js";
import { track } from "./identity.js";
import { renderWorkloadForm, renderWorkloadSummary } from "./workload.js";

// ------------------------------------------------------------------ modules
export const MODULES = {
  overview: ["Overview", "The whole engagement at a glance - click any card to open that module."],
  sources: ["Source systems", "What the customer has today, where each source lands on Google Cloud, and which are in this phase."],
  usecases: ["Use cases", "What the customer wants to achieve. Type in the customer's own use cases - or, if they have none yet, add their data sources and the top 5 are recommended from each source's type and system."],
  slots: ["BigQuery slots", "How much BigQuery computing power each environment needs, what to reserve or commit, and why."],
  chargeback: ["Charge-back", "Price a department's request - sources, pipelines, reports and AI use cases - on the negotiated Google Cloud prices."],
  usage: ["Usage", "Who is using Data Cloud Compass and what they do (admin key required)."],
  arch: ["Target architecture", "Sources, ingestion, raw zone, BigQuery bronze / silver / gold and the BI, AI, API and governance layers."],
  recs: ["Data flow & integrations", "How every source system gets into Google Cloud (the recommended GCP-native ETL / ELT, with rationale and alternatives) and how each BI, AI, API, database and governance product connects to BigQuery."],
  monitor: ["Product monitor", "Which key Google Cloud products this project uses - Looker, Apigee, Gemini Enterprise, Agent Platform and more - how much and what they cost; and the BigQuery slots needed each year with 1- and 3-year commitments."],
  enquiry: ["Customer technical enquiry", "Ask any technical question in plain language - answers come only from Google's public documentation, with the reference links."],
  pricing: ["Pricing", "Whole-programme cost: pay as you go, 1-year or 3-year commitment - by month, product and quantity."],
  env: ["Environments", "Production, development, test, DR … each sized as a share of production."],
  workload: ["Workload", "What the customer will run - data, pipelines, reports, dashboards and queries - in plain terms. It drives BigQuery sizing and pricing."],
  kickoff: ["Kickoff readiness", "What the customer and partner must have ready before kickoff for this architecture, the milestones with exit criteria, and the team size and skills."],
  roadmap: ["Roadmap", "Delivery plan by squad, go-live month per source and product, and the ramped monthly spend."],
  proposal: ["Proposal", "Generate a customer proposal of up to 15 pages - PDF, Word or Google Docs."],
  settings: ["Settings & assumptions", "Engagement settings, commercial terms, lakehouse layers, sizing constants and price sources."],
};
export const nav = { tab: "overview" };
const GROUP_ORDER_UI = ["Data ingestion & CDC", "BigQuery & storage", "Analytics & AI", "APIs & databases", "Governance & security", "Platform & network", "Contingency"];
const TARGET_SHORT = { data_platform: "Data platform", data_lake: "Data lake", operational_db: "Operational DB", data_mesh: "Data mesh" };
export { TARGET_SHORT };
const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "0%");
const sumArr = (a, lo = 0, hi = a.length) => a.slice(lo, hi).reduce((x, y) => x + y, 0);
export const pp = () => S.planResult?.pricing?.[plans.basis] || S.planResult?.pricing?.ramped;

export function showModule(id, sub) {
  if (id === "platform") id = "recs";              // Integrations now live on the Data flow & integrations page
  if (id === "slots") { id = "monitor"; sub = "slots"; }   // BigQuery slots now live in the Product monitor
  if (id === "monitor") nav.sub = sub || nav.sub || "products";
  if (!$("#tab-" + id)) id = "overview";
  nav.tab = id;
  $$(".modnav button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === id)));
  $$(".tabpanel").forEach((p) => (p.hidden = p.id !== "tab-" + id));
  try { localStorage.setItem("data-cloud-compass:tab", id); } catch (_) { /* ignore */ }
  renderModules();
  if (id === "chargeback") loadChargeback();
  if (id === "usage") loadUsage();
  if (id === "workload") renderWorkloadForm();
  if (S.booted) track("module opened", id);
  S.booted = true;
  window.scrollTo({ top: 0 });
}

export function renderModules() {
  if (!S.catalog) return;
  renderHead();
  if (nav.tab === "overview") renderOverview();
  if (nav.tab === "pricing") renderPlans();
  if (nav.tab === "env") renderEnvBody();
  if (nav.tab === "proposal") renderProposal();
  if (nav.tab === "kickoff") renderReadiness();
  if (nav.tab === "usecases") renderUseCases();
  if (nav.tab === "chargeback") renderChargeback();
  if (nav.tab === "usage") renderUsage();
  if (nav.tab === "workload") renderWorkloadSummary();
  if (nav.tab === "monitor") {
    $$(".mon-sub [data-mon-sub]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.monSub === nav.sub)));
    $("#monitorBody").hidden = nav.sub === "slots";
    $("#slotsBody").hidden = nav.sub !== "slots";
    if (nav.sub === "slots") renderSlotsPage(); else renderMonitor();
  }
  if (nav.tab === "enquiry") renderEnquiry();
  if (bomEd.open) renderBomEditor();
}

function insightChips(id) {
  const chips = [];
  const chip = (label, value, tone) => chips.push(`<div class="ins${tone ? " " + tone : ""}"><span>${esc(label)}</span><b>${value}</b></div>`);
  const P = pp()?.plans;
  const recs = S.result?.recommendations || [];
  const tg = S.result?.platform?.targets || {};
  if (id === "overview" && S.planResult) {
    chip("All sources live by", `Month ${Math.max(...S.planResult.waves.map((w) => w.go_live_month), 1)}`);
    chip("Environments", String(S.scenario.environments.length));
    chip("BigQuery region", esc(S.result?.region?.id || ""));
  }
  if (id === "pricing" && P) {
    chip("1 year, pay as you go", money(P.payg_1y.total));
    chip("1-year commitment", money(P.commit_1y.total), "good");
    chip("3-year commitment", money(P.commit_3y.total), "good");
  }
  if (id === "sources") {
    chip("Sources", `${recs.length} of ${S.scenario.sources.length} in this phase`);
    chip("Daily change", fmtGB(S.scenario.sources.filter((s) => s.included !== false).reduce((a, s) => a + (Number(s.daily_change_gb) || 0), 0)) + "/day");
    chip("To data platform", String((tg.data_platform || []).length));
    if ((tg.data_lake || []).length) chip("To data lake", String(tg.data_lake.length));
    if ((tg.operational_db || []).length) chip("To operational DB", String(tg.operational_db.length));
    if ((tg.data_mesh || []).length) chip("Data mesh domains", String((S.result?.domains || []).length));
  }
  if (id === "arch" || id === "platform") {
    const inv = archInventory();
    chip("Products in the architecture", String(inv.total));
    chip("Google Cloud", String(inv.google));
    chip("Partners (not costed)", String(inv.partner));
  }
  if (id === "monitor") {
    const m = monitorSummary();
    if (m && nav.sub !== "slots") { chip("Products used", `${m.used} of ${m.total}`); chip("BigQuery", esc(m.slots)); }
  }
  if (id === "enquiry") chip("Questions answered", String(enquiryCount()));
  if (id === "recs") {
    chip("CDC sources", String(recs.filter((r) => r.engine.includes("datastream")).length));
    chip("Distinct services", String(new Set(recs.flatMap((r) => r.chain)).size));
  }
  if (id === "env" && S.result?.environments) {
    chip("Environments", String(S.result.environments.length));
    if (S.result.environments.length > 1) chip("Non-production, year 1", money(S.result.environments.slice(1).reduce((a, e) => a + e.year1, 0)));
  }
  if (id === "workload" && S.result?.bigquery) {
    const b = S.result.bigquery;
    chip("Pricing uses", b.scan_basis === "workload" ? "These numbers" : "Rule of thumb", b.scan_basis === "workload" ? "good" : "");
    chip("Scanned / month", `${(b.scan_tib_month || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} TiB`);
    chip("Production slots", `${b.avg_slots} avg · ${Math.round(b.peak_slots)} peak`);
  }
  if (id === "usecases") {
    chip("Recommended", String((S.result?.use_cases || []).length));
    chip("Customer's list", String((S.scenario.use_cases || []).length));
  }
  if (id === "monitor" && nav.sub === "slots" && S.result?.bigquery?.active) {
    const b = S.result.bigquery, pl = b.plan;
    chip("Model", S.scenario.bq?.mode === "editions" ? `${EDITION_NAME[b.edition]} edition` : "On-demand");
    if (S.scenario.bq?.mode === "editions" && pl) {
      chip("Max slots, Y1 → Y3", `${pl.totals[0].max} → ${pl.totals[2].max}`);
      chip("3-yr commitment, Y1 → Y3", `${pl.totals[0].commitment.cud3} → ${pl.totals[2].commitment.cud3} slots`, "good");
      chip("3-yr compute saving", money(pl.three_year.payg - pl.three_year.cud3), "good");
    } else chip("Production demand", `${b.avg_slots} avg · ${Math.round(b.peak_slots)} peak`);
  }
  if (id === "kickoff" && readiness()) {
    const p = readinessProgress(), r = readiness();
    chip("Checklist ready", `${p.done} of ${p.total}`, p.done === p.total ? "good" : "");
    chip("Critical items open", String(p.critOpen), p.critOpen ? "warn" : "good");
    chip("Partner team at peak", `${r.team.partner_fte} FTE`);
    chip("Milestones", String(r.milestones.length));
  }
  if (id === "roadmap" && S.planResult) {
    chip("Programme", `${S.planResult.horizon} months`);
    chip("Squads", String(S.planResult.teams));
    chip("Year 1 with ramp-up", money(S.planResult.totals.ramped_year1));
  }
  return chips.join("");
}

export function renderHead() {
  const [title, desc] = MODULES[nav.tab] || MODULES.overview;
  $("#modTitle").textContent = title;
  $("#modDesc").textContent = desc;
  $("#modInsights").innerHTML = S.scenario.sources.length ? insightChips(nav.tab) : "";
  const badge = (k, v) => { const el = $(`[data-badge="${k}"]`); if (el) el.textContent = v || ""; };
  badge("sources", S.scenario.sources.length ? String(S.scenario.sources.length) : "");
  badge("pricing", pp() ? moneyShort(pp().plans.payg_1y.total) : "");
  badge("env", String(S.scenario.environments.length));
  badge("roadmap", S.planResult ? `${S.planResult.horizon} mo` : "");
  { const m = monitorSummary(); badge("monitor", m ? `${m.used}/${m.total}` : ""); }
  { const p = readinessProgress(); badge("kickoff", p ? `${p.done}/${p.total}` : ""); }
  badge("usecases", (S.scenario.use_cases || []).length ? String(S.scenario.use_cases.length) : "");
  $("#feedbackBtn").hidden = false;
}

export const feedbackUrl = () => (window.COMPASS_CONFIG && window.COMPASS_CONFIG.feedbackUrl) || S.config?.feedback_url || "";

// ------------------------------------------------------------------ overview
export function renderOverview() {
  const host = $("#overviewBody");
  if (!host) return;
  if (!S.scenario.sources.length) {
    host.innerHTML = `<div class="ov-empty"><h2>Start a discovery</h2><p>Add the customer's source systems (or use Discover / Load sample) to see the complete engagement.</p>
      <button class="btn primary" type="button" data-goto="sources">Add source systems</button></div>`;
    return;
  }
  const P = pp()?.plans;
  const r = S.result;
  const recs = r?.recommendations || [];
  const tg = r?.platform?.targets || {};
  const comps = S.scenario.components.map((c) => compMeta(c.type)).filter(Boolean);
  const groups = (r?.by_group || []).filter((g) => g.year1 > 0);
  const maxG = Math.max(...groups.map((x) => x.year1), 1);
  const top = (r?.by_service || []).slice(0, 3);
  const sl = S.wlResult?.slots;
  const card = (goto, title, body) => `<button type="button" class="ov-card" data-goto="${goto}"><h3>${esc(title)}</h3>${body}<span class="ov-open">Open ›</span></button>`;
  const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><b>${v}</b></div>`;
  let html = `<div class="ov-plans">`;
  if (P) {
    const pc = (key, label, sub) => `<button type="button" class="plan-card" data-goto="pricing" data-plan="${key}"><span>${esc(label)}</span><b>${money(P[key].total)}</b><small>${sub}</small></button>`;
    html += pc("payg_1y", "1 year · pay as you go", `${money(P.payg_1y.total / 12)} average per month, with ramp-up`)
      + pc("commit_1y", "1 year · 1-year commitment", `saves ${money(P.commit_1y.saving)} (${pct(P.commit_1y.saving, P.payg_1y.total)})`)
      + pc("commit_3y", "3 years · 3-year commitment", P.commit_3y.by_year.map((v, i) => `Y${i + 1} ${moneyShort(v)}`).join(" · "))
      + pc("payg_3y", "3 years · pay as you go", P.payg_3y.by_year.map((v, i) => `Y${i + 1} ${moneyShort(v)}`).join(" · "));
  }
  html += `</div><div class="ov-grid">`;
  html += card("sources", "Source systems", kv("In this phase", `${recs.length} of ${S.scenario.sources.length}`)
    + kv("Platform / lake / op. DB", `${(tg.data_platform || []).length} / ${(tg.data_lake || []).length} / ${(tg.operational_db || []).length}`)
    + kv("Daily change", fmtGB(S.scenario.sources.filter((s) => s.included !== false).reduce((a, s) => a + (Number(s.daily_change_gb) || 0), 0)) + "/day"));
  const inv = archInventory();
  html += card("arch", "Architecture", kv("Products", `${inv.total} (${inv.google} Google Cloud, ${inv.partner} partner)`)
    + kv("Lakehouse", r?.platform?.lakehouse?.raw_zone ? "Raw zone + bronze / silver / gold" : "Bronze / silver / gold")
    + kv("BigQuery", esc(r?.region?.name || "")));
  html += card("recs", "Data flow & integrations", recs.slice(0, 3).map((x) => kv(S.scenario.sources.find((s) => s.id === x.source_id)?.name || "", esc(tool(x.primary).name))).join("") || "<p>-</p>");
  html += card("pricing", "Where the money goes", groups.map((g) => `<div class="bar-row"><span>${esc(g.group)}</span><i style="width:${Math.max(3, (100 * g.year1) / maxG)}%;background:${GROUP_COLORS[g.group] || "#9AA0A6"}"></i><b>${moneyShort(g.year1)}</b></div>`).join("")
    + (top.length ? `<p class="ov-note">Biggest lines: ${top.map((t) => esc(t.service || t.key)).join(", ")}</p>` : ""));
  html += card("env", "Environments", (r?.environments || []).map((e) => kv(e.name, `${moneyShort(e.year1)}/yr`)).join(""));
  html += card("workload", "Sizing & BigQuery slots", sl ? kv("Average / peak", `${sl.avg_slots} / ${Math.round(sl.peak_slots)} slots`) + kv("Reservation", `${sl.baseline_slots} → ${sl.max_slots} slots`)
    + kv("Recommended", sl.model === "editions" ? EDITION_NAME[sl.edition] + " edition" : "On-demand") : "<p>Calculating…</p>");
  html += card("roadmap", "Roadmap", S.planResult ? kv("Programme", `${S.planResult.horizon} months, ${S.planResult.teams} squads`)
    + kv("First data live", `Month ${S.planResult.pricing?.go_live?.first ?? "-"}`) + kv("All sources live", `Month ${S.planResult.pricing?.go_live?.all ?? "-"}`) : "<p>Calculating…</p>");
  { const r = readiness(), p = readinessProgress();
    html += card("kickoff", "Kickoff readiness", r ? kv("Checklist", `${p.done} of ${p.total} ready`) + kv("Critical open", String(p.critOpen)) + kv("Partner team", `${r.team.partner_fte} FTE, ${r.team.squads} squad(s)`) : "<p>Calculating…</p>"); }
  { const m = monitorSummary();
    html += card("monitor", "Product monitor", m ? kv("Key products used", `${m.used} of ${m.total}`) + kv("BigQuery", esc(m.slots))
      + ["looker", "apigee", "gemini_enterprise", "agent_platform"].map((t) => kv(compMeta(t)?.name.replace(/ \(.*\)| API management.*| data agents/g, "") || t,
        S.scenario.components.some((c) => (c.type === t || (t === "looker" && c.type.startsWith("looker"))) && c.included !== false) ? "Used" : "Not used")).join("") : "<p>Calculating…</p>"); }
  html += card("enquiry", "Customer technical enquiry", `<p>Ask a technical question in plain language - answered only from Google's public documentation, with links.</p>`);
  html += card("proposal", "Proposal", `<p>Generate a customer-ready proposal (up to 15 pages) as PDF, Word or Google Docs.</p>`);
  html += `</div>`;
  host.innerHTML = html;
}

// ------------------------------------------------------------------ pricing plans
export const plans = { view: "plans", plan: "payg_1y", basis: "ramped", mode: "cost", year: 1, env: "all" };
const PLAN_KEY = { payg_1y: "payg", commit_1y: "cud1", commit_3y: "cud3", payg_3y: "payg" };

function planProducts() {
  const p = pp();
  if (!p) return [];
  const ids = new Set((S.result?.environments || []).map((e) => e.id));
  if (plans.env !== "all" && !ids.has(plans.env)) plans.env = "all";
  return p.products.filter((x) => plans.env === "all" || x.environment === plans.env);
}
export function mergeEnvs(rows, force) {
  if (!force && plans.env !== "all") return rows;
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.service)) by.set(r.service, { ...r, payg: [...r.payg], cud1: [...r.cud1], cud3: [...r.cud3], qty: [...r.qty] });
    else { const a = by.get(r.service); ["payg", "cud1", "cud3", "qty"].forEach((f) => r[f].forEach((v, i) => (a[f][i] += v))); a.commit_eligible = a.commit_eligible || r.commit_eligible; }
  }
  const gi = (g) => (GROUP_ORDER_UI.includes(g) ? GROUP_ORDER_UI.indexOf(g) : 99);
  return [...by.values()].sort((x, y) => (gi(x.group) - gi(y.group)) || (Math.abs(sumArr(y.payg)) - Math.abs(sumArr(x.payg))));
}
const moneyCell = (v) => (Math.abs(v) < 0.5 ? "-" : moneyShort(v));

export function renderPlans() {
  $$("#tab-pricing [data-pview]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.pview === plans.view)));
  $("#pricingBody").hidden = plans.view !== "plans";
  $("#pricingDetail").hidden = plans.view !== "detail";
  if (plans.view === "detail") { renderSummary(); return; }
  const host = $("#pricingBody");
  const p = pp();
  if (!p || !S.scenario.sources.length) { host.innerHTML = `<p class="empty-note">Pricing appears once at least one source system is added and the roadmap is calculated.</p>`; return; }
  const P = p.plans;
  const plan = P[plans.plan] || P.payg_1y;
  const key = PLAN_KEY[plans.plan] || "payg";
  const months = plan.months;
  const envs = S.result?.environments || [];
  let html = `<div class="pricing-controls">
    <div class="seg small" role="group" aria-label="Schedule">
      <button type="button" data-pbasis="ramped" aria-selected="${plans.basis === "ramped"}">With ramp-up plan</button>
      <button type="button" data-pbasis="steady" aria-selected="${plans.basis === "steady"}">Full scope from month 1</button>
    </div>
    ${envs.length > 1 ? `<div class="seg small" role="group" aria-label="Environment">${[{ id: "all", name: "All environments" }, ...envs].map((e) => `<button type="button" data-penv="${esc(e.id)}" aria-selected="${plans.env === e.id}">${esc(e.name)}</button>`).join("")}</div>` : ""}
  </div>`;
  const card = (k, n, label, sub) => `<button type="button" class="plan-card${plans.plan === k ? " on" : ""}" data-plan="${k}" aria-pressed="${plans.plan === k}">
    <span><i class="plan-n">${n}</i>${esc(label)}</span><b>${money(P[k].total)}</b><small>${sub}</small></button>`;
  html += `<div class="plan-cards three">
    ${card("payg_1y", 1, "Pay as you go · 1 year", `${money(P.payg_1y.total / 12)} average per month · no commitment`)}
    ${card("commit_1y", 2, "1-year commitment · all services", `Saves ${money(P.commit_1y.saving)} (${pct(P.commit_1y.saving, P.payg_1y.total)}) vs pay as you go`)}
    ${card("commit_3y", 3, "3-year commitment · all services", P.commit_3y.by_year.map((v, i) => `Year ${i + 1}: ${moneyShort(v)}`).join(" · ") + ` · saves ${moneyShort(P.commit_3y.saving)} vs ${moneyShort(P.payg_3y.total)} pay as you go`)}
  </div>`;
  if (plans.env !== "all") html += `<p class="hint">Plan totals above are for all environments; the detail below is filtered to ${esc(envs.find((e) => e.id === plans.env)?.name || "")}.</p>`;

  const rows = mergeEnvs(planProducts());
  const total = rows.reduce((a, r) => a + sumArr(r[key], 0, months), 0);
  const paygTotal = rows.reduce((a, r) => a + sumArr(r.payg, 0, months), 0);
  const isCommit = key !== "payg";
  html += `<section class="plan-detail"><div class="plan-head"><div><h2>${esc(plan.label)}</h2>
    <p>${plans.basis === "ramped" ? "Each service starts consuming in the month it goes live (see Roadmap)." : "Every service runs at full scope from month 1."}
    ${isCommit ? " Commitment pricing applies to eligible services (marked ●); everything else stays pay as you go." : ""}</p></div>
    <button type="button" class="plan-total" data-bom-open title="Open the bill of materials - products, quantities, prices and regions, editable"><b>${money(total)}</b><span>${months === 12 ? "over 12 months" : "over 36 months"}${isCommit ? ` · saves ${money(paygTotal - total)}` : ""}</span><em>View &amp; edit bill of materials ›</em></button></div>`;
  html += envSpecSection(plans.plan);
  const groups = GROUP_ORDER_UI.filter((g) => rows.some((r) => r.group === g));
  const series = groups.map((g) => ({ g, v: Array.from({ length: months }, (_, m) => rows.filter((r) => r.group === g).reduce((a, r) => a + Math.max(0, r[key][m]), 0)) }));
  const paygLine = isCommit ? Array.from({ length: months }, (_, m) => rows.reduce((a, r) => a + r.payg[m], 0)) : null;
  html += `<div class="stack-legend">${groups.map((g) => `<span><i style="background:${GROUP_COLORS[g] || "#9AA0A6"}"></i>${esc(g)}</span>`).join("")}${paygLine ? `<span><i class="dash"></i>Pay as you go</span>` : ""}</div>
    <div class="chart-wrap">${stackSvg(series, paygLine, months)}</div>`;
  if (months === 36) {
    html += `<div class="year-tiles">${[1, 2, 3].map((y) => `<div><span>Year ${y}</span><b>${money(rows.reduce((a, r) => a + sumArr(r[key], (y - 1) * 12, y * 12), 0))}</b>
      ${isCommit ? `<small>vs ${money(rows.reduce((a, r) => a + sumArr(r.payg, (y - 1) * 12, y * 12), 0))} pay as you go</small>` : ""}</div>`).join("")}</div>`;
  }
  const head = months === 36
    ? `<th>Product</th><th>Unit</th><th>Qty, 3 years</th><th>Unit price</th><th>Year 1</th><th>Year 2</th><th>Year 3</th><th>Total</th>${isCommit ? "<th>Saving</th>" : ""}`
    : `<th>Product</th><th>Unit</th><th>Qty, 12 months</th><th>Qty / month (M12)</th><th>Unit price</th><th>Avg / month</th><th>Total</th>${isCommit ? "<th>Saving</th>" : ""}`;
  const span = (months === 36 ? 8 : 7) + (isCommit ? 1 : 0);
  let lastG = null;
  const body = rows.map((r) => {
    const cost = sumArr(r[key], 0, months), q = sumArr(r.qty, 0, months);
    if (Math.abs(cost) < 0.005) return "";
    const up = r.unit && q ? cost / q : null;
    let h = "";
    if (r.group !== lastG) { h = `<tr class="bom-group"><th colspan="${span}"><i style="background:${GROUP_COLORS[r.group] || "#9AA0A6"}"></i>${esc(r.group)}</th></tr>`; lastG = r.group; }
    const name = `<td class="bom-prod"><b>${esc(r.service)}${isCommit && r.commit_eligible ? ` <span class="ce" title="Commitment discount applies">●</span>` : ""}</b></td>`;
    const sav = isCommit ? `<td>${money(sumArr(r.payg, 0, months) - cost)}</td>` : "";
    if (months === 36) return h + `<tr>${name}<td class="bom-unit">${esc(r.unit || "-")}</td><td>${r.unit ? fmtQty(q) : "-"}</td><td>${unitPrice(up)}</td>
      <td>${money(sumArr(r[key], 0, 12))}</td><td>${money(sumArr(r[key], 12, 24))}</td><td>${money(sumArr(r[key], 24, 36))}</td><td><b>${money(cost)}</b></td>${sav}</tr>`;
    return h + `<tr>${name}<td class="bom-unit">${esc(r.unit || "-")}</td><td>${r.unit ? fmtQty(q) : "-"}</td><td>${r.unit ? fmtQty(r.qty[11]) : "-"}</td><td>${unitPrice(up)}</td>
      <td>${money(cost / 12)}</td><td><b>${money(cost)}</b></td>${sav}</tr>`;
  }).join("");
  html += `<h3>Products, quantities and prices</h3><div style="overflow-x:auto"><table class="bom-table plan-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>
    <tfoot><tr><td>Total</td><td></td><td></td>${months === 36 ? `<td></td>${[0, 1, 2].map((y) => `<td>${money(rows.reduce((a, r) => a + sumArr(r[key], y * 12, y * 12 + 12), 0))}</td>`).join("")}` : `<td></td><td></td><td>${money(total / 12)}</td>`}<td>${money(total)}</td>${isCommit ? `<td>${money(paygTotal - total)}</td>` : ""}</tr></tfoot></table></div>`;
  const lo = months === 36 ? (plans.year - 1) * 12 : 0;
  html += `<div class="matrix-head"><h3>Month by month</h3>
    <div class="seg small" role="group" aria-label="Show"><button type="button" data-pmode="cost" aria-selected="${plans.mode === "cost"}">Cost</button><button type="button" data-pmode="qty" aria-selected="${plans.mode === "qty"}">Quantity</button></div>
    ${months === 36 ? `<div class="seg small" role="group" aria-label="Year">${[1, 2, 3].map((y) => `<button type="button" data-pyear="${y}" aria-selected="${plans.year === y}">Year ${y}</button>`).join("")}</div>` : ""}
    <button type="button" class="btn ghost small" id="planCsv">Download CSV</button></div>`;
  const mcols = Array.from({ length: 12 }, (_, i) => lo + i);
  const q = plans.mode === "qty";
  html += `<div class="matrix-wrap"><table class="matrix"><thead><tr><th>Product</th>${q ? "<th>Unit</th>" : ""}${mcols.map((m) => `<th>M${m + 1}</th>`).join("")}<th>${q ? "Total qty" : "Total"}</th></tr></thead><tbody>`
    + rows.filter((r) => Math.abs(sumArr(r[key], 0, months)) >= 0.005).map((r) => `<tr><td>${esc(r.service)}</td>${q ? `<td class="bom-unit">${esc(r.unit || "-")}</td>` : ""}${mcols.map((m) => `<td>${q ? (r.unit ? fmtQty(r.qty[m]) : "-") : moneyCell(r[key][m])}</td>`).join("")}<td><b>${q ? (r.unit ? fmtQty(sumArr(r.qty, lo, lo + 12)) : "-") : moneyCell(sumArr(r[key], lo, lo + 12))}</b></td></tr>`).join("")
    + (q ? "</tbody>" : `</tbody><tfoot><tr><td>Total</td>${mcols.map((m) => `<td>${moneyCell(rows.reduce((a, r) => a + r[key][m], 0))}</td>`).join("")}<td>${moneyCell(rows.reduce((a, r) => a + sumArr(r[key], lo, lo + 12), 0))}</td></tr></tfoot>`)
    + `</table></div>`;
  html += `<p class="disclaimer">Commitment views apply committed-use pricing to services that offer it (BigQuery editions, Dataflow streaming, Composer, Agent Engine, Knowledge Catalog premium processing, AlloyDB, Cloud SQL, Spanner, Bigtable, Firestore, Memorystore); a commitment is a fixed spend or capacity for the term. Negotiated discount and Customer Care from Settings are included. Ballpark from list prices - validate with the Google Cloud Pricing Calculator.</p></section>`;
  host.innerHTML = html;
}

function stackSvg(series, line, months) {
  const W = 900, H = 260, L = 64, R = 12, T = 12, B = 30;
  const tot = Array.from({ length: months }, (_, m) => series.reduce((a, s) => a + s.v[m], 0));
  const max = Math.max(...tot, ...(line || [0]), 1) * 1.08;
  const bw = (W - L - R) / months;
  const y = (v) => T + (H - T - B) * (1 - v / max);
  let g = "";
  for (let k = 0; k <= 4; k++) { const v = (max / 4) * k; g += `<line class="chart-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="chart-axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${esc(moneyShort(v))}</text>`; }
  for (let m = 0; m < months; m++) {
    let acc = 0;
    const x0 = L + m * bw + bw * 0.16, w = bw * 0.68;
    series.forEach((s) => { const v = s.v[m]; if (!v) return; g += `<rect x="${x0}" y="${y(acc + v)}" width="${w}" height="${Math.max(0, y(acc) - y(acc + v))}" fill="${GROUP_COLORS[s.g] || "#9AA0A6"}"><title>M${m + 1} ${esc(s.g)}: ${esc(money(v))}</title></rect>`; acc += v; });
    if (months <= 12 || m % 3 === 0) g += `<text class="chart-axis" x="${L + m * bw + bw / 2}" y="${H - 8}" text-anchor="middle">M${m + 1}</text>`;
  }
  if (line) g += `<path d="${line.map((v, i) => `${i ? "L" : "M"}${(L + i * bw + bw / 2).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}" fill="none" stroke="var(--ink-2)" stroke-width="2" stroke-dasharray="5 4"/>`;
  if (months === 36) [12, 24].forEach((m) => (g += `<line class="chart-grid" stroke-dasharray="3 3" x1="${L + m * bw}" x2="${L + m * bw}" y1="${T}" y2="${H - B}"/>`));
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly consumption by capability">${g}</svg>`;
}

function planCsv() {
  const p = pp(), plan = p.plans[plans.plan], key = PLAN_KEY[plans.plan];
  const rows = mergeEnvs(planProducts());
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const c = (v) => (v * fx()).toFixed(2);
  const months = Array.from({ length: plan.months }, (_, i) => i);
  const lines = [[q("Plan"), q(plan.label), q("Currency"), q(S.currency), q("Schedule"), q(plans.basis === "ramped" ? "With ramp-up" : "Full scope from month 1")].join(",")];
  lines.push([q("Capability"), q("Product"), q("Unit"), q("Measure"), ...months.map((m) => q(`M${m + 1}`)), q("Total")].join(","));
  rows.forEach((r) => {
    lines.push([q(r.group), q(r.service), q(r.unit || ""), q("Cost"), ...months.map((m) => c(r[key][m])), c(sumArr(r[key], 0, plan.months))].join(","));
    if (r.unit) lines.push([q(r.group), q(r.service), q(r.unit), q("Quantity"), ...months.map((m) => r.qty[m]), sumArr(r.qty, 0, plan.months).toFixed(3)].join(","));
  });
  return lines.join("\n");
}

/** Clear everything - sources, architecture, settings, edits and results - and start a new discovery. */
export function resetAll() {
  const prev = clone(S.scenario);
  const prevCloud = S.cloud;
  S.scenario = withDefaults({ components: [], environments: [] });
  forgetCloud();
  syncForm();
  changed();
  showModule("overview");
  toast("Everything cleared - start a new discovery", 9000, { label: "Undo", run: () => { S.scenario = prev; S.cloud = prevCloud; syncForm(); changed(); toast("Restored"); } });
}

export function bindModules(showTab) {
  bindMonitor(showTab);
  bindSlotsPage();
  $$(".mon-sub [data-mon-sub]").forEach((b) => b.addEventListener("click", () => { nav.sub = b.dataset.monSub; renderModules(); }));
  bindEnquiry();
  $("#resetBtn")?.addEventListener("click", () => {
    if (window.confirm("Reset Data Cloud Compass?\n\nThis clears all source systems, the architecture, environments, settings, edits and results so you can start a new discovery. Saved scenarios in the cloud are not deleted.")) resetAll();
  });
  bindReadiness();
  bindBomEditor(() => plans.plan);
  bindUseCases();
  bindChargeback();
  bindUsage();
  $$(".modnav button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("#tab-pricing").addEventListener("click", (e) => {
    const v = e.target.closest("[data-pview]");
    if (v) { plans.view = v.dataset.pview; renderPlans(); return; }
    const card = e.target.closest("[data-plan]");
    if (card) { plans.plan = card.dataset.plan; renderPlans(); return; }
    const b = e.target.closest("[data-pbasis]");
    if (b) { plans.basis = b.dataset.pbasis; renderPlans(); renderHead(); return; }
    const m = e.target.closest("[data-pmode]");
    if (m) { plans.mode = m.dataset.pmode; renderPlans(); return; }
    const y = e.target.closest("[data-pyear]");
    if (y) { plans.year = Number(y.dataset.pyear); renderPlans(); return; }
    const ev = e.target.closest("[data-penv]");
    if (ev) { plans.env = ev.dataset.penv; renderPlans(); return; }
    if (e.target.closest("#planCsv")) download(`${slug()}-${plans.plan}.csv`, "text/csv", planCsv());
  });
  $("#overviewBody").addEventListener("click", (e) => {
    const c = e.target.closest("[data-goto]");
    if (!c) return;
    if (c.dataset.plan) { plans.plan = c.dataset.plan; plans.view = "plans"; }
    showTab(c.dataset.goto);
  });
  document.addEventListener("click", (e) => { const g = e.target.closest("[data-goto-tab]"); if (g) showTab(g.dataset.gotoTab); });
  // a feedback form (FEEDBACK_URL) when one is configured, else the beta notice with the feedback e-mail
  $("#feedbackBtn").addEventListener("click", () => { const u = feedbackUrl(); if (u) window.open(u, "_blank", "noopener"); else showBeta(true); });
  const setTop = () => document.documentElement.style.setProperty("--top", ($(".topbar")?.offsetHeight || 66) + "px");
  setTop();
  window.addEventListener("resize", setTop);
}

// ------------------------------------------------------------------ environments module
export function renderEnvBody() {
  const host = $("#envBody");
  if (!host) return;
  const envs = S.result?.environments || [];
  if (!envs.length) { host.innerHTML = ""; return; }
  const max = Math.max(...envs.map((e) => e.three_year), 1);
  host.innerHTML = `<h3>Cost by environment</h3><div style="overflow-x:auto"><table class="env-table"><thead><tr><th>Environment</th><th>Sizing vs ${esc(envs[0].name)}</th><th>Per month (yr 1)</th><th>Year 1</th><th>3 years</th></tr></thead><tbody>`
    + envs.map((e, i) => `<tr><td><span class="env-dot e${Math.min(i, 5)}"></span>${esc(e.name)}<span class="share" style="width:${Math.max(2, (60 * e.three_year) / max)}px"></span></td>
      <td class="env-f">${i === 0 ? "Baseline - sized by your sources, products and workload" : S.catalog.environment_factors.map((f) => `${esc(f.name.replace(" %", ""))} ${+e.factors[f.id]}%`).join(" · ") + (e.slots ? ` · slots ${e.slots.baseline} → ${e.slots.max}` : "")}</td>
      <td>${money(e.monthly_year1)}</td><td>${money(e.year1)}</td><td>${money(e.three_year)}</td></tr>`).join("")
    + `</tbody></table></div>` + envSizingSection()
    + `<p class="hint">Network links (HA VPN / Interconnect) and the Looker licence are shared and counted once. Use <b>Edit sizing</b> to change each environment's share of production.</p>`;
}

// ------------------------------------------------------------------ proposal (max 15 pages)
let proposalPages = null, proposalSeq = 0, proposalTimer = null;
const VENDOR_BASE = "static/vendor/";
function proposalOpts() {
  const P = window.CompassProposal;
  S.scenario.proposal = { title: "Data & AI platform on Google Cloud", author: S.user?.name || "", company: "", plan: "commit_3y", basis: "ramped", summary: "",
    sections: P ? P.SECTIONS.map((x) => x.id) : [], ...(S.scenario.proposal || {}) };
  return S.scenario.proposal;
}
function proposalCtx() {
  return { scenario: S.scenario, result: S.result, wl: S.wlResult, plan: S.planResult, catalog: S.catalog, opts: proposalOpts(), currency: S.currency,
    money, moneyShort, fmtGB, fmtQty, unitPrice, tool, compMeta, freqName, regionName, bqModelName, EDITION_NAME, GROUP_COLORS, diagramPng };
}
export function renderProposal() {
  const host = $("#proposalBody");
  const P = window.CompassProposal;
  if (!host || !P) return;
  if (!S.result || !S.scenario.sources.length) { host.innerHTML = `<p class="empty-note">Add source systems to generate a proposal.</p>`; return; }
  const o = proposalOpts();
  if (!$("#ppForm")) {
    host.innerHTML = `<div class="pp-layout"><form class="pp-controls card-panel" id="ppForm" onsubmit="return false">
        <h2>Proposal settings</h2>
        <label>Title<input type="text" data-pp="title" maxlength="120"></label>
        <div class="grid2"><label>Prepared by<input type="text" data-pp="author" maxlength="80" placeholder="Your name"></label>
        <label>Company<input type="text" data-pp="company" maxlength="80" placeholder="Your company"></label></div>
        <div class="grid2"><label>Commercial option to feature<select data-pp="plan">
          <option value="payg_1y">Pay as you go - 1 year</option><option value="commit_1y">1-year commitment</option>
          <option value="commit_3y">3-year commitment</option><option value="payg_3y">Pay as you go - 3 years</option></select></label>
        <label>Schedule<select data-pp="basis"><option value="ramped">With ramp-up plan</option><option value="steady">Full scope from month 1</option></select></label></div>
        <label>Executive summary (optional - leave blank to generate)<textarea data-pp="summary" rows="4" maxlength="1500"></textarea></label>
        <fieldset class="pp-sections"><legend>Sections (one page each, max ${P.MAX_PAGES})</legend>
          ${P.SECTIONS.map((x) => `<label class="toggle"><input type="checkbox" data-pp-sec="${x.id}"> ${esc(x.name)}</label>`).join("")}</fieldset>
        <div class="pp-actions">
          <button type="button" class="btn primary" id="ppPdf">Print / Save as PDF</button>
          <button type="button" class="btn ghost" id="ppWord">Download Word (.docx)</button>
          <button type="button" class="btn ghost" id="ppGdoc">Create Google Doc</button>
        </div>
        <p class="hint" id="ppStatus" role="status"></p>
      </form>
      <div class="pp-preview"><div class="pp-count" id="ppCount"></div><div class="pp-pages" id="ppPages"></div></div></div>`;
    const f = $("#ppForm");
    ["title", "author", "company", "summary"].forEach((k) => ($(`[data-pp="${k}"]`, f).value = o[k] || ""));
    ["plan", "basis"].forEach((k) => ($(`[data-pp="${k}"]`, f).value = o[k]));
    $$("[data-pp-sec]", f).forEach((cb) => (cb.checked = o.sections.includes(cb.dataset.ppSec)));
    f.addEventListener("input", onProposalInput);
    f.addEventListener("change", onProposalInput);
    $("#ppPdf").addEventListener("click", printProposal);
    $("#ppWord").addEventListener("click", () => proposalWord(false));
    $("#ppGdoc").addEventListener("click", () => proposalWord(true));
    if (NO_DOWNLOAD) ["#ppPdf", "#ppWord", "#ppGdoc"].forEach((s2) => ($(s2).disabled = true));
  }
  clearTimeout(proposalTimer);
  proposalTimer = setTimeout(refreshProposal, 150);
}
function onProposalInput(e) {
  const o = proposalOpts();
  const el = e.target;
  if (el.dataset.pp) o[el.dataset.pp] = el.value;
  if (el.dataset.ppSec) o.sections = $$("[data-pp-sec]").filter((cb) => cb.checked).map((cb) => cb.dataset.ppSec);
  save();
  clearTimeout(proposalTimer);
  proposalTimer = setTimeout(refreshProposal, 300);
}
async function refreshProposal() {
  const my = ++proposalSeq;
  const ctx = proposalCtx();
  const pages = await window.CompassProposal.build(ctx);
  if (my !== proposalSeq || !$("#ppPages")) return;
  proposalPages = pages;
  $("#ppPages").innerHTML = window.CompassProposal.toHtml(pages, ctx);
  $("#ppCount").textContent = `${pages.length} page${pages.length === 1 ? "" : "s"} (maximum ${window.CompassProposal.MAX_PAGES})`;
}
function printProposal() {
  if (!proposalPages) return;
  document.body.classList.add("print-proposal");
  const done = () => { document.body.classList.remove("print-proposal"); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
  setTimeout(done, 1500);
}
async function proposalWord(toDrive) {
  const st = $("#ppStatus");
  if (!proposalPages) return;
  st.textContent = "Building the Word document…";
  try {
    const blob = await window.CompassProposal.toDocx(proposalPages, proposalCtx(), VENDOR_BASE);
    const name = `${slug()}-proposal.docx`;
    if (!toDrive) { download(name, blob.type, blob); st.textContent = `Downloaded ${name}.`; return; }
    const id = googleClientId();
    if (!id) { st.textContent = "Google Docs export needs the OAuth client ID - open Export → Google Sheets to set it up, or download the Word file and open it with Google Docs."; return; }
    st.textContent = "Uploading to Google Drive…";
    const res = await window.CompassExports.driveUpload(blob, `${S.scenario.customer || "Customer"} - Data & AI platform proposal`, "docs", id);
    st.innerHTML = `Created <a href="${esc(res.webViewLink)}" target="_blank" rel="noopener">${esc(res.name)}</a> in Google Docs.`;
  } catch (err) { st.textContent = `Could not build the document: ${err.message}`; }
}
