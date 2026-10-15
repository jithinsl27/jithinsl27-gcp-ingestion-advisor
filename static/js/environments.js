/* Data Cloud Compass - environments.js (ES module, no build step). */
import { S } from "./state.js";
import { $, $$, clone, esc, toast } from "./core.js";
import { GROUP_COLORS, money, moneyShort } from "./cost.js";
import { changed } from "./events.js";
import { opt } from "./main.js";
import { GROUP_ORDER_UI, SHARED_UI, bomCost, envOpt, hasEstimate, optShort, uid } from "./pricing.js";
import { isEditions, slotCell } from "./bigquery.js";

// ------------------------------------------------------------------ environments
export const ENV_ORDER = ["prod", "dev", "uat", "preprod", "dr", "sandbox"];

export const presetOf = (id) => S.catalog.environment_presets.find((p) => p.id === id);

export const FACTOR_IDS = () => S.catalog.environment_factors.map((f) => f.id);

export function normEnvs(list) {
  return clone(list).map((e, i) => {
    const p = presetOf(e.preset) || presetOf(i ? "dev" : "prod");
    const out = { id: e.id || uid("env"), name: e.name || p.name, preset: e.preset || p.id, included: e.included !== false };
    FACTOR_IDS().forEach((f) => (out[f] = e[f] ?? p[f]));
    if (i === 0) FACTOR_IDS().forEach((f) => (out[f] = 100));
    out.bq_baseline = e.bq_baseline ?? (e.bq_slots ?? null);     // legacy bq_slots = flat slots
    out.bq_max = e.bq_max ?? (e.bq_slots ?? null);
    return out;
  });
}

export function newEnvFrom(list) {
  const used = new Set(list.map((e) => e.preset));
  const pid = ENV_ORDER.find((id) => !used.has(id)) || "dev";
  const p = presetOf(pid);
  let name = p.name, k = 2;
  while (list.some((e) => e.name === name)) name = `${p.name} ${k++}`;
  return normEnvs([{ id: "x" }, { id: uid("env"), name, preset: pid }])[1];
}

export function setEnvCount(n) {
  const prev = clone(S.scenario.environments);
  while (S.scenario.environments.length < n) S.scenario.environments.push(newEnvFrom(S.scenario.environments));
  if (S.scenario.environments.length > n) {
    S.scenario.environments = S.scenario.environments.slice(0, n);
    toast(`${prev.length - n} environment${prev.length - n > 1 ? "s" : ""} removed`, 5000, { label: "Undo", run: () => { S.scenario.environments = prev; renderEnvs(); changed(); } });
  }
  renderEnvs();
  changed();
}

export const envCost = (id) => { const e = hasEstimate() ? S.result.environments?.find((x) => x.id === id) : null; return e ? envOpt(e) : null; };

export function renderEnvs() {
  if (!S.catalog) return;
  $("#envCount").value = String(S.scenario.environments.length);
  const short = { data_pct: "data", ingestion_pct: "ingest", compute_pct: "compute", ai_pct: "AI/BI", apps_pct: "APIs/DB", platform_pct: "platform", runtime_pct: "runs" };
  $("#envList").innerHTML = S.scenario.environments.map((e, i) => {
    const c = envCost(e.id);
    const sizing = i === 0 ? "Baseline - sized by your inputs" : FACTOR_IDS().map((f) => `${short[f]} ${+e[f]}%`).join(" · ");
    return `<li><button type="button" class="env-item" data-env="${esc(e.id)}"><span class="env-dot e${Math.min(i, 5)}"></span>
      <div><b>${esc(e.name)}</b><span>${esc(sizing)}</span></div><div class="tool">${c ? moneyShort(c.year1) + "/yr" : ""}</div></button></li>`;
  }).join("");
}

export function openEnvDialog() {
  S.envDraft = clone(S.scenario.environments);
  renderEnvGrid();
  $("#envDialog").showModal();
}

