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

from . import db

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
    rows = db.query("SELECT user_id FROM sessions WHERE token=?", (token,))
    return rows[0][0] if rows else None


def _require(request: Request) -> str:
    uid = current_user(request)
    if not uid:
        raise HTTPException(401, "Sign in to sync across devices.")
    return uid


def _start_session(response: Response, uid: str) -> None:
    token = secrets.token_urlsafe(32)
    db.execute("INSERT INTO sessions(token, user_id, created) VALUES (?,?,?)", (token, uid, time.time()))
    response.set_cookie(COOKIE, token, httponly=True, samesite="lax", max_age=60 * 60 * 24 * 90, path="/")


@router.post("/v1/auth/register")
def register(body: Creds, response: Response) -> dict[str, Any]:
    email = body.email.strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        raise HTTPException(400, "Enter a valid email address.")
    if len(body.password) < 8:
        raise HTTPException(400, "Use at least 8 characters for the password.")
    if db.query("SELECT 1 FROM users WHERE email=?", (email,)):
        raise HTTPException(409, "An account with this email already exists.")
    uid = secrets.token_hex(8)
    db.execute("INSERT INTO users(id, email, pw_hash, created) VALUES (?,?,?,?)", (uid, email, _hash(body.password), time.time()))
    _start_session(response, uid)
    return {"id": uid, "email": email}


@router.post("/v1/auth/login")
def login(body: Creds, response: Response) -> dict[str, Any]:
    email = body.email.strip().lower()
    rows = db.query("SELECT id, pw_hash FROM users WHERE email=?", (email,))
    if not rows or not _check(body.password, rows[0][1]):
        raise HTTPException(401, "Email or password is incorrect.")
    _start_session(response, rows[0][0])
    return {"id": rows[0][0], "email": email}


@router.post("/v1/auth/logout")
def logout(request: Request, response: Response) -> dict[str, Any]:
    token = request.cookies.get(COOKIE)
    if token:
        db.execute("DELETE FROM sessions WHERE token=?", (token,))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/v1/auth/me")
def me(request: Request) -> dict[str, Any]:
    uid = current_user(request)
    if not uid:
        return {"user": None}
    rows = db.query("SELECT email, course_profile FROM users WHERE id=?", (uid,))
    return {"user": {"id": uid, "email": rows[0][0], "courseProfile": rows[0][1]} if rows else None}


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
        rows = db.query("SELECT updated FROM user_docs WHERE user_id=? AND doc_id=?", (uid, did))
        if rows and rows[0][0] >= updated:
            continue
        db.execute("INSERT OR REPLACE INTO user_docs(user_id, doc_id, updated, body, deleted) VALUES (?,?,?,?,?)",
                   (uid, did, updated, json.dumps(d.get("body")), 1 if d.get("deleted") else 0))
    rows = db.query("SELECT doc_id, updated, body, deleted FROM user_docs WHERE user_id=?", (uid,))
    return {"docs": [{"id": r[0], "updated": r[1], "body": json.loads(r[2]), "deleted": bool(r[3])} for r in rows]}


class StateIn(BaseModel):
    key: str
    body: dict[str, Any]
    updated: float


@router.post("/v1/sync/state")
def sync_state(body: StateIn, request: Request) -> dict[str, Any]:
    uid = _require(request)
    key = body.key[:64]
    rows = db.query("SELECT updated, body FROM user_state WHERE user_id=? AND key=?", (uid, key))
    if rows and rows[0][0] > body.updated:
        return {"key": key, "updated": rows[0][0], "body": json.loads(rows[0][1])}
    db.execute("INSERT OR REPLACE INTO user_state(user_id, key, updated, body) VALUES (?,?,?,?)", (uid, key, body.updated, json.dumps(body.body)))
    return {"key": key, "updated": body.updated, "body": body.body}


class ProfileIn(BaseModel):
    courseProfile: str


@router.post("/v1/auth/profile")
def set_profile(body: ProfileIn, request: Request) -> dict[str, Any]:
    uid = _require(request)
    db.execute("UPDATE users SET course_profile=? WHERE id=?", (body.courseProfile[:64], uid))
    return {"ok": True}


@router.get("/v1/account/export")
def export_all(request: Request) -> dict[str, Any]:
    uid = _require(request)
    user = db.query("SELECT email, created, course_profile FROM users WHERE id=?", (uid,))
    docs = db.query("SELECT doc_id, updated, body, deleted FROM user_docs WHERE user_id=?", (uid,))
    state = db.query("SELECT key, updated, body FROM user_state WHERE user_id=?", (uid,))
    shares = db.query("SELECT id, created, title FROM shares WHERE owner=?", (uid,))
    return {
        "user": {"id": uid, "email": user[0][0], "created": user[0][1], "courseProfile": user[0][2]} if user else None,
        "docs": [{"id": d[0], "updated": d[1], "body": json.loads(d[2]), "deleted": bool(d[3])} for d in docs],
        "state": [{"key": s[0], "updated": s[1], "body": json.loads(s[2])} for s in state],
        "shares": [{"id": s[0], "created": s[1], "title": s[2]} for s in shares],
    }


@router.delete("/v1/account")
def delete_all(request: Request, response: Response) -> dict[str, Any]:
    uid = _require(request)
    for sql in ("DELETE FROM user_docs WHERE user_id=?", "DELETE FROM user_state WHERE user_id=?", "DELETE FROM shares WHERE owner=?",
                "DELETE FROM sessions WHERE user_id=?", "DELETE FROM users WHERE id=?"):
        db.execute(sql, (uid,))
    response.delete_cookie(COOKIE, path="/")
    return {"deleted": True}
