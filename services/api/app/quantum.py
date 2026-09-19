"""Queued quantum jobs (spec §11): PySCF HF/DFT single points → HOMO/LUMO, density and ESP grids.

Results are qualitative teaching visuals: gas phase, modest basis sets, at the supplied model
geometry. Every result carries its method so the UI can say exactly what was computed.
"""
from __future__ import annotations

import asyncio
import base64
import json
import secrets
import time
from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import db

router = APIRouter()

try:
    import pyscf  # noqa: F401
    from pyscf import dft, gto, scf

    _AVAILABLE = True
except Exception:  # noqa: BLE001
    _AVAILABLE = False

BOHR = 0.52917721092
_queue: asyncio.Queue[str] | None = None
_worker: asyncio.Task | None = None


def available() -> bool:
    return _AVAILABLE


class QuantumIn(BaseModel):
    atoms: list[dict[str, Any]]  # [{id, element, x, y, z}] in Å, hydrogens included
    charge: int = 0
    multiplicity: int = 1
    method: str = "HF"  # HF | B3LYP
    basis: str = "sto-3g"  # sto-3g | 3-21g | 6-31g*
    outputs: list[str] = ["homo", "lumo", "density", "esp"]
    spacing: float = 0.3


def _grid(coords_ang: np.ndarray, spacing: float, pad: float = 3.5) -> tuple[np.ndarray, list[int], np.ndarray]:
    lo = coords_ang.min(axis=0) - pad
    hi = coords_ang.max(axis=0) + pad
    n = np.maximum(np.ceil((hi - lo) / spacing).astype(int) + 1, 8)
    n = np.minimum(n, 90)
    axes = [np.linspace(lo[k], lo[k] + spacing * (n[k] - 1), n[k]) for k in range(3)]
    gx, gy, gz = np.meshgrid(*axes, indexing="ij")
    pts = np.stack([gx.ravel(), gy.ravel(), gz.ravel()], axis=1)
    return pts, n.tolist(), lo


def _encode(values: np.ndarray) -> str:
    return base64.b64encode(values.astype(np.float32).tobytes()).decode("ascii")


def _run(req: dict[str, Any]) -> dict[str, Any]:
    t0 = time.time()
    atoms = req["atoms"]
    if len(atoms) > 60:
        raise ValueError("Quantum jobs are limited to 60 atoms (including hydrogens) on this server.")
    basis = req.get("basis", "sto-3g")
    method = req.get("method", "HF").upper()
    if method == "B3LYP" and len(atoms) > 30:
        raise ValueError("B3LYP jobs are limited to 30 atoms; use HF/STO-3G for larger molecules.")
    mol = gto.M(
        atom=[(a["element"], (a["x"], a["y"], a["z"])) for a in atoms],
        basis=basis,
        charge=int(req.get("charge", 0)),
        spin=int(req.get("multiplicity", 1)) - 1,
        unit="Angstrom",
        verbose=0,
    )
    if method == "B3LYP":
        mf = dft.RKS(mol) if mol.spin == 0 else dft.UKS(mol)
        mf.xc = "b3lyp"
    else:
        mf = scf.RHF(mol) if mol.spin == 0 else scf.UHF(mol)
    mf.max_cycle = 150
    mf.kernel()
    if not mf.converged:
        mf = mf.newton()
        mf.kernel()
    mo_energy = np.asarray(mf.mo_energy if mol.spin == 0 else mf.mo_energy[0])
    mo_coeff = np.asarray(mf.mo_coeff if mol.spin == 0 else mf.mo_coeff[0])
    mo_occ = np.asarray(mf.mo_occ if mol.spin == 0 else mf.mo_occ[0])
    homo = int(np.where(mo_occ > 0)[0].max())
    lumo = homo + 1 if homo + 1 < len(mo_energy) else None
    coords_ang = np.array([[a["x"], a["y"], a["z"]] for a in atoms])
    spacing = float(max(0.2, min(0.6, req.get("spacing", 0.3))))
    pts_ang, dims, origin = _grid(coords_ang, spacing)
    pts_bohr = pts_ang / BOHR
    ao = mol.eval_gto("GTOval", pts_bohr)
    grids: dict[str, Any] = {}
    outputs = set(req.get("outputs", []))
    if "homo" in outputs:
        grids["homo"] = _encode(ao @ mo_coeff[:, homo])
    if "lumo" in outputs and lumo is not None:
        grids["lumo"] = _encode(ao @ mo_coeff[:, lumo])
    dm = mf.make_rdm1()
    if mol.spin != 0:
        dm = dm[0] + dm[1]
    if "density" in outputs or "esp" in outputs:
        rho = np.einsum("pi,ij,pj->p", ao, dm, ao, optimize=True)
        grids["density"] = _encode(rho)
    esp_meta = None
    if "esp" in outputs:
        # ESP on a coarser grid (interpolated onto the density surface by the client).
        esp_spacing = max(spacing, 0.45)
        epts_ang, edims, eorigin = _grid(coords_ang, esp_spacing)
        epts = epts_ang / BOHR
        z = mol.atom_charges()
        rc = mol.atom_coords()
        nuc = np.zeros(len(epts))
        for zi, ri in zip(z, rc):
            d = np.linalg.norm(epts - ri, axis=1)
            nuc += zi / np.maximum(d, 1e-6)
        ele = np.zeros(len(epts))
        for i0 in range(0, len(epts), 600):
            ints = mol.intor("int1e_grids", grids=epts[i0 : i0 + 600])
            ele[i0 : i0 + 600] = np.einsum("gij,ij->g", ints, dm)
        esp = nuc - ele  # hartree/e
        grids["esp"] = _encode(esp)
        esp_meta = {"dims": edims, "origin": eorigin.tolist(), "spacing": esp_spacing, "unit": "hartree/e"}
    mulliken = mf.mulliken_pop(verbose=0)[1].tolist()
    dipole = mf.dip_moment(verbose=0).tolist()
    ha_to_ev = 27.211386
    return {
        "method": f"{'RKS/B3LYP' if method == 'B3LYP' else 'RHF'}/{basis} (PySCF {pyscf.__version__}), gas phase, single point at the supplied geometry",
        "caveat": "Qualitative teaching visual: modest basis set, no solvent, force-field geometry.",
        "energy_hartree": float(mf.e_tot),
        "converged": bool(mf.converged),
        "homoIndex": homo,
        "lumoIndex": lumo,
        "orbitalEnergies_eV": [round(float(e) * ha_to_ev, 3) for e in mo_energy[max(0, homo - 4) : homo + 6]],
        "orbitalEnergyStart": max(0, homo - 4),
        "homoEnergy_eV": float(mo_energy[homo]) * ha_to_ev,
        "lumoEnergy_eV": float(mo_energy[lumo]) * ha_to_ev if lumo is not None else None,
        "mulliken": {a["id"]: round(q, 3) for a, q in zip(atoms, mulliken)},
        "dipole_debye": dipole,
        "grid": {"dims": dims, "origin": origin.tolist(), "spacing": spacing, "unit": "angstrom"},
        "espGrid": esp_meta,
        "grids": grids,
        "seconds": round(time.time() - t0, 2),
    }


