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
import tempfile
import time
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

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
            "found": {"type": "boolean", "description": "False if the image contains no readable structure."},
            "atoms": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "element": {"type": "string", "description": "Element symbol of the heavy atom (a line vertex/end without a label is C). Labels like OH, NH2, CH3 are the heavy atom O, N, C."},
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
            "notes": {"type": "string", "description": "Anything ambiguous (smudges, unclear labels, uncertain stereo)."},
            "ring_sizes": {"type": "array", "items": {"type": "integer"}, "description": "The number of atoms in each ring you see in the drawing (count the vertices of each ring polygon)."},
            "smiles": {"type": "string", "description": "The same structure written independently as a SMILES string (a second reading used to cross-check the atom list)."},
            "name": {"type": "string", "description": "The compound's common or IUPAC name if you recognize it; empty string otherwise."},
        },
        "required": ["found", "atoms", "bonds", "notes", "ring_sizes", "smiles", "name"],
        "additionalProperties": False,
    },
}

VISION_PROMPT = """Read the chemical structure drawn in this image (a skeletal/line drawing, possibly handwritten). Report every heavy atom — including the unlabeled carbons at line ends and vertices — with its position in the image, and every bond between them with its order and any wedge/hash. Do not add hydrogens. Count the vertices of every ring polygon carefully (a benzene hexagon has exactly six). Also give the structure as SMILES and, if you recognize the compound, its name — these are used to cross-check your atom list. Use low confidence for anything you are unsure of; a student will check your reading against the photo before using it."""


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
    name = (out.get("name") or "").strip()
    if name:
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
        if named is not None and Chem.MolToSmiles(named, isomericSmiles=False) != canon:
            problems.append(f"it identified the compound as {name}, but the structure it traced is not {name}")
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
            "warnings": [f"The reader disagrees with itself: {p}. Check the highlighted drawing carefully against your photo." for p in problems],
            "reread": reread,
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
