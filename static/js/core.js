/* Data Cloud Compass - core.js (ES module, no build step). */
import { S } from "./state.js";

// API base: "" when served by the Cloud Run app, the service URL in the static demo (window.COMPASS_API_BASE).
export const API_BASE = (window.COMPASS_API_BASE || "").replace(/\/$/, "");

// Signed-in requests carry the Google ID token (set by account.js); dev deployments use AUTH_DEV_USER.
export function authHeaders() {
  return S.idToken ? { Authorization: `Bearer ${S.idToken}` } : {};
}

export function call(method, path, body, opts = {}) {
  const init = { method, headers: { ...authHeaders(), ...(opts.headers || {}) } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(API_BASE + path, init).then(okJson);
}

export const post = (url) => (body) => call("POST", url, body);

export const api = window.ADVISOR_API || {
  catalog: () => call("GET", "/api/catalog"),
  samples: () => call("GET", "/api/samples"),
  config: () => call("GET", "/api/config"),
  estimate: post("/api/estimate"),
  workload: post("/api/workload"),
  plan: post("/api/plan"),
  compare: post("/api/compare"),
  me: () => call("GET", "/api/me"),
  list: () => call("GET", "/api/scenarios"),
  create: (b) => call("POST", "/api/scenarios", b),
  get: (id) => call("GET", `/api/scenarios/${encodeURIComponent(id)}`),
  save: (id, b) => call("PUT", `/api/scenarios/${encodeURIComponent(id)}`, b),
  remove: (id) => call("DELETE", `/api/scenarios/${encodeURIComponent(id)}`),
  versions: (id) => call("GET", `/api/scenarios/${encodeURIComponent(id)}/versions`),
  version: (id, v) => call("GET", `/api/scenarios/${encodeURIComponent(id)}/versions/${v}`),
  share: (id, b) => call("POST", `/api/scenarios/${encodeURIComponent(id)}/share`, b),
  assistNotes: (text) => call("POST", "/api/assist/notes", { text }),
  assistFile: (file) => { const f = new FormData(); f.append("file", file); return call("POST", "/api/assist/file", f); },
  templateUrl: () => API_BASE + "/api/assist/template.csv",
  pricingStatus: () => call("GET", "/api/pricing/status"),
};

export async function okJson(r) {
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const j = await r.json(); msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch (_) { /* keep status */ }
    throw new Error(msg);
  }
  return r.json();
}

export const STORE_KEY = "ingestion-advisor:scenario:v2";

export const STREAMING = new Set(["realtime", "near_realtime"]);

export const $ = (s, el = document) => el.querySelector(s);

export const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const clone = (o) => JSON.parse(JSON.stringify(o));

// ------------------------------------------------------------------ toast

export function toast(msg, ms = 2400, action) {
  const t = $("#toast");
  t.innerHTML = "";
  t.append(document.createTextNode(msg));
  if (action) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "toast-action"; b.textContent = action.label;
    b.addEventListener("click", () => { t.hidden = true; action.run(); });
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => (t.hidden = true), ms);
}
