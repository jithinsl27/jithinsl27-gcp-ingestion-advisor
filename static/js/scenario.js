/* Data Cloud Compass - scenario.js (ES module, no build step). */
import { S } from "./state.js";
import { $, STORE_KEY, api, clone, esc, toast } from "./core.js";
import { normEnvs, renderEnvs } from "./environments.js";
import { migrateBq, renderBqPanel } from "./bigquery.js";
import { changed } from "./events.js";
import { compDefaults, compMeta, legacySecurityComponents, uid } from "./pricing.js";
import { renderWorkloadForm } from "./workload.js";

// ------------------------------------------------------------------ scenario defaults
export function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return over === undefined || over === null ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

export function legacyToComponents(p) {
  const comps = [];
  let i = 0;
  const push = (type, settings) => comps.push({ id: `c${++i}`, type, settings });
  const strip = (o) => { const c = { ...(o || {}) }; delete c.enabled; return c; };
  const bi = p.bi || {};
  if (bi.enabled !== false) {
    const s = { users: bi.users ?? 50 };
    if ((bi.tool || "looker") === "looker") s.annual_quote_usd = bi.looker_annual_usd ?? 0;
    push(bi.tool || "looker", s);
  }
  if ((p.agents || {}).enabled !== false) push("agent_platform", strip(p.agents));
  if ((p.gemini_enterprise || {}).enabled !== false) push("gemini_enterprise", strip(p.gemini_enterprise));
  if ((p.gpu || {}).enabled) push("vertex_gpu", strip(p.gpu));
  if ((p.governance || {}).enabled !== false) push("knowledge_catalog", strip(p.governance));
  return { comps, sec: { ...S.catalog.default_security, ...(p.security || {}) } };
}

export function withDefaults(sc) {
  sc = clone(sc || {});
  if (!sc.components && sc.platform) {
    const { comps, sec } = legacyToComponents(sc.platform);
    sc.components = comps;
    sc.security = sec;
  }
  delete sc.platform;
  migrateBq(sc);                       // legacy bq_model / bq_slots -> bq, before defaults are merged
  const out = { ...clone(S.DEFAULT_SCENARIO), ...sc };
  out.components = (sc.components || clone(S.DEFAULT_SCENARIO.components)).filter((c) => compMeta(c.type))
    .map((c) => ({ id: c.id || uid("c"), type: c.type, included: c.included !== false, settings: { ...compDefaults(c.type), ...(c.settings || {}) } }));
  out.excluded_services = Array.isArray(sc.excluded_services) ? sc.excluded_services : [];
  const hasSec = out.components.some((c) => compMeta(c.type).category === "security");
  if (sc.security && !hasSec) out.components.push(...legacySecurityComponents({ ...S.catalog.default_security, ...sc.security }));
  delete out.security;
  out.sources = (out.sources || []).map((s) => ({ ...s, included: s.included !== false }));
  out.workload = deepMerge(S.catalog.default_workload, sc.workload || {});
  out.processing_region = sc.processing_region || "";
  out.plan = { teams: 2, ...(sc.plan || {}) };
  out.lakehouse = { ...S.catalog.lakehouse_defaults, ...(sc.lakehouse || {}) };
  out.environments = normEnvs(Array.isArray(sc.environments) && sc.environments.length ? sc.environments : S.catalog.default_environments);
  out.workload_units = { ...(sc.workload_units || {}) };
  if (!["payg", "cud1", "cud3"].includes(out.pricing_option)) out.pricing_option = "payg";
  out.commercial = { ...(sc.commercial || {}) };
  migrateBq(out);
  out.environments.forEach((e) => delete e.bq_slots);
  return out;
}

// ------------------------------------------------------------------ volume units (KB ... ZB, stored as GB)
export const unitGb = (u) => (S.catalog.volume_units.find((x) => x.id === u) || { gb: 1 }).gb;

export function bestUnit(gb) {
  gb = Math.abs(Number(gb) || 0);
  if (!gb) return "GB";
  let best = "KB";
  for (const u of S.catalog.volume_units) if (gb / u.gb >= 1) best = u.id;
  return best;
}

export const inUnit = (gb, u) => +((Number(gb) || 0) / unitGb(u)).toPrecision(6);

// ------------------------------------------------------------------ persistence
export function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ scenario: S.scenario, currency: S.currency })); } catch (_) { /* storage unavailable */ }
}

export function restore() {
  try {
    const raw = localStorage.getItem(STORE_KEY) || localStorage.getItem("ingestion-advisor:scenario:v1");
    if (raw) {
      const d = JSON.parse(raw);
      S.scenario = withDefaults(d.scenario || {});
      S.currency = d.currency || "USD";
      S.restored = true;
    }
  } catch (_) { /* ignore */ }
}

export function syncForm() {
  $("#customer").value = S.scenario.customer || "";
  $("#region").value = S.scenario.region;
  $("#processing_region").value = S.scenario.processing_region || "";
  $("#currency").value = S.currency;
  ["skill", "orchestration", "environment"].forEach((k) => ($("#" + k).value = S.scenario[k]));
  ["annual_growth_pct", "contingency_pct"].forEach((k) => ($("#" + k).value = S.scenario[k] ?? ""));
  const cm = S.scenario.commercial || {};
  $("#cm_discount_pct").value = cm.discount_pct ?? "";
  $("#cm_support_plan").value = cm.support_plan || "none";
  $("#cm_range_low_pct").value = cm.range_low_pct ?? -25;
  $("#cm_range_high_pct").value = cm.range_high_pct ?? 30;
  $("#analytics_tib_month").value = S.scenario.analytics_tib_month ?? "";
  renderBqPanel();
  const lk = S.scenario.lakehouse;
  $("#lk_raw_zone").checked = lk.raw_zone !== false;
  ["raw_scope", "raw_storage_class"].forEach((k) => ($("#lk_" + k).value = lk[k]));
  ["raw_retention_months", "silver_pct", "gold_pct"].forEach((k) => ($("#lk_" + k).value = lk[k]));
  renderEnvs();
  renderWorkloadForm();
}

// ------------------------------------------------------------------ samples / import
export async function loadSamples() {
  try {
    const samples = await api.samples();
    S.samples = samples;
    $("#samplesMenu").innerHTML = samples.map((s, i) =>
      `<button role="menuitem" data-i="${i}">${esc(s.title.replace(/^Sample - /, ""))}<small>${s.scenario.sources.length} sources, ${esc(s.scenario.region)}</small></button>`).join("");
    $("#samplesMenu").addEventListener("click", (e) => {
      const b = e.target.closest("[data-i]");
      if (!b) return;
      S.scenario = withDefaults(samples[+b.dataset.i].scenario);
      $("#samplesMenu").hidden = true;
      syncForm();
      changed();
      toast("Sample scenario loaded");
    });
    if (!S.restored && !S.scenario.sources.length && samples.length) {
      const first = samples.find((s) => s.file === "retail-bank-ksa.json") || samples[0];
      S.scenario = withDefaults(first.scenario);
      syncForm();
      changed();
    }
  } catch (_) {
    $("#samplesBtn").hidden = true;
  }
}

export function importScenario(e) {
  const f = e.target.files[0];
  if (!f) return;
  f.text().then((t) => {
    const d = JSON.parse(t);
    const sc = d.scenario || d;
    if (!Array.isArray(sc.sources)) throw new Error("File has no sources list");
    S.scenario = withDefaults(sc);
    syncForm();
    changed();
    toast("Scenario opened");
  }).catch((err) => toast(`Could not open file: ${err.message}`, 6000));
  e.target.value = "";
  $("#exportMenu").hidden = true;
}
