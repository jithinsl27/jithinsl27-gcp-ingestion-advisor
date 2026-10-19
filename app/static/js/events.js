/* Data Cloud Compass - events.js (ES module, no build step). */
import { S } from "./state.js";
import { addComponent, closeResults, openComp, removeComponent, renderPills, renderResults, saveComp, toggleComponent } from "./components.js";
import { $, $$, api, clone, toast } from "./core.js";
import { renderCost } from "./cost.js";
import { DROP_MODES, applyDropMode, bindDiagramDrag, modeForDrop } from "./diagram.js";
import { newEnvFrom, onEnvGridChange, onInlineSizing, openEnvDialog, renderEnvGrid, saveEnvDialog, setEnvCount } from "./environments.js";
import { EDITION_NAME, bq } from "./bigquery.js";
import { doExport } from "./exports.js";
import { renderPlatform } from "./integrations.js";
import { compMeta, drill, hasEstimate, openDrill, renderDrill, setOption } from "./pricing.js";
import { renderAll, renderSources, renderSummary } from "./render.js";
import { renderRoadmap } from "./roadmap.js";
import { markDirty } from "./account.js";
import { importScenario, inUnit, save, syncForm, unitGb } from "./scenario.js";
import { bindModules, nav, renderEnvBody, renderHead, renderModules, renderPlans, showModule } from "./modules.js";
import { reviewThen } from "./review.js";
import { applyTypeDefaults, openDialog, saveSource, updateHint, showDomain } from "./sources.js";
import { onWorkloadInput, renderWorkloadForm, renderWorkloadResults } from "./workload.js";

