"""Optical chemical structure recognition (spec §12 'Scan from notes').

MolScribe (MIT) is used when installed; it returns atom positions in the image, bond list and
per-element confidences — exactly what the verification overlay needs. The result is always a
*proposal*: the client shows it over the photo and the student corrects and accepts it.
"""
from __future__ import annotations

import asyncio
import base64
import io
import os
import re
import tempfile
import time
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from rdkit import Chem

from . import chemistry, config

router = APIRouter()
_model = None
_err: str | None = None
CKPT = os.environ.get("MOLSCRIBE_CHECKPOINT", str(config.DATA_DIR / "molscribe" / "swin_base_char_aux_1m680k.pth"))


def status() -> dict[str, Any]:
    try:
        import molscribe  # noqa: F401
    except Exception:  # noqa: BLE001
        return {"available": False, "reason": "MolScribe is not installed on this server."}
    if not os.path.exists(CKPT):
        return {"available": False, "reason": f"MolScribe checkpoint not found at {CKPT}."}
    return {"available": True, "engine": "MolScribe"}


def _load():
    global _model, _err
    if _model is not None:
        return _model
    import torch
    from molscribe import MolScribe

    _model = MolScribe(CKPT, device=torch.device("cpu"))
    return _model


class RecognizeIn(BaseModel):
    image: str  # data URL or base64 PNG/JPEG


VISION_TOOL = {
    "name": "report_structure",
    "description": "Report the single chemical structure drawn in the image as atoms and bonds with image positions.",
    "input_schema": {
        "type": "object",
        "properties": {
            "smiles": {"type": "string", "description": "Write this FIRST: the structure as a SMILES string (heavy atoms only, no explicit H)."},
            "found": {"type": "boolean", "description": "False if the image contains no readable structure."},
            "atoms": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "element": {"type": "string", "description": "Element symbol of the heavy atom (a line vertex/end without a label is C). Labels like OH, NH2, CH3 are the heavy atom O, N, C. List atoms in exactly the order they appear in your SMILES."},
                        "x": {"type": "number", "description": "Horizontal position, 0 = left edge, 1 = right edge of the image."},
                        "y": {"type": "number", "description": "Vertical position, 0 = top edge, 1 = bottom edge."},
                        "charge": {"type": "integer"},
                        "confidence": {"type": "number", "description": "0–1: how sure you are about this atom and its label."},
                    },
                    "required": ["element", "x", "y", "charge", "confidence"],
                    "additionalProperties": False,
                },
            },
            "bonds": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "a": {"type": "integer", "description": "Index into atoms (the narrow end for wedges/hashes)."},
                        "b": {"type": "integer"},
                        "order": {"type": "integer", "enum": [1, 2, 3]},
                        "stereo": {"type": "string", "enum": ["none", "wedge", "hash", "wavy"]},
                        "confidence": {"type": "number"},
                    },
                    "required": ["a", "b", "order", "stereo", "confidence"],
                    "additionalProperties": False,
                },
            },
            "notes": {"type": "string", "description": "One short sentence for a student about anything ambiguous (smudges, unclear labels, uncertain stereo). No coordinates."},
            "ring_sizes": {"type": "array", "items": {"type": "integer"}, "description": "The number of atoms in each ring you see in the drawing (count the vertices of each ring polygon)."},
            "name": {"type": "string", "description": "The compound's common or IUPAC name if you recognize it; empty string otherwise."},
        },
        "required": ["found", "atoms", "bonds", "notes", "ring_sizes", "smiles", "name"],
        "additionalProperties": False,
    },
}

VISION_PROMPT = """Read the chemical structure drawn in this image (a skeletal/line drawing, possibly handwritten). First write it as SMILES. Then report every heavy atom — including the unlabeled carbons at line ends and vertices — in exactly the order the atoms appear in your SMILES, each with its position in the image, and every bond between them with its order and any wedge/hash. Do not add hydrogens. Count the vertices of every ring polygon carefully (a benzene hexagon has exactly six). If you recognize the compound, give its name. Use low confidence for anything you are unsure of; a student will check your reading against the photo before using it."""


