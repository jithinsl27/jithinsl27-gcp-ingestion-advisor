"""Monthly risk register: plain-language risks -> plan changes -> before / after impact and recommendations.

A risk such as "Subscriber billing won't be ready for month 3, expect month 5" is turned into changes:

  delay    a source goes live later (or earlier) - sets its go-live month
  descope  a source is taken out of this phase
  volume   a source's data volume changes by a factor
  none     a risk with no direct effect on the numbers (people, approvals, contracts) - logged only

Gemini reads the sentence when it is available; otherwise a rules parser handles the common phrasings.
`impact()` rebuilds the roadmap and pricing with the changes and compares them with the current plan.
Nothing is changed in the scenario until the architect applies the risk in the app.
"""
from __future__ import annotations

import copy
import re

from .plan import build_plan

KINDS = ("delay", "descope", "volume", "none")
LEVELS = ("low", "medium", "high")


# --------------------------------------------------------------------------- parsing
def _norm(t):
    return re.sub(r"[^a-z0-9 ]+", " ", (t or "").lower())


def _match_source(text, sources):
    """Best source for the text by word overlap with its name (ties: longest name)."""
    words = set(_norm(text).split()) - {"the", "and", "of", "for", "to", "in", "a", "data", "source", "system", "month", "months"}
    best, score = None, 0
    for s in sources:
        name = _norm(s.get("name") or s.get("type"))
        nw = set(name.split()) - {"the", "and", "of", "data"}
        sc = len(words & nw) + (2 if name and name in _norm(text) else 0) + (1 if s.get("type") and s["type"] in words else 0)
        if sc > score or (sc == score and sc and len(name) > len(_norm(best.get("name") if best else ""))):
            best, score = s, sc
    return best if score >= 1 else None


WORD_NUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "twelve": 12}


def rules_parse(text: str, scenario: dict, golive: dict) -> dict:
    """Common phrasings without Gemini: delays to a month or by N months, de-scoping, volume changes."""
    t = _norm(text)
    for w, n in WORD_NUM.items():
        t = re.sub(rf"\b{w}\b", str(n), t)
    srcs = [s for s in scenario.get("sources", []) if s.get("included", True) is not False]
    src = _match_source(text, srcs)
    months = [int(x) for x in re.findall(r"\b(?:month|m)\s*(\d{1,2})\b", t)]
    by = re.search(r"\b(?:by|slip(?:s|ped)?|delay(?:ed)?|late|push(?:ed)?)\s*(?:by\s*)?(\d{1,2})\s*months?\b", t)
    changes = []
    if src and re.search(r"\b(descope|de scope|out of scope|drop(?:ped)?|cancel(?:led)?|remove[d]?|phase 2|next phase|not needed|no longer)\b", t):
        changes.append({"kind": "descope", "source_id": src["id"]})
    elif src and re.search(r"\b(double[sd]?|triple[sd]?|half|halve[sd]?|\d{1,3}\s*(?:percent|pc)|more data|less data|increase[sd]?|decrease[sd]?|grow[sn]?)\b", t) and not by and len(months) < 2:
        f = 2.0 if "doubl" in t else 3.0 if "tripl" in t else 0.5 if re.search(r"\bhal(f|ve)", t) else None
        pct = re.search(r"(\d{1,3})\s*(?:percent|pc)", text.lower().replace("%", " percent"))
        if f is None and pct:
            p = int(pct.group(1)) / 100
            f = 1 - p if re.search(r"\b(less|decrease|lower|reduce|drop)", t) else 1 + p
        changes.append({"kind": "volume", "source_id": src["id"], "factor": round(f or 1.5, 2)})
    elif src and (months or by):
        cur = golive.get(src["id"])
        if by:
            new = (cur or 2) + int(by.group(1))
        elif len(months) >= 2:
            new = months[-1]
        else:
            new = months[0] if cur is None or months[0] != cur else cur + 2
        changes.append({"kind": "delay", "source_id": src["id"], "month": max(2, min(36, new))})
    elif src and re.search(r"\b(delay|late|slip|not ready|cannot|can t|won t|unable|blocked)\b", t):
        changes.append({"kind": "delay", "source_id": src["id"], "month": min(36, (golive.get(src["id"]) or 2) + 2)})
    lik = "high" if re.search(r"\b(will|confirmed|certain|definitely|won t|cannot|can t|not able|unable)\b", t) else "medium"
    return {"summary": text.strip()[:300], "likelihood": lik, "impact": "medium" if changes else "low",
            "changes": changes or [{"kind": "none"}], "recommendations": [], "method": "rules"}


