/* Data Cloud Compass - beta.js: "this is a beta" notice with the feedback address.
 * Shown once per browser session - after the welcome screen, after Google sign-in, or on a returning visit -
 * and again from the Feedback button (marked Beta). */
import { $ } from "./core.js";

export const FEEDBACK_EMAIL = "jithinsl@google.com";
const SEEN = "data-cloud-compass:beta-seen";

export function showBeta(force = false) {
  const d = $("#betaDialog");
  if (!d || d.open) return;
  let seen = false;
  try { seen = sessionStorage.getItem(SEEN) === "1"; } catch (_) { /* private mode */ }
  if (seen && !force) return;
  if ($("#idDialog")?.open) return;              // the welcome screen comes first; it shows this when it closes
  try { sessionStorage.setItem(SEEN, "1"); } catch (_) { /* ignore */ }
  d.showModal();
}

export function bindBeta() { /* the Feedback button opens the notice - bound in modules.js */ }
