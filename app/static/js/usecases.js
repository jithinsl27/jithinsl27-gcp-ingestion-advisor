/* Data Cloud Compass - usecases.js: top 5 recommended use cases from the customer's data, plus their own. */
import { S } from "./state.js";
import { $, esc, toast } from "./core.js";
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
  let html = `<p class="lede">What the customer wants to achieve drives the design. Below are the <b>top 5 use cases recommended from the data sources in scope</b> - add the ones the customer cares about, and type in their own.</p>`;
  html += `<h3>Recommended from the customer's data</h3>`;
  if (!rec.length) html += `<p class="empty-note">Add source systems to get recommendations.</p>`;
  else html += `<div class="uc-grid">${rec.map((u, i) => `<article class="uc-card${picked.has(u.id) ? " on" : ""}"><header><span class="uc-rank">${i + 1}</span><h4>${esc(u.name)}</h4></header>
      <p>${esc(u.value)}</p>${u.why ? `<p class="uc-why"><b>Why:</b> ${esc(u.why)}</p>` : ""}
      <p class="uc-prod">${u.products.map((p) => `<i>${esc(p)}</i>`).join("")}</p>
      <button type="button" class="btn ${picked.has(u.id) ? "ghost" : "primary"} small" data-uc-toggle="${esc(u.id)}">${picked.has(u.id) ? "Remove from the customer's list" : "Add to the customer's list"}</button></article>`).join("")}</div>`;
  html += `<h3>The customer's use cases <small class="muted">${mine.length}</small></h3>
    <form class="uc-add" id="ucAdd"><input id="ucName" maxlength="200" placeholder="e.g. Daily branch performance dashboard for regional managers" aria-label="Use case"><button class="btn primary small" type="submit">Add use case</button></form>`;
  if (mine.length) html += `<ol class="uc-list">${mine.map((u, i) => `<li><div><b>${esc(u.name)}</b> <span class="tag">${u.source === "recommended" ? "recommended" : "customer"}</span>
      <textarea data-uc-notes="${esc(u.id)}" rows="1" maxlength="1000" placeholder="Notes: owner, KPI, data needed, priority">${esc(u.notes || "")}</textarea></div>
      <span class="uc-actions"><button type="button" class="link-btn" data-uc-up="${i}" ${i ? "" : "disabled"} aria-label="Move up">↑</button><button type="button" class="link-btn" data-uc-del="${esc(u.id)}">Remove</button></span></li>`).join("")}</ol>`;
  else html += `<p class="hint">No use cases yet - add from the recommendations or type the customer's own. They appear in the proposal and the exports.</p>`;
  host.innerHTML = html;
}

function persist() { markDirty(); save(); renderUseCases(); renderHead(); }

export function bindUseCases() {
  const host = $("#useCasesBody");
  host.addEventListener("click", (e) => {
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
