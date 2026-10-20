/* Data Cloud Compass - envfinal.js: "environments finalised" sign-off.
 *
 * The architect ticks it on the Environments page once production, development, test… are agreed.
 * It stores a fingerprint of the environments, so any later change to them clears the sign-off
 * automatically. Product monitor shows its figures as Draft until then, and as Final after. */
import { S } from "./state.js";

function fingerprint() {
  const t = JSON.stringify((S.scenario?.environments || []).map((e) => ({ ...e, name: undefined })));
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return `${(S.scenario?.environments || []).length}:${h}`;
}

export const envFinal = () => !!S.scenario?.env_final && S.scenario.env_final.key === fingerprint();
export const envFinalInfo = () => (envFinal() ? S.scenario.env_final : null);

export function setEnvFinal(on) {
  if (on) S.scenario.env_final = { key: fingerprint(), at: Date.now(), by: S.user?.name || S.identity?.name || "" };
  else delete S.scenario.env_final;
}

/** True when the sign-off exists but the environments were changed afterwards. */
export const envFinalStale = () => !!S.scenario?.env_final && !envFinal();