export function renderEnvGrid() {
  const head = `<thead><tr><th>Capability</th>${S.envDraft.map((e, i) => `<th>
      <input type="text" data-env-i="${i}" data-env-k="name" value="${esc(e.name)}" aria-label="Environment name" maxlength="60">
      ${i === 0 ? `<span class="env-base">Baseline</span>` : `<select data-env-i="${i}" data-env-k="preset" aria-label="Preset">${opt(S.catalog.environment_presets, e.preset)}</select>
      <button type="button" class="link-btn" data-env-rm="${i}">Remove</button>`}</th>`).join("")}</tr></thead>`;
  const rows = S.catalog.environment_factors.map((f) => `<tr><th scope="row">${esc(f.name)}<small class="f-help">${esc(f.help || "")}</small></th>${S.envDraft.map((e, i) =>
    `<td><input type="number" min="0" max="1000" step="5" data-env-i="${i}" data-env-k="${f.id}" value="${esc(e[f.id])}" ${i === 0 ? "disabled" : ""} aria-label="${esc(e.name)} ${esc(f.name)}"></td>`).join("")}</tr>`).join("");
  const cost = S.result?.environments ? `<tr class="env-cost"><th scope="row">Current estimate, year 1</th>${S.envDraft.map((e) => `<td>${envCost(e.id) ? money(envCost(e.id).year1) : "new"}</td>`).join("")}</tr>` : "";
  $("#envGrid").innerHTML = head + `<tbody>${rows}${cost}</tbody>`;
  $("#envSpec").innerHTML = hasEstimate() ? `<h3>Resulting specification per environment</h3><p class="hint">What the sizing above provisions in each environment at month 12 (run-rate), from the applied estimate. Apply to refresh after changing a percentage.</p>${envSpecTable()}` : "";
}

export function onEnvGridChange(e) {
  const el = e.target.closest("[data-env-i]");
  if (!el) return;
  const env = S.envDraft[Number(el.dataset.envI)], k = el.dataset.envK;
  if (k === "name") env.name = el.value.trim() || env.name;
  else if (k === "preset") {
    const p = presetOf(el.value);
    env.preset = p.id;
    FACTOR_IDS().forEach((f) => (env[f] = p[f]));
    if (!S.envDraft.some((x, j) => x !== env && x.name === p.name)) env.name = p.name;
    renderEnvGrid();
  } else env[k] = Math.max(0, Number(el.value) || 0);
}

export function saveEnvDialog() {
  $$("#envGrid [data-env-k=name]").forEach((el) => { const env = S.envDraft[Number(el.dataset.envI)]; env.name = el.value.trim() || env.name; });
  S.scenario.environments = normEnvs(S.envDraft);
  $("#envDialog").close();
  renderEnvs();
  toast(`${S.scenario.environments.length} environment${S.scenario.environments.length > 1 ? "s" : ""} sized`);
  changed();
}

// ------------------------------------------------------------------ environment sizing: parameters + resulting spec
export const fmtSpecQty = (q) => q == null ? "" : q >= 1e6 ? (q / 1e6).toFixed(2) + "M" : q >= 1e4 ? Math.round(q).toLocaleString() : (+(+q).toPrecision(3)).toLocaleString();