async def _worker_loop() -> None:
    assert _queue is not None
    while True:
        jid = await _queue.get()
        rows = db.query("SELECT request FROM jobs WHERE id=?", (jid,))
        if not rows:
            continue
        db.execute("UPDATE jobs SET status='running', updated=? WHERE id=?", (time.time(), jid))
        try:
            result = await asyncio.to_thread(_run, json.loads(rows[0][0]))
            db.execute("UPDATE jobs SET status='done', updated=?, result=? WHERE id=?", (time.time(), json.dumps(result), jid))
        except Exception as exc:  # noqa: BLE001
            db.execute("UPDATE jobs SET status='failed', updated=?, error=? WHERE id=?", (time.time(), str(exc), jid))


def _ensure_worker() -> None:
    global _queue, _worker
    if _queue is None:
        _queue = asyncio.Queue()
    if _worker is None or _worker.done():
        _worker = asyncio.create_task(_worker_loop())


@router.post("/v1/quantum/submit")
async def submit(body: QuantumIn) -> dict[str, Any]:
    if not _AVAILABLE:
        raise HTTPException(503, "Quantum jobs are not available on this server (PySCF not installed).")
    if not body.atoms:
        raise HTTPException(400, "No atoms")
    key = "q:" + json.dumps(body.model_dump(), sort_keys=True)
    import hashlib

    digest = hashlib.sha256(key.encode()).hexdigest()[:24]
    rows = db.query("SELECT id, status FROM jobs WHERE id=?", (digest,))
    if rows and rows[0][1] in ("done", "queued", "running"):
        return {"id": digest, "status": rows[0][1], "cached": rows[0][1] == "done"}
    db.execute("INSERT OR REPLACE INTO jobs(id, kind, status, created, updated, request) VALUES (?,?,?,?,?,?)",
               (digest, "quantum", "queued", time.time(), time.time(), json.dumps(body.model_dump())))
    _ensure_worker()
    assert _queue is not None
    await _queue.put(digest)
    position = _queue.qsize()
    return {"id": digest, "status": "queued", "position": position, "token": secrets.token_hex(4)}


@router.get("/v1/quantum/{jid}")
async def status(jid: str) -> dict[str, Any]:
    rows = db.query("SELECT status, result, error, created, updated FROM jobs WHERE id=?", (jid,))
    if not rows:
        raise HTTPException(404, "No such job")
    st, result, error, created, updated = rows[0]
    out: dict[str, Any] = {"id": jid, "status": st, "elapsed": round(updated - created, 1)}
    if st == "done":
        out["result"] = json.loads(result)
    if st == "failed":
        out["error"] = error
    return out
