/* Data Cloud Compass - discover.js: guided discovery interview, AI assist from meeting notes (Gemini)
 * and inventory spreadsheet import. Everything ends in a proposal the architect reviews and applies. */
import { S } from "./state.js";
import { $, api, clone, esc, toast } from "./core.js";
import { changed } from "./events.js";
import { regionOptions } from "./main.js";
import { compDefaults, compMeta, uid } from "./pricing.js";
import { syncForm, withDefaults } from "./scenario.js";
import { normEnvs } from "./environments.js";
import { forgetCloud } from "./account.js";

let tab = "guided";
let step = 0;
let W = null;              // wizard answers
let proposal = null;       // from AI / spreadsheet

const SIZES = { S: { daily: 1, initial: 100, label: "Small (~1 GB/day)" }, M: { daily: 20, initial: 2000, label: "Medium (~20 GB/day)" }, L: { daily: 200, initial: 50000, label: "Large (~200 GB/day)" } };
const FREQ_BY_CAT = { rdbms: "near_realtime", rdbms_gcp: "near_realtime", sap: "near_realtime", nosql: "near_realtime", nosql_gcp: "near_realtime",
  kafka: "realtime", stream_aws: "realtime", stream_azure: "realtime", events: "realtime", logs: "realtime" };
const LOC_BY_CAT = { rdbms_gcp: "gcp", nosql_gcp: "gcp", object_gcp: "gcp", object_aws: "aws", stream_aws: "aws", object_azure: "azure", stream_azure: "azure",
  saas_google: "saas", saas_salesforce: "saas", saas_other: "saas", api: "saas", logs: "gcp" };
const TYPE_BY_CAT = { kafka: "events", stream_aws: "events", stream_azure: "events", events: "events", logs: "events", unstructured: "unstructured",
  nosql: "semi_structured", nosql_gcp: "semi_structured", api: "semi_structured", saas_other: "semi_structured" };
const GROUPS = [["Databases", ["rdbms", "rdbms_gcp", "rdbms_nocdc", "nosql", "nosql_gcp"]], ["Warehouses & big data", ["dwh", "hadoop"]],
  ["Enterprise apps & mainframe", ["sap", "mainframe"]], ["Streaming & events", ["kafka", "stream_aws", "stream_azure", "events", "logs"]],
  ["Files & objects", ["files_onprem", "object_aws", "object_azure", "object_gcp", "unstructured"]], ["SaaS & APIs", ["saas_google", "saas_salesforce", "saas_other", "api"]]];
const STEPS = ["Customer", "Source systems", "Consumers", "Platform & pricing", "Review"];

function freshWizard() {
  return { customer: S.scenario.customer || "", industry: "", region: S.scenario.region, residency: false, sources: {}, size: "M",
    bi: "looker", bi_users: 50, ge_users: 0, agents: false, apigee: false, db: "none",
    envs: new Set(["prod", "dev", "uat"]), sec: new Set(["cmek", "policy_tags", "knowledge_catalog"]),
    bq: "auto", pricing: "cud1", support: "enhanced", mode: S.scenario.sources.length ? "merge" : "replace" };
}

export function openDiscover(which) {
  if (which) tab = which;
  if (!W) W = freshWizard();
  render();
  if (!$("#discDialog").open) $("#discDialog").showModal();
}

function render() {
  const aiOk = S.config?.assist;
  const tabs = [["guided", "Guided interview"], ["notes", "Meeting notes (AI)"], ["sheet", "Inventory spreadsheet"]];
  let html = `<div class="seg disc-tabs" role="tablist">${tabs.map(([id, n]) => `<button type="button" role="tab" aria-selected="${tab === id}" class="${tab === id ? "on" : ""}" data-dtab="${id}">${n}</button>`).join("")}</div>`;
  if (tab === "guided") html += guided();
  else if (tab === "notes") {
    html += aiOk ? `<p class="hint">Paste meeting notes, an RFP extract or an e-mail thread. Gemini (in this deployment's Google Cloud project) proposes source systems, products, open questions and assumptions - you choose what to add.</p>
      <textarea id="notesText" rows="10" placeholder="e.g. Core banking on Oracle 19c on-prem, ~8 TB, CDC needed. Cards on SQL Server. Kafka for transactions ~40 GB/day. Salesforce CRM. Power BI today, want Looker and Gemini for 300 analysts. Data must stay in KSA..."></textarea>
      <div class="dlg-actions"><span class="spacer"></span><button type="button" class="btn primary" id="notesGo">Propose sources &amp; products</button></div>`
      : `<p class="empty-note">AI assist needs sign-in and Vertex AI on this deployment${S.config?.auth ? " - sign in first" : ""}. The guided interview and the spreadsheet template work without it.</p>`;
  } else {
    html += `<p class="hint">Upload a CSV or Excel inventory. The <a href="${esc(api.templateUrl())}" download>template</a> (name, type, frequency, daily change, initial volume, location, data type, transform, notes) is imported directly; any other layout is read by Gemini${aiOk ? "" : " (needs sign-in)"}.</p>
      <label class="file-drop"><input type="file" id="sheetFile" accept=".csv,.xlsx,.xlsm,.txt,.tsv"><span>Choose a .csv or .xlsx file</span></label>`;
  }
  if (tab !== "guided" && proposal) html += proposalView();
  $("#discBody").innerHTML = html;
  const r = $('#discBody [data-w="region"]');
  if (r) r.value = W.region;
}