// ------------------------------------------------------------------ events
export function bindEvents() {
  $("#customer").addEventListener("input", (e) => { S.scenario.customer = e.target.value; save(); renderSummary(); });
  $("#region").addEventListener("change", (e) => { S.scenario.region = e.target.value; changed(); });
  $("#processing_region").addEventListener("change", (e) => { S.scenario.processing_region = e.target.value; changed(); });
  $("#currency").addEventListener("change", (e) => { S.currency = e.target.value; save(); renderSummary(); renderCost(); renderPlatform(); renderWorkloadResults(); renderRoadmap(); });
  ["skill", "orchestration", "environment"].forEach((k) =>
    $("#" + k).addEventListener("change", (e) => { S.scenario[k] = e.target.value; changed(); }));
  // commercial terms
  ["discount_pct", "range_low_pct", "range_high_pct"].forEach((k) => $("#cm_" + k).addEventListener("change", (e) => {
    const c = (S.scenario.commercial ||= {});
    if (e.target.value === "") delete c[k]; else c[k] = Number(e.target.value);
    changed();
  }));
  $("#cm_support_plan").addEventListener("change", (e) => { (S.scenario.commercial ||= {}).support_plan = e.target.value; changed(); });
  ["annual_growth_pct", "contingency_pct", "analytics_tib_month"].forEach((k) =>
    $("#" + k).addEventListener("input", (e) => {
      const v = e.target.value === "" ? null : Number(e.target.value);
      S.scenario[k] = k === "analytics_tib_month" ? v : (v ?? 0);
      changed();
    }));
  bindModules(showTab);
  // lakehouse layers
  $("#lk_raw_zone").addEventListener("change", (e) => { S.scenario.lakehouse.raw_zone = e.target.checked; changed(); });
  ["raw_scope", "raw_storage_class"].forEach((k) => $("#lk_" + k).addEventListener("change", (e) => { S.scenario.lakehouse[k] = e.target.value; changed(); }));
  ["raw_retention_months", "silver_pct", "gold_pct"].forEach((k) => $("#lk_" + k).addEventListener("input", (e) => {
    const v = Number(e.target.value);
    if (e.target.value === "" || !(v >= 0)) return;
    S.scenario.lakehouse[k] = k === "raw_retention_months" ? Math.max(1, Math.round(v)) : v;
    changed();
  }));
  // environments
  $("#envCount").addEventListener("change", (e) => setEnvCount(Number(e.target.value)));
  $("#envConfigure").addEventListener("click", openEnvDialog);
  $("#envList").addEventListener("click", (e) => { if (e.target.closest("[data-env]")) openEnvDialog(); });
  $("#envAdd").addEventListener("click", () => { S.envDraft.push(newEnvFrom(S.envDraft)); renderEnvGrid(); });
  $("#envCancel").addEventListener("click", () => $("#envDialog").close());
  $("#envForm").addEventListener("submit", (e) => { e.preventDefault(); saveEnvDialog(); });
  $("#envGrid").addEventListener("change", onEnvGridChange);
  $("#envGrid").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-env-rm]");
    if (rm) { S.envDraft.splice(Number(rm.dataset.envRm), 1); renderEnvGrid(); }
  });
  // source dialog units
  ["initial", "daily"].forEach((k) => $(`#f_${k}_unit`).addEventListener("change", (e) => {
    const inp = $(k === "initial" ? "#f_initial_volume_gb" : "#f_daily_change_gb");
    const prev = inp.dataset.unit || "GB";
    inp.value = inUnit(Number(inp.value) * unitGb(prev), e.target.value);
    inp.dataset.unit = e.target.value;
  }));
  $("#addSourceBtn").addEventListener("click", () => openDialog(null));
  $("#sourceList").addEventListener("click", (e) => {
    if (e.target.closest("[data-include]")) return;
    const li = e.target.closest("[data-id]");
    if (li) openDialog(li.dataset.id);
  });
  const diagram = $("#diagram");
  diagram.addEventListener("click", (e) => {
    if (S.suppressClick) return;
    const add = e.target.closest("[data-addcomp]");
    if (add) { addComponent(add.dataset.addcomp); changed(); return; }
    if (e.target.closest("[data-lake]")) { showTab("settings"); setTimeout(() => $("#lakePanel").scrollIntoView({ behavior: "smooth", block: "center" }), 50); return; }
    const n = e.target.closest("[data-src]");
    if (n) return openDialog(n.dataset.src);
    const c = e.target.closest("[data-comp]");
    if (c) openComp(c.dataset.comp);
  });
  diagram.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const add = e.target.closest("[data-addcomp]");
    if (add) { e.preventDefault(); addComponent(add.dataset.addcomp); changed(); return; }
    const n = e.target.closest("[data-src],[data-comp]");
    if (!n) return;
    e.preventDefault();
    if (n.dataset.src) openDialog(n.dataset.src); else openComp(n.dataset.comp);
  });
  // drag & drop from the component library onto the diagram
  let dragging = null;
  diagram.addEventListener("dragover", (e) => { if (dragging) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; diagram.classList.add("drop-active"); } });
  diagram.addEventListener("dragleave", (e) => { if (!diagram.contains(e.relatedTarget)) diagram.classList.remove("drop-active"); });
  diagram.addEventListener("drop", (e) => {
    const type = dragging || e.dataTransfer.getData("text/plain");
    dragging = null;
    diagram.classList.remove("drop-active", "drop-ready");
    if (type) {
      e.preventDefault();
      const tgt = e.target.closest?.("[data-drop]")?.dataset.drop;
      const existing = S.scenario.components.find((c) => c.type === type);
      if (existing && DROP_MODES[type] && tgt) applyDropMode(existing, tgt);
      else addComponent(type, modeForDrop(type, tgt));
    }
  });
  bindDiagramDrag();
  // product search picker
  const search = $("#compSearch"), results = $("#compResults");
  search.addEventListener("input", () => renderResults(search.value));
  search.addEventListener("focus", () => renderResults(search.value));
  search.addEventListener("keydown", (e) => {
    const rows = $$(".res", results);
    let i = rows.findIndex((r) => r.classList.contains("active"));
    if (e.key === "ArrowDown") { e.preventDefault(); i = Math.min(rows.length - 1, i + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); i = Math.max(0, i - 1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (rows[Math.max(0, i)]) toggleComponent(rows[Math.max(0, i)].dataset.type);
      search.value = "";
      closeResults();
      return;
    }
    else if (e.key === "Escape") { closeResults(); return; }
    else return;
    rows.forEach((r, k) => r.classList.toggle("active", k === i));
    rows[i]?.scrollIntoView({ block: "nearest" });
  });
  results.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the search box
  results.addEventListener("click", (e) => {
    const r = e.target.closest(".res");
    if (r) toggleComponent(r.dataset.type);
  });
  results.addEventListener("dragstart", (e) => {
    const r = e.target.closest(".res");
    if (!r) return;
    dragging = r.dataset.type;
    e.dataTransfer.setData("text/plain", r.dataset.type);
    e.dataTransfer.effectAllowed = "copy";
    diagram.classList.add("drop-ready");
  });
  results.addEventListener("dragend", () => { dragging = null; diagram.classList.remove("drop-ready", "drop-active"); });
  document.addEventListener("click", (e) => { if (!e.target.closest(".search-box")) closeResults(); });
  $("#selectedPills").addEventListener("change", (e) => {
    const cb = e.target.closest("[data-price]");
    if (!cb) return;
    const c = S.scenario.components.find((x) => x.id === cb.dataset.price);
    if (c) { c.included = cb.checked; toast(`${compMeta(c.type).name} ${cb.checked ? "included in" : "left out of"} pricing`); changed(); }
  });
  $("#costBody").addEventListener("click", (e) => {
    const b = e.target.closest("[data-bom-env]");
    if (b) { S.bomEnv = b.dataset.bomEnv; renderCost(); }
  });
  $("#costBody").addEventListener("change", (e) => {
    const cb = e.target.closest("[data-svc]");
    if (!cb) return;
    const svc = cb.dataset.svc;
    const set = new Set(S.scenario.excluded_services);
    if (cb.checked) set.delete(svc); else set.add(svc);
    S.scenario.excluded_services = [...set];
    changed();
  });
  $("#selectedPills").addEventListener("click", (e) => {
    if (e.target.closest("[data-price]")) return;
    const rm = e.target.closest("[data-remove]");
    if (rm) return removeComponent(rm.dataset.remove);
    const b = e.target.closest("[data-comp]");
    if (b) openComp(b.dataset.comp);
  });
  // source include / exclude for phased estimates
  $("#sourceList").addEventListener("change", (e) => {
    const cb = e.target.closest("[data-include]");
    if (!cb) return;
    const s = S.scenario.sources.find((x) => x.id === cb.dataset.include);
    if (s) { s.included = cb.checked; changed(); }
  });
  $("#srcAll").addEventListener("click", () => { S.scenario.sources.forEach((s) => (s.included = true)); changed(); });
  $("#srcNone").addEventListener("click", () => { S.scenario.sources.forEach((s) => (s.included = false)); changed(); });
  $("#platformBody").addEventListener("change", (e) => {
    const sel = e.target.closest("[data-mode-comp]");
    if (!sel) return;
    const c = S.scenario.components.find((x) => x.id === sel.dataset.modeComp);
    if (!c) return;
    const key = compMeta(c.type).modes.key;
    c.settings[key] = sel.value;
    if (c.type === "gemini_enterprise" && ["looker", "both"].includes(sel.value) && !S.scenario.components.some((x) => x.type === "looker")) addComponent("looker", null, true);
    changed();
  });
  $("#platformBody").addEventListener("click", (e) => {
    const b = e.target.closest("[data-comp]");
    if (b) openComp(b.dataset.comp);
  });

  $("#f_cancel").addEventListener("click", () => $("#sourceDialog").close());
  $("#f_delete").addEventListener("click", () => {
    S.scenario.sources = S.scenario.sources.filter((s) => s.id !== S.editingId);
    $("#sourceDialog").close();
    toast("Source removed");
    changed();
  });
  $("#sourceForm").addEventListener("submit", (e) => { e.preventDefault(); saveSource(); });
  $("#f_type").addEventListener("change", applyTypeDefaults);
  $("#f_like_type").addEventListener("change", applyTypeDefaults);
  $("#f_target").addEventListener("change", showDomain);
  ["f_frequency", "f_location", "f_transform", "f_type"].forEach((id) => $("#" + id).addEventListener("change", updateHint));

  $("#c_cancel").addEventListener("click", () => $("#compDialog").close());
  $("#c_delete").addEventListener("click", () => { $("#compDialog").close(); removeComponent(S.editingComp); });
  $("#compForm").addEventListener("submit", (e) => { e.preventDefault(); saveComp(); });

  $("#roadmapBody").addEventListener("change", (e) => {
    if (e.target.id === "rmTeams") { S.scenario.plan.teams = Number(e.target.value); save(); runPlan(); }
  });
  $("#workloadBody").addEventListener("input", onWorkloadInput);
  $("#workloadBody").addEventListener("change", onWorkloadInput);
  $("#workloadBody").addEventListener("click", (e) => {
    if (e.target.closest("#slotApply") && S.wlResult?.slots) {
      // reconcile: the consumption estimate now sizes BigQuery from this workload
      const sl = S.wlResult.slots;
      const prev = clone(bq());
      Object.assign(bq(), { scan_basis: "workload", mode: sl.model === "editions" ? "editions" : "ondemand", edition: sl.model === "editions" ? sl.edition : prev.edition });
      syncForm(); changed();
      toast(sl.model === "editions" ? `Estimate now sizes ${EDITION_NAME[sl.edition]} edition slots from this workload` : "Estimate now uses on-demand pricing with this workload's scan volume", 6000,
        { label: "Undo", run: () => { S.scenario.bq = prev; syncForm(); changed(); } });
      return;
    }
    if (e.target.closest("#wlReset")) {
      S.scenario.workload = clone(S.catalog.default_workload);
      renderWorkloadForm();
      changed();
      toast("Example workload values loaded");
    }
  });

  menu("#samplesBtn", "#samplesMenu");
  menu("#exportBtn", "#exportMenu");
  $("#exportMenu").addEventListener("click", (e) => {
    const b = e.target.closest("[data-export]");
    if (!b) return;
    $("#exportMenu").hidden = true;
    const kind = b.dataset.export;
    // saving the scenario file or starting over needs no review; anything the customer may see does
    if (kind === "json" || kind === "reset" || !hasEstimate()) return doExport(kind);
    reviewThen(b.textContent.trim(), () => doExport(kind));
  });
  $("#importFile").addEventListener("change", importScenario);

  // pricing option switch (summary strip, consumption tab, drill-down)
  document.addEventListener("click", (e) => {
    const o = e.target.closest("[data-opt]");
    if (o) setOption(o.dataset.opt);
  });
  // cost drill-down
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-drill]");
    if (b && hasEstimate()) openDrill(b.dataset.drill);
  });
  $("#drillDialog").addEventListener("click", (e) => {
    const v = e.target.closest("[data-drill-view]"), en = e.target.closest("[data-drill-env]");
    if (v) { drill.view = v.dataset.drillView; renderDrill(); }
    else if (en) { drill.env = en.dataset.drillEnv; renderDrill(); }
    else if (e.target.closest("#drillClose")) $("#drillDialog").close();
  });
  // inline environment sizing (consumption tab); slot inputs are handled in bigquery.js
  $("#costBody").addEventListener("change", onInlineSizing);
  $("#costBody").addEventListener("click", (e) => { if (e.target.closest("#envSizeEdit")) openEnvDialog(); });
  $("#envBody").addEventListener("change", onInlineSizing);
  $("#envBody").addEventListener("click", (e) => { if (e.target.closest("#envSizeEdit")) openEnvDialog(); });
}

