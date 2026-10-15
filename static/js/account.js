/* Data Cloud Compass - account.js: Google sign-in and saved scenarios (Firestore) -
 * save, save as copy, open, version history, share and shared links (?s=<id>).
 *
 * Sign-in uses Google Identity Services; the ID token is sent as a Bearer token.
 * Deployments with AUTH_DEV_USER (local / tests) are signed in without Google.
 */
import { S } from "./state.js";
import { $, api, clone, esc, toast } from "./core.js";
import { money } from "./cost.js";
import { scheduleEstimate } from "./events.js";
import { renderAll } from "./render.js";
import { save, syncForm, withDefaults } from "./scenario.js";

const TOKEN_KEY = "compass:idtoken";
let pendingOpen = null;                  // ?s=<id> waiting for sign-in

const canCloud = () => !!S.config?.auth;
const decode = (t) => { try { return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch (_) { return {}; } };
const ago = (ts) => {
  const s = Math.max(0, Date.now() / 1000 - ts);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(ts * 1000).toLocaleDateString();
};

// ------------------------------------------------------------------ sign-in
function setToken(t) {
  S.idToken = t;
  try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch (_) { /* private mode */ }
}

function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Could not load Google sign-in"));
    document.head.append(s);
  });
}

async function onSignedIn() {
  try {
    const me = await api.me();
    S.user = me;
  } catch (e) {
    setToken(null);
    S.user = null;
    toast(e.message, 6000);
  }
  renderAccount();
  if (S.user && pendingOpen) { const id = pendingOpen; pendingOpen = null; openCloud(id); }
}

export async function initAccount() {
  renderAccount();
  if (!canCloud()) return;
  const params = new URLSearchParams(location.search);
  if (params.get("s")) pendingOpen = params.get("s");
  if (!S.config.google_client_id) { await onSignedIn(); return; }          // dev sign-in
  try {
    const t = sessionStorage.getItem(TOKEN_KEY);
    if (t && (decode(t).exp || 0) * 1000 > Date.now() + 60_000) { setToken(t); await onSignedIn(); }
  } catch (_) { /* ignore */ }
  try {
    await loadGis();
    window.google.accounts.id.initialize({
      client_id: S.config.google_client_id, auto_select: true, itp_support: true, use_fedcm_for_prompt: true,
      callback: (resp) => { setToken(resp.credential); onSignedIn(); },
    });
    renderAccount();
    if (!S.user) window.google.accounts.id.prompt();
  } catch (e) {
    $("#account").innerHTML = `<span class="hint">${esc(e.message)}</span>`;
  }
}

export function renderAccount() {
  const host = $("#account");
  if (!host) return;
  if (!canCloud()) { host.innerHTML = ""; renderCloudStatus(); return; }
  if (S.user) {
    const pic = S.user.picture ? `<img src="${esc(S.user.picture)}" alt="" referrerpolicy="no-referrer">` : `<span class="avatar">${esc((S.user.name || S.user.email)[0].toUpperCase())}</span>`;
    host.innerHTML = `<button type="button" class="user-chip" id="userChip" title="${esc(S.user.email)} - click to sign out">${pic}<span>${esc(S.user.name || S.user.email)}</span></button>`;
  } else {
    host.innerHTML = `<div id="gsiBtn"></div>`;
    if (window.google?.accounts?.id) window.google.accounts.id.renderButton($("#gsiBtn"), { type: "standard", size: "medium", theme: "outline", text: "signin", shape: "pill" });
  }
  renderCloudStatus();
}

function signOut() {
  setToken(null);
  S.user = null;
  try { window.google?.accounts?.id?.disableAutoSelect(); } catch (_) { /* ignore */ }
  renderAccount();
  toast("Signed out - work stays in this browser");
}

function requireUser() {
  if (!canCloud()) { toast("Cloud saving is not configured on this deployment - use Export → Save scenario (JSON)", 6000); return false; }
  if (!S.user) {
    toast("Sign in with Google to save and share scenarios", 5000);
    try { window.google?.accounts?.id?.prompt(); } catch (_) { /* ignore */ }
    return false;
  }
  return true;
}

