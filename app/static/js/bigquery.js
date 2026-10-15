/* Data Cloud Compass - bigquery.js: BigQuery compute (on-demand or editions), slots per environment,
 * edition comparison, scan basis and calibration from INFORMATION_SCHEMA.
 *
 * Slots are auto-sized by the engine (app/slots.py): a baseline (always on, commitment-eligible) and a
 * max (baseline + autoscaling, pay-as-you-go). Every value can be overridden per environment; blank = auto.
 */
import { S } from "./state.js";
import { $, esc, toast } from "./core.js";
import { money } from "./cost.js";
import { changed } from "./events.js";
import { OPT, bomCost, optShort } from "./pricing.js";

export const EDITION_NAME = { standard: "Standard", enterprise: "Enterprise", enterprise_plus: "Enterprise Plus" };
const SLOT_STEP = 50;

export const bq = () => (S.scenario.bq ||= { mode: "ondemand", edition: "auto" });
export const isEditions = () => bq().mode === "editions";
const R = () => S.result?.bigquery || null;
const envSlots = (i) => {
  const e = S.scenario.environments[i];
  return S.result?.environments?.find((x) => x.id === e?.id)?.slots || null;
};
const editionShown = () => (bq().edition === "auto" ? R()?.recommended_edition : bq().edition) || "enterprise";

/** Migrate legacy bq_model / bq_slots (flat slots) into `bq`. */
export function migrateBq(sc) {
  if (!sc.bq) {
    const ed = ["standard", "enterprise", "enterprise_plus"].includes(sc.bq_model) ? sc.bq_model : null;
    sc.bq = { mode: ed ? "editions" : "ondemand", edition: ed || "auto" };
    if (ed && sc.bq_slots != null && sc.bq_slots !== "") sc.bq.baseline_slots = sc.bq.max_slots = Number(sc.bq_slots);
  }
  delete sc.bq_model;
  delete sc.bq_slots;
  sc.bq = { mode: "ondemand", edition: "auto", ...sc.bq };
  return sc;
}

// ------------------------------------------------------------------ slot inputs (shared with the consumption tab)
function slotValue(i, kind) {
  if (i === 0) return kind === "baseline" ? bq().baseline_slots : bq().max_slots;
  const e = S.scenario.environments[i];
  return kind === "baseline" ? e.bq_baseline : e.bq_max;
}

export function slotCell(i, kind) {
  const sl = envSlots(i);
  const auto = sl ? (kind === "baseline" ? sl.auto_baseline : sl.auto_max) : "";
  const v = slotValue(i, kind);
  const std = editionShown() === "standard" && kind === "baseline";
  const name = S.scenario.environments[i]?.name || "";
  return `<input type="number" min="0" step="${SLOT_STEP}" data-slot-i="${i}" data-slot-k="${kind}" value="${v ?? ""}" placeholder="${auto === "" ? "auto" : auto}"
    ${std ? "disabled title=\"Standard edition has no baseline\"" : ""} aria-label="${esc(name)} ${kind} slots" class="${v != null && v !== "" ? "set" : ""}">`;
}

export function setSlot(i, kind, raw) {
  const v = raw === "" || raw == null ? null : Math.max(0, Math.round(Number(raw)));
  if (i === 0) bq()[kind === "baseline" ? "baseline_slots" : "max_slots"] = v;
  else S.scenario.environments[i][kind === "baseline" ? "bq_baseline" : "bq_max"] = v;
}

function resetSlots() {
  delete bq().baseline_slots;
  delete bq().max_slots;
  S.scenario.environments.forEach((e) => { e.bq_baseline = null; e.bq_max = null; });
}

