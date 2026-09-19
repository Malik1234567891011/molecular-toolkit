"""Optical chemical structure recognition (spec §12 'Scan from notes').

MolScribe (MIT) is used when installed; it returns atom positions in the image, bond list and
per-element confidences — exactly what the verification overlay needs. The result is always a
*proposal*: the client shows it over the photo and the student corrects and accepts it.
"""
from __future__ import annotations

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


@router.post("/v1/structures/recognize-image")
def recognize(body: RecognizeIn) -> dict[str, Any]:
    st = status()
    if not st["available"]:
        raise HTTPException(503, st["reason"])
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
