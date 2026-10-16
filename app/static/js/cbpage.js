/* Data Cloud Compass - cbpage.js: charge-back on negotiated prices.
 *
 * 1. Price book: download the template, enter negotiated prices, upload it back (Excel, CSV, Google Sheets link,
 *    PDF or a scanned image - PDFs and images are read with Gemini). Review, then save (shared by everyone).
 * 2. Request: a department's sources, pipelines, reports and AI use cases -> services, quantity and monthly cost.
 * 3. Ledger: saved requests by department.
 */
import { S } from "./state.js";
import { $, $$, api, esc, toast } from "./core.js";
import { fmtQty, money, unitPrice } from "./cost.js";
import { download, slug } from "./exports.js";
import { regionName, regionOptions } from "./main.js";

const KINDS = [["database_cdc", "Databases - change data capture"], ["database_batch", "Databases - daily batch"], ["files", "Files"],
  ["saas", "SaaS applications"], ["streaming", "Event streams"], ["documents", "Documents (for AI)"]];
const cb = { book: null, review: null, known: [], result: null, ledger: [], busy: false, timer: null,
  req: { department: "", title: "", requester: "", kind: "analytics", region: "", sources: [{ kind: "database_cdc", count: 1, daily_gb: 10, history_gb: 500 }],
    pipelines: { simple: 5, medium: 2, complex: 0, runs_per_day: 1 }, reports: { dashboards: 5, users: 25, bi_tool: "looker_studio_pro", adhoc_reports: 0 },
    ai: { use_cases: 0, requests_per_month: 5000, model: "flash" }, with_dev: false, include_shared: false, bq_mode: "ondemand" } };

const region = () => cb.req.region || cb.book?.region || S.scenario.region || "us-central1";
const ago = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : "");

export async function loadChargeback() {
  try {
    [cb.book, cb.ledger] = await Promise.all([api.cbPricebook(), api.cbRequests()]);
  } catch (e) { toast(`Charge-back: ${e.message}`, 6000); }
  if (!cb.req.region) cb.req.region = cb.book?.region && cb.book.items?.length ? cb.book.region : S.scenario.region;
  renderChargeback();
  priceNow();
}

