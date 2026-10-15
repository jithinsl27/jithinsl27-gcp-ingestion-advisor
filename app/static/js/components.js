/* Data Cloud Compass - components.js (ES module, no build step). */
import { S } from "./state.js";
import { $, $$, clone, esc, toast } from "./core.js";
import { DROP_MODES } from "./diagram.js";
import { changed } from "./events.js";
import { opt, regionOptions } from "./main.js";
import { compDefaults, compMeta, uid } from "./pricing.js";

// ------------------------------------------------------------------ components
export const MULTI_INSTANCE = new Set(["vertex_gpu", "agent_platform"]);

export function addComponent(type, mode, quiet) {
  const meta = compMeta(type);
  if (!meta) return;
  const existing = S.scenario.components.find((c) => c.type === type);
  if (existing && !MULTI_INSTANCE.has(type)) {
    if (!quiet) toast(`${meta.name} is already in the architecture`);
    return;
  }
  const settings = compDefaults(type);
  if (mode && DROP_MODES[type]) settings[DROP_MODES[type].key] = mode;
  S.scenario.components.push({ id: uid("c"), type, settings });
  if (type === "gemini_enterprise" && (mode === "looker") && !S.scenario.components.some((c) => c.type === "looker")) S.scenario.components.push({ id: uid("c"), type: "looker", settings: compDefaults("looker") });
  if (!quiet) toast(`${meta.name} added${mode ? ` (${DROP_MODES[type].msg[mode] ? DROP_MODES[type].msg[mode].replace(/^.*? now /, "") : mode})` : ""}${meta.vendor === "partner" ? " (partner product - not costed)" : ""}`);
  changed();
}

export function removeComponent(id) {
  const c = S.scenario.components.find((x) => x.id === id);
  if (!c) return;
  const prev = clone(S.scenario.components);
  S.scenario.components = S.scenario.components.filter((x) => x.id !== id);
  changed();
  toast(`${compMeta(c.type).name} removed`, 5000, { label: "Undo", run: () => { S.scenario.components = prev; changed(); } });
}

export function openComp(id) {
  const c = S.scenario.components.find((x) => x.id === id);
  if (!c) return;
  S.editingComp = id;
  const meta = compMeta(c.type);
  $("#compTitle").textContent = meta.name;
  $("#compVendor").textContent = meta.vendor === "google" ? "Google Cloud" : "Partner - not costed";
  $("#compVendor").className = "vendor-badge " + meta.vendor;
  $("#compMethod").textContent = meta.method;
  let fields = meta.settings.map((f) => {
    const v = c.settings[f.key] ?? f.default;
    const input = f.type === "select"
      ? `<select data-ck="${esc(f.key)}">${opt(f.options, v)}</select>`
      : `<input type="number" min="0" step="${esc(f.step ?? 1)}" data-ck="${esc(f.key)}" value="${esc(v)}">`;
    return `<label>${esc(f.label)}${input}</label>`;
  }).join("");
  if (meta.costed) {
    fields += `<label class="toggle span2"><input type="checkbox" data-ck="included" ${c.included !== false ? "checked" : ""}> Include in pricing</label>`;
    fields += `<label class="span2">Region for this service<select data-ck="region">${regionOptions("Same as BigQuery region")}</select></label>`;
  }
  $("#compFields").innerHTML = fields || `<p class="hint span2">No settings - this component is shown for the integration design only.</p>`;
  const rs = $("#compFields [data-ck=region]");
  if (rs) rs.value = c.settings.region || "";
  $("#compSteps").innerHTML = meta.steps.map((s) => `<li>${esc(s)}</li>`).join("");
  $("#compNotes").innerHTML = meta.notes.map((s) => `<li>${esc(s)}</li>`).join("");
  $("#compDoc").href = meta.doc;
  $("#compDialog").showModal();
}

export function saveComp() {
  const c = S.scenario.components.find((x) => x.id === S.editingComp);
  if (!c) return;
  $$("#compFields [data-ck]").forEach((el) => {
    if (el.dataset.ck === "included") { c.included = el.checked; return; }
    c.settings[el.dataset.ck] = el.type === "number" ? Math.max(0, Number(el.value) || 0) : el.value;
  });
  $("#compDialog").close();
  toast(`${compMeta(c.type).name} updated`);
  changed();
}

