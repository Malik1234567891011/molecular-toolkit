"""Name ↔ structure pipelines (spec §9): universal input resolution, round-trip verification,
tiered structure → name, and structure-based answer checking."""
from __future__ import annotations

import asyncio
import re
import unicodedata
from typing import Any

import httpx
from rdkit import Chem

from . import chemistry, config, pubchem
from .chemistry import ChemError
from .opsin import opsin

# ---------------------------------------------------------------------------------------------
# Input normalisation — harmless typography only, and every change is reported.

_TYPO_MAP = {
    "‐": ("-", "hyphen"), "‑": ("-", "non-breaking hyphen"), "‒": ("-", "figure dash"),
    "–": ("-", "en dash"), "—": ("-", "em dash"), "―": ("-", "horizontal bar"), "−": ("-", "minus sign"),
    "﹣": ("-", "small hyphen"), "－": ("-", "full-width hyphen"), "′": ("'", "prime"), "″": ("''", "double prime"),
    "‘": ("'", "curly quote"), "’": ("'", "curly apostrophe"), "“": ('"', "curly quote"), "”": ('"', "curly quote"),
    " ": (" ", "non-breaking space"), " ": (" ", "narrow space"), " ": (" ", "thin space"),
    "​": ("", "zero-width space"), "﻿": ("", "byte-order mark"), "·": ("·", "middle dot"),
}


def normalize(raw: str) -> tuple[str, list[str]]:
    changes: list[str] = []
    out = []
    for ch in raw:
        if ch in _TYPO_MAP:
            rep, label = _TYPO_MAP[ch]
            out.append(rep)
            msg = f"replaced {label} with “{rep}”" if rep.strip() else f"removed {label}"
            if msg not in changes:
                changes.append(msg)
        else:
            out.append(ch)
    s = "".join(out)
    s2 = re.sub(r"\s+", " ", s).strip()
    if s2 != s.strip():
        changes.append("collapsed extra spaces")
    return s2, changes


CAS_RE = re.compile(r"^\d{2,7}-\d{2}-\d$")
CID_RE = re.compile(r"^(?:cid[:\s]*)(\d+)$", re.I)
INCHIKEY_RE = re.compile(r"^[A-Z]{14}-[A-Z]{10}-[A-Z]$")
FORMULA_RE = re.compile(r"^(?:[A-Z][a-z]?\d*)+$")
SMILES_CHARS = re.compile(r"^[A-Za-z0-9@+\-\[\]()=#$:/\\%.*]+$")


def classify(q: str) -> list[str]:
    kinds: list[str] = []
    if q.startswith("InChI="):
        return ["inchi"]
    if INCHIKEY_RE.match(q):
        return ["inchikey"]
    if CAS_RE.match(q):
        return ["cas"]
    if CID_RE.match(q):
        return ["cid"]
    if FORMULA_RE.match(q) and re.search(r"\d", q) and chemistry.try_mol(q) is None:
        return ["formula"]
    if " " not in q and SMILES_CHARS.match(q) and chemistry.try_mol(q) is not None:
        kinds.append("smiles")
        # Short strings like "CO" or "NO" are also formulas (carbon monoxide, nitric oxide); resolve both.
        if len(q) <= 3 and FORMULA_RE.match(q):
            kinds.append("formula")
        return kinds
    return ["name"]


def _candidate(mol, source: str, **extra: Any) -> dict[str, Any]:
    from rdkit import Chem
    from rdkit.Chem import Descriptors

    ids = chemistry.identifiers(mol)
    return {**ids, "sources": [source], "stereo": chemistry.stereo_report(mol), "netCharge": Chem.GetFormalCharge(mol),
            "radicals": Descriptors.NumRadicalElectrons(mol), **extra}