PROMPT = """You are a delivery manager for a Google Cloud data platform programme. Turn the risk below into
structured changes to the plan. The plan's source systems are listed with their id and current go-live month.
Rules:
- kind "delay": the source goes live in a different month -> give "month" (the new go-live month, 2-36).
  If the text says "by N months", add N to the current go-live month.
- kind "descope": the source is removed from this phase.
- kind "volume": the source's data volume changes -> give "factor" (e.g. 2 = double, 0.7 = 30% less).
- kind "none": the risk does not change sources (people, approvals, budget, contracts).
- Use only source ids from the list. One change per affected source.
- likelihood and impact: low, medium or high.
- summary: one plain sentence restating the risk.
- recommendations: 2-4 short, practical mitigations for the programme (not generic advice).
Return JSON only.
"""


def schema():
    s = {"type": "STRING"}
    return {"type": "OBJECT", "properties": {
        "summary": s, "likelihood": {"type": "STRING", "enum": list(LEVELS)}, "impact": {"type": "STRING", "enum": list(LEVELS)},
        "recommendations": {"type": "ARRAY", "items": s},
        "changes": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
            "kind": {"type": "STRING", "enum": list(KINDS)}, "source_id": s, "month": {"type": "INTEGER"}, "factor": {"type": "NUMBER"}},
            "required": ["kind"]}}},
        "required": ["summary", "likelihood", "impact", "changes", "recommendations"]}


def prompt(text: str, scenario: dict, golive: dict, month_raised: int | None) -> str:
    lines = [f"- id {s['id']}: {s.get('name') or s.get('type')} (go-live month {golive.get(s['id'], '?')})"
             for s in scenario.get("sources", []) if s.get("included", True) is not False]
    return (PROMPT + f"\nRisk raised in month {month_raised or '?'}: {text[:1500]}\n\nSource systems:\n" + "\n".join(lines[:60]))


def clean(data: dict, scenario: dict) -> dict:
    ids = {s["id"] for s in scenario.get("sources", []) if s.get("included", True) is not False}
    out = []
    for c in data.get("changes") or []:
        k = c.get("kind")
        if k not in KINDS:
            continue
        if k == "none":
            continue
        if c.get("source_id") not in ids:
            continue
        if k == "delay" and c.get("month"):
            out.append({"kind": k, "source_id": c["source_id"], "month": max(2, min(36, int(c["month"])))})
        elif k == "volume" and c.get("factor"):
            out.append({"kind": k, "source_id": c["source_id"], "factor": max(0.05, min(20.0, round(float(c["factor"]), 2)))})
        elif k == "descope":
            out.append({"kind": k, "source_id": c["source_id"]})
    lvl = lambda v: v if v in LEVELS else "medium"  # noqa: E731
    return {"summary": str(data.get("summary") or "")[:300], "likelihood": lvl(data.get("likelihood")), "impact": lvl(data.get("impact")),
            "changes": out or [{"kind": "none"}], "recommendations": [str(r)[:240] for r in (data.get("recommendations") or [])[:4]]}


# --------------------------------------------------------------------------- applying and impact
def apply(scenario: dict, changes: list) -> dict:
    sc = copy.deepcopy(scenario)
    by_id = {s.get("id"): s for s in sc.get("sources", [])}
    for c in changes or []:
        s = by_id.get(c.get("source_id"))
        if not s:
            continue
        if c["kind"] == "delay" and c.get("month"):
            s["go_live_override"] = max(2, min(36, int(c["month"])))
        elif c["kind"] == "descope":
            s["included"] = False
        elif c["kind"] == "volume" and c.get("factor"):
            f = float(c["factor"])
            s["daily_change_gb"] = round(float(s.get("daily_change_gb") or 0) * f, 3)
            s["initial_volume_gb"] = round(float(s.get("initial_volume_gb") or 0) * f, 3)
    return sc


