/* Data Cloud Compass - identity.js: name & email on the first visit (self-reported, no sign-in) for usage logs. */
import { S } from "./state.js";
import { $, IDENTITY_KEY, api, esc, identity } from "./core.js";
import { showBeta } from "./beta.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function renderIdentityChip() {
  const id = S.identity || identity();
  const el = $("#whoBtn");
  if (!el) return;
  el.hidden = !id;
  if (id) {
    const ini = id.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || id.email[0].toUpperCase();
    el.textContent = ini;
    el.title = `${id.name} <${id.email}> - click to change`;
    el.setAttribute("aria-label", `Signed in as ${id.name} - change`);
  }
}

function open(force) {
  const d = $("#idDialog");
  const id = S.identity || identity() || {};
  $("#id_name").value = id.name || "";
  $("#id_email").value = id.email || "";
  $("#id_org").value = id.org || "";
  $("#id_err").textContent = "";
  $("#id_cancel").hidden = !force;
  if (!d.open) d.showModal();
  setTimeout(() => $("#id_name").focus(), 30);
}

export function initIdentity() {
  S.identity = identity();
  renderIdentityChip();
  const enabled = S.config?.identity_prompt !== false && !window.ADVISOR_NO_IDENTITY;
  $("#idForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#id_name").value.trim(), email = $("#id_email").value.trim().toLowerCase(), org = $("#id_org").value.trim();
    if (name.length < 2) { $("#id_err").textContent = "Please enter your name."; return; }
    if (!EMAIL.test(email)) { $("#id_err").textContent = "Please enter a valid email address."; return; }
    const first = !S.identity;
    S.identity = { name, email, org };
    try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(S.identity)); } catch (_) { /* private mode: keep for this visit */ }
    $("#idDialog").close();
    renderIdentityChip();
    api.usageEvent(first ? "first visit" : "identity changed", org);
    if (first) showBeta(true);
  });
  // the dialog cannot be dismissed with Escape on the first visit
  $("#idDialog").addEventListener("cancel", (e) => { if (!S.identity) e.preventDefault(); });
  $("#id_cancel").addEventListener("click", () => $("#idDialog").close());
  $("#whoBtn")?.addEventListener("click", () => open(true));
  if (enabled && !S.identity) open(false);
  else { if (S.identity) api.usageEvent("visit", location.pathname); showBeta(); }
}

export function track(action, detail) { api.usageEvent(action, detail); }
export const identityLabel = () => (S.identity ? `${esc(S.identity.name)} (${esc(S.identity.email)})` : "");