export function renderChargeback() {
  const host = $("#cbBody");
  if (!host) return;
  if (!cb.book) { host.innerHTML = `<p class="hint">Loading…</p>`; return; }
  const n = (cb.book.items || []).filter((i) => i.price != null && i.price !== "").length;
  let html = `<p class="lede">Once the customer has bought Google Cloud with its discounts, the data office can charge each department for what it asks for. Load the negotiated prices once, then price any request: data sources, pipelines, reports and AI use cases.</p>`;
  // ---------------- 1. price book
  html += `<section class="cb-sec"><h3><span class="step">1</span>Negotiated price book</h3>
    <p class="${n ? "ok-note" : "hint"}">${n ? `<b>${n} negotiated prices</b> in use · ${esc(regionName(cb.book.region))} · updated ${esc(ago(cb.book.updated_at))}${cb.book.updated_by ? ` by ${esc(cb.book.updated_by)}` : ""}${cb.book.note ? ` · ${esc(cb.book.note)}` : ""}` : "No price book yet - requests are priced at Google list prices."}</p>
    <div class="cb-actions">
      <label>Price region <select data-cb-region>${regionOptions()}</select></label>
      <button type="button" class="btn ghost small" data-cb-template>Download template (Excel)</button>
      <a class="btn ghost small" href="${esc(api.cbTemplateCsvUrl(region()))}" download>Template (CSV)</a>
      <label class="btn primary small file-btn">Upload price sheet<input type="file" data-cb-file accept=".xlsx,.xlsm,.csv,.tsv,.txt,.pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff,.gif" hidden></label>
    </div>
    <form class="cb-link" data-cb-linkform><input type="url" data-cb-link placeholder="…or paste a Google Sheets link (shared as 'Anyone with the link can view')" aria-label="Google Sheets link"><button class="btn ghost small" type="submit">Read sheet</button></form>
    <p class="hint">Accepted: Excel, CSV, a Google Sheets link, PDF quotes or scanned / photographed price sheets (read with Gemini 3.8 Flash - always review before saving).</p>
    ${cb.busy ? `<p class="hint">Reading the price sheet…</p>` : ""}
    ${cb.review ? reviewTable() : ""}</section>`;
  // ---------------- 2. request
  const r = cb.req;
  const num = (path, label, step = 1) => `<label>${esc(label)}<input type="number" min="0" step="${step}" data-cb="${path}" value="${esc(get(path))}"></label>`;
  html += `<section class="cb-sec"><h3><span class="step">2</span>Price a department's request</h3><form class="cb-form" onsubmit="return false">
    <div class="grid4"><label>Department<input data-cb="department" value="${esc(r.department)}" placeholder="e.g. Marketing" maxlength="120"></label>
      <label>Request<input data-cb="title" value="${esc(r.title)}" placeholder="e.g. Campaign performance dashboard" maxlength="160"></label>
      <label>Requested by<input data-cb="requester" value="${esc(r.requester)}" maxlength="120"></label>
      <label>Type<select data-cb="kind">${[["analytics", "Analytics report"], ["ai", "AI use case"], ["data_product", "Data product"], ["mixed", "Mixed"]].map(([k, v]) => `<option value="${k}"${r.kind === k ? " selected" : ""}>${v}</option>`).join("")}</select></label></div>
    <fieldset><legend>Data sources to ingest</legend><table class="cb-src"><thead><tr><th>Kind</th><th>How many</th><th>New data per day (GB, all)</th><th>History (GB, all)</th><th></th></tr></thead><tbody>
      ${r.sources.map((s, i) => `<tr><td><select data-cb="sources.${i}.kind">${KINDS.map(([k, v]) => `<option value="${k}"${s.kind === k ? " selected" : ""}>${v}</option>`).join("")}</select></td>
        <td><input type="number" min="0" step="1" data-cb="sources.${i}.count" value="${s.count}"></td><td><input type="number" min="0" step="any" data-cb="sources.${i}.daily_gb" value="${s.daily_gb}"></td>
        <td><input type="number" min="0" step="any" data-cb="sources.${i}.history_gb" value="${s.history_gb}"></td><td><button type="button" class="link-btn" data-cb-delsrc="${i}">Remove</button></td></tr>`).join("")}
      </tbody></table><button type="button" class="link-btn" data-cb-addsrc>+ Add a kind of source</button></fieldset>
    <div class="grid3"><fieldset><legend>Pipelines</legend><div class="grid2">${num("pipelines.simple", "Simple")}${num("pipelines.medium", "Medium")}${num("pipelines.complex", "Complex")}${num("pipelines.runs_per_day", "Runs per day")}</div></fieldset>
      <fieldset><legend>Reports</legend><div class="grid2">${num("reports.dashboards", "Dashboards")}${num("reports.users", "Report users")}${num("reports.adhoc_reports", "Ad-hoc reports / week")}
        <label>BI tool<select data-cb="reports.bi_tool">${[["looker_studio_pro", "Looker Studio Pro"], ["looker", "Looker"], ["existing", "Existing tool (no licence)"]].map(([k, v]) => `<option value="${k}"${r.reports.bi_tool === k ? " selected" : ""}>${v}</option>`).join("")}</select></label></div></fieldset>
      <fieldset><legend>AI use cases</legend><div class="grid2">${num("ai.use_cases", "AI use cases")}${num("ai.requests_per_month", "Questions / month each", 500)}
        <label>Model<select data-cb="ai.model">${[["flash", "Gemini 3.8 Flash"], ["flash_lite", "Gemini 3.5 Flash-Lite"], ["pro", "Gemini 3.1 Pro (preview)"]].map(([k, v]) => `<option value="${k}"${r.ai.model === k ? " selected" : ""}>${v}</option>`).join("")}</select></label></div></fieldset></div>
    <div class="cb-opts"><label class="toggle"><input type="checkbox" data-cb="with_dev" ${r.with_dev ? "checked" : ""}> Include a development environment</label>
      <label class="toggle"><input type="checkbox" data-cb="include_shared" ${r.include_shared ? "checked" : ""}> Include shared platform items (network, encryption keys)</label>
      <label>BigQuery<select data-cb="bq_mode"><option value="ondemand"${r.bq_mode === "ondemand" ? " selected" : ""}>On-demand (per TiB)</option><option value="editions"${r.bq_mode === "editions" ? " selected" : ""}>Shared slot reservation</option></select></label></div>
  </form>${resultBlock()}</section>`;
  // ---------------- 3. ledger
  const byDept = {};
  cb.ledger.forEach((x) => { byDept[x.department || "-"] = (byDept[x.department || "-"] || 0) + (x.totals?.monthly || 0); });
  html += `<section class="cb-sec"><h3><span class="step">3</span>Charge-back ledger <small class="muted">${cb.ledger.length} request${cb.ledger.length === 1 ? "" : "s"}</small></h3>`;
  if (!cb.ledger.length) html += `<p class="hint">Saved requests appear here, with the monthly charge per department.</p>`;
  else {
    html += `<div class="cb-depts">${Object.entries(byDept).sort((a, b) => b[1] - a[1]).map(([d, v]) => `<div><span>${esc(d)}</span><b>${money(v)}</b><small>per month</small></div>`).join("")}</div>
      <div style="overflow-x:auto"><table class="bom-table"><thead><tr><th>Saved</th><th>Department</th><th>Request</th><th>By</th><th class="num">Per month</th><th class="num">Year 1</th><th></th></tr></thead><tbody>
      ${cb.ledger.map((x) => `<tr><td>${esc(ago(x.created_at))}</td><td>${esc(x.department)}</td><td>${esc(x.title)}</td><td>${esc(x.created_by || "")}</td><td class="num">${money(x.totals.monthly)}</td><td class="num">${money(x.totals.year1)}</td>
        <td><button type="button" class="link-btn" data-cb-load="${esc(x.id)}">Open</button> <button type="button" class="link-btn" data-cb-del="${esc(x.id)}">Delete</button></td></tr>`).join("")}</tbody></table></div>
      <button type="button" class="btn ghost small" data-cb-ledgercsv>Download ledger (CSV)</button>`;
  }
  html += `</section>`;
  host.innerHTML = html;
  const rs = $("[data-cb-region]", host);
  if (rs) rs.value = region();
}

