"""Persistence behind named operations: shares, accounts, synced documents, practice state,
analytics events, quantum jobs, caches and short-lived AR files.

Two backends with identical behaviour:
- SQLite (services/api/data) for local development — the default;
- Redis when REDIS_URL (or KV_URL) is set, as on Vercel, where containers are stateless and
  anything written to their disk is gone after a scale-down.

Every Redis key lives under PREFIX, and every id that reaches a key is validated, so these
operations can only ever touch Orbital's own records.
"""
from __future__ import annotations

import json
import os
import re
import time
from typing import Any

from . import config, db

PREFIX = "orbital:"
DAY = 24 * 3600
_ID = re.compile(r"^[A-Za-z0-9_.@+\-]{1,200}$")

_redis = None
_url = os.environ.get("REDIS_URL") or os.environ.get("KV_URL") or ""


def _safe(part: str) -> str:
    """Ids come from requests (share ids, tokens, emails); refuse anything odd rather than escape it."""
    if not _ID.match(part):
        raise ValueError("invalid id")
    return part


def _k(*parts: str) -> str:
    return PREFIX + ":".join(_safe(p) for p in parts)


def backend() -> str:
    return "redis" if _url else "sqlite"


def r():
    global _redis
    if _redis is None:
        import redis

        _redis = redis.Redis.from_url(_url, decode_responses=False, socket_timeout=10, socket_connect_timeout=10, health_check_interval=30)
    return _redis


def _j(v: bytes | str | None) -> Any:
    if v is None:
        return None
    return json.loads(v)


# --------------------------------------------------------------------------------------------
# Cache (PubChem lookups, conformers): losing it only costs a refetch.


def cache_get(key: str, max_age: float | None = None) -> Any | None:
    if backend() == "sqlite":
        return db.cache_get(key, max_age)
    raw = r().get(PREFIX + "cache:" + key[:400])
    if raw is None:
        return None
    rec = json.loads(raw)
    if max_age is not None and time.time() - rec["t"] > max_age:
        return None
    return rec["v"]


def cache_put(key: str, value: Any) -> None:
    if backend() == "sqlite":
        return db.cache_put(key, value)
    r().set(PREFIX + "cache:" + key[:400], json.dumps({"v": value, "t": time.time()}), ex=30 * DAY)


# --------------------------------------------------------------------------------------------
# Shares: immutable snapshots behind unlisted ids.


def share_create(sid: str, owner: str | None, title: str | None, snapshot: str) -> None:
    now = time.time()
    if backend() == "sqlite":
        db.execute("INSERT INTO shares(id, created, owner, title, snapshot) VALUES (?,?,?,?,?)", (sid, now, owner, title, snapshot))
        return
    r().set(_k("share", sid), json.dumps({"created": now, "owner": owner, "title": title, "snapshot": snapshot}))
    if owner:
        r().sadd(_k("shares_of", owner), sid)


def share_get(sid: str) -> dict[str, Any] | None:
    try:
        _safe(sid)
    except ValueError:
        return None
    if backend() == "sqlite":
        rows = db.query("SELECT title, snapshot, created FROM shares WHERE id=?", (sid,))
        return {"title": rows[0][0], "snapshot": rows[0][1], "created": rows[0][2]} if rows else None
    rec = _j(r().get(_k("share", sid)))
    return {"title": rec["title"], "snapshot": rec["snapshot"], "created": rec["created"]} if rec else None


def share_viewed(sid: str) -> None:
    if backend() == "sqlite":
        db.execute("UPDATE shares SET views = views + 1 WHERE id=?", (sid,))
    else:
        r().incr(_k("share_views", sid))


def shares_of(owner: str) -> list[dict[str, Any]]:
    if backend() == "sqlite":
        return [{"id": s[0], "created": s[1], "title": s[2]} for s in db.query("SELECT id, created, title FROM shares WHERE owner=?", (owner,))]
    out = []
    for sid in r().smembers(_k("shares_of", owner)):
        sid = sid.decode()
        rec = _j(r().get(_k("share", sid)))
        if rec:
            out.append({"id": sid, "created": rec["created"], "title": rec["title"]})
    return out


def shares_delete_owner(owner: str) -> None:
    if backend() == "sqlite":
        db.execute("DELETE FROM shares WHERE owner=?", (owner,))
        return
    for sid in r().smembers(_k("shares_of", owner)):
        r().delete(_k("share", sid.decode()), _k("share_views", sid.decode()))
    r().delete(_k("shares_of", owner))


# --------------------------------------------------------------------------------------------
# Analytics events (spec §22): names and small counts only.

EVENTS_KEPT = 20000