def _vision(data: bytes, media_type: str, retry_hint: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Multimodal fallback: the model proposes atoms and bonds; RDKit validates; the student verifies."""
    from . import tutor

    if not tutor.available():
        raise HTTPException(503, "Structure recognition is not available on this server (no MolScribe, no vision model). Trace the photo by hand instead.")
    import anthropic

    client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY, default_headers={"anthropic-workspace-id": config.ANTHROPIC_WORKSPACE_ID} if config.ANTHROPIC_WORKSPACE_ID else None, max_retries=2, timeout=120.0)
    messages: list[dict[str, Any]] = [{"role": "user", "content": [
        {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": base64.b64encode(data).decode("ascii")}},
        {"type": "text", "text": VISION_PROMPT},
    ]}]
    if retry_hint:
        messages += retry_hint
    msg = client.beta.messages.create(
        model=config.TUTOR_MODEL_LARGE,
        max_tokens=8000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        tools=[VISION_TOOL],
        tool_choice={"type": "tool", "name": "report_structure"},
        messages=messages,
    )
    block = next((b for b in msg.content if b.type == "tool_use"), None)
    if block is None or not isinstance(block.input, dict):
        raise HTTPException(502, "The recognizer returned no structure.")
    return {**block.input, "_tool_use_id": block.id}


def _build(atoms: list[dict[str, Any]], bonds: list[dict[str, Any]], width: int, height: int) -> tuple[str, bool, str | None]:
    """RDKit molecule from a proposed graph; wedges/hashes and E/Z are read from the 2D positions."""
    from rdkit import Chem
    from rdkit.Chem import AllChem  # noqa: F401
    from rdkit.Geometry import Point3D

    rw = Chem.RWMol()
    for a in atoms:
        at = Chem.Atom(str(a.get("element") or "C").capitalize() if len(str(a.get("element") or "C")) <= 2 else "C")
        at.SetFormalCharge(int(a.get("charge") or 0))
        rw.AddAtom(at)
    kinds = {1: Chem.BondType.SINGLE, 2: Chem.BondType.DOUBLE, 3: Chem.BondType.TRIPLE}
    for b in bonds:
        i, j = int(b["a"]), int(b["b"])
        if i == j or not (0 <= i < len(atoms) and 0 <= j < len(atoms)) or rw.GetBondBetweenAtoms(i, j):
            continue
        rw.AddBond(i, j, kinds.get(int(b.get("order") or 1), Chem.BondType.SINGLE))
        bond = rw.GetBondBetweenAtoms(i, j)
        if bond.GetBeginAtomIdx() != i:
            continue
        st = b.get("stereo")
        if st == "wedge":
            bond.SetBondDir(Chem.BondDir.BEGINWEDGE)
        elif st == "hash":
            bond.SetBondDir(Chem.BondDir.BEGINDASH)
        elif st == "wavy":
            bond.SetBondDir(Chem.BondDir.UNKNOWN)
    mol = rw.GetMol()
    conf = Chem.Conformer(mol.GetNumAtoms())
    scale = max(width, height) / 40.0 or 1.0
    for k, a in enumerate(atoms):
        conf.SetAtomPosition(k, Point3D(float(a["x"]) * width / scale, -float(a["y"]) * height / scale, 0.0))
    mol.AddConformer(conf, assignId=True)
    try:
        Chem.SanitizeMol(mol)
        Chem.AssignChiralTypesFromBondDirs(mol)
        Chem.DetectBondStereochemistry(mol)
        Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
        return Chem.MolToSmiles(mol), True, None
    except Exception as exc:  # noqa: BLE001
        return "", False, str(exc)


def _from_smiles(out: dict[str, Any], atoms: list[dict[str, Any]], width: int, height: int) -> tuple[str, list[dict[str, Any]]] | None:
    """Bonds from the reader's SMILES, positions from its atom list. A multimodal reader writes the
    SMILES of a drawing more reliably than it traces the drawing atom by atom (a benzene hexagon
    comes back seven-membered), so when the atom list follows the SMILES order element for
    element, the SMILES decides the topology and the atom list only says where each atom sits.
    Wedges are recomputed from those positions so stereo in the SMILES survives."""
    from rdkit.Geometry import Point3D

    m = Chem.MolFromSmiles(out.get("smiles") or "") if out.get("smiles") else None
    if m is None or m.GetNumAtoms() != len(atoms):
        return None
    for i, a in enumerate(atoms):
        el = str(a.get("element") or "C").capitalize()
        if m.GetAtomWithIdx(i).GetSymbol() != el:
            return None
    Chem.Kekulize(m, clearAromaticFlags=True)
    positions = _clean_layout(m, atoms, width, height)
    conf = Chem.Conformer(m.GetNumAtoms())
    scale = max(width, height) / 40.0 or 1.0
    for k, (x, y) in enumerate(positions):
        conf.SetAtomPosition(k, Point3D(x * width / scale, -y * height / scale, 0.0))
    cid = m.AddConformer(conf, assignId=True)
    Chem.WedgeMolBonds(m, m.GetConformer(cid))
    bonds = []
    for b in m.GetBonds():
        d = b.GetBondDir()
        bonds.append({
            "a": b.GetBeginAtomIdx(), "b": b.GetEndAtomIdx(),
            "order": {Chem.BondType.SINGLE: 1, Chem.BondType.DOUBLE: 2, Chem.BondType.TRIPLE: 3}.get(b.GetBondType(), 1),
            "stereo": "wedge" if d == Chem.BondDir.BEGINWEDGE else "hash" if d == Chem.BondDir.BEGINDASH else "none",
            "confidence": 0.9,
        })
    for k, (x, y) in enumerate(positions):
        atoms[k]["x"], atoms[k]["y"] = x, y
    return Chem.MolToSmiles(Chem.MolFromSmiles(out["smiles"])), bonds


def _clean_layout(m: Any, atoms: list[dict[str, Any]], width: int, height: int) -> list[tuple[float, float]]:
    """A tidy RDKit depiction of the structure (true hexagons, even bond lengths), placed by a
    Procrustes fit — rotation, reflection, scale, shift — onto the reader's rough positions,
    which share its atom order. The client then snaps the result onto the ink."""
    import numpy as np
    from rdkit.Chem import rdDepictor

    work = Chem.Mol(m)
    rdDepictor.Compute2DCoords(work)
    c = work.GetConformer()
    P = np.array([[c.GetAtomPosition(i).x, -c.GetAtomPosition(i).y] for i in range(work.GetNumAtoms())])
    Q = np.array([[float(a["x"]) * width, float(a["y"]) * height] for a in atoms])
    if len(P) < 2:
        return [(float(a["x"]), float(a["y"])) for a in atoms]
    pm, qm = P.mean(0), Q.mean(0)
    P0, Q0 = P - pm, Q - qm
    best = None
    for flip in (1.0, -1.0):
        Pf = P0 * np.array([1.0, flip])
        U, S, Vt = np.linalg.svd(Pf.T @ Q0)
        R = U @ Vt
        if np.linalg.det(R) < 0:
            continue
        s = S.sum() / max((Pf ** 2).sum(), 1e-9)
        fitted = s * Pf @ R + qm
        err = ((fitted - Q) ** 2).sum()
        if best is None or err < best[0]:
            best = (err, fitted)
    if best is None:
        return [(float(a["x"]), float(a["y"])) for a in atoms]
    return [(float(x) / width, float(y) / height) for x, y in best[1]]


def _map_onto_smiles(out: dict[str, Any], atoms: list[dict[str, Any]], bonds: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    """When the traced atoms do not line up with the reader's SMILES (it traced an extra ring
    atom, say), keep the SMILES topology and borrow positions: a maximum common substructure
    maps traced atoms onto SMILES atoms, and the few unmapped ones are placed beside their
    bonded neighbours (the client then settles every atom onto the ink)."""
    import math

    from rdkit import Chem
    from rdkit.Chem import rdFMCS

    m = Chem.MolFromSmiles(out.get("smiles") or "") if out.get("smiles") else None
    if m is None or not atoms:
        return None
    rw = Chem.RWMol()
    for a in atoms:
        el = str(a.get("element") or "C").capitalize()
        rw.AddAtom(Chem.Atom(el if len(el) <= 2 else "C"))
    for b in bonds:
        i, j = int(b.get("a", -1)), int(b.get("b", -1))
        if 0 <= i < len(atoms) and 0 <= j < len(atoms) and i != j and not rw.GetBondBetweenAtoms(i, j):
            rw.AddBond(i, j, Chem.BondType.SINGLE)
    traced = rw.GetMol()
    traced.UpdatePropertyCache(strict=False)
    Chem.GetSymmSSSR(traced)
    # Same atom order as the SMILES as written (that order is what _from_smiles uses), with
    # every bond made single so the comparison is about connectivity only.
    plain = Chem.Mol(m)
    Chem.Kekulize(plain, clearAromaticFlags=True)
    for bd in plain.GetBonds():
        bd.SetBondType(Chem.BondType.SINGLE)
    plain.UpdatePropertyCache(strict=False)
    res = rdFMCS.FindMCS([traced, plain], atomCompare=rdFMCS.AtomCompare.CompareElements, bondCompare=rdFMCS.BondCompare.CompareAny, ringMatchesRingOnly=False, completeRingsOnly=False, timeout=2)
    if not res.numAtoms:
        return None
    patt = Chem.MolFromSmarts(res.smartsString)
    ti = traced.GetSubstructMatch(patt)
    mi = plain.GetSubstructMatch(patt)
    if not ti or not mi or len(mi) < 0.7 * m.GetNumAtoms():
        return None
    pos: dict[int, tuple[float, float]] = {}
    conf: dict[int, float] = {}
    for a, b in zip(ti, mi):
        pos[b] = (float(atoms[a]["x"]), float(atoms[a]["y"]))
        conf[b] = float(atoms[a].get("confidence") or 0.7)
    lengths = [math.dist(pos[x.GetBeginAtomIdx()], pos[x.GetEndAtomIdx()]) for x in m.GetBonds() if x.GetBeginAtomIdx() in pos and x.GetEndAtomIdx() in pos]
    step = sorted(lengths)[len(lengths) // 2] if lengths else 0.08
    for _ in range(m.GetNumAtoms()):
        pending = [i for i in range(m.GetNumAtoms()) if i not in pos]
        if not pending:
            break
        for i in pending:
            placed = [n.GetIdx() for n in m.GetAtomWithIdx(i).GetNeighbors() if n.GetIdx() in pos]
            if not placed:
                continue
            ax, ay = pos[placed[0]]
            # Point away from the anchor's other neighbours.
            others = [pos[n.GetIdx()] for n in m.GetAtomWithIdx(placed[0]).GetNeighbors() if n.GetIdx() in pos and n.GetIdx() != i]
            vx, vy = (ax - sum(o[0] for o in others) / len(others), ay - sum(o[1] for o in others) / len(others)) if others else (1.0, 0.0)
            norm = math.hypot(vx, vy) or 1.0
            pos[i] = (ax + vx / norm * step, ay + vy / norm * step)
            conf[i] = 0.3  # invented position: highlighted for the student to check
    if len(pos) != m.GetNumAtoms():
        return None
    return [{"element": m.GetAtomWithIdx(i).GetSymbol(), "x": pos[i][0], "y": pos[i][1], "charge": m.GetAtomWithIdx(i).GetFormalCharge(), "confidence": conf[i]} for i in range(m.GetNumAtoms())]


def _alternative(smiles: str, out: dict[str, Any]) -> str | None:
    from rdkit import Chem

    alt = Chem.MolFromSmiles(out.get("smiles") or "") if out.get("smiles") else None
    if alt is None:
        return None
    m = Chem.MolFromSmiles(smiles) if smiles else None
    if m is not None and Chem.MolToSmiles(m, isomericSmiles=False) == Chem.MolToSmiles(alt, isomericSmiles=False):
        return None
    return Chem.MolToSmiles(alt)


async def _consistency(smiles: str, out: dict[str, Any]) -> list[str]:
    """Cross-check the atom-by-atom reading against the reader's own ring count, SMILES and name.
    A multimodal reader can miscount a ring while naming the compound correctly; disagreement
    between its readings is the cue to look again (spec §12: if tools disagree, say so)."""
    from rdkit import Chem
    from .opsin import opsin

    m = Chem.MolFromSmiles(smiles) if smiles else None
    if m is None:
        return []
    problems: list[str] = []
    graph_rings = sorted(len(r) for r in m.GetRingInfo().AtomRings())
    reported = sorted(int(x) for x in (out.get("ring_sizes") or []) if isinstance(x, (int, float)))
    if reported and graph_rings != reported:
        problems.append(f"the atoms and bonds form rings of size {graph_rings or 'none'}, but the reader counted rings of size {reported}")
    canon = Chem.MolToSmiles(m, isomericSmiles=False)
    alt = Chem.MolFromSmiles(out.get("smiles") or "") if out.get("smiles") else None
    if alt is not None and Chem.MolToSmiles(alt, isomericSmiles=False) != canon:
        problems.append(f"its SMILES reading ({out.get('smiles')}) is a different structure from its atom-by-atom reading")
    raw_name = (out.get("name") or "").strip()
    # "Ibuprofen (2-[4-(2-methylpropyl)phenyl]propanoic acid)": check each name it contains.
    both = re.match(r"^(.*?)\s+\((.*)\)\s*$", raw_name)
    names = [both.group(1).strip(), both.group(2).strip(), raw_name] if both else [raw_name]
    mismatch = None
    for name in names[:3]:
        if not name:
            continue
        try:
            r = await opsin.parse(name)
            named = Chem.MolFromSmiles(r.smiles) if r.ok else None
        except Exception:  # noqa: BLE001 — the name check is advisory
            named = None
        if named is None:
            try:
                from . import pubchem
                cids = await pubchem.cids_for_name(name)
                props = (await pubchem.properties_for_cids(cids[:1]))[0] if cids else None
                smi = (props or {}).get("smiles") or (props or {}).get("isomericSmiles") or (props or {}).get("canonicalSmiles")
                named = Chem.MolFromSmiles(smi) if smi else None
            except Exception:  # noqa: BLE001
                named = None
        if named is None:
            continue
        if Chem.MolToSmiles(named, isomericSmiles=False) == canon:
            mismatch = None
            break
        mismatch = mismatch or name
    if mismatch:
        problems.append(f"it identified the compound as {mismatch}, but the structure it traced is not {mismatch}")
    return problems


@router.post("/v1/structures/recognize-image")
async def recognize(body: RecognizeIn) -> dict[str, Any]:
    st = status()
    if not st["available"]:
        # MolScribe missing: multimodal model proposes the graph instead (always verified by the student).
        raw = body.image.split(",", 1)[1] if body.image.startswith("data:") else body.image
        media = body.image[5:body.image.index(";")] if body.image.startswith("data:") and ";" in body.image else "image/png"
        if media not in ("image/png", "image/jpeg", "image/webp", "image/gif"):
            media = "image/png"
        data = base64.b64decode(raw)
        if len(data) > 5_000_000:
            raise HTTPException(413, "Image too large (5 MB max) — crop to the structure.")
        from PIL import Image

        img = Image.open(io.BytesIO(data))
        width, height = img.size
        t0 = time.time()
        out = await asyncio.to_thread(_vision, data, media)
        atoms = out.get("atoms") or []
        bonds = out.get("bonds") or []
        if not out.get("found") or not atoms:
            return {"engine": "vision", "found": False, "atoms": [], "bonds": [], "notes": out.get("notes", ""), "image": {"width": width, "height": height}}
        via = _from_smiles(out, atoms, width, height)
        if not via:
            remapped = _map_onto_smiles(out, atoms, bonds)
            if remapped:
                via = _from_smiles(out, remapped, width, height)
                if via:
                    atoms = remapped
        if via:
            smiles, bonds = via
            valid, error = True, None
        else:
            smiles, valid, error = _build(atoms, bonds, width, height)
        problems = await _consistency(smiles, out) if valid else []
        reread = False
        if problems:
            # One second look, told exactly what disagreed.
            hint = [
                {"role": "assistant", "content": [{"type": "tool_use", "id": out["_tool_use_id"], "name": "report_structure", "input": {k: v for k, v in out.items() if not k.startswith("_")}}]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": out["_tool_use_id"], "content": "Your readings disagree: " + "; ".join(problems) + ". Look at the image again, recount each ring's vertices, and report the structure again."},
                ]},
            ]
            try:
                again = await asyncio.to_thread(_vision, data, media, hint)
                a2, b2 = again.get("atoms") or [], again.get("bonds") or []
                via2 = _from_smiles(again, a2, width, height) if a2 else None
                if via2:
                    s2, b2 = via2
                    v2, e2 = True, None
                else:
                    s2, v2, e2 = _build(a2, b2, width, height) if a2 else ("", False, None)
                if v2:
                    p2 = await _consistency(s2, again)
                    if len(p2) < len(problems):
                        out, atoms, bonds, smiles, valid, error, problems, reread = again, a2, b2, s2, v2, e2, p2, True
            except HTTPException:
                pass
        return {
            "engine": "vision",
            "found": True,
            "smiles": smiles,
            "valid": valid,
            "error": error,
            "image": {"width": width, "height": height},
            "atoms": [{"index": i, "symbol": a.get("element"), "x": a.get("x"), "y": a.get("y"), "charge": a.get("charge", 0), "confidence": a.get("confidence")} for i, a in enumerate(atoms)],
            "bonds": [{"a": b.get("a"), "b": b.get("b"), "order": b.get("order", 1), "stereo": b.get("stereo", "none"), "confidence": b.get("confidence")} for b in bonds],
            "notes": out.get("notes", ""),
            "readerName": out.get("name") or None,
            "warnings": [p[0].upper() + p[1:] + "." for p in problems],
            # When the atom-by-atom tracing is the odd one out, its independent SMILES reading
            # is offered as an alternative (still confirmed by the student).
            "altSmiles": _alternative(smiles, out) if problems else None,
            "reread": reread,
            "topology": "smiles" if via else "tracing",
            "seconds": round(time.time() - t0, 2),
            "note": "An AI reading of your photo — probabilistic, especially for stereo. Check every highlighted atom and bond before accepting. The image is not stored.",
        }
    raw = body.image.split(",", 1)[1] if body.image.startswith("data:") else body.image
    data = base64.b64decode(raw)
    if len(data) > 12_000_000:
        raise HTTPException(413, "Image too large (12 MB max).")
    t0 = time.time()
    with tempfile.NamedTemporaryFile(suffix=".png", delete=True) as f:
        from PIL import Image

        img = Image.open(io.BytesIO(data)).convert("RGB")
        width, height = img.size
        img.save(f.name)
        out = _load().predict_image_file(f.name, return_atoms_bonds=True, return_confidence=True)
    # The uploaded image is not stored (deleted with the temp file) — spec §20.
    smiles = out.get("smiles", "")
    mol = chemistry.try_mol(smiles) if smiles else None
    atoms = [
        {"index": i, "symbol": a.get("atom_symbol"), "x": a.get("x"), "y": a.get("y"), "confidence": a.get("confidence")}
        for i, a in enumerate(out.get("atoms", []))
    ]
    bonds = [
        {"a": b.get("endpoint_atoms", [0, 0])[0], "b": b.get("endpoint_atoms", [0, 0])[1], "type": b.get("bond_type"), "confidence": b.get("confidence")}
        for b in out.get("bonds", [])
    ]
    return {
        "engine": "MolScribe",
        "smiles": smiles,
        "molblock": out.get("molfile"),
        "valid": mol is not None,
        "confidence": out.get("confidence"),
        "image": {"width": width, "height": height},
        "atoms": atoms,
        "bonds": bonds,
        "seconds": round(time.time() - t0, 2),
        "note": "Recognition is probabilistic — especially wedges and hashes. Check every highlighted atom and bond before accepting.",
    }
