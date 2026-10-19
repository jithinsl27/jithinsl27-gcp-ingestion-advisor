/* Data Cloud Compass - main.js (ES module, no build step). */
import { S } from "./state.js";
import { $, $$, api, clone, esc, toast } from "./core.js";
import { bindEvents, menu, scheduleEstimate } from "./events.js";
import { bindGoogleExport, loadServerConfig } from "./exports.js";
import { initIdentity } from "./identity.js";
import { loadIconManifest } from "./icons.js";
import { renderAll } from "./render.js";
import { bindBq } from "./bigquery.js";
import { bindNotices } from "./notices.js";
import { bindAccount, initAccount, restoreCloudRef } from "./account.js";
import { bindCompare, openCompare } from "./compare.js";
import { bindDiscover } from "./discover.js";
import { loadSamples, restore, syncForm, withDefaults } from "./scenario.js";
import { showModule } from "./modules.js";
import { initTips } from "./tips.js";

// ------------------------------------------------------------------ boot
export async function boot() {
  try {
    [S.catalog, S.config] = await Promise.all([api.catalog(), api.config().catch(() => ({})), loadIconManifest()]);
  } catch (e) {
    toast(`Could not load the catalog: ${e.message}`, 8000);
    return;
  }
  S.DEFAULT_SCENARIO = {
    ...S.DEFAULT_SCENARIO,
    components: [],      // nothing is priced until the architect adds sources or products
    security: {},
    workload: clone(S.catalog.default_workload),
  };
  S.scenario = withDefaults({});
  fillSelects();
  if (window.ADVISOR_NO_DOWNLOAD) {
    $$('[data-export="print"]').forEach((b) => (b.hidden = true));
    $$("#exportMenu [data-export]").forEach((b) => { if (["md", "csv", "json", "svg"].includes(b.dataset.export)) b.textContent = "Copy " + b.textContent.charAt(0).toLowerCase() + b.textContent.slice(1); });
  }
  if (window.ADVISOR_DEMO) document.body.classList.add("demo");
  restore();
  restoreCloudRef();
  bindEvents();
  initTips();
  bindBq();
  bindNotices();
  bindAccount(openCompare);
  bindCompare();
  bindDiscover();
  menu("#scenariosBtn", "#scenariosMenu");
  bindGoogleExport();
  loadServerConfig();
  loadSamples();
  syncForm();
  let tab = "overview";
  try { tab = localStorage.getItem("data-cloud-compass:tab") || "overview"; } catch (_) { /* ignore */ }
  showModule(tab);
  renderAll();
  scheduleEstimate(0);
  initAccount();
  initIdentity();
}

export function opt(list, sel) {
  return list.map((o) => `<option value="${esc(o.id)}"${o.id === sel ? " selected" : ""}>${esc(o.name)}</option>`).join("");
}

export function regionOptions(sameLabel) {
  const byGeo = {};
  S.catalog.regions.forEach((r) => (byGeo[r.geo] = byGeo[r.geo] || []).push(r));
  return (sameLabel ? `<option value="">${esc(sameLabel)}</option>` : "") + Object.entries(byGeo).map(([g, rs]) =>
    `<optgroup label="${esc(g)}">${rs.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("")}</optgroup>`).join("");
}

export const regionName = (id) => S.catalog.regions.find((r) => r.id === id)?.name || id;

export function fillSelects() {
  $("#region").innerHTML = regionOptions();
  $("#processing_region").innerHTML = regionOptions("Same as BigQuery region");
  $("#f_region").innerHTML = regionOptions("Same as BigQuery region");
  $("#skill").innerHTML = opt(S.catalog.skills);
  $("#orchestration").innerHTML = opt(S.catalog.orchestration);
  const cats = {
    rdbms: "Relational databases", rdbms_gcp: "Relational databases", rdbms_nocdc: "Relational databases",
    dwh: "Warehouses & big data", hadoop: "Warehouses & big data", sap: "Enterprise applications", mainframe: "Enterprise applications",
    nosql: "NoSQL", nosql_gcp: "NoSQL", files_onprem: "Files & object storage", object_aws: "Files & object storage",
    object_azure: "Files & object storage", object_gcp: "Files & object storage", kafka: "Streaming & events",
    stream_aws: "Streaming & events", stream_azure: "Streaming & events", events: "Streaming & events", logs: "Streaming & events",
    saas_google: "SaaS & APIs", saas_salesforce: "SaaS & APIs", saas_other: "SaaS & APIs", api: "SaaS & APIs", unstructured: "Unstructured",
  };
  const groups = {};
  S.catalog.source_types.forEach((s) => (groups[cats[s.category] || "Other"] = groups[cats[s.category] || "Other"] || []).push(s));
  $("#f_type").innerHTML = Object.entries(groups).map(([g, ss]) =>
    `<optgroup label="${esc(g)}">${ss.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</optgroup>`).join("");
  $("#f_like_type").innerHTML = S.catalog.source_types.filter((s) => s.id !== "custom").map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
  $("#f_data_type").innerHTML = opt(S.catalog.data_types);
  $("#f_location").innerHTML = opt(S.catalog.locations);
  $("#f_frequency").innerHTML = opt(S.catalog.frequencies);
  $("#f_transform").innerHTML = opt(S.catalog.transforms);
  $("#currency").innerHTML = ["USD", "SAR", "AED", "EUR", "GBP", "INR"].map((c) => `<option>${c}</option>`).join("");
  $("#envCount").innerHTML = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}">${n}</option>`).join("");
  $("#lk_raw_storage_class").innerHTML = opt(S.catalog.storage_classes);
  $("#f_iot_option").innerHTML = opt(S.catalog.iot_options.map((o) => ({ id: o.id, name: o.name })));
  const units = S.catalog.volume_units.map((u) => `<option>${u.id}</option>`).join("");
  $("#f_initial_unit").innerHTML = units;
  $("#f_daily_unit").innerHTML = units;
}

boot();
