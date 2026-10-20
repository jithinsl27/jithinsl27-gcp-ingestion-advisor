/* Data Cloud Compass - usecases.js: top 5 recommended use cases from the customer's data, plus their own. */
import { S } from "./state.js";
import { $, api, esc, toast } from "./core.js";
import { markDirty } from "./account.js";
import { save } from "./scenario.js";
import { renderHead } from "./modules.js";

const list = () => (S.scenario.use_cases ||= []);
const uid = () => "u" + Math.random().toString(36).slice(2, 9);

export function renderUseCases() {
  const host = $("#useCasesBody");
  if (!host) return;
  const rec = S.result?.use_cases || [];
  const mine = list();
  const picked = new Set(mine.map((u) => u.id));
  const nSrc = (S.scenario.sources || []).filter((x) => x.included !== false).length;
  let html = `<div class="explain uc-intro">
    <p><b>Why use cases matter:</b> they say what the customer wants to achieve with the data. They shape the architecture, appear in the proposal and the exports, and help the customer see the value before the cost.</p>
    <div class="uc-routes">
      <div><b><span class="uc-step">A</span>The customer has use cases in mind</b><p>Type them in below during the meeting - one line each, with the owner, KPI or data needed in the notes.</p></div>
      <div><b><span class="uc-step">B</span>The customer has none yet</b><p>Add the data sources first. From each source's <b>type and system</b> (for example SAP → finance and supply chain, CRM → customer 360, IoT → predictive maintenance), the tool <b>recommends the top 5 use cases</b>. Add the ones the customer likes to their list.</p></div>
    </div></div>`;
  html += `<h3><span class="uc-step">A</span>The customer's use cases <small class="muted">${mine.length}</small></h3>
    <form class="uc-add" id="ucAdd"><input id="ucName" maxlength="200" placeholder="e.g. Daily branch performance dashboard for regional managers" aria-label="Use case"><button class="btn primary small" type="submit">Add use case</button></form>`;
  if (mine.length) html += `<ol class="uc-list">${mine.map((u, i) => `<li><div><b>${esc(u.name)}</b> <span class="tag">${u.source === "recommended" ? "recommended" : "customer"}</span>
      <textarea data-uc-notes="${esc(u.id)}" rows="1" maxlength="1000" placeholder="Notes: owner, KPI, data needed, priority">${esc(u.notes || "")}</textarea></div>
      <span class="uc-actions"><button type="button" class="link-btn" data-uc-mine="${esc(u.id)}">Details ›</button><button type="button" class="link-btn" data-uc-up="${i}" ${i ? "" : "disabled"} aria-label="Move up">↑</button><button type="button" class="link-btn" data-uc-del="${esc(u.id)}">Remove</button></span></li>`).join("")}</ol>`;
  else html += `<p class="hint">No use cases yet. Type the customer's own above, or add recommended ones from route B below.</p>`;
  html += `<h3><span class="uc-step">B</span>Recommended from the customer's data sources</h3>`;
  if (!rec.length) html += `<div class="empty-note uc-empty"><p>${nSrc ? "No recommendations for these sources yet - add more source systems or products." : "No data sources yet. Add the customer's source systems and the recommended use cases appear here automatically."}</p>
      <button type="button" class="btn small" data-uc-sources>Go to Sources ›</button></div>`;
  else html += `<p class="hint">Based on the ${nSrc} source system${nSrc === 1 ? "" : "s"} in scope - the <b>Why</b> line shows which sources led to each one.</p>
    <div class="uc-grid">${rec.map((u, i) => `<article class="uc-card${picked.has(u.id) ? " on" : ""}"><header><span class="uc-rank">${i + 1}</span><h4>${esc(u.name)}</h4></header>
      <p>${esc(u.value)}</p>${u.why ? `<p class="uc-why"><b>Why:</b> ${esc(u.why)}</p>` : ""}
      <p class="uc-prod">${u.products.map((p) => `<i>${esc(p)}</i>`).join("")}</p>
      <div class="uc-card-actions"><button type="button" class="btn ghost small" data-uc-detail="${esc(u.id)}">Details, benefits &amp; data ›</button>
      <button type="button" class="btn ${picked.has(u.id) ? "ghost" : "primary"} small" data-uc-toggle="${esc(u.id)}">${picked.has(u.id) ? "Remove from the customer's list" : "Add to the customer's list"}</button></div></article>`).join("")}</div>`;
  host.innerHTML = html;
}

function persist() { markDirty(); save(); renderUseCases(); renderHead(); }