def event_add(at: float, session: str, name: str, props: str) -> None:
    if backend() == "sqlite":
        db.execute("INSERT INTO events(at, session, name, props) VALUES (?,?,?,?)", (at, session, name, props))
        return
    key = PREFIX + "events"
    r().rpush(key, json.dumps([at, session, name, props]))
    r().ltrim(key, -EVENTS_KEPT, -1)


def events_all() -> list[tuple[float, str, str, str]]:
    if backend() == "sqlite":
        return [tuple(x) for x in db.query("SELECT at, session, name, props FROM events ORDER BY at")]
    rows = [tuple(json.loads(x)) for x in r().lrange(PREFIX + "events", 0, -1)]
    rows.sort(key=lambda x: x[0])
    return rows


# --------------------------------------------------------------------------------------------
# Accounts and sessions.

SESSION_TTL = 90 * DAY


def session_create(token: str, uid: str) -> None:
    if backend() == "sqlite":
        db.execute("INSERT INTO sessions(token, user_id, created) VALUES (?,?,?)", (token, uid, time.time()))
        return
    r().set(_k("session", token), uid, ex=SESSION_TTL)
    r().sadd(_k("sessions_of", uid), token)


def session_user(token: str) -> str | None:
    try:
        _safe(token)
    except ValueError:
        return None
    if backend() == "sqlite":
        rows = db.query("SELECT user_id FROM sessions WHERE token=?", (token,))
        return rows[0][0] if rows else None
    v = r().get(_k("session", token))
    return v.decode() if v else None


def session_delete(token: str) -> None:
    try:
        _safe(token)
    except ValueError:
        return
    if backend() == "sqlite":
        db.execute("DELETE FROM sessions WHERE token=?", (token,))
    else:
        r().delete(_k("session", token))


def user_by_email(email: str) -> tuple[str, str] | None:
    """(user id, password hash)."""
    try:
        _safe(email)
    except ValueError:
        return None
    if backend() == "sqlite":
        rows = db.query("SELECT id, pw_hash FROM users WHERE email=?", (email,))
        return (rows[0][0], rows[0][1]) if rows else None
    uid = r().get(_k("email", email))
    if not uid:
        return None
    rec = _j(r().get(_k("user", uid.decode())))
    return (uid.decode(), rec["pw_hash"]) if rec else None


def user_create(uid: str, email: str, pw_hash: str) -> bool:
    """False when the email is taken."""
    _safe(email)
    if backend() == "sqlite":
        if db.query("SELECT 1 FROM users WHERE email=?", (email,)):
            return False
        db.execute("INSERT INTO users(id, email, pw_hash, created) VALUES (?,?,?,?)", (uid, email, pw_hash, time.time()))
        return True
    if not r().set(_k("email", email), uid, nx=True):
        return False
    r().set(_k("user", uid), json.dumps({"email": email, "pw_hash": pw_hash, "created": time.time(), "course_profile": None}))
    return True


def user_get(uid: str) -> dict[str, Any] | None:
    if backend() == "sqlite":
        rows = db.query("SELECT email, created, course_profile FROM users WHERE id=?", (uid,))
        return {"email": rows[0][0], "created": rows[0][1], "course_profile": rows[0][2]} if rows else None
    return _j(r().get(_k("user", uid)))


def user_set_profile(uid: str, profile: str) -> None:
    if backend() == "sqlite":
        db.execute("UPDATE users SET course_profile=? WHERE id=?", (profile, uid))
        return
    rec = _j(r().get(_k("user", uid)))
    if rec:
        rec["course_profile"] = profile
        r().set(_k("user", uid), json.dumps(rec))


def user_delete_all(uid: str) -> None:
    """Delete the account and everything it owns (spec §20: full deletion)."""
    if backend() == "sqlite":
        for sql in ("DELETE FROM user_docs WHERE user_id=?", "DELETE FROM user_state WHERE user_id=?", "DELETE FROM shares WHERE owner=?",
                    "DELETE FROM sessions WHERE user_id=?", "DELETE FROM users WHERE id=?"):
            db.execute(sql, (uid,))
        return
    rec = _j(r().get(_k("user", uid)))
    shares_delete_owner(uid)
    for tok in r().smembers(_k("sessions_of", uid)):
        r().delete(_k("session", tok.decode()))
    keys = [_k("sessions_of", uid), _k("docs", uid), _k("state", uid), _k("user", uid)]
    if rec and rec.get("email"):
        keys.append(_k("email", rec["email"]))
    r().delete(*keys)


# --------------------------------------------------------------------------------------------
# Synced documents and practice state (last writer wins).


def doc_updated(uid: str, did: str) -> float | None:
    if backend() == "sqlite":
        rows = db.query("SELECT updated FROM user_docs WHERE user_id=? AND doc_id=?", (uid, did))
        return rows[0][0] if rows else None
    rec = _j(r().hget(_k("docs", uid), did))
    return rec["updated"] if rec else None