// ------------------------------------------------------------------ guided interview
function guided() {
  const nav = `<ol class="steps">${STEPS.map((s, i) => `<li class="${i === step ? "on" : i < step ? "done" : ""}"><button type="button" data-step="${i}">${i + 1}. ${esc(s)}</button></li>`).join("")}</ol>`;
  let body = "";
  if (step === 0) {
    body = `<div class="grid2 wiz">
      <label>Customer / engagement<input data-w="customer" value="${esc(W.customer)}" placeholder="e.g. Retail Bank KSA"></label>
      <label>Industry<select data-w="industry">${["", "Banking & financial services", "Insurance", "Retail & e-commerce", "Telecommunications", "Manufacturing", "Energy & utilities", "Healthcare & life sciences", "Public sector", "Media & gaming", "Transport & logistics", "Other"].map((x) => `<option${x === W.industry ? " selected" : ""}>${esc(x)}</option>`).join("")}</select></label>
      <label>Where should the data platform run (BigQuery region)?<select data-w="region">${regionOptions()}</select></label>
      <label class="toggle"><input type="checkbox" data-w="residency" ${W.residency ? "checked" : ""}> Data must stay in this country / region (no processing elsewhere)</label></div>`;
  } else if (step === 1) {
    const counts = W.sources;
    body = `<p class="hint">Tap a system type to add one (tap again for more). Typical size for new sources:
      <select data-w="size">${Object.entries(SIZES).map(([k, v]) => `<option value="${k}"${W.size === k ? " selected" : ""}>${v.label}</option>`).join("")}</select> - you can fine-tune volumes afterwards.</p>
      ${GROUPS.map(([g, cats]) => {
        const types = S.catalog.source_types.filter((t) => cats.includes(t.category));
        return `<div class="chip-group"><b>${esc(g)}</b><div>${types.map((t) => `<span class="src-chip${counts[t.id] ? " on" : ""}"><button type="button" data-add="${t.id}">${esc(t.name)}${counts[t.id] ? ` <i>×${counts[t.id]}</i>` : ""}</button>${counts[t.id] ? `<button type="button" class="minus" data-sub="${t.id}" aria-label="One fewer ${esc(t.name)}">−</button>` : ""}</span>`).join("")}</div></div>`;
      }).join("")}`;
  } else if (step === 2) {
    const bi = [["none", "No BI tool / later"], ["looker", "Looker"], ["looker_studio_pro", "Looker Studio Pro"], ["power_bi", "Power BI (partner, not costed)"], ["tableau", "Tableau (partner, not costed)"]];
    const db = [["none", "None"], ["alloydb", "AlloyDB"], ["cloudsql", "Cloud SQL"], ["spanner", "Spanner"]];
    body = `<div class="grid2 wiz">
      <label>BI and dashboards<select data-w="bi">${bi.map(([k, n]) => `<option value="${k}"${W.bi === k ? " selected" : ""}>${n}</option>`).join("")}</select></label>
      <label>BI users<input type="number" min="0" data-w="bi_users" value="${W.bi_users}"></label>
      <label>Gemini Enterprise users (0 = none)<input type="number" min="0" data-w="ge_users" value="${W.ge_users}"></label>
      <label class="toggle"><input type="checkbox" data-w="agents" ${W.agents ? "checked" : ""}> Data agents on Agent Platform (conversational analytics, automations)</label>
      <label class="toggle"><input type="checkbox" data-w="apigee" ${W.apigee ? "checked" : ""}> Expose data as APIs / AI gateway (Apigee)</label>
      <label>Operational database for apps<select data-w="db">${db.map(([k, n]) => `<option value="${k}"${W.db === k ? " selected" : ""}>${n}</option>`).join("")}</select></label></div>`;
  } else if (step === 3) {
    const envs = [["prod", "Production"], ["dev", "Development"], ["uat", "UAT / test"], ["preprod", "Pre-production"], ["dr", "Disaster recovery"], ["sandbox", "Data science sandbox"]];
    const sec = [["cmek", "Customer-managed keys (CMEK)"], ["vpc_sc", "VPC Service Controls"], ["policy_tags", "Column / row-level security"], ["sdp", "Sensitive data discovery"], ["knowledge_catalog", "Data quality & lineage (Knowledge Catalog)"]];
    body = `<div class="grid2 wiz">
      <fieldset><legend>Environments</legend>${envs.map(([k, n]) => `<label class="toggle"><input type="checkbox" data-wset="envs" value="${k}" ${W.envs.has(k) ? "checked" : ""} ${k === "prod" ? "disabled" : ""}> ${n}</label>`).join("")}</fieldset>
      <fieldset><legend>Security &amp; governance</legend>${sec.map(([k, n]) => `<label class="toggle"><input type="checkbox" data-wset="sec" value="${k}" ${W.sec.has(k) ? "checked" : ""}> ${n}</label>`).join("")}</fieldset>
      <label>BigQuery compute<select data-w="bq"><option value="auto"${W.bq === "auto" ? " selected" : ""}>Recommend the cheaper model for me</option><option value="ondemand"${W.bq === "ondemand" ? " selected" : ""}>On-demand (per TiB)</option><option value="editions"${W.bq === "editions" ? " selected" : ""}>Editions (slots, auto-sized)</option></select></label>
      <label>Show prices as<select data-w="pricing"><option value="payg"${W.pricing === "payg" ? " selected" : ""}>Pay-as-you-go</option><option value="cud1"${W.pricing === "cud1" ? " selected" : ""}>1-year commitment</option><option value="cud3"${W.pricing === "cud3" ? " selected" : ""}>3-year commitment</option></select></label>
      <label>Customer Care<select data-w="support"><option value="none">Not included</option><option value="standard"${W.support === "standard" ? " selected" : ""}>Standard</option><option value="enhanced"${W.support === "enhanced" ? " selected" : ""}>Enhanced</option><option value="premium"${W.support === "premium" ? " selected" : ""}>Premium</option></select></label></div>`;
  } else {
    const n = Object.values(W.sources).reduce((a, b) => a + b, 0);
    body = `<ul class="review">
      <li><b>${esc(W.customer || "Unnamed customer")}</b>${W.industry ? ` · ${esc(W.industry)}` : ""} · BigQuery in ${esc(W.region)}${W.residency ? " · all processing in-region" : ""}</li>
      <li>${n} source system${n === 1 ? "" : "s"} (${esc(SIZES[W.size].label)}): ${esc(Object.entries(W.sources).map(([t, c]) => `${S.catalog.source_types.find((x) => x.id === t).name}${c > 1 ? ` ×${c}` : ""}`).join(", ") || "none yet")}</li>
      <li>Consumers: ${esc([W.bi !== "none" ? `${compMeta(W.bi).name} (${W.bi_users} users)` : "", W.ge_users ? `Gemini Enterprise (${W.ge_users} users)` : "", W.agents ? "data agents" : "", W.apigee ? "Apigee" : "", W.db !== "none" ? compMeta(W.db).name : ""].filter(Boolean).join(", ") || "none")}</li>
      <li>Environments: ${esc([...W.envs].join(", "))} · security: ${esc([...W.sec].map((x) => compMeta(x)?.name || x).join(", ") || "none")}</li>
      <li>BigQuery: ${esc({ auto: "recommended model", ondemand: "on-demand", editions: "editions, auto-sized slots" }[W.bq])} · prices shown ${esc({ payg: "pay-as-you-go", cud1: "with 1-year commitments", cud3: "with 3-year commitments" }[W.pricing])} · Customer Care: ${esc(W.support)}</li></ul>
      <div class="seg narrow"><button type="button" data-w-mode="replace" class="${W.mode === "replace" ? "on" : ""}">Start a new scenario</button><button type="button" data-w-mode="merge" class="${W.mode === "merge" ? "on" : ""}">Add to the current one</button></div>`;
  }
  const nextLbl = step === STEPS.length - 1 ? "Create the design" : "Next";
  return nav + `<div class="wiz-body">${body}</div><div class="dlg-actions">${step ? `<button type="button" class="btn ghost" data-wnav="-1">Back</button>` : ""}<span class="spacer"></span><button type="button" class="btn primary" data-wnav="1">${nextLbl}</button></div>`;
}