export function menu(btnSel, popSel) {
  const btn = $(btnSel), pop = $(popSel);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = pop.hidden;
    $$(".menu-pop").forEach((p) => (p.hidden = true));
    pop.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => { if (!pop.contains(e.target)) { pop.hidden = true; btn.setAttribute("aria-expanded", "false"); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") pop.hidden = true; });
}

export function showTab(id) {
  showModule(id);
}

export function changed() {
  markDirty();
  save();
  renderSources();
  renderPills();
  if (!$("#compResults").hidden) renderResults($("#compSearch").value);
  scheduleEstimate(250);
}

export function scheduleEstimate(delay) {
  clearTimeout(S.estimateTimer);
  S.estimateTimer = setTimeout(() => { runEstimate(); runWorkload(); runPlan(); }, delay);
}

export function payload() {
  const p = clone(S.scenario);
  p.analytics_tib_month = p.analytics_tib_month || null;
  if (!p.processing_region) delete p.processing_region;
  p.sources.forEach((s) => { if (!s.region) delete s.region; });
  p.components.forEach((c) => { if (!c.settings.region) delete c.settings.region; });
  ["data_region", "pipelines_region", "streaming_region"].forEach((k) => { if (!p.workload[k]) p.workload[k] = null; });
  return p;
}

export async function runEstimate() {
  const my = ++S.seq;
  try {
    const r = await api.estimate(payload());
    if (my !== S.seq) return;
    S.result = r;
    if (S.scenario.bq?._recommend && r.bigquery?.active) {        // guided interview: pick the cheaper model once
      delete S.scenario.bq._recommend;
      if (r.bigquery.recommended_mode !== S.scenario.bq.mode) { S.scenario.bq.mode = r.bigquery.recommended_mode; changed(); return; }
    }
    renderAll();
  } catch (e) {
    toast(`Estimate failed: ${e.message}`, 6000);
  }
}

export async function runWorkload() {
  const my = ++S.wlSeq;
  try {
    const r = await api.workload(payload());
    if (my !== S.wlSeq) return;
    S.wlResult = r;
    renderWorkloadResults();
    renderModules();
  } catch (e) {
    toast(`Workload sizing failed: ${e.message}`, 6000);
  }
}

export async function runPlan() {
  const my = ++S.planSeq;
  try {
    const r = await api.plan(payload());
    if (my !== S.planSeq) return;
    S.planResult = r;
    renderRoadmap();
    renderModules();
  } catch (e) {
    toast(`Roadmap failed: ${e.message}`, 6000);
  }
}