def doc_put(uid: str, did: str, updated: float, body: str, deleted: bool) -> None:
    if backend() == "sqlite":
        db.execute("INSERT OR REPLACE INTO user_docs(user_id, doc_id, updated, body, deleted) VALUES (?,?,?,?,?)", (uid, did, updated, body, 1 if deleted else 0))
        return
    r().hset(_k("docs", uid), did, json.dumps({"updated": updated, "body": body, "deleted": deleted}))


def docs_of(uid: str) -> list[tuple[str, float, str, bool]]:
    if backend() == "sqlite":
        return [(x[0], x[1], x[2], bool(x[3])) for x in db.query("SELECT doc_id, updated, body, deleted FROM user_docs WHERE user_id=?", (uid,))]
    out = []
    for did, raw in r().hgetall(_k("docs", uid)).items():
        rec = json.loads(raw)
        out.append((did.decode(), rec["updated"], rec["body"], bool(rec["deleted"])))
    return out


def state_get(uid: str, key: str) -> tuple[float, str] | None:
    if backend() == "sqlite":
        rows = db.query("SELECT updated, body FROM user_state WHERE user_id=? AND key=?", (uid, key))
        return (rows[0][0], rows[0][1]) if rows else None
    rec = _j(r().hget(_k("state", uid), key))
    return (rec["updated"], rec["body"]) if rec else None


def state_put(uid: str, key: str, updated: float, body: str) -> None:
    if backend() == "sqlite":
        db.execute("INSERT OR REPLACE INTO user_state(user_id, key, updated, body) VALUES (?,?,?,?)", (uid, key, updated, body))
        return
    r().hset(_k("state", uid), key, json.dumps({"updated": updated, "body": body}))


def states_of(uid: str) -> list[tuple[str, float, str]]:
    if backend() == "sqlite":
        return [(x[0], x[1], x[2]) for x in db.query("SELECT key, updated, body FROM user_state WHERE user_id=?", (uid,))]
    return [(k.decode(), json.loads(v)["updated"], json.loads(v)["body"]) for k, v in r().hgetall(_k("state", uid)).items()]


# --------------------------------------------------------------------------------------------
# Quantum jobs.

JOB_TTL = 7 * DAY


def job_get(jid: str) -> dict[str, Any] | None:
    try:
        _safe(jid)
    except ValueError:
        return None
    if backend() == "sqlite":
        rows = db.query("SELECT kind, status, created, updated, request, result, error FROM jobs WHERE id=?", (jid,))
        if not rows:
            return None
        k, s, c, u, req, res, err = rows[0]
        return {"kind": k, "status": s, "created": c, "updated": u, "request": req, "result": res, "error": err}
    return _j(r().get(_k("job", jid)))


def job_put(jid: str, kind: str, status: str, request: str) -> None:
    now = time.time()
    if backend() == "sqlite":
        db.execute("INSERT OR REPLACE INTO jobs(id, kind, status, created, updated, request) VALUES (?,?,?,?,?,?)", (jid, kind, status, now, now, request))
        return
    r().set(_k("job", jid), json.dumps({"kind": kind, "status": status, "created": now, "updated": now, "request": request, "result": None, "error": None}), ex=JOB_TTL)


def job_update(jid: str, status: str, result: str | None = None, error: str | None = None) -> None:
    now = time.time()
    if backend() == "sqlite":
        if result is not None:
            db.execute("UPDATE jobs SET status=?, updated=?, result=? WHERE id=?", (status, now, result, jid))
        elif error is not None:
            db.execute("UPDATE jobs SET status=?, updated=?, error=? WHERE id=?", (status, now, error, jid))
        else:
            db.execute("UPDATE jobs SET status=?, updated=? WHERE id=?", (status, now, jid))
        return
    rec = _j(r().get(_k("job", jid))) or {"kind": "", "created": now, "request": "{}"}
    rec.update({"status": status, "updated": now})
    if result is not None:
        rec["result"] = result
    if error is not None:
        rec["error"] = error
    r().set(_k("job", jid), json.dumps(rec), ex=JOB_TTL)


# --------------------------------------------------------------------------------------------
# Short-lived files (AR models handed to a phone's viewer).


def blob_put(name: str, data: bytes, ttl: int) -> None:
    if backend() == "sqlite":
        path = config.DATA_DIR / "ar"
        path.mkdir(parents=True, exist_ok=True)
        (path / _safe(name)).write_bytes(data)
        return
    r().set(_k("blob", name), data, ex=ttl)


def blob_get(name: str) -> bytes | None:
    try:
        _safe(name)
    except ValueError:
        return None
    if backend() == "sqlite":
        path = config.DATA_DIR / "ar" / name
        return path.read_bytes() if path.exists() else None
    return r().get(_k("blob", name))