function newSource(typeId, i, size) {
  const t = S.catalog.source_types.find((x) => x.id === typeId);
  const sz = SIZES[size];
  return { id: uid("s"), name: `${t.name.split(" (")[0]}${i > 1 ? ` ${i}` : ""}`, type: typeId, included: true,
    data_type: TYPE_BY_CAT[t.category] || "structured", frequency: FREQ_BY_CAT[t.category] || "daily",
    location: LOC_BY_CAT[t.category] || "on_prem", transform: "light", daily_change_gb: sz.daily, initial_volume_gb: sz.initial,
    notes: "Volume is a placeholder from the guided interview - confirm with the customer." };
}

function comp(type, settings = {}) {
  return { id: uid("c"), type, included: true, settings: { ...compDefaults(type), ...settings } };
}

function applyWizard() {
  const base = W.mode === "replace" ? withDefaults({}) : clone(S.scenario);
  const sc = base;
  sc.customer = W.customer || sc.customer;
  sc.region = W.region;
  if (W.residency) sc.processing_region = "";
  Object.entries(W.sources).forEach(([t, n]) => { for (let i = 1; i <= n; i++) sc.sources.push(newSource(t, i, W.size)); });
  const has = new Set(sc.components.map((c) => c.type));
  const add = (type, settings) => { if (!has.has(type)) { sc.components.push(comp(type, settings)); has.add(type); } };
  if (W.bi !== "none") add(W.bi, { users: Number(W.bi_users) || 0 });
  if (Number(W.ge_users) > 0) add("gemini_enterprise", { users: Number(W.ge_users), grounding: W.bi === "looker" ? "both" : "bigquery" });
  if (W.agents) add("agent_platform");
  if (W.apigee) add("apigee", { role: W.agents ? "both" : "integration" });
  if (W.db !== "none") add(W.db);
  W.sec.forEach((x) => add(x));
  const presets = ["prod", ...["dev", "uat", "preprod", "dr", "sandbox"].filter((x) => W.envs.has(x))];
  if (W.mode === "replace" || sc.environments.length < presets.length) sc.environments = normEnvs(presets.map((p) => ({ id: p, preset: p })));
  sc.bq = W.bq === "editions" ? { mode: "editions", edition: "auto" } : { mode: "ondemand", edition: "auto", _recommend: W.bq === "auto" };
  sc.pricing_option = W.pricing;
  sc.commercial = { ...(sc.commercial || {}), support_plan: W.support };
  if (W.mode === "replace") forgetCloud();
  S.scenario = withDefaults(sc);
  syncForm();
  changed();
  $("#discDialog").close();
  toast(`Design created from the interview - ${sc.sources.length} sources, ${sc.components.length} products`, 6000);
  W = null;
  step = 0;
}

