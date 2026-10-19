/* Data Cloud Compass - tips.js: hover / focus explanations for headers and figures.
 *
 * Mark any element with data-tip="text" (or use tip(text) to add a small "i" next to a heading).
 * The bubble is a single fixed-position element, so it is never clipped by scrolling tables,
 * and it opens on mouse hover and on keyboard focus. */

let bubble = null;
let anchor = null;

const ensure = () => {
  if (bubble) return bubble;
  bubble = document.createElement("div");
  bubble.className = "tipbox";
  bubble.setAttribute("role", "tooltip");
  bubble.id = "tipbox";
  bubble.hidden = true;
  document.body.appendChild(bubble);
  return bubble;
};

/** A small "i" button that explains the heading it follows. */
export function tip(text) {
  if (!text) return "";
  const t = String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<span class="tip" tabindex="0" role="button" aria-label="How this is calculated: ${t}" data-tip="${t}">i</span>`;
}

function show(el) {
  const b = ensure();
  anchor = el;
  b.textContent = el.dataset.tip;
  b.hidden = false;
  el.setAttribute("aria-describedby", "tipbox");
  const r = el.getBoundingClientRect();
  const w = b.offsetWidth, h = b.offsetHeight, gap = 8;
  let left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
  let top = r.top - h - gap;
  if (top < 8) top = r.bottom + gap;              // no room above: open below
  b.style.left = `${left}px`;
  b.style.top = `${top}px`;
}

function hide() {
  if (!bubble || bubble.hidden) return;
  bubble.hidden = true;
  anchor?.removeAttribute("aria-describedby");
  anchor = null;
}

export function initTips() {
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (el) { if (el !== anchor) show(el); } else if (anchor && !anchor.contains(document.activeElement)) hide();
  });
  document.addEventListener("focusin", (e) => { const el = e.target.closest?.("[data-tip]"); if (el) show(el); });
  document.addEventListener("focusout", hide);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  window.addEventListener("scroll", hide, true);
}
