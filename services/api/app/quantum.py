"""Queued quantum jobs (spec §11): PySCF HF/DFT single points → HOMO/LUMO, density and ESP grids.

Results are qualitative teaching visuals: gas phase, modest basis sets, at the supplied model
geometry. Every result carries its method so the UI can say exactly what was computed.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import secrets
import time
from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import store

router = APIRouter()

try:
    import pyscf  # noqa: F401
    from pyscf import df, dft, gto, lib, scf

    _AVAILABLE = True
except Exception:  # noqa: BLE001
    _AVAILABLE = False

BOHR = 0.52917721092
MAX_MEMORY_MB = int(os.environ.get("ORBITAL_QUANTUM_MAX_MEMORY_MB", "900"))
# Hosted instances (2 GB, one vCPU, 5-minute requests) cap the basis size: memory grows about
# with its cube. Measured peaks: 251 functions HF/3-21G ≈ 1.2 GB, 230 B3LYP/6-31G* ≈ 1.4 GB.
MAX_NAO = {"HF": int(os.environ.get("ORBITAL_QUANTUM_MAX_NAO_HF", "0")), "B3LYP": int(os.environ.get("ORBITAL_QUANTUM_MAX_NAO_B3LYP", "0"))}
_queue: asyncio.Queue[str] | None = None
_one_at_a_time = asyncio.Semaphore(1)
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


def _electronic_potential(mol, dm: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Potential of the electron density at each point (bohr), from the density fitted onto an
    auxiliary basis (def2-universal-jfit): one two-centre integral per auxiliary function and
    point, instead of nao² three-centre ones. 5-10x faster than the exact integrals and within
    ~3 kcal/mol of them around the molecular surface, where the ESP spans 100+ kcal/mol."""
    auxmol = df.addons.make_auxmol(mol, "weigend")
    dm_tril = lib.pack_tril(dm + dm.T - np.diag(np.diag(dm)))
    npair = len(dm_tril)
    ao_loc = auxmol.ao_loc_nr()
    rhs = np.empty(auxmol.nao)
    per_block = max(1, int(80e6 / (8 * npair)))  # auxiliary functions per ~80 MB block
    s0 = 0
    while s0 < auxmol.nbas:
        s1 = s0 + 1
        while s1 < auxmol.nbas and ao_loc[s1 + 1] - ao_loc[s0] <= per_block:
            s1 += 1
        blk = df.incore.aux_e2(mol, auxmol, "int3c2e", aosym="s2ij", shls_slice=(0, mol.nbas, 0, mol.nbas, s0, s1))
        rhs[ao_loc[s0] : ao_loc[s1]] = dm_tril @ blk
        del blk
        s0 = s1
    coef = np.linalg.solve(auxmol.intor("int2c2e"), rhs)
    out = np.empty(len(pts))
    for i0 in range(0, len(pts), 4000):
        charges = gto.fakemol_for_charges(pts[i0 : i0 + 4000])
        out[i0 : i0 + 4000] = gto.mole.intor_cross("int2c2e", charges, auxmol) @ coef
    return out


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
        # PySCF sizes its work blocks to max_memory (4 GB by default); hosted instances have
        # 2 GB in all, shared with RDKit and the OPSIN JVM.
        max_memory=MAX_MEMORY_MB,
    )
    cap = MAX_NAO.get(method, 0)
    if cap and mol.nao > cap:
        hint = "HF / STO-3G" if basis != "sto-3g" else "a smaller molecule"
        raise ValueError(f"This molecule is too large for {method}/{basis} on this server ({mol.nao} basis functions; the limit is {cap}). Try {hint}.")
    if method == "B3LYP":
        mf = dft.RKS(mol) if mol.spin == 0 else dft.UKS(mol)
        mf.xc = "b3lyp"
        # A coarser integration grid than PySCF's default (3): ~0.1 mEh on energies, invisible
        # on an isosurface, and a fifth less time.
        mf.grids.level = 2
    else:
        mf = scf.RHF(mol) if mol.spin == 0 else scf.UHF(mol)
    # Density fitting: a few MB of three-index integrals instead of nao⁴ in memory (or
    # recomputing them every cycle), several times faster on one vCPU; the error it adds is far
    # below what a teaching surface can show.
    mf = mf.density_fit()
    # Default convergence (1e-9 Eh) is for thermochemistry; a teaching surface needs far less.
    mf.conv_tol = 1e-7
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
    grids: dict[str, Any] = {}
    outputs = set(req.get("outputs", []))
    dm = mf.make_rdm1()
    if mol.spin != 0:
        dm = dm[0] + dm[1]
    want_rho = "density" in outputs or "esp" in outputs
    homo_v = np.zeros(len(pts_bohr)) if "homo" in outputs else None
    lumo_v = np.zeros(len(pts_bohr)) if "lumo" in outputs and lumo is not None else None
    rho = np.zeros(len(pts_bohr)) if want_rho else None
    # Orbital values on the grid, a slab of points at a time (the whole grid × every basis
    # function would be hundreds of MB).
    step = max(1000, int(40e6 / (8 * mol.nao)))
    for i0 in range(0, len(pts_bohr), step):
        ao = mol.eval_gto("GTOval", pts_bohr[i0 : i0 + step])
        if homo_v is not None:
            homo_v[i0 : i0 + step] = ao @ mo_coeff[:, homo]
        if lumo_v is not None:
            lumo_v[i0 : i0 + step] = ao @ mo_coeff[:, lumo]
        if rho is not None:
            rho[i0 : i0 + step] = np.einsum("pi,pi->p", ao @ dm, ao)
        del ao
    if homo_v is not None:
        grids["homo"] = _encode(homo_v)
    if lumo_v is not None:
        grids["lumo"] = _encode(lumo_v)
    if rho is not None:
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
        mf.with_df.reset()  # the SCF's fitted integrals aren't needed any more
        esp = nuc - _electronic_potential(mol, dm, epts)  # hartree/e
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
        await _execute(jid)