// ------------------------------------------------------------------ AI / spreadsheet proposals
function proposalView() {
  const p = proposal;
  const src = p.sources.map((s, i) => `<tr><td><input type="checkbox" data-ps="${i}" checked aria-label="Add ${esc(s.name)}"></td><td><b>${esc(s.name)}</b><br><small class="muted">${esc(S.catalog.source_types.find((t) => t.id === s.type)?.name || s.type)}</small></td>
    <td>${esc(S.catalog.frequencies.find((f) => f.id === s.frequency)?.name || s.frequency)}</td><td class="num">${(+s.daily_change_gb).toLocaleString()} GB/day${s.volume_estimated ? " <span class=\"tag\">estimated</span>" : ""}</td><td class="num">${(+s.initial_volume_gb).toLocaleString()} GB</td><td><small>${esc(s.notes || "")}</small></td></tr>`).join("");
  const comps = p.components.map((c, i) => `<label class="toggle"><input type="checkbox" data-pc="${i}" checked> <b>${esc(compMeta(c.type)?.name || c.type)}</b> - ${esc(c.reason || "")}</label>`).join("");
  return `<h3>Proposal${p.method === "gemini" ? ` from Gemini (${esc(p.model || "")})` : " from the template"}</h3>
    ${p.sources.length ? `<div style="overflow-x:auto"><table class="cmp-table"><thead><tr><th></th><th>Source</th><th>Frequency</th><th class="num">Change</th><th class="num">Initial</th><th>Notes</th></tr></thead><tbody>${src}</tbody></table></div>` : `<p class="hint">No source systems found.</p>`}
    ${comps ? `<h3>Products</h3><div class="prop-comps">${comps}</div>` : ""}
    ${p.questions?.length ? `<h3>Questions to ask the customer next</h3><ol class="questions">${p.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ol><button type="button" class="link-btn" id="copyQs">Copy questions</button>` : ""}
    ${p.assumptions?.length ? `<h3>Assumptions</h3><ul class="questions">${p.assumptions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}
    <div class="dlg-actions"><span class="spacer"></span><button type="button" class="btn primary" id="propApply">Add selected to the design</button></div>`;
}

function applyProposal() {
  const p = proposal;
  const sc = S.scenario;
  const wasEmpty = !sc.sources.length;
  let ns = 0, nc = 0;
  p.sources.forEach((s, i) => { if ($(`[data-ps="${i}"]`)?.checked) { sc.sources.push({ id: uid("s"), included: true, ...s }); ns++; } });
  const has = new Set(sc.components.map((c) => c.type));
  p.components.forEach((c, i) => {
    if ($(`[data-pc="${i}"]`)?.checked && !has.has(c.type) && compMeta(c.type)) {
      sc.components.push(comp(c.type, c.users ? { users: c.users } : {}));
      has.add(c.type);
      nc++;
    }
  });
  if (!sc.customer && p.customer) sc.customer = p.customer;
  if (wasEmpty && p.region_hint && S.catalog.regions.some((r) => r.id === p.region_hint)) sc.region = p.region_hint;
  S.scenario = withDefaults(sc);
  syncForm();
  changed();
  $("#discDialog").close();
  toast(`Added ${ns} source${ns === 1 ? "" : "s"} and ${nc} product${nc === 1 ? "" : "s"}`, 5000);
  proposal = null;
}

async function analyseNotes() {
  const text = $("#notesText").value.trim();
  if (text.length < 10) return toast("Paste a few lines of notes first");
  $("#notesGo").disabled = true;
  $("#notesGo").textContent = "Reading the notes…";
  try {
    proposal = await api.assistNotes(text);
    render();
  } catch (e) {
    toast(`AI assist failed: ${e.message}`, 7000);
    $("#notesGo").disabled = false;
    $("#notesGo").textContent = "Propose sources & products";
  }
}

async function importSheet(file) {
  try {
    proposal = await api.assistFile(file);
    render();
  } catch (e) {
    toast(`Could not read the file: ${e.message}`, 7000);
  }
}

// ------------------------------------------------------------------ events
export function bindDiscover() {
  $("#discoverBtn").addEventListener("click", () => openDiscover());
  const dlg = $("#discDialog");
  dlg.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) return dlg.close();
    const t = e.target.closest("[data-dtab]");
    if (t) { tab = t.dataset.dtab; return render(); }
    const st = e.target.closest("[data-step]");
    if (st) { step = Number(st.dataset.step); return render(); }
    const nv = e.target.closest("[data-wnav]");
    if (nv) {
      if (Number(nv.dataset.wnav) > 0 && step === STEPS.length - 1) return applyWizard();
      step = Math.max(0, Math.min(STEPS.length - 1, step + Number(nv.dataset.wnav)));
      return render();
    }
    const a = e.target.closest("[data-add]");
    if (a) { W.sources[a.dataset.add] = (W.sources[a.dataset.add] || 0) + 1; return render(); }
    const m = e.target.closest("[data-sub]");
    if (m) { const k = m.dataset.sub; W.sources[k] = Math.max(0, (W.sources[k] || 0) - 1); if (!W.sources[k]) delete W.sources[k]; return render(); }
    const md = e.target.closest("[data-w-mode]");
    if (md) { W.mode = md.dataset.wMode; return render(); }
    if (e.target.id === "notesGo") return analyseNotes();
    if (e.target.id === "propApply") return applyProposal();
    if (e.target.id === "copyQs") navigator.clipboard?.writeText(proposal.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")).then(() => toast("Questions copied"));
  });
  dlg.addEventListener("change", (e) => {
    const w = e.target.closest("[data-w]");
    if (w) { W[w.dataset.w] = w.type === "checkbox" ? w.checked : w.value; if (w.dataset.w === "size") render(); return; }
    const ws = e.target.closest("[data-wset]");
    if (ws) { const set = W[ws.dataset.wset]; ws.checked ? set.add(ws.value) : set.delete(ws.value); return; }
    if (e.target.id === "sheetFile" && e.target.files[0]) importSheet(e.target.files[0]);
  });
  dlg.addEventListener("input", (e) => { const w = e.target.closest("[data-w]"); if (w && w.type !== "checkbox" && w.tagName === "INPUT") W[w.dataset.w] = w.value; });
}
