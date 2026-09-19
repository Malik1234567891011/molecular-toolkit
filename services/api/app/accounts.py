"""Optional accounts (spec §20): only for cross-device sync. Everything works signed-out.

Passwords are hashed with scrypt; sessions are opaque random tokens in an HttpOnly cookie.
Users can export and delete all of their data.
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from . import store

router = APIRouter()
COOKIE = "orbital_session"


def _hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return salt.hex() + ":" + dk.hex()


def _check(password: str, stored: str) -> bool:
    salt_hex, dk_hex = stored.split(":")
    return secrets.compare_digest(_hash(password, bytes.fromhex(salt_hex)).split(":")[1], dk_hex)


class Creds(BaseModel):
    email: str
    password: str


def current_user(request: Request) -> str | None:
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    return store.session_user(token)


def _require(request: Request) -> str:
    uid = current_user(request)
    if not uid:
        raise HTTPException(401, "Sign in to sync across devices.")
    return uid


def _start_session(response: Response, uid: str) -> None:
    token = secrets.token_urlsafe(32)
    store.session_create(token, uid)
    response.set_cookie(COOKIE, token, httponly=True, samesite="lax", max_age=60 * 60 * 24 * 90, path="/")


@router.post("/v1/auth/register")
def register(body: Creds, response: Response) -> dict[str, Any]:
    email = body.email.strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        raise HTTPException(400, "Enter a valid email address.")
    if len(body.password) < 8:
        raise HTTPException(400, "Use at least 8 characters for the password.")
    uid = secrets.token_hex(8)
    try:
        created = store.user_create(uid, email, _hash(body.password))
    except ValueError:
        raise HTTPException(400, "Use an email address made of letters, digits and . _ + - @.") from None
    if not created:
        raise HTTPException(409, "An account with this email already exists.")
    _start_session(response, uid)
    return {"id": uid, "email": email}


@router.post("/v1/auth/login")
def login(body: Creds, response: Response) -> dict[str, Any]:
    email = body.email.strip().lower()
    found = store.user_by_email(email)
    if not found or not _check(body.password, found[1]):
        raise HTTPException(401, "Email or password is incorrect.")
    _start_session(response, found[0])
    return {"id": found[0], "email": email}


@router.post("/v1/auth/logout")
def logout(request: Request, response: Response) -> dict[str, Any]:
    token = request.cookies.get(COOKIE)
    if token:
        store.session_delete(token)
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/v1/auth/me")
def me(request: Request) -> dict[str, Any]:
    uid = current_user(request)
    if not uid:
        return {"user": None}
    user = store.user_get(uid)
    return {"user": {"id": uid, "email": user["email"], "courseProfile": user.get("course_profile")} if user else None}


class DocsIn(BaseModel):
    docs: list[dict[str, Any]]  # [{id, updated, body, deleted}]


@router.post("/v1/sync/docs")
def sync_docs(body: DocsIn, request: Request) -> dict[str, Any]:
    """Last-writer-wins per document; returns the merged set so the client can reconcile."""
    uid = _require(request)
    for d in body.docs[:500]:
        did = str(d.get("id", ""))[:64]
        if not did:
            continue
        updated = float(d.get("updated", 0))
        prev = store.doc_updated(uid, did)
        if prev is not None and prev >= updated:
            continue
        store.doc_put(uid, did, updated, json.dumps(d.get("body")), bool(d.get("deleted")))
    rows = store.docs_of(uid)
    return {"docs": [{"id": r[0], "updated": r[1], "body": json.loads(r[2]), "deleted": r[3]} for r in rows]}


class StateIn(BaseModel):
    key: str
    body: dict[str, Any]
    updated: float


@router.post("/v1/sync/state")
def sync_state(body: StateIn, request: Request) -> dict[str, Any]:
    uid = _require(request)
    key = body.key[:64]
    prev = store.state_get(uid, key)
    if prev and prev[0] > body.updated:
        return {"key": key, "updated": prev[0], "body": json.loads(prev[1])}
    store.state_put(uid, key, body.updated, json.dumps(body.body))
    return {"key": key, "updated": body.updated, "body": body.body}


class ProfileIn(BaseModel):
    courseProfile: str


@router.post("/v1/auth/profile")
def set_profile(body: ProfileIn, request: Request) -> dict[str, Any]:
    uid = _require(request)
    store.user_set_profile(uid, body.courseProfile[:64])
    return {"ok": True}


@router.get("/v1/account/export")
def export_all(request: Request) -> dict[str, Any]:
    uid = _require(request)
    user = store.user_get(uid)
    return {
        "user": {"id": uid, "email": user["email"], "created": user["created"], "courseProfile": user.get("course_profile")} if user else None,
        "docs": [{"id": d[0], "updated": d[1], "body": json.loads(d[2]), "deleted": d[3]} for d in store.docs_of(uid)],
        "state": [{"key": s[0], "updated": s[1], "body": json.loads(s[2])} for s in store.states_of(uid)],
        "shares": store.shares_of(uid),
    }


@router.delete("/v1/account")
def delete_all(request: Request, response: Response) -> dict[str, Any]:
    uid = _require(request)
    store.user_delete_all(uid)
    response.delete_cookie(COOKIE, path="/")
    return {"deleted": True}