async def _execute(jid: str) -> None:
    job = store.job_get(jid)
    if not job:
        return
    store.job_update(jid, "running")
    try:
        # One calculation at a time per instance: two at once could exceed its memory.
        async with _one_at_a_time:
            result = await asyncio.to_thread(_run, json.loads(job["request"]))
        store.job_update(jid, "done", result=json.dumps(result))
    except Exception as exc:  # noqa: BLE001
        store.job_update(jid, "failed", error=str(exc))


def _ensure_worker() -> None:
    global _queue, _worker
    if _queue is None:
        _queue = asyncio.Queue()
    if _worker is None or _worker.done():
        _worker = asyncio.create_task(_worker_loop())


# Hosted, a job runs inside its submit request, which the platform ends at 5 minutes; a job
# still marked unfinished well after that was cut off, and is reported (and re-run) as such.
HOSTED_LIMIT_S = 300


def _cut_off(job: dict[str, Any]) -> bool:
    return store.backend() == "redis" and job["status"] in ("queued", "running") and time.time() - (job.get("updated") or 0) > HOSTED_LIMIT_S + 30


@router.post("/v1/quantum/submit")
async def submit(body: QuantumIn) -> dict[str, Any]:
    if not _AVAILABLE:
        raise HTTPException(503, "Quantum jobs are not available on this server (PySCF not installed).")
    if not body.atoms:
        raise HTTPException(400, "No atoms")
    key = "q:" + json.dumps(body.model_dump(), sort_keys=True)
    import hashlib

    digest = hashlib.sha256(key.encode()).hexdigest()[:24]
    prev = store.job_get(digest)
    if prev and prev["status"] in ("done", "queued", "running") and not _cut_off(prev):
        return {"id": digest, "status": prev["status"], "cached": prev["status"] == "done"}
    store.job_put(digest, "quantum", "queued", json.dumps(body.model_dump()))
    if store.backend() == "redis":
        # Hosted (stateless instances): work left running after the response may be frozen or
        # land on another instance, so the job completes inside this request.
        await _execute(digest)
        done = store.job_get(digest) or {}
        return {"id": digest, "status": done.get("status", "failed"), "position": 0}
    _ensure_worker()
    assert _queue is not None
    await _queue.put(digest)
    position = _queue.qsize()
    return {"id": digest, "status": "queued", "position": position, "token": secrets.token_hex(4)}


@router.get("/v1/quantum/{jid}")
async def status(jid: str) -> dict[str, Any]:
    job = store.job_get(jid)
    if not job:
        raise HTTPException(404, "No such job")
    st, result, error, created, updated = job["status"], job["result"], job["error"], job["created"], job["updated"]
    if _cut_off(job):
        st, error = "failed", "The calculation ran out of time on the server. Try HF / STO-3G, or a smaller molecule."
    out: dict[str, Any] = {"id": jid, "status": st, "elapsed": round(updated - created, 1)}
    if st == "done":
        out["result"] = json.loads(result)
    if st == "failed":
        out["error"] = error
    return out
