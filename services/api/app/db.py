"""SQLite storage: caches, shares, analytics, accounts, synced molecules, practice state, quantum jobs."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any

from . import config

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS kv_cache (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY, created REAL NOT NULL, owner TEXT, title TEXT, snapshot TEXT NOT NULL, views INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL, session TEXT, name TEXT NOT NULL, props TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, pw_hash TEXT NOT NULL, created REAL NOT NULL, course_profile TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS user_docs (
  user_id TEXT NOT NULL, doc_id TEXT NOT NULL, updated REAL NOT NULL, body TEXT NOT NULL, deleted INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, doc_id)
);
CREATE TABLE IF NOT EXISTS user_state (
  user_id TEXT NOT NULL, key TEXT NOT NULL, updated REAL NOT NULL, body TEXT NOT NULL, PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL,
  request TEXT NOT NULL, result TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS events_name ON events(name);
"""


def conn() -> sqlite3.Connection:
    global _conn
    with _lock:
        if _conn is None:
            _conn = sqlite3.connect(config.DB_PATH, check_same_thread=False, isolation_level=None)
            _conn.execute("PRAGMA journal_mode=WAL")
            _conn.executescript(SCHEMA)
        return _conn


def cache_get(key: str, max_age: float | None = None) -> Any | None:
    with _lock:
        row = conn().execute("SELECT value, created FROM kv_cache WHERE key=?", (key,)).fetchone()
    if not row:
        return None
    if max_age is not None and time.time() - row[1] > max_age:
        return None
    return json.loads(row[0])


def cache_put(key: str, value: Any) -> None:
    with _lock:
        conn().execute("INSERT OR REPLACE INTO kv_cache(key, value, created) VALUES (?,?,?)", (key, json.dumps(value), time.time()))


def execute(sql: str, args: tuple = ()) -> sqlite3.Cursor:
    with _lock:
        return conn().execute(sql, args)


def query(sql: str, args: tuple = ()) -> list[tuple]:
    with _lock:
        return conn().execute(sql, args).fetchall()