export function closeResults() {
  $("#compResults").hidden = true;
  $("#compSearch").setAttribute("aria-expanded", "false");
}

export function toggleComponent(type) {
  const existing = S.scenario.components.find((c) => c.type === type);
  if (existing) removeComponent(existing.id);
  else addComponent(type);
}

export function renderResults(q) {
  const list = $("#compResults");
  const terms = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  const catName = (id) => S.catalog.component_categories.find((c) => c.id === id).name;
  const hay = (c) => `${c.name} ${c.id} ${catName(c.category)} ${c.vendor === "partner" ? "partner" : "google"} ${c.method}`.toLowerCase();
  const score = (c) => {
    const name = c.name.toLowerCase();
    const words = name.split(/[^a-z0-9]+/);
    let sc = 0;
    for (const t of terms) {
      if (words.some((w) => w.startsWith(t))) sc += 100;
      else if (name.includes(t)) sc += 60;
      else if (`${c.id} ${catName(c.category)}`.toLowerCase().includes(t)) sc += 25;
      else if (hay(c).includes(t)) sc += 5;
      else return -1;
    }
    return sc;
  };
  const used = new Set(S.scenario.components.map((c) => c.type));
  const row = (c) => `<li class="res" role="option" draggable="true" data-type="${esc(c.id)}" aria-selected="${used.has(c.id)}">
      <span class="res-name">${esc(c.name)}<small>${esc(catName(c.category))} · ${esc(c.method)}</small></span>
      <span class="vendor-badge ${c.vendor}">${c.vendor === "google" ? (c.costed ? "Google Cloud" : "Google · no charge") : "Partner · not costed"}</span>
      <span class="res-btn ${used.has(c.id) ? "remove" : ""}">${used.has(c.id) ? "Remove" : "Add"}</span></li>`;
  let html = "";
  if (terms.length) {
    const ranked = S.catalog.components.map((c) => [c, score(c)]).filter(([, sc]) => sc >= 0).sort((x, y) => y[1] - x[1]).map(([c]) => c);
    html = ranked.length ? ranked.map(row).join("")
      : `<li class="res-empty">No product matches "${esc(q)}". Try a product name such as Looker, Power BI, Spanner or Collibra.</li>`;
  } else {
    for (const cat of S.catalog.component_categories) {
      const items = S.catalog.components.filter((c) => c.category === cat.id);
      html += `<li class="res-cat" role="presentation">${esc(cat.name)}</li>` + items.map(row).join("");
    }
  }
  list.innerHTML = html;
  list.hidden = false;
  $("#compSearch").setAttribute("aria-expanded", "true");
}

export function renderPills() {
  const host = $("#selectedPills");
  if (!S.scenario.components.length) {
    host.innerHTML = `<span class="pills-hint">No products selected yet - search above to add BI, AI, API, database, governance or security products.</span>`;
    return;
  }
  const order = S.catalog.component_categories.map((c) => c.id);
  const comps = [...S.scenario.components].sort((a, b) => order.indexOf(compMeta(a.type).category) - order.indexOf(compMeta(b.type).category));
  host.innerHTML = comps.map((c) => {
    const m = compMeta(c.type);
    const priced = c.included !== false;
    return `<span class="pill ${m.vendor} cat-${m.category}${priced ? "" : " unpriced"}">
      ${m.costed ? `<input type="checkbox" class="pill-price" data-price="${esc(c.id)}" ${priced ? "checked" : ""} title="${priced ? "Priced - untick to leave out of the estimate" : "Not priced - tick to include in the estimate"}" aria-label="Include ${esc(m.name)} in pricing">` : `<span class="dot"></span>`}
      <button type="button" data-comp="${esc(c.id)}" title="Configure ${esc(m.name)}">${esc(m.name)}${m.costed && c.settings.region ? ` · ${esc(c.settings.region)}` : ""}${priced ? "" : " · not priced"}</button>
      <button type="button" class="pill-x" data-remove="${esc(c.id)}" aria-label="Remove ${esc(m.name)}">×</button></span>`;
  }).join("");
}