def _merge(cands: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for c in cands:
        key = c["inchiKey"] or c["canonicalSmiles"]
        if key in merged:
            m = merged[key]
            m["sources"] = sorted(set(m["sources"] + c["sources"]))
            for k, v in c.items():
                if k not in m or m[k] in (None, "", []):
                    m[k] = v
        else:
            merged[key] = dict(c)
    return list(merged.values())


REPAIRS: list[tuple[str, str]] = [
    (r"\bflouro", "fluoro"), (r"\bchlor(?=[bcdfghjklmnpqrstvwxz])", "chloro"), (r"\bbrom(?=[bcdfghjklmnpqrstvwxz])", "bromo"),
    (r"\biod(?=[bcdfghjklmnpqrstvwxz])", "iodo"), (r"\bmethy\b", "methyl"), (r"\bethy\b", "ethyl"), (r"\bt-butyl", "tert-butyl"),
    (r"\btert butyl", "tert-butyl"), (r"\biso-propyl", "isopropyl"), (r"\bisopropanol\b", "propan-2-ol"), (r"benzen\b", "benzene"),
    (r"\bphenl", "phenyl"), (r"\bpropanone\b", "propan-2-one"), (r"\bhexan\b", "hexane"), (r"\bpentan\b", "pentane"), (r"\bbutan\b", "butane"),
    (r"\bheptan\b", "heptane"), (r"\boctan\b", "octane"), (r"\bdimethy\b", "dimethyl"), (r"\bcyclohexanal\b", "cyclohexanol"),
    (r"\bethanal\b", "ethanal"), (r"\bamine\b", "amine"),
]


# Pieces OPSIN understands, long enough that a fuzzy match means something. A typo anywhere in a
# systematic name is usually one of these spelled wrong ("fluro" for "fluoro"), so the piece is
# swapped for its nearest neighbour and the whole name is offered back to the parser.
MORPHEMES = """
fluoro chloro bromo iodo hydroxy oxo amino nitro cyano nitroso azido isocyanato
methyl ethyl propyl butyl pentyl hexyl heptyl octyl nonyl decyl
isopropyl isobutyl sec-butyl tert-butyl neopentyl cyclopropyl cyclobutyl cyclopentyl cyclohexyl
phenyl benzyl vinyl allyl ethenyl ethynyl methylidene
methoxy ethoxy propoxy butoxy phenoxy formyl acetyl benzoyl carboxy carbamoyl
sulfanyl sulfonyl mercapto trifluoromethyl
tetra penta hexa hepta octa nona deca
meth eth prop pent hex hept oct undec dodec cyclo
ane ene yne anol enol amine amide nitrile carbaldehyde carboxylic
benzene phenol aniline toluene styrene pyridine furan thiophene pyrrole imidazole naphthalene
methane ethane propane butane pentane hexane heptane octane nonane decane
methanol ethanol propanol butanol pentanol hexanol
ethene propene butene pentene hexene ethyne propyne butyne
cyclopropane cyclobutane cyclopentane cyclohexane cycloheptane cyclooctane cyclohexene cyclopentene
acid acetate benzoate ketone aldehyde ether ester
""".split()


def _morpheme_repairs(q: str, focus: str | None = None, limit: int = 24) -> list[str]:
    """Names rebuilt by fixing one mis-spelled piece. When the parser says which section it
    choked on, only that part of the name is touched; otherwise every place a part could start
    is tried, skipping the ones that are already spelled correctly."""
    s = q.lower()
    window: range | None = None
    if focus:
        at = s.find(focus.lower().strip())
        if at >= 0:
            window = range(at, at + len(focus) + 3)
    scored: dict[str, tuple[int, int]] = {}
    for i, ch in enumerate(s):
        if not ch.isalpha() or (i and s[i - 1].isalpha()):
            continue  # a part starts at the beginning, or after a locant, hyphen or bracket
        if window is not None and i not in window:
            continue
        if window is None and any(s.startswith(m, i) for m in MORPHEMES if len(m) >= 5):
            continue  # already a name part: nothing to fix here
        for m in MORPHEMES:
            if len(m) < 4:
                continue
            allowed = min(2, len(m) // 3)
            for length in range(max(3, len(m) - 2), len(m) + 3):
                piece = s[i : i + length]
                if len(piece) < 3 or piece == m:
                    continue
                d = _edit_distance(piece, m)
                if d and d <= allowed:
                    fixed = s[:i] + m + s[i + length :]
                    rank = (d, -len(m))
                    if fixed != s and (fixed not in scored or rank < scored[fixed]):
                        scored[fixed] = rank
    return [name for name, _ in sorted(scored.items(), key=lambda kv: kv[1])[:limit]]


def repair_candidates(q: str) -> list[str]:
    out: list[str] = []
    s = q.lower()
    variants = {s}
    variants.add(re.sub(r"(\d)\s+(?=[a-z])", r"\1-", s))  # "2 methyl" → "2-methyl"
    variants.add(re.sub(r"(?<=[a-z])\s+(?=[a-z])", "", s))  # "methyl propane" → "methylpropane"
    variants.add(re.sub(r"(\d)\s+(?=[a-z])", r"\1-", re.sub(r"(?<=[a-z])\s+(?=[a-z])", "", s)))
    variants.add(re.sub(r"(?<=[a-z])(\d)", r"-\1", s))  # "butan2ol" → "butan-2ol"
    variants.add(re.sub(r"(?<=[a-z])(\d+)(?=[a-z])", r"-\1-", s))  # "butan2ol" → "butan-2-ol"
    variants.add(re.sub(r"^(\d[\d,]*)(?=[a-z])", r"\1-", s))  # "2methylpropane" → "2-methylpropane"
    more = set()
    for v in variants:
        w = v
        for pat, rep in REPAIRS:
            w = re.sub(pat, rep, w)
        more.add(w)
    variants |= more
    for v in variants:
        if v != s and v not in out:
            out.append(v)
    return out


async def resolve(query: str) -> dict[str, Any]:
    normalized, changes = normalize(query)
    kinds = classify(normalized)
    cands: list[dict[str, Any]] = []
    warnings: list[str] = []
    pubchem_state = "not-needed"
    opsin_info: dict[str, Any] | None = None

    async def via_opsin(name: str) -> None:
        nonlocal opsin_info
        r = await opsin.parse(name)
        opsin_info = {"status": r.status, "message": r.message, "flags": r.flags}
        if r.ok:
            mol = chemistry.try_mol(r.smiles)
            if mol is not None:
                cands.append(_candidate(mol, "opsin", opsinSmiles=r.smiles, inputName=name, ambiguousName="ambiguous" in r.flags))
            if "stereo_ignored" in r.flags:
                warnings.append("Some stereodescriptors in the name could not be interpreted and were ignored.")

    async def via_pubchem_cids(cids: list[int], source: str) -> None:
        props = await pubchem.properties_for_cids(cids)
        for p in props:
            mol = chemistry.try_mol(p["smiles"] or "")
            if mol is not None:
                cands.append(_candidate(mol, source, cid=p["cid"], pubchemTitle=p["title"], iupacName=p["iupacName"]))

    async def via_pubchem_name(name: str) -> None:
        nonlocal pubchem_state
        try:
            cids = await pubchem.cids_for_name(name)
            pubchem_state = "ok"
            if cids:
                await via_pubchem_cids(cids[:1], "pubchem")
        except pubchem.PubChemUnavailable as exc:
            pubchem_state = f"unavailable: {exc}"

    jobs = []
    for k in kinds:
        if k == "smiles":
            mol = chemistry.try_mol(normalized)
            if mol is not None:
                cands.append(_candidate(mol, "smiles"))
        elif k == "inchi":
            mol = chemistry.try_mol(normalized)
            if mol is not None:
                cands.append(_candidate(mol, "inchi"))
        elif k in ("name", "cas"):
            if k == "name":
                jobs.append(via_opsin(normalized))
            jobs.append(via_pubchem_name(normalized))
        elif k == "cid":
            m = CID_RE.match(normalized)
            assert m

            async def cid_job(cid: int = int(m.group(1))) -> None:
                nonlocal pubchem_state
                try:
                    await via_pubchem_cids([cid], "pubchem-cid")
                    pubchem_state = "ok"
                except pubchem.PubChemUnavailable as exc:
                    pubchem_state = f"unavailable: {exc}"

            jobs.append(cid_job())
        elif k == "inchikey":

            async def ik_job() -> None:
                nonlocal pubchem_state
                try:
                    cids = await pubchem.cids_for_inchikey(normalized)
                    pubchem_state = "ok"
                    if cids:
                        await via_pubchem_cids(cids[:1], "pubchem-inchikey")
                except pubchem.PubChemUnavailable as exc:
                    pubchem_state = f"unavailable: {exc}"

            jobs.append(ik_job())
        elif k == "formula":

            async def formula_job() -> None:
                nonlocal pubchem_state
                try:
                    cids = await pubchem.cids_for_formula(normalized)
                    pubchem_state = "ok"
                    if cids:
                        await via_pubchem_cids(cids[:10], "pubchem-formula")
                        # Isotopologues (D, 13C) are not what a student means by a formula.
                        cands[:] = [c for c in cands if not (c["sources"] == ["pubchem-formula"] and (re.search(r"\[\d+[A-Z]", c["canonicalSmiles"]) or c["netCharge"] or c["radicals"]))]
                except pubchem.PubChemUnavailable as exc:
                    pubchem_state = f"unavailable: {exc}"

            jobs.append(formula_job())
    if jobs:
        await asyncio.gather(*jobs)

    merged = _merge(cands)
    suggestions: list[dict[str, str]] = []
    if not merged and "name" in kinds:
        # OPSIN names the section it could not read ("… section of the name: 3-fluro"): repair
        # that part rather than guessing at the whole name.
        stuck = None
        if opsin_info and opsin_info.get("message"):
            m = re.search(r"section of the name:\s*(.+?)(?:\s\s|\n|$)", opsin_info["message"])
            stuck = m.group(1).strip() if m else None
        for v in repair_candidates(normalized)[:12] + _morpheme_repairs(normalized, stuck):
            r = await opsin.parse(v)
            if r.ok and v not in [s["name"] for s in suggestions]:
                suggestions.append({"name": v, "source": "spelling"})
        for sug in await _spelling_suggestions(normalized):
            if sug not in [x["name"] for x in suggestions]:
                suggestions.append({"name": sug, "source": "pubchem"})
    # Resolved only through a PubChem synonym (not OPSIN, not the compound's own title): say so,
    # and offer close spellings — "isopropanal" is filed under acetone, the student meant isopropanol.
    synonym_of = None
    if len(merged) == 1 and "name" in kinds and len(normalized) >= 5:
        title = (merged[0].get("pubchemTitle") or "").strip()
        if title and title.lower() != normalized.lower():
            if merged[0]["sources"] == ["pubchem"]:
                synonym_of = title
            # One edit from a different compound's name ("isopropanal" → isopropanol): offer it
            # without replacing what was typed (spec §9.1 "Did you mean propan-2-ol?").
            for sug in await _spelling_suggestions(normalized, max_distance=1):
                if sug.lower() != title.lower() and sug not in [x["name"] for x in suggestions]:
                    suggestions.append({"name": sug, "source": "spelling"})
    status = "resolved" if len(merged) == 1 else "ambiguous" if len(merged) > 1 else "failed"
    if "formula" in kinds and merged:
        status = "ambiguous" if len(merged) > 1 else "resolved"
        warnings.append("A formula matches many structural isomers; pick the one you mean.")
    agreement = None
    if len(merged) == 1 and len(merged[0]["sources"]) > 1:
        agreement = "all sources agree on the same structure"
    elif len(merged) > 1 and {"opsin", "pubchem"} <= {s for c in merged for s in c["sources"]}:
        agreement = "OPSIN and PubChem disagree — choose the structure you mean"
    return {
        "engine": {"opsin": opsin.version, "rdkit": chemistry.RDKIT_VERSION},
        "input": {"raw": query, "normalized": normalized, "changes": changes, "interpretedAs": kinds},
        "status": status,
        "candidates": merged,
        "agreement": agreement,
        "suggestions": suggestions[:8],
        "synonymOf": synonym_of,
        "opsin": opsin_info,
        "pubchem": pubchem_state,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------------------------
# Verification and tiered structure → name


async def verify_name(target, name: str) -> dict[str, Any]:
    r = await opsin.parse(name)
    if not r.ok:
        return {"name": name, "status": "unparseable", "message": r.message}
    mol = chemistry.try_mol(r.smiles)
    if mol is None:
        return {"name": name, "status": "unparseable", "message": "OPSIN output could not be read by RDKit"}
    cmp = chemistry.same_structure(target, mol)
    status = "verified" if cmp["identical"] else "stereo_mismatch" if cmp["sameConnectivity"] else "mismatch"
    return {"name": name, "status": status, "parsedSmiles": cmp["b"]["canonicalSmiles"], "flags": r.flags}


async def _spelling_suggestions(normalized: str, max_distance: int | None = None) -> list[str]:
    """Close spellings from PubChem. Its autocomplete is prefix-based, so a typo ("caffiene")
    finds neighbours rather than the word: ask with short prefixes too, split multi-word terms
    ("Ibuprofen lysinate") into words, and keep only terms a couple of edits away."""
    target = normalized.lower()
    pool: dict[str, str] = {}
    prefixes = [p for p in dict.fromkeys([normalized, normalized[:5], normalized[:4], normalized[:3]]) if len(p) >= 3 and (len(p) >= 4 or len(normalized) >= 5)]
    results = await asyncio.gather(*(pubchem.autocomplete(p, 12) for p in prefixes), return_exceptions=True)
    for terms in results:
        if isinstance(terms, BaseException):
            continue
        for term in terms:
            pool.setdefault(term.lower(), term)
            for word in re.findall(r"[A-Za-z]{4,}", term):
                pool.setdefault(word.lower(), word.lower())
    limit = max_distance if max_distance is not None else max(2, len(target) // 4)
    close = sorted((d, t) for t in pool if t != target and (d := _edit_distance(t, target)) <= limit)
    return [pool[t] for _, t in close[:4]]


def _edit_distance(a: str, b: str) -> int:
    """Damerau–Levenshtein (optimal string alignment): a swapped pair of letters is one edit."""
    d = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(len(a) + 1):
        d[i][0] = i
    for j in range(len(b) + 1):
        d[0][j] = j
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
    return d[len(a)][len(b)]


def _plausible_synonym(s: str) -> bool:
    if len(s) > 60 or len(s) < 3:
        return False
    if re.match(r"^\d+-\d+-\d$", s) or re.match(r"^[A-Z0-9\-]{5,}$", s) or re.search(r"(UNII|CHEBI|DTXSID|NSC|EINECS|HSDB|CAS|MFCD|SCHEMBL|ZINC|AKOS|RefChem|BRN|CHEMBL)", s, re.I):
        return False
    if re.search(r"\d{4,}", s):
        return False
    return True


async def vet_synonyms(target, raw: list[str], exclude: list[str], limit: int = 8) -> list[dict[str, Any]]:
    """PubChem synonyms are user-deposited and sometimes name a different compound. Every
    synonym that OPSIN can parse must round-trip to this exact structure; names OPSIN cannot
    parse (trade and trivial names) are kept but marked as not structure-checked."""
    seen = {e.strip().rstrip(".").lower() for e in exclude if e}
    # A structure with defined stereo only accepts synonyms whose stereo we could check;
    # racemate / relative-configuration labels (±, rac, R*, threo…) describe something else.
    specified = any(True for _ in Chem.FindMolChiralCenters(target, includeUnassigned=False, useLegacyImplementation=False)) or any(
        b.GetStereo() != Chem.BondStereo.STEREONONE for b in target.GetBonds())
    stereo_words = re.compile(r"\(\s*[RSEZ][,)*\s]|\b[RSEZ]\*|\(\+|\(-\)|±|\+/-|A\+/-|\brac\b|\bthreo\b|\berythro\b|\bcis\b|\btrans\b|\bmeso\b|\bDL\b|\b[DL]-", re.I)
    out: list[dict[str, Any]] = []
    for s in raw:
        name = s.strip().rstrip(".").strip()
        key = name.lower()
        if key in seen or not _plausible_synonym(name) or "A+/-" in name:
            continue
        seen.add(key)
        v = await verify_name(target, name)
        if v["status"] in ("mismatch", "stereo_mismatch"):
            continue  # a wrong name deposited against this record — never shown
        if specified and v["status"] != "verified" and stereo_words.search(name):
            continue
        cas_index = bool(re.search(r", .*-$|^[A-Z][a-z]+, ", name))
        out.append({
            "name": name,
            "checked": v["status"] == "verified",
            "kind": "cas-index" if cas_index else "systematic" if v["status"] == "verified" else "common",
        })
        if len(out) >= limit:
            break
    return out


async def generate(smiles: str, course: list[dict[str, Any]]) -> dict[str, Any]:
    target = chemistry.mol_from_text(smiles)
    ids = chemistry.identifiers(target)
    stereo = chemistry.stereo_report(target)
    course_results = []
    for c in course:
        v = await verify_name(target, c["name"])
        course_results.append({**c, **v, "provenance": "verified_systematic" if v["status"] == "verified" else "unverified_candidate"})
    database: dict[str, Any] = {"status": "not-found"}
    try:
        cids = await pubchem.cids_for_inchikey(ids["inchiKey"])
        if cids:
            props = (await pubchem.properties_for_cids(cids[:1]))[0]
            details = await vet_synonyms(target, await pubchem.synonyms(cids[0], 40), [props.get("iupacName") or ""])
            database = {"status": "found", "cid": cids[0], "iupacName": props["iupacName"], "title": props["title"],
                        "synonyms": [d["name"] for d in details], "synonymDetails": details, "provenance": "database_name"}
            if props.get("iupacName"):
                v = await verify_name(target, props["iupacName"])
                database["iupacVerified"] = v["status"] == "verified"
    except pubchem.PubChemUnavailable as exc:
        database = {"status": "unavailable", "reason": str(exc)}
    ml: dict[str, Any] = {"status": "unavailable", "reason": "STOUT V2 service is not configured on this server (set STOUT_URL)."}
    if config.STOUT_URL:
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                r = await client.post(config.STOUT_URL, json={"smiles": ids["canonicalSmiles"]})
                name = r.json().get("name") if r.status_code == 200 else None
            if name:
                v = await verify_name(target, name)
                ml = {"status": "ok", "name": name, "verification": v,
                      "provenance": "candidate_verified" if v["status"] == "verified" else "unverified_candidate"}
            else:
                ml = {"status": "no-result"}
        except Exception as exc:  # noqa: BLE001
            ml = {"status": "unavailable", "reason": f"STOUT request failed: {exc}"}
    return {
        "engine": {"opsin": opsin.version, "rdkit": chemistry.RDKIT_VERSION, "standardization": chemistry.STANDARDIZATION_PROFILE},
        "identifiers": ids,
        "stereo": stereo,
        "course": course_results,
        "database": database,
        "ml": ml,
    }


async def check_answer(target_smiles: str, answer: str) -> dict[str, Any]:
    normalized, changes = normalize(answer)
    target = chemistry.mol_from_text(target_smiles)
    r = await opsin.parse(normalized)
    if not r.ok:
        sugg = []
        for v in repair_candidates(normalized)[:10]:
            rr = await opsin.parse(v)
            if rr.ok:
                sugg.append(v)
        return {"verdict": "unparseable", "message": r.message, "suggestions": sugg[:3], "normalized": normalized, "changes": changes}
    mol = chemistry.try_mol(r.smiles)
    if mol is None:
        return {"verdict": "unparseable", "message": "The name gives a structure that could not be read.", "normalized": normalized}
    cmp = chemistry.same_structure(target, mol)
    verdict = "correct" if cmp["identical"] else "stereo" if cmp["sameConnectivity"] else "isomer" if cmp["sameFormula"] else "different"
    return {
        "verdict": verdict,
        "normalized": normalized,
        "changes": changes,
        "answerSmiles": cmp["b"]["canonicalSmiles"],
        "targetSmiles": cmp["a"]["canonicalSmiles"],
        "answerFormula": cmp["b"]["formula"],
        "targetFormula": cmp["a"]["formula"],
        "stereo": chemistry.stereo_report(mol),
    }