function reviewTable() {
  const rows = cb.review.items;
  const names = [...new Set(cb.known.map((k) => k.service))];
  const found = rows.filter((x) => x.price != null).length;
  return `<div class="cb-review"><h4>Review the prices read from ${esc(cb.review.file || "the sheet")} <small class="muted">${found} prices found · read by ${esc({ gemini: "Gemini", spreadsheet: "the spreadsheet reader", google_sheet: "Google Sheets" }[cb.review.method] || cb.review.method)}</small></h4>
    <div style="overflow-x:auto"><table class="bom-table"><thead><tr><th>In the sheet</th><th>Service in the tool</th><th>Unit</th><th class="num">List price</th><th class="num">Negotiated price</th><th>Match</th></tr></thead><tbody>
    ${rows.map((x, i) => `<tr class="${x.match === "none" ? "warn-row" : ""}"><td>${esc(x.source_name || "-")}</td>
      <td><select data-rv="${i}" data-rv-f="service"><option value="">- ignore -</option>${names.map((n) => `<option${n === x.service ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></td>
      <td>${esc(x.unit || "")}</td><td class="num">${x.list_price != null ? unitPrice(x.list_price) : "-"}</td>
      <td class="num"><input type="number" min="0" step="any" data-rv="${i}" data-rv-f="price" value="${x.price ?? ""}" placeholder="list price"></td>
      <td>${esc({ exact: "exact", closest: "closest name", none: "no match", "not in sheet": "not in sheet" }[x.match] || x.match)}</td></tr>`).join("")}</tbody></table></div>
    <div class="cb-actions"><button type="button" class="btn primary small" data-cb-savebook>Save price book</button><button type="button" class="btn ghost small" data-cb-cancelreview>Cancel</button>
      <span class="hint">Saved prices are shared with everyone who opens Charge-back.</span></div></div>`;
}

function resultBlock() {
  const x = cb.result;
  if (!x) return `<p class="hint">Calculating…</p>`;
  const t = x.totals;
  return `<div class="cb-result"><div class="cb-kpis"><div><span>Monthly charge</span><b>${money(t.monthly)}</b><small>${x.price_book_used ? `${money(t.saving_monthly)} below list price` : "at list prices"}</small></div>
      <div><span>First year</span><b>${money(t.year1)}</b><small>data grows over the year</small></div>
      <div><span>Region</span><b>${esc(regionName(x.region))}</b><small>${x.lines.length} services</small></div></div>
    <div style="overflow-x:auto"><table class="bom-table"><thead><tr><th>Service</th><th>Environment</th><th class="num">Qty / month</th><th>Unit</th><th class="num">Unit price</th><th class="num">Per month</th></tr></thead><tbody>
    ${x.lines.filter((l) => Math.abs(l.monthly) >= 0.005).map((l) => `<tr><td><b>${esc(l.service)}</b></td><td>${esc(l.environment)}</td><td class="num">${l.unit ? fmtQty(l.qty_month) : "-"}</td><td class="bom-unit">${esc(l.unit || "-")}</td>
      <td class="num">${l.unit_price != null ? unitPrice(l.unit_price) : "-"}${l.negotiated && l.list_unit_price ? ` <s class="muted">${unitPrice(l.list_unit_price)}</s>` : ""}</td><td class="num">${money(l.monthly)}</td></tr>`).join("")}</tbody>
    <tfoot><tr><td colspan="5">Total per month</td><td class="num">${money(t.monthly)}</td></tr></tfoot></table></div>
    <ul class="cb-assume">${x.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
    <div class="cb-actions"><button type="button" class="btn primary small" data-cb-save>Save to the ledger</button><button type="button" class="btn ghost small" data-cb-csv>Download (CSV)</button></div></div>`;
}

function get(path) { return path.split(".").reduce((o, k) => (o == null ? o : o[k]), cb.req); }
function set(path, v) { const ks = path.split("."); let o = cb.req; ks.slice(0, -1).forEach((k) => (o = o[k])); o[ks[ks.length - 1]] = v; }

async function priceNow() {
  const my = (cb.seq = (cb.seq || 0) + 1);
  try {
    const res = await api.cbPrice({ ...cb.req, region: region() });
    if (my !== cb.seq) return;
    cb.result = res;
    const blk = $("#cbBody .cb-result") || $("#cbBody .cb-form + p.hint");
    if (blk) blk.outerHTML = resultBlock(); else renderChargeback();
  } catch (e) { toast(`Charge-back: ${e.message}`, 6000); }
}
const schedule = () => { clearTimeout(cb.timer); cb.timer = setTimeout(priceNow, 350); };

async function readFile(f) {
  cb.busy = true; renderChargeback();
  try {
    cb.known = (await api.cbTemplate(region())).rows;
    cb.review = await api.cbExtract(f, region());
  } catch (e) { toast(e.message, 8000); }
  cb.busy = false; renderChargeback();
}

function csv(rows) { return rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n"); }

export function bindChargeback() {
  const host = $("#cbBody");
  host.addEventListener("input", (e) => {
    const el = e.target.closest("[data-cb]");
    if (el) {
      const v = el.type === "checkbox" ? el.checked : el.type === "number" ? Math.max(0, Number(el.value) || 0) : el.value;
      set(el.dataset.cb, v);
      if (el.type === "checkbox" || el.tagName === "SELECT" || el.type === "number") schedule();
      return;
    }
    const rv = e.target.closest("[data-rv]");
    if (rv) {
      const it = cb.review.items[+rv.dataset.rv];
      if (rv.dataset.rvF === "price") it.price = rv.value === "" ? null : Number(rv.value);
      else { it.service = rv.value || null; const k = cb.known.find((x) => x.service === rv.value); if (k) { it.unit = k.unit; it.list_price = k.list_price; } }
    }
  });
  host.addEventListener("change", (e) => {
    if (e.target.matches("[data-cb-region]")) { cb.req.region = e.target.value; renderChargeback(); schedule(); return; }
    if (e.target.matches("[data-cb-file]") && e.target.files[0]) readFile(e.target.files[0]);
    if (e.target.matches("[data-cb='department'],[data-cb='title'],[data-cb='requester']")) schedule();
  });
  host.addEventListener("submit", async (e) => {
    if (!e.target.matches("[data-cb-linkform]")) return;
    e.preventDefault();
    const url = $("[data-cb-link]", host).value.trim();
    if (!url) return;
    cb.busy = true; renderChargeback();
    try { cb.known = (await api.cbTemplate(region())).rows; cb.review = await api.cbExtractLink(url, region()); } catch (err) { toast(err.message, 8000); }
    cb.busy = false; renderChargeback();
  });
  host.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("[data-cb-template]")) {
      try {
        const rows = (await api.cbTemplate(region())).rows;
        const ST = window.CompassExports.STYLE;
        const H = (l) => l.map((v) => ({ v, s: ST.head }));
        const sheet = [[{ v: `Data Cloud Compass - price sheet template (${regionName(region())})`, s: ST.title }],
          [{ v: "Enter your negotiated unit price in the last column (leave blank to keep the list price), then upload this file in Charge-back.", s: ST.sub }], [],
          H(["Service", "Group", "Unit", "List price (USD per unit)", "Negotiated price (USD per unit)"]),
          ...rows.map((r) => [r.service, r.group, r.unit, { v: r.list_price, s: ST.price }, ""])];
        download(`price-sheet-template-${region()}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          await window.CompassExports.xlsx([{ name: "Price sheet", rows: sheet, widths: [42, 24, 16, 22, 26], merges: ["A1:E1", "A2:E2"], freeze: 4 }]));
      } catch (err) { toast(`Template: ${err.message}`, 6000); }
      return;
    }
    if (t.closest("[data-cb-cancelreview]")) { cb.review = null; renderChargeback(); return; }
    if (t.closest("[data-cb-savebook]")) {
      const items = cb.review.items.filter((x) => x.service).map((x) => ({ service: x.service, unit: x.unit, list_price: x.list_price, price: x.price }));
      try {
        cb.book = await api.cbSavePricebook({ region: region(), currency: "USD", items, note: `From ${String(cb.review.file || "").slice(0, 120)}` });
        cb.review = null; toast("Price book saved"); renderChargeback(); priceNow();
      } catch (err) { toast(err.message, 6000); }
      return;
    }
    if (t.closest("[data-cb-addsrc]")) { cb.req.sources.push({ kind: "files", count: 1, daily_gb: 5, history_gb: 100 }); renderChargeback(); schedule(); return; }
    const ds = t.closest("[data-cb-delsrc]");
    if (ds) { cb.req.sources.splice(+ds.dataset.cbDelsrc, 1); renderChargeback(); schedule(); return; }
    if (t.closest("[data-cb-save]")) {
      if (!cb.req.department.trim()) { toast("Enter the department first"); $("[data-cb='department']", host)?.focus(); return; }
      try { await api.cbSave({ ...cb.req, region: region() }); cb.ledger = await api.cbRequests(); toast("Saved to the ledger"); renderChargeback(); } catch (err) { toast(err.message, 6000); }
      return;
    }
    if (t.closest("[data-cb-csv]") && cb.result) {
      const rows = [["Department", cb.req.department], ["Request", cb.req.title], ["Region", region()], [],
        ["Service", "Environment", "Qty / month", "Unit", "Unit price (USD)", "List unit price", "Per month (USD)"],
        ...cb.result.lines.map((l) => [l.service, l.environment, l.qty_month ?? "", l.unit || "", l.unit_price ?? "", l.list_unit_price ?? "", l.monthly]),
        [], ["Total per month", "", "", "", "", "", cb.result.totals.monthly]];
      download(`${slug()}-chargeback-${(cb.req.department || "request").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`, "text/csv", csv(rows));
      return;
    }
    if (t.closest("[data-cb-ledgercsv]")) {
      download("chargeback-ledger.csv", "text/csv", csv([["Saved", "Department", "Request", "By", "Per month (USD)", "Year 1 (USD)"],
        ...cb.ledger.map((x) => [ago(x.created_at), x.department, x.title, x.created_by, x.totals.monthly, x.totals.year1])]));
      return;
    }
    const ld = t.closest("[data-cb-load]");
    if (ld) { const x = cb.ledger.find((y) => y.id === ld.dataset.cbLoad); if (x) { cb.req = JSON.parse(JSON.stringify({ ...cb.req, ...x.request })); renderChargeback(); priceNow(); window.scrollTo({ top: 0 }); } return; }
    const dl = t.closest("[data-cb-del]");
    if (dl && confirm("Delete this request from the ledger?")) { await api.cbDelete(dl.dataset.cbDel); cb.ledger = await api.cbRequests(); renderChargeback(); }
  });
}