export function envSpecTable() {
  const envs = S.result.environments || [];
  const services = [];
  (S.result.bom || []).forEach((b) => { if (!services.some((x) => x.service === b.service)) services.push({ service: b.service, group: b.group, unit: b.unit }); });
  services.sort((a, b) => (GROUP_ORDER_UI.indexOf(a.group) - GROUP_ORDER_UI.indexOf(b.group)));
  let last = null;
  const body = services.map((svc) => {
    let head = "";
    if (svc.group !== last) head = `<tr class="bom-group"><th colspan="${envs.length + 1}"><i style="background:${GROUP_COLORS[svc.group] || "#9AA0A6"}"></i>${esc(svc.group)}</th></tr>`;
    last = svc.group;
    return head + `<tr><td>${esc(svc.service)}</td>` + envs.map((e) => {
      const b = S.result.bom.find((x) => x.environment === e.id && x.service === svc.service);
      if (!b) return `<td class="num muted">${SHARED_UI.has(svc.service) && e !== envs[0] ? "shared" : "-"}</td>`;
      return `<td class="num">${b.qty_month12 != null ? `<span class="q">${fmtSpecQty(b.qty_month12)} ${esc(b.unit || "")}</span>` : ""}<b>${money(bomCost(b, "month12"))}</b></td>`;
    }).join("") + `</tr>`;
  }).join("");
  const slotRow = isEditions() ? `<tr class="spec-key"><td>BigQuery slots: baseline → max</td>${envs.map((e) => `<td class="num"><b>${e.slots ? `${e.slots.baseline} → ${e.slots.max}` : "-"}</b></td>`).join("")}</tr>` : "";
  return `<div style="overflow-x:auto"><table class="spec-table"><thead><tr><th>Product (quantity / month at month 12)</th>${envs.map((e, i) => `<th class="num"><span class="env-dot e${Math.min(i, 5)}"></span>${esc(e.name)}</th>`).join("")}</tr></thead>
    <tbody>${slotRow}${body}</tbody><tfoot><tr><td>Month 12 run-rate (${esc(optShort())})</td>${envs.map((e) => `<td class="num">${money((S.result.bom || []).filter((b) => b.environment === e.id).reduce((a, b) => a + bomCost(b, "month12"), 0))}</td>`).join("")}</tr></tfoot></table></div>`;
}

export function envSizingSection() {
  const envs = S.scenario.environments;
  const factors = S.catalog.environment_factors;
  let html = `<h3 id="envSizing">How each environment is sized</h3>
    <p class="hint">The sources, products and workload you enter describe <b>${esc(envs[0].name)}</b> (100%). Every other environment is priced as a percentage of it per capability - edit any value here; network links and the Looker licence are shared and counted once. <button type="button" class="link-btn" id="envSizeEdit">Add, rename or remove environments</button></p>
    <div style="overflow-x:auto"><table class="sizing-table"><thead><tr><th>Sizing parameter</th>${envs.map((e, i) => `<th class="num"><span class="env-dot e${Math.min(i, 5)}"></span>${esc(e.name)}</th>`).join("")}</tr></thead><tbody>`;
  html += factors.map((f) => `<tr><td><b>${esc(f.name)}</b><small>${esc(f.help || "")}</small></td>${envs.map((e, i) =>
    i === 0 ? `<td class="num muted">100%</td>` : `<td class="num"><input type="number" min="0" max="1000" step="5" data-szi="${i}" data-szk="${f.id}" value="${esc(e[f.id])}" aria-label="${esc(e.name)} ${esc(f.name)}"></td>`).join("")}</tr>`).join("");
  if (isEditions()) {
    html += `<tr><td><b>BigQuery baseline slots</b><small>Always on, the only part a 1- or 3-year commitment covers. Blank = auto-sized (cheapest baseline for the demand; non-production running part-time gets autoscaling only).</small></td>${envs.map((e, i) => `<td class="num">${slotCell(i, "baseline")}</td>`).join("")}</tr>`;
    html += `<tr><td><b>BigQuery max slots</b><small>Baseline + autoscaling, billed pay-as-you-go per slot-hour while queries run. Blank = auto-sized from the busiest hour.</small></td>${envs.map((e, i) => `<td class="num">${slotCell(i, "max")}</td>`).join("")}</tr>`;
  }
  html += `</tbody></table></div>`;
  html += `<h3>Resulting specification per environment</h3><p class="hint">What those parameters provision in each environment: quantity and cost per month at month 12 (run-rate). Click any headline figure for the full price breakdown.</p>${envSpecTable()}`;
  return html;
}

export function onInlineSizing(e) {
  const el = e.target.closest("[data-szi]");
  if (!el) return;
  const i = Number(el.dataset.szi), k = el.dataset.szk;
  S.scenario.environments[i][k] = Math.max(0, Number(el.value) || 0);
  renderEnvs();
  changed();
}
