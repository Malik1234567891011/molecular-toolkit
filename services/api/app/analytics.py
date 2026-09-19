"""Product metrics from the privacy-preserving event log (spec §22)."""
from __future__ import annotations

import json
import statistics
from collections import Counter, defaultdict
from typing import Any

from . import db


def compute() -> dict[str, Any]:
    rows = db.query("SELECT at, session, name, props FROM events ORDER BY at")
    by_session: dict[str, list[tuple[float, str, dict]]] = defaultdict(list)
    counts: Counter[str] = Counter()
    for at, session, name, props in rows:
        p = json.loads(props or "{}")
        by_session[session].append((at, name, p))
        counts[name] += 1
    ttfm = []
    for evs in by_session.values():
        opened = next((a for a, n, _ in evs if n == "studio_opened"), None)
        first = next((a for a, n, _ in evs if n == "first_molecule_completed"), None)
        if opened is not None and first is not None and first >= opened:
            ttfm.append(first - opened)
    resolved = counts["input_name_resolved"]
    failed = counts["input_name_failed"]
    ambiguous = counts["input_name_ambiguous"]
    verified = counts["structure_name_verified"]
    unsupported = counts["structure_name_unsupported"]
    explained = counts["naming_step_opened"]
    interacted = counts["explanation_interaction"]
    hints = [p.get("level") for evs in by_session.values() for _, n, p in evs if n == "hint_level_used"]
    corrected_after_hint = counts["answer_corrected"]
    total_inputs = resolved + failed + ambiguous
    return {
        "sessions": len(by_session),
        "events": dict(counts),
        "medianSecondsToFirstMolecule": statistics.median(ttfm) if ttfm else None,
        "nameResolution": {"resolved": resolved, "ambiguous": ambiguous, "failed": failed, "rate": resolved / total_inputs if total_inputs else None},
        "verifiedNamingCoverage": verified / (verified + unsupported) if (verified + unsupported) else None,
        "explanationInteractionRate": interacted / explained if explained else None,
        "correctionRateAfterHint": corrected_after_hint / len(hints) if hints else None,
        "shareExportRate": (counts["molecule_shared"] + counts["molecule_exported"]) / len(by_session) if by_session else None,
    }