// ------------------------------------------------------------------ status
export function renderCloudStatus() {
  const el = $("#saveStatus");
  if (!el) return;
  const c = S.cloud;
  if (!c) { el.textContent = canCloud() ? (S.user ? "Not saved to the cloud yet" : "Sign in to save to the cloud") : "Cloud saving not configured"; return; }
  const ro = S.readOnlyVersion ? ` · viewing v${S.readOnlyVersion}` : "";
  el.innerHTML = `<b>${esc(c.title)}</b> · v${c.version}${ro} · ${S.dirty ? "unsaved changes" : `saved ${ago(c.updated_at)}`}${c.role !== "owner" ? ` · ${c.role === "edit" ? "can edit" : "view only"}` : ""}`;
  $("#scenariosBtn")?.classList.toggle("dirty", !!S.dirty);
}

export function markDirty() {
  S.dirty = true;
  renderCloudStatus();
}

function adopt(doc, { readOnlyVersion = null } = {}) {
  S.cloud = { id: doc.id, version: doc.version, title: doc.title, role: doc.role, updated_at: doc.updated_at, owner: doc.owner,
    shared_with: doc.shared_with || [], editors: doc.editors || [], link_access: doc.link_access || "none" };
  S.readOnlyVersion = readOnlyVersion;
  S.dirty = false;
  persistRef();
  renderCloudStatus();
}

function persistRef() {
  try { localStorage.setItem("compass:cloud", JSON.stringify(S.cloud)); } catch (_) { /* ignore */ }
}

export function restoreCloudRef() {
  try { S.cloud = JSON.parse(localStorage.getItem("compass:cloud") || "null"); } catch (_) { S.cloud = null; }
}

export function forgetCloud() {
  S.cloud = null;
  S.readOnlyVersion = null;
  S.dirty = false;
  persistRef();
  renderCloudStatus();
}

function load(scenario) {
  S.scenario = withDefaults(scenario);
  syncForm();
  save();
  renderAll();
  scheduleEstimate(0);
}

// ------------------------------------------------------------------ actions
export async function cloudSave({ note = "", asCopy = false, title = "" } = {}) {
  if (!requireUser()) return;
  const sc = clone(S.scenario);
  try {
    if (S.cloud && !asCopy && S.cloud.role !== "view") {
      const base = S.readOnlyVersion ? undefined : S.cloud.version;
      const doc = await api.save(S.cloud.id, { scenario: sc, note: note || (S.readOnlyVersion ? `Restored version ${S.readOnlyVersion}` : ""), base_version: base });
      adopt(doc);
      toast(`Saved version ${doc.version}`);
    } else {
      const t = title || (asCopy && S.cloud ? `${S.cloud.title} (copy)` : S.scenario.customer || "Untitled scenario");
      const doc = await api.create({ scenario: sc, title: t, note: note || (asCopy ? "Saved as a copy" : "Created") });
      adopt(doc);
      history.replaceState(null, "", `${location.pathname}?s=${encodeURIComponent(doc.id)}`);
      toast(`Saved "${doc.title}"`);
    }
  } catch (e) {
    if (/409|meanwhile/.test(e.message)) toast(e.message, 8000, { label: "Save a copy", run: () => cloudSave({ asCopy: true }) });
    else toast(`Could not save: ${e.message}`, 6000);
  }
}

export async function openCloud(id, version) {
  if (!requireUser()) { pendingOpen = id; return; }
  try {
    const doc = await api.get(id);
    if (version) {
      const v = await api.version(id, version);
      load(v.scenario);
      adopt(doc, { readOnlyVersion: v.version === doc.version ? null : v.version });
      toast(v.version === doc.version ? `Opened "${doc.title}"` : `Viewing version ${v.version} - Save restores it as a new version`, 6000);
    } else {
      load(doc.scenario);
      adopt(doc);
      toast(`Opened "${doc.title}" (v${doc.version}${doc.role === "view" ? ", view only" : ""})`);
    }
    history.replaceState(null, "", `${location.pathname}?s=${encodeURIComponent(id)}`);
    $("#scDialog").close();
  } catch (e) {
    toast(`Could not open the scenario: ${e.message}`, 6000);
  }
}