// ------------------------------------------------------------------ sidebar panel
export function renderBqPanel() {
  const host = $("#bqPanel");
  if (!host || !S.scenario) return;
  if (host.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
  const r = R();
  const b = bq();
  const ed = isEditions();
  const active = r?.active;
  const rec = r ? (r.recommended_mode === "ondemand"
    ? `On-demand is cheaper at ~${(r.scan_tib_month || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} TiB scanned / month.`
    : `${EDITION_NAME[r.recommended_edition]} edition is cheaper: baseline ${r.auto_baseline} → max ${r.auto_max} slots.`) : "";
  let html = `<div class="bq-head"><b>BigQuery compute</b><button type="button" class="link-btn" data-bq-open>Sizing &amp; calibration ›</button></div>
    <div class="seg" role="radiogroup" aria-label="BigQuery pricing model">
      <button type="button" role="radio" aria-checked="${!ed}" class="${!ed ? "on" : ""}" data-bq-mode="ondemand">On-demand (per TiB)</button>
      <button type="button" role="radio" aria-checked="${ed}" class="${ed ? "on" : ""}" data-bq-mode="editions">Editions (slots)</button>
    </div>`;
  if (rec && active) html += `<p class="bq-rec ${((r.recommended_mode === "ondemand") === !ed) ? "ok" : "warn"}">${esc(rec)}</p>`;
  if (ed) {
    const recName = r ? EDITION_NAME[r.recommended_edition] : "";
    html += `<label class="bq-ed">Edition<select id="bqEdition">
      <option value="auto"${b.edition === "auto" ? " selected" : ""}>Recommend for me${recName ? ` (${recName})` : ""}</option>
      ${Object.entries(EDITION_NAME).map(([k, n]) => `<option value="${k}"${b.edition === k ? " selected" : ""}>${n}</option>`).join("")}
    </select></label>`;
    const rows = S.scenario.environments.map((e, i) => {
      const bom = S.result?.bom?.find((x) => x.environment === e.id && x.service === "BigQuery compute");
      return `<tr><td><span class="env-dot e${Math.min(i, 5)}"></span>${esc(e.name)}</td><td>${slotCell(i, "baseline")}</td><td>${slotCell(i, "max")}</td>
        <td class="num">${bom ? money(bomCost(bom, "year1") / 12) : "-"}</td></tr>`;
    }).join("");
    html += `<table class="es-table"><thead><tr><th>Environment</th><th>Baseline</th><th>Max</th><th title="Year-1 average, ${esc(optShort())}">Per month</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="hint">Slots are sized automatically from the data and workload (grey numbers). Type a value to override it; clear it to go back to auto. Commitments (${esc(optShort(OPT() === "payg" ? "cud1" : OPT()))}) apply to the baseline only - autoscaling is always pay-as-you-go.
      <button type="button" class="link-btn" data-bq-reset>Reset all to auto</button></p>`;
  } else if (r && active) {
    const best = (r.comparison || []).find((c) => c.edition === r.recommended_edition);
    html += `<p class="hint">~${(r.scan_tib_month || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} TiB scanned / month at month ${r.reference_month} (${esc(basisName(r.scan_basis))}).${best ? ` On ${esc(best.name)} edition (recommended for this architecture) this would be ~${money(best.cud1)} / month with a 1-year commitment (baseline ${best.baseline} → max ${best.max}).` : ""}</p>`;
  }
  (r?.warnings || []).forEach((w) => { html += `<p class="bq-warn">${esc(w)}</p>`; });
  host.innerHTML = html;
}

const basisName = (id) => ({ heuristic: "rule of thumb", workload: "Workload sizing tab", measured: "measured from INFORMATION_SCHEMA" }[id] || id);

// ------------------------------------------------------------------ dialog: sizing, comparison, calibration
export function openBqDialog() {
  renderBqDialog();
  if (!$("#bqDialog").open) $("#bqDialog").showModal();
}

const CAL_SQL = `-- Run in the customer's project (BigQuery console). Use their region, e.g. \`region-me-central2\`.
SELECT
  ROUND(SUM(total_bytes_processed) / POW(1024, 4), 2) AS tib_scanned_30d,
  ROUND(SUM(total_slot_ms) / 1000 / 3600, 0)          AS slot_hours_30d
FROM \`region-us\`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
  AND job_type = 'QUERY' AND statement_type != 'SCRIPT';`;

export function renderBqDialog() {
  const host = $("#bqBody");
  const r = R();
  if (!host) return;
  if (!r || !r.active) { host.innerHTML = `<p class="empty-note">Add a source system so BigQuery has data to size.</p>`; return; }
  const b = bq();
  const sh = r.shape || {};
  const num = (k, v, step, label, help, min = 0) => `<label>${esc(label)}<input type="number" step="${step}" min="${min}" data-bq-k="${k}" value="${v ?? ""}">${help ? `<small>${esc(help)}</small>` : ""}</label>`;
  const comp = (r.comparison || []).map((c) => {
    const cur = (c.edition === "ondemand" && !isEditions()) || (isEditions() && c.edition === r.edition);
    return `<tr class="${cur ? "sel" : ""}"><td><b>${esc(c.name)}</b>${c.fits ? "" : ` <span class="tag warn">over the 1,600-slot limit</span>`}${c.edition === r.recommended_edition && c.edition !== "ondemand" ? ` <span class="tag">recommended edition</span>` : ""}</td>
      <td class="num">${c.baseline == null ? "-" : `${c.baseline} → ${c.max}`}</td><td class="num">${money(c.payg)}</td><td class="num">${money(c.cud1)}</td><td class="num">${money(c.cud3)}</td>
      <td>${cur ? "In use" : `<button type="button" class="link-btn" data-bq-use="${c.edition}">Use</button>`}</td></tr>`;
  }).join("");
  const bases = r.bases.map((x) => `<label class="basis${x.tib_month == null ? " off" : ""}"><input type="radio" name="bqBasis" value="${x.id}" ${r.scan_basis === x.id ? "checked" : ""} ${x.tib_month == null ? "disabled" : ""}>
      <span><b>${esc(x.name)}</b> ${x.tib_month == null ? "<i>no data yet</i>" : `${x.tib_month.toLocaleString(undefined, { maximumFractionDigits: 1 })} TiB / month · ${money(x.ondemand_month)} on-demand`}<small>${esc(x.detail)}</small></span></label>`).join("");
  host.innerHTML = `
    <div class="wl-kpis slot-kpis">
      <div><span>Average demand</span><b>${r.avg_slots.toLocaleString()} slots</b><span>${r.slot_hours_month.toLocaleString()} slot-hours / month</span></div>
      <div><span>Busiest hour</span><b>${Math.round(r.peak_slots).toLocaleString()} slots</b><span>${r.heavy_burst_slots > r.peak_slots ? `heavy query burst ${Math.round(r.heavy_burst_slots)}` : "dashboards & interactive"}</span></div>
      <div><span>Auto-sized reservation</span><b>${r.auto_baseline} → ${r.auto_max}</b><span>baseline → max (production)</span></div>
      <div><span>In the estimate</span><b>${isEditions() ? `${esc(EDITION_NAME[r.edition])}` : "On-demand"}</b><span>${isEditions() ? `${r.baseline} → ${r.max} slots` : `${r.scan_tib_month.toLocaleString(undefined, { maximumFractionDigits: 1 })} TiB / month`}</span></div>
    </div>
    <div class="slot-grid"><div><div class="chart-wrap">${profileSvg(r)}</div><p class="hint">Average slot demand by hour (month ${r.reference_month}); dashed = baseline, dotted = max. Pipelines run in a ${sh.batch_window_hours}-hour overnight window; dashboards and queries over ${sh.business_hours} business hours with a ×${sh.peak_concurrency} busiest hour.</p></div>
    <div><p class="sub">Why this edition</p><ul class="slot-recs reasons">${r.edition_reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      ${(r.warnings || []).map((w) => `<p class="bq-warn">${esc(w)}</p>`).join("")}</div></div>

    <h3>Pricing model and edition - per month at month ${r.reference_month} (production)</h3>
    <div style="overflow-x:auto"><table class="cmp-table"><thead><tr><th>Option</th><th class="num">Baseline → max</th><th class="num">Pay-as-you-go</th><th class="num">1-yr commitment</th><th class="num">3-yr commitment</th><th></th></tr></thead><tbody>${comp}</tbody></table></div>
    <p class="hint">Editions: baseline slots billed every hour (commitments discount only these) plus autoscaled slot-hours at the pay-as-you-go rate with a ×${r.autoscale_overhead} allowance for 50-slot steps and the 1-minute minimum. Standard edition has no baseline or commitments and stops at 1,600 slots.</p>

    <h3>What the scan volume is based on</h3>
    <div class="bases">${bases}</div>

    <h3>Sizing assumptions</h3>
    <div class="grid4">
      ${num("elt_scan_multiplier", r.elt_scan_multiplier, 0.5, "ELT scan × data ingested", "Each month's transformations read this multiple of the data ingested")}
      ${num("analytics_scan_multiplier", r.analytics_scan_multiplier, 0.5, "Analytics scan × data stored", "Dashboards and analysis read this multiple of the stored data per month")}
      ${num("slot_hours_per_tib", b.slot_hours_per_tib ?? r.slot_hours_per_tib, 5, "Slot-hours per TiB scanned", r.calibrated && b.measured_slot_hours_month ? "Calibrated from the measured values below" : "60 is typical for mixed BI/ELT; measure it below", 1)}
      ${num("shape.batch_window_hours", sh.batch_window_hours, 1, "Batch window (hours)", "", 1)}
      ${num("shape.business_hours", sh.business_hours, 1, "Business hours / day", "", 1)}
      ${num("shape.peak_concurrency", sh.peak_concurrency, 0.1, "Busiest hour vs average (×)", "", 1)}
    </div>

    <h3>Calibrate from the customer's BigQuery usage</h3>
    <p class="hint">If the customer already runs BigQuery (or can run a pilot), measure the last 30 days and enter the results - the estimate then uses the measured scan volume (grown by the data growth rate) and the measured slot-hours per TiB.</p>
    <pre class="sql" id="calSql">${esc(CAL_SQL)}</pre>
    <div class="grid4">
      ${num("measured_scan_tib_month", b.measured_scan_tib_month, 1, "Measured TiB scanned / month", "")}
      ${num("measured_slot_hours_month", b.measured_slot_hours_month, 100, "Measured slot-hours / month", "")}
      <div class="cal-actions"><button type="button" class="btn ghost small" data-bq-copysql>Copy SQL</button>${r.calibrated ? `<button type="button" class="btn ghost small" data-bq-clearcal>Clear measured values</button>` : ""}</div>
    </div>`;
}

function profileSvg(r) {
  const W = 560, H = 190, L = 44, Rr = 8, T = 10, B = 24;
  const prof = r.profile || [];
  const base = isEditions() ? r.baseline : r.auto_baseline, max = isEditions() ? r.max : r.auto_max;
  const top = Math.max(...prof, base || 0, max || 0, 1) * 1.1;
  const bw = (W - L - Rr) / 24;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  let g = "";
  for (let k = 0; k <= 3; k++) { const v = (top / 3) * k; g += `<line class="chart-grid" x1="${L}" x2="${W - Rr}" y1="${y(v)}" y2="${y(v)}"/><text class="chart-axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`; }
  prof.forEach((v, h) => {
    g += `<rect class="slot-bar" x="${L + h * bw + 2}" y="${y(v)}" width="${bw - 4}" height="${Math.max(0, y(0) - y(v))}"><title>${String(h).padStart(2, "0")}:00 - ${v} slots</title></rect>`;
    if (h % 3 === 0) g += `<text class="chart-axis" x="${L + h * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${String(h).padStart(2, "0")}h</text>`;
  });
  if (base) g += `<line class="chart-marker" x1="${L}" x2="${W - Rr}" y1="${y(base)}" y2="${y(base)}"/>`;
  if (max) g += `<line class="chart-marker max" x1="${L}" x2="${W - Rr}" y1="${y(max)}" y2="${y(max)}"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Slot demand by hour of day">${g}</svg>`;
}

// ------------------------------------------------------------------ events
function setPath(path, raw) {
  const b = bq();
  const v = raw === "" ? null : Number(raw);
  if (path.startsWith("shape.")) {
    b.shape = { ...(b.shape || {}) };
    const k = path.slice(6);
    if (v == null) delete b.shape[k]; else b.shape[k] = v;
  } else if (v == null) delete b[path];
  else b[path] = v;
}

function rerender() {
  renderBqPanel();
  if ($("#bqDialog")?.open) renderBqDialog();
}

export function bindBq() {
  document.addEventListener("click", (e) => {
    const m = e.target.closest("[data-bq-mode]");
    if (m) {
      bq().mode = m.dataset.bqMode;
      changed();
      rerender();
      if (m.dataset.bqMode === "editions") toast("Editions: slots are sized automatically per environment - edit any baseline or max in the BigQuery panel", 5000);
      return;
    }
    if (e.target.closest("[data-bq-open]")) return openBqDialog();
    if (e.target.closest("[data-bq-reset]")) { resetSlots(); changed(); rerender(); toast("Slots back to auto-sized"); return; }
    const u = e.target.closest("[data-bq-use]");
    if (u) {
      const ed = u.dataset.bqUse;
      if (ed === "ondemand") bq().mode = "ondemand";
      else { bq().mode = "editions"; bq().edition = ed; }
      changed();
      rerender();
      return;
    }
    if (e.target.closest("[data-bq-copysql]")) {
      navigator.clipboard?.writeText(CAL_SQL).then(() => toast("SQL copied"), () => toast("Select the SQL and copy it"));
      return;
    }
    if (e.target.closest("[data-bq-clearcal]")) {
      delete bq().measured_scan_tib_month;
      delete bq().measured_slot_hours_month;
      if (bq().scan_basis === "measured") bq().scan_basis = "auto";
      changed();
      rerender();
    }
  });
  document.addEventListener("change", (e) => {
    const s = e.target.closest("[data-slot-i]");
    if (s) { setSlot(Number(s.dataset.slotI), s.dataset.slotK, s.value); changed(); return; }
    if (e.target.id === "bqEdition") { bq().edition = e.target.value; changed(); return; }
    const k = e.target.closest("[data-bq-k]");
    if (k) { setPath(k.dataset.bqK, k.value); changed(); return; }
    if (e.target.name === "bqBasis") { bq().scan_basis = e.target.value; changed(); }
  });
  $("#bqDialog").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) $("#bqDialog").close(); });
}
