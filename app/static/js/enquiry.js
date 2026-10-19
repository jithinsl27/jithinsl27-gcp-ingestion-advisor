/* Data Cloud Compass - enquiry.js: Customer technical enquiry - natural-language questions answered only from
 * Google's public documentation, with the reference links (POST /api/enquiry). */
import { S } from "./state.js";
import { $, api, esc, toast } from "./core.js";
import { compMeta } from "./pricing.js";
import { tool } from "./render.js";
import { renderHead } from "./modules.js";

const KEY = "data-cloud-compass:enquiry";
const st = { items: [], busy: false };
try { st.items = JSON.parse(localStorage.getItem(KEY) || "[]").slice(-20); } catch (_) { st.items = []; }
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(st.items.slice(-20))); } catch (_) { /* ignore */ } };

/** Light formatting: paragraphs, bullet lists and **bold** - everything else escaped. */
export function formatAnswer(text) {
  const lines = String(text || "").split(/\r?\n/);
  let html = "", list = false;
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  lines.forEach((ln) => {
    const m = ln.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (m) { if (!list) { html += "<ul>"; list = true; } html += `<li>${inline(m[1])}</li>`; return; }
    if (list) { html += "</ul>"; list = false; }
    if (ln.trim()) html += `<p>${inline(ln.replace(/^#+\s*/, ""))}</p>`;
  });
  if (list) html += "</ul>";
  return html;
}

function suggestions() {
  const out = [];
  const names = new Set();
  (S.result?.recommendations || []).forEach((r) => r.chain.forEach((t) => names.add(tool(t).name)));
  const comps = (S.scenario?.components || []).map((c) => compMeta(c.type)?.name).filter(Boolean);
  const src = (S.scenario?.sources || [])[0];
  if (names.has("Datastream") && src) out.push(`Does Datastream support change data capture from ${src.name.replace(/\s*\(.*\)/, "")}, and what are its limits?`);
  out.push(`How do BigQuery capacity commitments and autoscaling slots work?`);
  if (S.scenario?.region) out.push(`Which BigQuery and Vertex AI features are available in the ${S.scenario.region} region?`);
  if (comps.some((n) => /Gemini Enterprise/.test(n))) out.push("How does Gemini Enterprise connect to BigQuery data, and how is access controlled?");
  if (comps.some((n) => /Apigee/.test(n))) out.push("What is the difference between Apigee environments types and how are API calls billed?");
  if (comps.some((n) => /VPC Service Controls/.test(n))) out.push("Which BigQuery features work inside a VPC Service Controls perimeter?");
  out.push("What is the BigQuery SLA and how is availability measured?");
  return out.slice(0, 6);
}

export function renderEnquiry() {
  const host = $("#enquiryBody");
  if (!host) return;
  const conv = st.items.map((it, i) => `<article class="eq-item">
      <p class="eq-q"><span>Question</span>${esc(it.question)}</p>
      <div class="eq-a${it.grounded ? "" : " none"}">${formatAnswer(it.answer)}</div>
      ${it.references?.length ? `<div class="eq-refs"><span>Google documentation</span><ol>${it.references.map((r) => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a> <small>${esc(r.host)}</small></li>`).join("")}</ol></div>` : ""}
      <footer><small>${it.grounded ? `Answered from ${it.references.length} Google documentation page${it.references.length === 1 ? "" : "s"}` : "No Google documentation found"}${it.model ? ` · ${esc(it.model)}` : ""}</small>
        <button type="button" class="link-btn" data-eq-copy="${i}">Copy</button></footer>
    </article>`).reverse().join("");
  host.innerHTML = `
    <form class="eq-form" id="eqForm" autocomplete="off">
      <label for="eqQ">Ask a technical question about Google Cloud</label>
      <div class="eq-row"><textarea id="eqQ" rows="2" maxlength="1000" placeholder="e.g. Can BigQuery reservations be shared across projects, and how are idle slots used?" ${st.busy ? "disabled" : ""}></textarea>
        <button class="btn primary" type="submit" ${st.busy ? "disabled" : ""}>${st.busy ? "Searching the documentation…" : "Ask"}</button></div>
      <p class="hint">Answers come only from Google's public documentation (cloud.google.com and related Google sites), in plain language, with the links they are based on. If the documentation does not cover it, you are told so. Check the linked pages before quoting limits or prices to a customer.</p>
      <div class="eq-sugg">${suggestions().map((q) => `<button type="button" class="chip" data-eq-ask="${esc(q)}">${esc(q)}</button>`).join("")}</div>
    </form>
    ${st.items.length ? `<div class="eq-head"><h3>Answers</h3><button type="button" class="link-btn" data-eq-clear>Clear</button></div>` : ""}
    <div class="eq-list">${conv}</div>`;
}

async function ask(q) {
  q = (q || "").trim();
  if (q.length < 3 || st.busy) return;
  st.busy = true;
  renderEnquiry();
  try {
    const history = st.items.slice(-3).map((x) => ({ q: x.question, a: x.answer }));
    const r = await api.enquiry({ question: q, history });
    st.items.push(r);
    persist();
  } catch (e) {
    toast(e.message || "Could not get an answer", 7000);
  } finally {
    st.busy = false;
    renderEnquiry();
    renderHead();
  }
}

export function enquiryCount() { return st.items.length; }

export function bindEnquiry() {
  const host = $("#enquiryBody");
  if (!host) return;
  host.addEventListener("submit", (e) => { if (e.target.id === "eqForm") { e.preventDefault(); ask($("#eqQ").value); } });
  host.addEventListener("keydown", (e) => {
    if (e.target.id === "eqQ" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(e.target.value); }
  });
  host.addEventListener("click", (e) => {
    const s = e.target.closest("[data-eq-ask]");
    if (s) { ask(s.dataset.eqAsk); return; }
    if (e.target.closest("[data-eq-clear]")) { st.items = []; persist(); renderEnquiry(); return; }
    const c = e.target.closest("[data-eq-copy]");
    if (c) {
      const it = st.items[Number(c.dataset.eqCopy)];
      const text = `${it.question}\n\n${it.answer}\n\nReferences:\n${(it.references || []).map((r) => `- ${r.title}: ${r.url}`).join("\n")}`;
      navigator.clipboard?.writeText(text).then(() => toast("Answer copied"), () => toast("Select the text and copy it"));
    }
  });
}