// ------------------------------------------------------------------ dialogs
function dialog(title, html) {
  $("#scTitle").textContent = title;
  $("#scBody").innerHTML = html;
  if (!$("#scDialog").open) $("#scDialog").showModal();
}

async function showOpen() {
  if (!requireUser()) return;
  dialog("Saved scenarios", `<p class="hint">Loading…</p>`);
  try {
    const rows = await api.list();
    dialog("Saved scenarios", rows.length ? `<div style="overflow-x:auto"><table class="cmp-table"><thead><tr><th>Scenario</th><th>Region</th><th class="num">Year 1</th><th class="num">3 years</th><th>Version</th><th>Updated</th><th>Access</th><th></th></tr></thead><tbody>${rows.map((d) =>
      `<tr${S.cloud?.id === d.id ? ` class="sel"` : ""}><td><b>${esc(d.title)}</b><br><small class="muted">${esc(d.owner)}</small></td><td>${esc(d.region || "")}</td>
        <td class="num">${d.summary?.year1 != null ? money(d.summary.year1) : "-"}</td><td class="num">${d.summary?.three_year != null ? money(d.summary.three_year) : "-"}</td>
        <td>v${d.version}</td><td>${esc(ago(d.updated_at))}</td><td>${esc(d.role)}${d.link_access !== "none" ? " · link" : ""}</td>
        <td class="row-actions"><button type="button" class="link-btn" data-open="${esc(d.id)}">Open</button>${d.role === "owner" ? `<button type="button" class="link-btn danger" data-del="${esc(d.id)}">Delete</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="empty-note">Nothing saved yet. Use <b>Scenarios → Save</b> to keep this scenario in the cloud, with version history and sharing.</p>`);
  } catch (e) {
    dialog("Saved scenarios", `<p class="bq-warn">${esc(e.message)}</p>`);
  }
}

async function showHistory() {
  if (!requireUser()) return;
  if (!S.cloud) { toast("Save the scenario first - every save creates a version"); return; }
  dialog(`Version history - ${S.cloud.title}`, `<p class="hint">Loading…</p>`);
  try {
    const vs = await api.versions(S.cloud.id);
    dialog(`Version history - ${S.cloud.title}`, `<div style="overflow-x:auto"><table class="cmp-table"><thead><tr><th>Version</th><th>Saved</th><th>By</th><th>Note</th><th class="num">Year 1</th><th class="num">3 years</th><th></th></tr></thead><tbody>${vs.map((v) =>
      `<tr${v.version === (S.readOnlyVersion || S.cloud.version) ? ` class="sel"` : ""}><td>v${v.version}</td><td>${esc(ago(v.saved_at))}</td><td>${esc(v.saved_by)}</td><td>${esc(v.note || "")}</td>
        <td class="num">${v.summary?.year1 != null ? money(v.summary.year1) : "-"}</td><td class="num">${v.summary?.three_year != null ? money(v.summary.three_year) : "-"}</td>
        <td class="row-actions"><button type="button" class="link-btn" data-view="${v.version}">View</button><button type="button" class="link-btn" data-cmpv="${v.version}">Compare with current</button></td></tr>`).join("")}</tbody></table></div>
      <p class="hint">Viewing an old version loads it here; Save then restores it as a new version (nothing is overwritten).</p>`);
  } catch (e) {
    dialog("Version history", `<p class="bq-warn">${esc(e.message)}</p>`);
  }
}

function showShare() {
  if (!requireUser()) return;
  if (!S.cloud) { toast("Save the scenario first, then share it"); return; }
  const c = S.cloud;
  const link = `${location.origin}${location.pathname}?s=${encodeURIComponent(c.id)}`;
  dialog(`Share - ${c.title}`, `<form id="shareForm" class="share-form">
      <label>People who can view (e-mails, comma separated)<textarea id="shViewers" rows="2">${esc((c.shared_with || []).join(", "))}</textarea></label>
      <label>People who can edit<textarea id="shEditors" rows="2">${esc((c.editors || []).join(", "))}</textarea></label>
      <label>Anyone signed in who has the link
        <select id="shLink"><option value="none"${c.link_access === "none" ? " selected" : ""}>No access</option><option value="view"${c.link_access === "view" ? " selected" : ""}>Can view</option><option value="edit"${c.link_access === "edit" ? " selected" : ""}>Can edit</option></select></label>
      <div class="share-link"><input id="shUrl" readonly value="${esc(link)}"><button type="button" class="btn ghost small" id="shCopy">Copy link</button></div>
      <div class="dlg-actions"><span class="spacer"></span><button type="submit" class="btn primary">Save sharing</button></div>
    </form>`);
}

async function submitShare() {
  const split = (s) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  try {
    const doc = await api.share(S.cloud.id, { viewers: split($("#shViewers").value), editors: split($("#shEditors").value), link_access: $("#shLink").value });
    Object.assign(S.cloud, { shared_with: doc.shared_with, editors: doc.editors, link_access: doc.link_access });
    persistRef();
    toast("Sharing updated");
    $("#scDialog").close();
  } catch (e) {
    toast(`Could not share: ${e.message}`, 6000);
  }
}

function showSaveAs() {
  if (!requireUser()) return;
  dialog("Save as a copy", `<form id="saveAsForm" class="share-form">
      <label>Title<input id="saTitle" maxlength="120" value="${esc((S.cloud ? `${S.cloud.title} (option B)` : S.scenario.customer) || "Untitled scenario")}"></label>
      <label>Note<input id="saNote" maxlength="500" placeholder="e.g. On-demand BigQuery, no DR"></label>
      <div class="dlg-actions"><span class="spacer"></span><button type="submit" class="btn primary">Save copy</button></div></form>`);
}

export function bindAccount(openCompare) {
  $("#scenariosMenu").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sc]");
    if (!b) return;
    $("#scenariosMenu").hidden = true;
    const a = b.dataset.sc;
    if (a === "save") cloudSave();
    else if (a === "saveas") showSaveAs();
    else if (a === "open") showOpen();
    else if (a === "history") showHistory();
    else if (a === "share") showShare();
    else if (a === "compare") openCompare();
  });
  $("#scDialog").addEventListener("click", async (e) => {
    if (e.target.closest("[data-close]")) return $("#scDialog").close();
    const o = e.target.closest("[data-open]");
    if (o) return openCloud(o.dataset.open);
    const d = e.target.closest("[data-del]");
    if (d) {
      if (!confirm("Delete this scenario and all its versions for everyone it is shared with?")) return;
      try { await api.remove(d.dataset.del); if (S.cloud?.id === d.dataset.del) forgetCloud(); toast("Deleted"); showOpen(); } catch (err) { toast(err.message, 6000); }
      return;
    }
    const v = e.target.closest("[data-view]");
    if (v) return openCloud(S.cloud.id, Number(v.dataset.view));
    const c = e.target.closest("[data-cmpv]");
    if (c) { $("#scDialog").close(); openCompare({ a: "current", b: `version:${c.dataset.cmpv}` }); return; }
    if (e.target.id === "shCopy") navigator.clipboard?.writeText($("#shUrl").value).then(() => toast("Link copied"));
  });
  $("#scDialog").addEventListener("submit", (e) => {
    e.preventDefault();
    if (e.target.id === "shareForm") submitShare();
    if (e.target.id === "saveAsForm") { cloudSave({ asCopy: true, title: $("#saTitle").value.trim(), note: $("#saNote").value.trim() }); $("#scDialog").close(); }
  });
  $("#account").addEventListener("click", (e) => { if (e.target.closest("#userChip") && confirm("Sign out?")) signOut(); });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); cloudSave(); }
  });
  window.addEventListener("beforeunload", (e) => { if (S.cloud && S.dirty) { e.preventDefault(); e.returnValue = ""; } });
}

// used by compare.js
export async function fetchCloudScenario(id, version) {
  return version ? (await api.version(id, version)).scenario : (await api.get(id)).scenario;
}
export { canCloud };