export function bindUseCases() {
  const host = $("#useCasesBody");
  host.addEventListener("click", (e) => {
    const dt = e.target.closest("[data-uc-detail]");
    if (dt) { const r = S.result.use_cases.find((u) => u.id === dt.dataset.ucDetail); openDetails({ id: r.id, name: r.name }); return; }
    const mn = e.target.closest("[data-uc-mine]");
    if (mn) { const u = list().find((x) => x.id === mn.dataset.ucMine); if (u) openDetails({ id: u.source === "recommended" ? u.id : null, name: u.name, notes: u.notes || "" }); return; }
    if (e.target.closest("[data-uc-sources]")) { document.querySelector('.modnav [data-tab="sources"]')?.click(); return; }
    const t = e.target.closest("[data-uc-toggle]");
    if (t) {
      const id = t.dataset.ucToggle;
      const i = list().findIndex((u) => u.id === id);
      if (i >= 0) list().splice(i, 1);
      else { const r = S.result.use_cases.find((u) => u.id === id); list().push({ id, name: r.name, source: "recommended", notes: r.value }); }
      persist();
      return;
    }
    const d = e.target.closest("[data-uc-del]");
    if (d) { S.scenario.use_cases = list().filter((u) => u.id !== d.dataset.ucDel); persist(); return; }
    const up = e.target.closest("[data-uc-up]");
    if (up) { const i = +up.dataset.ucUp; const l = list(); [l[i - 1], l[i]] = [l[i], l[i - 1]]; persist(); }
  });
  host.addEventListener("submit", (e) => {
    if (e.target.id !== "ucAdd") return;
    e.preventDefault();
    const name = $("#ucName").value.trim();
    if (!name) return;
    list().push({ id: uid(), name, source: "customer", notes: "" });
    persist();
    toast("Use case added");
    setTimeout(() => $("#ucName")?.focus(), 0);
  });
  host.addEventListener("change", (e) => {
    const n = e.target.closest("[data-uc-notes]");
    if (n) { const u = list().find((x) => x.id === n.dataset.ucNotes); if (u) { u.notes = n.value; markDirty(); save(); } }
  });
}


// ------------------------------------------------------------------ details dialog
const detailCache = new Map();

function detailHtml(d) {
  const src = (x) => x.sources.length ? x.sources.map((n) => `<span class="uc-src ok">${esc(n)}</span>`).join("")
    : x.possible?.length ? `<span class="uc-src maybe-note">Possibly in:</span>${x.possible.map((n) => `<span class="uc-src maybe">${esc(n)}</span>`).join("")}`
    : `<span class="uc-src gap">Not in scope yet - ask the customer</span>`;
  const cov = d.coverage || { covered: 0, total: 0 };
  return `<p class="uc-summary">${esc(d.summary)}</p>
    <div class="uc-cols"><section><h3>Business benefits</h3><ul>${d.benefits.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></section>
      <section><h3>How success is measured</h3><ul class="uc-kpis">${d.kpis.map((k) => `<li>${esc(k)}</li>`).join("")}</ul></section></div>
    <h3>Data needed <small class="muted">${cov.covered} of ${cov.total} covered by the sources in scope</small></h3>
    <div class="tbl-scroll"><table class="bom-table uc-data"><thead><tr><th>Data</th><th>Specific data points</th><th>From the customer's sources</th></tr></thead><tbody>
      ${d.data.map((x) => `<tr class="${x.covered ? "" : x.partial ? "part" : "gap"}"><td><b>${esc(x.data)}</b></td><td>${x.points.map((p) => `<span class="uc-pt">${esc(p)}</span>`).join("")}</td><td>${src(x)}</td></tr>`).join("")}
    </tbody></table></div>
    <h3>How it is built on Google Cloud</h3><ol class="uc-build">${d.build.map((b) => `<li>${esc(b)}</li>`).join("")}</ol>
    ${d.products?.length ? `<p class="uc-prod">${d.products.map((p) => `<i>${esc(p)}</i>`).join("")}</p>` : ""}
    <p class="hint">${d.method === "gemini" ? `Generated by Gemini${d.model ? ` (${esc(d.model)})` : ""} for this customer's use case - review before sharing.` : "Curated description, matched to the source systems in this scenario. Sources are matched by type and name - confirm with the customer."}</p>`;
}

export async function openDetails({ id, name, notes = "" }) {
  const dlg = $("#ucDialog");
  $("#ucTitle").textContent = name;
  $("#ucKicker").textContent = id ? "Recommended use case" : "The customer's use case";
  const body = $("#ucDetailBody");
  if (!dlg.open) dlg.showModal();
  const key = JSON.stringify([id, name, notes, (S.scenario.sources || []).map((x) => [x.name, x.type, x.included])]);
  if (detailCache.has(key)) { body.innerHTML = detailHtml(detailCache.get(key)); return; }
  body.innerHTML = `<p class="hint">${id ? "Loading…" : "Gemini is describing this use case…"}</p>`;
  try {
    const d = await api.ucDetails({ id, name, notes, scenario: { customer: S.scenario.customer, sources: S.scenario.sources } });
    detailCache.set(key, d);
    if ($("#ucTitle").textContent === name) body.innerHTML = detailHtml(d);
  } catch (e) {
    body.innerHTML = `<div class="notice info"><b>Details are not available for this use case right now.</b> ${esc(e.message)}</div>
      ${notes ? `<h3>Notes</h3><p>${esc(notes)}</p>` : ""}
      <p class="hint">Details for the customer's own use cases are written by Gemini, which needs Google Cloud credentials on the deployment. The ${S.result?.use_cases?.length || 5} recommended use cases always have curated details.</p>`;
  }
}

export function bindUseCaseDialog() {
  const dlg = $("#ucDialog");
  dlg?.addEventListener("click", (e) => { if (e.target.closest("[data-uc-close]") || e.target === dlg) dlg.close(); });
}
