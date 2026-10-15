/* Data Cloud Compass - sources.js (ES module, no build step). */
import { S } from "./state.js";
import { $, STREAMING, toast } from "./core.js";
import { changed } from "./events.js";
import { uid } from "./pricing.js";
import { bestUnit, inUnit, unitGb } from "./scenario.js";

// ------------------------------------------------------------------ source dialog
export const TYPE_DEFAULTS = {
  rdbms: { data_type: "structured", frequency: "near_realtime", location: "on_prem" },
  rdbms_gcp: { data_type: "structured", frequency: "near_realtime", location: "gcp" },
  rdbms_nocdc: { data_type: "structured", frequency: "daily", location: "on_prem" },
  dwh: { data_type: "structured", frequency: "daily", location: "on_prem" },
  hadoop: { data_type: "semi_structured", frequency: "daily", location: "on_prem" },
  sap: { data_type: "structured", frequency: "near_realtime", location: "on_prem" },
  mainframe: { data_type: "structured", frequency: "daily", location: "on_prem" },
  nosql: { data_type: "semi_structured", frequency: "near_realtime", location: "on_prem" },
  nosql_gcp: { data_type: "semi_structured", frequency: "near_realtime", location: "gcp" },
  files_onprem: { data_type: "semi_structured", frequency: "daily", location: "on_prem" },
  object_aws: { data_type: "semi_structured", frequency: "daily", location: "aws" },
  object_azure: { data_type: "semi_structured", frequency: "daily", location: "azure" },
  object_gcp: { data_type: "semi_structured", frequency: "daily", location: "gcp" },
  kafka: { data_type: "events", frequency: "realtime", location: "on_prem" },
  stream_aws: { data_type: "events", frequency: "realtime", location: "aws" },
  stream_azure: { data_type: "events", frequency: "realtime", location: "azure" },
  events: { data_type: "events", frequency: "realtime", location: "on_prem" },
  logs: { data_type: "semi_structured", frequency: "realtime", location: "gcp" },
  saas_google: { data_type: "structured", frequency: "daily", location: "saas" },
  saas_salesforce: { data_type: "structured", frequency: "daily", location: "saas" },
  saas_other: { data_type: "structured", frequency: "daily", location: "saas" },
  api: { data_type: "semi_structured", frequency: "hourly", location: "saas" },
  unstructured: { data_type: "unstructured", frequency: "daily", location: "on_prem" },
};

export function applyTypeDefaults() {
  if (S.editingId) return updateHint();
  const t = S.catalog.source_types.find((s) => s.id === $("#f_type").value);
  const d = TYPE_DEFAULTS[t?.category] || {};
  Object.entries(d).forEach(([k, v]) => ($("#f_" + k).value = v));
  updateHint();
}

export function updateHint() {
  const freq = $("#f_frequency").value, type = $("#f_type").value;
  const t = S.catalog.source_types.find((s) => s.id === type);
  let h;
  if (t?.cdc && STREAMING.has(freq)) h = "Log-based CDC will be recommended - confirm the DBA can enable it on the source.";
  else if (freq === "one_time") h = "Only the initial load is costed; ongoing ingestion is excluded.";
  else if (STREAMING.has(freq)) h = "Streaming pipelines run 24x7 and are costed as always-on.";
  else h = "Scheduled batch: cost scales with runs per month and volume per run.";
  if ($("#f_region").value && $("#f_region").value !== S.scenario.region) h += " Processing outside the BigQuery region adds cross-region transfer cost - check data-residency rules.";
  $("#f_hint").textContent = h;
}

export function openDialog(id) {
  S.editingId = id;
  const s = id ? S.scenario.sources.find((x) => x.id === id) : null;
  $("#dlgTitle").textContent = s ? "Edit source system" : "Add source system";
  $("#f_save").textContent = s ? "Save changes" : "Add source";
  $("#f_delete").hidden = !s;
  const setVol = (inpSel, unitSel, gb, unit) => {
    const u = unit || bestUnit(gb);
    $(unitSel).value = u;
    $(inpSel).dataset.unit = u;
    $(inpSel).value = inUnit(gb, u);
  };
  if (s) {
    ["type", "name", "data_type", "location", "frequency", "transform", "notes", "region"]
      .forEach((k) => ($("#f_" + k).value = s[k] ?? ""));
    setVol("#f_initial_volume_gb", "#f_initial_unit", s.initial_volume_gb, s.units?.initial);
    setVol("#f_daily_change_gb", "#f_daily_unit", s.daily_change_gb, s.units?.daily);
    $("#f_iot_option").value = s.iot_option || "native";
  } else {
    $("#f_type").value = "oracle"; $("#f_name").value = ""; $("#f_notes").value = ""; $("#f_region").value = "";
    $("#f_transform").value = "none";
    setVol("#f_initial_volume_gb", "#f_initial_unit", 500, "GB");
    setVol("#f_daily_change_gb", "#f_daily_unit", 5, "GB");
    $("#f_iot_option").value = "native";
    applyTypeDefaults();
  }
  $("#f_iot_wrap").hidden = $("#f_type").value !== "iot";
  updateHint();
  $("#sourceDialog").showModal();
  $("#f_type").focus();
}

export function saveSource() {
  const v = (k) => $("#f_" + k).value;
  const typeName = S.catalog.source_types.find((s) => s.id === v("type"))?.name || v("type");
  const src = {
    id: S.editingId || uid("s"),
    name: v("name").trim() || typeName,
    type: v("type"), data_type: v("data_type"), location: v("location"),
    frequency: v("frequency"), transform: v("transform"),
    initial_volume_gb: Math.max(0, (Number(v("initial_volume_gb")) || 0) * unitGb(v("initial_unit"))),
    daily_change_gb: Math.max(0, (Number(v("daily_change_gb")) || 0) * unitGb(v("daily_unit"))),
    units: { initial: v("initial_unit"), daily: v("daily_unit") },
    notes: v("notes"),
    region: v("region") || "",
  };
  if (src.type === "iot") src.iot_option = v("iot_option");
  const prevSrc = S.editingId && S.scenario.sources.find((x) => x.id === S.editingId);
  if (prevSrc) { src.included = prevSrc.included !== false; if (prevSrc.start_month) src.start_month = prevSrc.start_month; }
  if (S.editingId) S.scenario.sources = S.scenario.sources.map((s) => (s.id === S.editingId ? src : s));
  else S.scenario.sources.push(src);
  $("#sourceDialog").close();
  toast(S.editingId ? "Source updated" : "Source added");
  changed();
}
