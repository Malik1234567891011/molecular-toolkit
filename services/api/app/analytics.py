"""Product metrics from the privacy-preserving event log (spec §22).

Only event names and small scalar props are stored — never names typed, molecules or AI text.
"""
from __future__ import annotations

import json
import statistics
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any

from . import db

# Funnel steps: a session counts once per step if it fired any of the events.
FUNNEL: list[tuple[str, tuple[str, ...]]] = [
    ("Opened the studio", ("studio_opened", "return_session")),
    ("Built or loaded a molecule", ("first_molecule_completed", "input_name_resolved", "atom_added")),
    ("Got a verified name", ("structure_name_verified",)),
    ("Opened an explanation", ("naming_step_opened", "why_not_numbering_opened", "projection_opened")),
    ("Started practice", ("practice_started",)),
    ("Shared or exported", ("molecule_shared", "molecule_exported")),
]


def _rate(num: float, den: float) -> float | None:
    return num / den if den else None


def compute() -> dict[str, Any]:
    rows = db.query("SELECT at, session, name, props FROM events ORDER BY at")
    by_session: dict[str, list[tuple[float, str, dict]]] = defaultdict(list)
    counts: Counter[str] = Counter()
    days: dict[str, dict[str, Any]] = defaultdict(lambda: {"sessions": set(), "events": 0})
    for at, session, name, props in rows:
        try:
            p = json.loads(props or "{}")
        except ValueError:
            p = {}
        by_session[session].append((at, name, p))
        counts[name] += 1
        day = datetime.fromtimestamp(at, tz=timezone.utc).strftime("%Y-%m-%d")
        days[day]["sessions"].add(session)
        days[day]["events"] += 1

    # Median time from opening the studio to the first molecule, per session.
    ttfm = []
    for evs in by_session.values():
        opened = next((a for a, n, _ in evs if n == "studio_opened"), None)
        first = next((a for a, n, _ in evs if n == "first_molecule_completed"), None)
        if opened is not None and first is not None and first >= opened:
            ttfm.append(first - opened)

    # Hints are logged when an answer is graded; a correction logged with it means that answer was wrong.
    hinted_answers = 0
    wrong_after_hint = 0
    for evs in by_session.values():
        for k, (at, name, _) in enumerate(evs):
            if name != "hint_level_used":
                continue
            hinted_answers += 1
            nxt = evs[k + 1] if k + 1 < len(evs) else None
            if nxt and nxt[1] == "answer_corrected" and nxt[0] - at < 5:
                wrong_after_hint += 1

    funnel = []
    for label, names in FUNNEL:
        n = sum(1 for evs in by_session.values() if any(e[1] in names for e in evs))
        funnel.append({"step": label, "sessions": n})

    input_classes: Counter[str] = Counter()
    for evs in by_session.values():
        for _, name, p in evs:
            if name == "input_name_resolved":
                kind = str(p.get("kind") or "other").split(",")[0] or "other"
                input_classes[kind] += 1
    input_classes["ambiguous"] += counts["input_name_ambiguous"]
    input_classes["not found"] += counts["input_name_failed"]

    provenance: Counter[str] = Counter()
    for evs in by_session.values():
        for _, name, p in evs:
            if name == "structure_name_verified":
                provenance[str(p.get("provenance") or "verified")] += 1
    provenance["unsupported"] += counts["structure_name_unsupported"]

    resolved = counts["input_name_resolved"]
    total_inputs = resolved + counts["input_name_failed"] + counts["input_name_ambiguous"]
    verified = counts["structure_name_verified"]
    unsupported = counts["structure_name_unsupported"]
    sessions = len(by_session)
    returning = sum(1 for evs in by_session.values() if any(n == "return_session" for _, n, _ in evs))
    return {
        "generatedAt": time.time(),
        "sessions": sessions,
        "totalEvents": sum(counts.values()),
        "events": dict(counts),
        "kpis": {
            "medianSecondsToFirstMolecule": statistics.median(ttfm) if ttfm else None,
            "nameResolutionRate": _rate(resolved, total_inputs),
            "verifiedNamingCoverage": _rate(verified, verified + unsupported),
            "explanationInteractionRate": min(1.0, _rate(counts["explanation_interaction"], counts["naming_step_opened"]) or 0) if counts["naming_step_opened"] else None,
            "correctionRateAfterHint": _rate(wrong_after_hint, hinted_answers),
            "shareExportRate": _rate(sum(1 for evs in by_session.values() if any(n in ("molecule_shared", "molecule_exported") for _, n, _ in evs)), sessions),
            "returningSessionShare": _rate(returning, sessions),
        },
        "samples": {"timeToFirstMolecule": len(ttfm), "nameInputs": total_inputs, "namedStructures": verified + unsupported, "hintedAnswers": hinted_answers},
        "funnel": funnel,
        "inputClasses": [{"kind": k, "count": v} for k, v in input_classes.most_common() if v],
        "provenance": [{"kind": k, "count": v} for k, v in provenance.most_common() if v],
        "daily": [{"date": d, "sessions": len(v["sessions"]), "events": v["events"]} for d, v in sorted(days.items())],
    }
