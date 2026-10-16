/* Data Cloud Compass - usagepage.js: who is using the tool (admin key required on Cloud Run). */
import { $, api, esc, toast } from "./core.js";

const KEY = "data-cloud-compass:admin-key";
const st = { data: null, days: 30, err: "" };
const when = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : "-");
const getKey = () => { try { return sessionStorage.getItem(KEY) || ""; } catch (_) { return ""; } };

export async function loadUsage() {
  st.err = "";
  try { st.data = await api.adminUsage(getKey(), st.days); } catch (e) { st.data = null; st.err = e.message; }
  renderUsage();
}

export function renderUsage() {
  const host = $("#usageBody");
  if (!host) return;
  if (!st.data) {
    host.innerHTML = `<p class="lede">See who is using Data Cloud Compass: names and emails people entered on their first visit, when they were last active and what they did.</p>
      <form class="usage-key" data-usage-form><label>Admin key<input type="password" data-usage-key value="${esc(getKey())}" autocomplete="off" placeholder="Printed by deploy.sh"></label>
      <button class="btn primary small" type="submit">Show usage</button></form>
      ${st.err ? `<p class="bq-warn">${esc(st.err)}</p>` : ""}
      <p class="hint">The key is the ADMIN_KEY setting of the Cloud Run service (deploy.sh prints it). Every API call is also logged in Cloud Logging - filter <code>jsonPayload.kind="compass_request"</code>.</p>`;
    return;
  }
  const d = st.data;
  const max = Math.max(1, ...d.by_day.map((x) => x.events));
  host.innerHTML = `<div class="usage-top"><div class="slot-totals"><div><span>People</span><b>${d.user_count}</b><small>last ${st.days} days</small></div>
      <div><span>Actions logged</span><b>${d.event_count.toLocaleString()}</b><small>visits, modules, exports, charge-back</small></div>
      <div><span>Most active</span><b>${esc(d.users[0]?.name || d.users[0]?.email || "-")}</b><small>${d.users[0] ? `${d.users[0].events} actions` : ""}</small></div></div>
      <div class="seg small">${[7, 30, 90].map((n) => `<button type="button" data-usage-days="${n}" aria-selected="${st.days === n}">${n} days</button>`).join("")}</div>
      <button type="button" class="btn ghost small" data-usage-csv>Download (CSV)</button></div>
    <div class="usage-days">${d.by_day.map((x) => `<i style="height:${Math.max(3, (60 * x.events) / max)}px" title="${esc(x.day)}: ${x.events}"></i>`).join("")}</div>
    <h3>People</h3><div style="overflow-x:auto"><table class="bom-table"><thead><tr><th>Name</th><th>Email</th><th>First seen</th><th>Last active</th><th class="num">Active days</th><th class="num">Actions</th><th>Top actions</th></tr></thead><tbody>
    ${d.users.map((u) => `<tr><td><b>${esc(u.name || "-")}</b></td><td>${esc(u.email || "-")}</td><td>${esc(when(u.first))}</td><td>${esc(when(u.last))}</td><td class="num">${u.active_days}</td><td class="num">${u.events}</td>
      <td><small>${u.top_actions.map((a) => `${esc(a.action)} (${a.count})`).join(" · ")}</small></td></tr>`).join("")}</tbody></table></div>
    <h3>Recent activity</h3><div style="overflow-x:auto"><table class="bom-table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th><th class="num">ms</th></tr></thead><tbody>
    ${d.recent.slice(0, 100).map((e) => `<tr><td>${esc(when(e.ts))}</td><td>${esc(e.name || e.email || "anonymous")}</td><td>${esc(e.action)}</td><td><small>${esc(e.detail || "")}</small></td><td class="num">${e.ms || ""}</td></tr>`).join("")}</tbody></table></div>`;
}

export function bindUsage() {
  const host = $("#usageBody");
  host.addEventListener("submit", (e) => {
    if (!e.target.matches("[data-usage-form]")) return;
    e.preventDefault();
    try { sessionStorage.setItem(KEY, $("[data-usage-key]", host).value.trim()); } catch (_) { /* ignore */ }
    loadUsage();
  });
  host.addEventListener("click", (e) => {
    const b = e.target.closest("[data-usage-days]");
    if (b) { st.days = +b.dataset.usageDays; loadUsage(); return; }
    if (e.target.closest("[data-usage-csv]") && st.data) {
      const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const lines = [["When", "Name", "Email", "Action", "Detail", "Path", "Status", "ms"].map(q).join(",")]
        .concat(st.data.recent.map((x) => [when(x.ts), x.name, x.email, x.action, x.detail, x.path, x.status, x.ms].map(q).join(",")));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
      a.download = "compass-usage.csv";
      a.click();
      toast("Usage downloaded");
    }
  });
}
