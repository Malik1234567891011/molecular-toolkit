"""PubChem PUG REST adapter: exact-match lookup, synonyms, autocomplete.

Respects the usage policy (≤5 requests/second) with a token bucket, caches aggressively
(InChIKey / CID keyed, long TTL) and degrades gracefully: callers get `available=False`
instead of an exception when PubChem is slow, rate-limited or unreachable.
"""
from __future__ import annotations

import asyncio
import time
import urllib.parse
from typing import Any

import httpx

from . import config, store

_client: httpx.AsyncClient | None = None
_bucket_lock = asyncio.Lock()
_tokens = 5.0
_last = time.monotonic()
DAY = 86400.0


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=config.PUBCHEM_TIMEOUT, headers={"User-Agent": "Orbital-molecular-studio/0.1 (education)"})
    return _client


async def _throttle() -> None:
    global _tokens, _last
    async with _bucket_lock:
        while True:
            now = time.monotonic()
            _tokens = min(5.0, _tokens + (now - _last) * 5.0)
            _last = now
            if _tokens >= 1:
                _tokens -= 1
                return
            await asyncio.sleep((1 - _tokens) / 5.0)


class PubChemUnavailable(Exception):
    pass


async def _get_json(path: str) -> Any | None:
    if config.OFFLINE:
        raise PubChemUnavailable("offline mode")
    await _throttle()
    url = f"{config.PUBCHEM_BASE}/{path}"
    try:
        r = await client().get(url)
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        raise PubChemUnavailable(str(exc)) from exc
    if r.status_code == 404:
        return None
    if r.status_code in (503, 429):
        raise PubChemUnavailable(f"PubChem busy ({r.status_code})")
    if r.status_code >= 400:
        return None
    try:
        return r.json()
    except ValueError:
        return None


def q(s: str) -> str:
    # PubChem requires '/' in SMILES to be escaped; quote everything.
    return urllib.parse.quote(s, safe="")


PROPS = "SMILES,ConnectivitySMILES,IUPACName,InChIKey,MolecularFormula,Title,MolecularWeight"


async def properties_for_cids(cids: list[int]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    missing: list[int] = []
    for cid in cids:
        hit = store.cache_get(f"pc:cid:{cid}", 30 * DAY)
        if hit:
            out.append(hit)
        else:
            missing.append(cid)
    if missing:
        data = await _get_json(f"pug/compound/cid/{','.join(map(str, missing))}/property/{PROPS}/JSON")
        for p in (data or {}).get("PropertyTable", {}).get("Properties", []):
            rec = {
                "cid": p.get("CID"),
                "smiles": p.get("SMILES") or p.get("IsomericSMILES") or p.get("ConnectivitySMILES"),
                "iupacName": p.get("IUPACName"),
                "inchiKey": p.get("InChIKey"),
                "formula": p.get("MolecularFormula"),
                "title": p.get("Title"),
                "molarMass": float(p["MolecularWeight"]) if p.get("MolecularWeight") else None,
            }
            store.cache_put(f"pc:cid:{rec['cid']}", rec)
            out.append(rec)
    order = {c: i for i, c in enumerate(cids)}
    return sorted(out, key=lambda r: order.get(r["cid"], 1e9))


async def cids_for_name(name: str) -> list[int]:
    key = f"pc:name:{name.strip().lower()}"
    hit = store.cache_get(key, DAY)
    if hit is not None:
        return hit
    data = await _get_json(f"pug/compound/name/{q(name)}/cids/JSON")
    cids = (data or {}).get("IdentifierList", {}).get("CID", [])[:5]
    store.cache_put(key, cids)
    return cids


async def cids_for_inchikey(key: str) -> list[int]:
    ck = f"pc:ik:{key}"
    hit = store.cache_get(ck, 30 * DAY)
    if hit is not None:
        return hit
    data = await _get_json(f"pug/compound/inchikey/{q(key)}/cids/JSON")
    cids = (data or {}).get("IdentifierList", {}).get("CID", [])[:3]
    store.cache_put(ck, cids)
    return cids


async def cids_for_formula(formula: str) -> list[int]:
    ck = f"pc:formula:{formula}"
    hit = store.cache_get(ck, 7 * DAY)
    if hit is not None:
        return hit
    data = await _get_json(f"pug/compound/fastformula/{q(formula)}/cids/JSON?MaxRecords=12")
    cids = (data or {}).get("IdentifierList", {}).get("CID", [])[:12]
    store.cache_put(ck, cids)
    return cids


async def synonyms(cid: int, limit: int = 20) -> list[str]:
    ck = f"pc:syn:{cid}"
    hit = store.cache_get(ck, 30 * DAY)
    if hit is None:
        data = await _get_json(f"pug/compound/cid/{cid}/synonyms/JSON")
        info = (data or {}).get("InformationList", {}).get("Information", [])
        hit = info[0].get("Synonym", [])[:60] if info else []
        store.cache_put(ck, hit)
    return hit[:limit]


async def autocomplete(query: str, limit: int = 8) -> list[str]:
    ck = f"pc:ac:{query.strip().lower()}:{limit}"
    hit = store.cache_get(ck, 7 * DAY)
    if hit is not None:
        return hit
    if config.OFFLINE:
        raise PubChemUnavailable("offline mode")
    await _throttle()
    try:
        r = await client().get(f"{config.PUBCHEM_BASE}/autocomplete/compound/{q(query)}/json", params={"limit": limit})
        terms = r.json().get("dictionary_terms", {}).get("compound", []) if r.status_code == 200 else []
    except (httpx.TimeoutException, httpx.TransportError, ValueError) as exc:
        raise PubChemUnavailable(str(exc)) from exc
    store.cache_put(ck, terms)
    return terms


async def sdf_3d(cid: int) -> str | None:
    ck = f"pc:sdf3d:{cid}"
    hit = store.cache_get(ck, 30 * DAY)
    if hit is not None:
        return hit or None
    if config.OFFLINE:
        raise PubChemUnavailable("offline mode")
    await _throttle()
    try:
        r = await client().get(f"{config.PUBCHEM_BASE}/pug/compound/cid/{cid}/record/SDF", params={"record_type": "3d"})
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        raise PubChemUnavailable(str(exc)) from exc
    text = r.text if r.status_code == 200 else ""
    store.cache_put(ck, text)
    return text or None
