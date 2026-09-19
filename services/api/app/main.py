"""Orbital chemistry API (FastAPI). Contracts follow spec §16 'Key API contracts'."""
from __future__ import annotations

import secrets
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import chemistry, config, db, naming, pubchem, store
from .chemistry import ChemError
from .opsin import opsin


@asynccontextmanager
async def lifespan(app: FastAPI):
    if store.backend() == "sqlite":
        db.conn()
    try:
        await opsin.start()
    except Exception as exc:  # noqa: BLE001
        print(f"[orbital] OPSIN failed to start: {exc}")
    yield
    await opsin.close()


app = FastAPI(title="Orbital chemistry API", version="0.1.0", lifespan=lifespan)


class StripApiPrefix:
    """Hosted, the public route /api/v1/... reaches this service with its path unchanged; locally
    the Next.js rewrite has already dropped the /api. Serve both."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket") and scope["path"].startswith("/api/"):
            scope = dict(scope, path=scope["path"][4:])
            if isinstance(scope.get("raw_path"), bytes) and scope["raw_path"].startswith(b"/api/"):
                scope["raw_path"] = scope["raw_path"][4:]
        await self.app(scope, receive, send)


app.add_middleware(StripApiPrefix)


@app.exception_handler(ChemError)
async def chem_error(_: Request, exc: ChemError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"error": {"code": exc.code, "message": exc.message}})


def engine() -> dict[str, str]:
    return {"rdkit": chemistry.RDKIT_VERSION, "opsin": opsin.version, "standardization": chemistry.STANDARDIZATION_PROFILE}


# ---------------------------------------------------------------------------------------------
# Health


@app.get("/v1/health")
async def health() -> dict[str, Any]:
    from . import tutor, quantum  # noqa: F401  (lazy: optional modules)

    return {
        "ok": True,
        "engine": engine(),
        "capabilities": {
            "opsin": opsin.proc is not None,
            "pubchem": not config.OFFLINE,
            "tutor": tutor.available(),
            "stout": bool(config.STOUT_URL),
            "quantum": quantum.available(),
            "ocsr": _ocsr_available(),
        },
    }


def _ocsr_available() -> dict[str, Any]:
    try:
        from . import ocsr, tutor

        st = ocsr.status()
        if not st["available"] and tutor.available():
            return {"available": True, "engine": "vision", "reason": "MolScribe not installed; using the multimodal model (always verified by the student)."}
        return st
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "reason": str(exc)}


# ---------------------------------------------------------------------------------------------
# Molecules


class StructureIn(BaseModel):
    structure: str = Field(..., description="SMILES, molfile or InChI")


@app.post("/v1/molecules/validate")
def validate(body: StructureIn) -> dict[str, Any]:
    try:
        mol = chemistry.mol_from_text(body.structure)
    except ChemError as exc:
        return {"engine": engine(), "valid": False, "error": {"code": exc.code, "message": exc.message}}
    return {"engine": engine(), "valid": True, "identifiers": chemistry.identifiers(mol), "stereo": chemistry.stereo_report(mol), "cip": chemistry.cip_labels(mol)}


@app.post("/v1/molecules/depict-2d")
def depict(body: StructureIn) -> dict[str, Any]:
    mol = chemistry.mol_from_text(body.structure)
    return {"engine": engine(), "molblock": chemistry.depict_2d(mol)}


@app.post("/v1/molecules/properties")
def props(body: StructureIn) -> dict[str, Any]:
    mol = chemistry.mol_from_text(body.structure)
    return {"engine": engine(), "properties": chemistry.properties(mol), "identifiers": chemistry.identifiers(mol), "stereo": chemistry.stereo_report(mol)}


class ConformersIn(BaseModel):
    smiles: str = Field(..., description="SMILES with atom maps = 1-based document atom order")
    count: int = 1
    seed: int = 0xF00D


@app.post("/v1/molecules/conformers")
def confs(body: ConformersIn) -> dict[str, Any]:
    key = f"conf:{body.smiles}:{body.count}:{body.seed}:{chemistry.RDKIT_VERSION}"
    hit = store.cache_get(key)
    if hit:
        return {"engine": engine(), **hit, "cached": True}
    res = chemistry.conformers(body.smiles, body.count, body.seed)
    store.cache_put(key, res)
    return {"engine": engine(), **res}


class ScanIn(BaseModel):
    smiles: str
    coordinates: dict[str, list[float]]
    dihedral: list[int]
    angles: list[float]
    relax: bool = False


@app.post("/v1/molecules/dihedral-scan")
def scan(body: ScanIn) -> dict[str, Any]:
    return {"engine": engine(), **chemistry.mmff_energy_scan(body.smiles, body.coordinates, body.dihedral, body.angles, body.relax)}


# ---------------------------------------------------------------------------------------------
# Names


class ResolveIn(BaseModel):
    query: str


@app.post("/v1/names/resolve")
async def resolve(body: ResolveIn) -> dict[str, Any]:
    if len(body.query) > 500:
        raise HTTPException(400, "Query too long")
    return await naming.resolve(body.query)


class CourseName(BaseModel):
    name: str
    kind: str = "systematic"
    profile: str | None = None


class GenerateIn(BaseModel):
    smiles: str
    course: list[CourseName] = []


@app.post("/v1/names/generate")
async def generate(body: GenerateIn) -> dict[str, Any]:
    return await naming.generate(body.smiles, [c.model_dump() for c in body.course])


class VerifyIn(BaseModel):
    smiles: str
    names: list[str]


@app.post("/v1/names/verify")
async def verify(body: VerifyIn) -> dict[str, Any]:
    target = chemistry.mol_from_text(body.smiles)
    return {"engine": engine(), "results": [await naming.verify_name(target, n) for n in body.names[:40]]}


class CheckIn(BaseModel):
    targetSmiles: str
    answer: str


@app.post("/v1/names/check-answer")
async def check(body: CheckIn) -> dict[str, Any]:
    return {"engine": engine(), **(await naming.check_answer(body.targetSmiles, body.answer))}


class ParseIn(BaseModel):
    name: str


@app.post("/v1/names/parse")
async def parse_name(body: ParseIn) -> dict[str, Any]:
    normalized, changes = naming.normalize(body.name)
    r = await opsin.parse(normalized)
    out: dict[str, Any] = {"engine": engine(), "normalized": normalized, "changes": changes, "status": r.status, "message": r.message, "flags": r.flags}
    if r.ok:
        mol = chemistry.try_mol(r.smiles)
        if mol is not None:
            out["identifiers"] = chemistry.identifiers(mol)
            out["stereo"] = chemistry.stereo_report(mol)
    return out


@app.get("/v1/names/autocomplete")
async def autocomplete(q: str) -> dict[str, Any]:
    try:
        return {"terms": await pubchem.autocomplete(q, 8), "available": True}
    except pubchem.PubChemUnavailable as exc:
        return {"terms": [], "available": False, "reason": str(exc)}


@app.get("/v1/pubchem/{cid}/sdf3d")
async def sdf3d(cid: int) -> dict[str, Any]:
    try:
        return {"sdf": await pubchem.sdf_3d(cid), "available": True}
    except pubchem.PubChemUnavailable as exc:
        return {"sdf": None, "available": False, "reason": str(exc)}


# ---------------------------------------------------------------------------------------------
# Shares (unlisted, immutable snapshots)


class ShareIn(BaseModel):
    title: str | None = None
    snapshot: dict[str, Any]


@app.post("/v1/shares")
def create_share(body: ShareIn, request: Request) -> dict[str, Any]:
    import json

    raw = json.dumps(body.snapshot)
    if len(raw) > 2_000_000:
        raise HTTPException(413, "Snapshot too large")
    sid = secrets.token_urlsafe(9)
    owner = _user_id(request)
    store.share_create(sid, owner, body.title, raw)
    return {"id": sid}


@app.get("/v1/shares/{sid}")
def get_share(sid: str) -> dict[str, Any]:
    import json

    rec = store.share_get(sid)
    if not rec:
        raise HTTPException(404, "This share link does not exist (or was deleted).")
    store.share_viewed(sid)
    return {"id": sid, "title": rec["title"], "snapshot": json.loads(rec["snapshot"]), "created": rec["created"]}


# ---------------------------------------------------------------------------------------------
# AR assets: USDZ (iOS Quick Look) and GLB (Android Scene Viewer) need a real https URL.
# Files are anonymous, content-addressed, and deleted after 24 hours.

AR_TYPES = {"usdz": "model/vnd.usdz+zip", "glb": "model/gltf-binary"}


@app.post("/v1/ar-assets")
async def upload_ar_asset(request: Request, ext: str) -> dict[str, Any]:
    import hashlib

    if ext not in AR_TYPES:
        raise HTTPException(400, "ext must be usdz or glb")
    body = await request.body()
    # Hosted functions cap request bodies at 4.5 MB; course molecules are far smaller.
    if not body or len(body) > 4_000_000:
        raise HTTPException(413, "Asset missing or larger than 4 MB")
    now = time.time()
    name = f"{hashlib.sha256(body).hexdigest()[:20]}.{ext}"
    store.blob_put(name, body, 24 * 3600)
    return {"name": name, "url": f"/api/v1/ar-assets/{name}", "expires": now + 24 * 3600}


@app.get("/v1/ar-assets/{name}")
def get_ar_asset(name: str):
    from fastapi.responses import Response as RawResponse

    stem, _, ext = name.partition(".")
    if ext not in AR_TYPES or not stem.isalnum():
        raise HTTPException(404, "Not found")
    data = store.blob_get(name)
    if data is None:
        raise HTTPException(404, "This AR model expired; open it again from Orbital.")
    return RawResponse(data, media_type=AR_TYPES[ext], headers={"Cache-Control": "public, max-age=86400"})


# ---------------------------------------------------------------------------------------------
# Analytics (no raw AI conversations are logged)


class EventsIn(BaseModel):
    session: str
    events: list[dict[str, Any]]


ALLOWED_EVENTS = {
    "studio_opened", "first_molecule_completed", "atom_added", "bond_changed", "invalid_edit_attempted", "input_name_resolved",
    "input_name_ambiguous", "input_name_failed", "structure_name_verified", "structure_name_unsupported", "naming_step_opened",
    "why_not_numbering_opened", "projection_opened", "ar_opened", "practice_started", "hint_level_used", "answer_corrected",
    "scan_started", "scan_correction_required", "scan_accepted", "molecule_saved", "molecule_shared", "molecule_exported",
    "study_room_joined", "return_session", "explanation_interaction", "answer_checked", "tour_started", "tour_completed",
    "tour_skipped",
}


@app.post("/v1/analytics/events")
def events(body: EventsIn) -> dict[str, Any]:
    import json

    n = 0
    for e in body.events[:200]:
        name = str(e.get("name", ""))
        if name not in ALLOWED_EVENTS:
            continue
        props = {k: v for k, v in (e.get("props") or {}).items() if isinstance(v, (int, float, str, bool)) and k != "text"}
        store.event_add(float(e.get("at", time.time())), body.session[:64], name, json.dumps(props))
        n += 1
    return {"stored": n}


@app.get("/v1/analytics/metrics")
def metrics() -> dict[str, Any]:
    from . import analytics

    return analytics.compute()


# ---------------------------------------------------------------------------------------------
# Accounts, sync, deletion


def _user_id(request: Request) -> str | None:
    token = request.cookies.get("orbital_session")
    if not token:
        return None
    return store.session_user(token)


from . import accounts  # noqa: E402

app.include_router(accounts.router)

from . import tutor as tutor_module  # noqa: E402

app.include_router(tutor_module.router)

from . import quantum as quantum_module  # noqa: E402

app.include_router(quantum_module.router)

try:
    from . import ocsr as ocsr_module  # noqa: E402

    app.include_router(ocsr_module.router)
except Exception as exc:  # noqa: BLE001
    print(f"[orbital] OCSR routes disabled: {exc}")