def _summ(p):
    pr = p["pricing"]["ramped"]
    return {"golive": {w["id"]: w["go_live_month"] for w in p["waves"]}, "names": {w["id"]: w["name"] for w in p["waves"]},
            "all_live": max([w["go_live_month"] for w in p["waves"]] or [0]),
            "payg": pr["plans"]["payg_3y"]["by_year"], "cud3": pr["plans"]["commit_3y"]["by_year"],
            "monthly": pr["plans"]["payg_3y"]["monthly"]}


def impact(scenario: dict, changes: list, before_plan: dict | None = None) -> dict:
    before = _summ(before_plan or build_plan(scenario))
    after = _summ(build_plan(apply(scenario, changes)))
    names = {s.get("id"): s.get("name") or s.get("type") for s in scenario.get("sources", [])}
    rows = []
    for sid in dict.fromkeys(list(before["golive"]) + list(after["golive"])):
        b, a = before["golive"].get(sid), after["golive"].get(sid)
        if b != a:
            rows.append({"id": sid, "name": names.get(sid, sid), "before": b, "after": a})
    d = lambda k: [round(x - y, 2) for x, y in zip(after[k], before[k])]  # noqa: E731
    out = {"golive_changes": rows, "all_live": {"before": before["all_live"], "after": after["all_live"]},
           "payg": {"before": before["payg"], "after": after["payg"], "delta": d("payg")},
           "cud3": {"before": before["cud3"], "after": after["cud3"], "delta": d("cud3")},
           "monthly": {"before": before["monthly"], "after": after["monthly"]}}
    out["recommendations"] = recommendations(scenario, changes, out)
    return out


def recommendations(scenario: dict, changes: list, imp: dict) -> list[str]:
    from .usecases import recommend_use_cases
    recs = []
    names = {s.get("id"): s.get("name") or s.get("type") for s in scenario.get("sources", [])}
    dy1 = imp["payg"]["delta"][0]
    d3 = sum(imp["payg"]["delta"])
    kinds = {c["kind"] for c in changes or []}
    if "delay" in kinds:
        for c in changes:
            if c["kind"] == "delay":
                g = next((r for r in imp["golive_changes"] if r["id"] == c["source_id"]), None)
                if g and g["after"] and g["before"] and g["after"] > g["before"]:
                    recs.append(f"{names.get(c['source_id'])} now goes live in month {g['after']} instead of {g['before']}: tell the steering committee and update the milestone plan.")
        if dy1 < 0:
            recs.append(f"Year 1 spend falls by about ${-dy1:,.0f} as consumption starts later - keep that budget for the slipped months rather than releasing it.")
        recs.append("Do not buy slot or service commitments for the delayed source until it is live - commitments bill from day one.")
        recs.append("Move the delivery squad onto the next wave in the meantime, so the team is not idle and later go-lives do not slip too.")
        if imp["all_live"]["after"] > imp["all_live"]["before"]:
            recs.append(f"All sources are now live in month {imp['all_live']['after']} (was {imp['all_live']['before']}): check that dependent use cases and data agents move with them.")
    if "descope" in kinds:
        recs.append(f"De-scoping saves about ${-d3:,.0f} over three years at pay-as-you-go prices." if d3 < 0 else "De-scoping changes the three-year cost only slightly.")
        recs.append("Confirm with the customer which use cases relied on the de-scoped data, and keep its ingestion design for a later phase.")
    if "volume" in kinds:
        recs.append(f"Three-year cost changes by about ${d3:+,.0f}: re-check BigQuery slots, storage and the commitment size before the next pricing review.")
        recs.append("Validate the new volume with the source owner (sample extract or monitoring data) before re-baselining the budget.")
    if not changes or kinds <= {"none"}:
        recs.append("This risk does not change sources or volumes. Track an owner and a due date, and review it at the next monthly checkpoint.")
    try:
        uc = [u["name"] for u in recommend_use_cases(apply(scenario, changes))]
        before_uc = [u["name"] for u in recommend_use_cases(scenario)]
        lost = [u for u in before_uc if u not in uc]
        if lost:
            recs.append("Use cases at risk: " + ", ".join(lost) + ".")
    except Exception:  # noqa: BLE001 - recommendations are best effort
        pass
    return recs[:6]
