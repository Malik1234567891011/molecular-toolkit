// Study-room relay (spec §14): Yjs documents over WebSockets, y-websocket wire protocol.
//
// Locally (no REDIS_URL) rooms live in this process's memory and disappear a few minutes after
// the last person leaves.
//
// Hosted on Vercel the relay runs as functions: many instances, no affinity, and each socket is
// closed at the function's max duration (the client reconnects on its own). So a room can span
// instances and must outlive any one of them:
// - document updates are appended to a per-room Redis log (expires an hour after the room goes
//   quiet) and published on a per-room channel, so every instance converges on the same doc;
// - presence (cursors, names) is only published while another instance is in the room, and
//   coalesced, because it is chatty and Redis commands are metered.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const PORT = Number(process.env.PORT ?? 8720);
const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL || '';
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const ROOM_TTL_MS = REDIS_URL ? 30 * 1000 : 5 * 60 * 1000; // hosted, Redis keeps the room
const LOG_TTL_S = 60 * 60;
const COMPACT_AFTER = 40;
const AWARENESS_FLUSH_MS = 150;
const NUMSUB_TTL_MS = 10 * 1000;
const MAX_ROOMS = 500;
const ROOM_RE = /^[\w-]{4,64}$/;

// ------------------------------------------------------------------------------------------
// Redis (hosted only)

const INSTANCE = randomBytes(8);
const KIND_DOC = 0;
const KIND_AWARENESS = 1;
const KIND_HELLO = 2;
let pub = null;
let sub = null;
if (REDIS_URL) {
  const opts = { maxRetriesPerRequest: 3, enableAutoPipelining: true };
  pub = new Redis(REDIS_URL, opts);
  sub = new Redis(REDIS_URL, opts);
  pub.on('error', (e) => console.error('[rooms] redis', e.message));
  sub.on('error', (e) => console.error('[rooms] redis sub', e.message));
  sub.on('messageBuffer', (channel, message) => onRemote(channel.toString(), message));
}
// Every key sits under orbital:room:<validated name>: — nothing else in the database is touched.
const logKey = (name) => `orbital:room:${name}:log`;
const lockKey = (name) => `orbital:room:${name}:compact`;
const channelOf = (name) => `orbital:room:${name}:ch`;
const nameOf = (channel) => channel.slice('orbital:room:'.length, -':ch'.length);

function frame(kind, payload) {
  const out = Buffer.allocUnsafe(9 + payload.length);
  INSTANCE.copy(out, 0);
  out[8] = kind;
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(out, 9);
  return out;
}

async function loadRoom(name, room) {
  await sub.subscribe(channelOf(name));
  const items = await pub.lrangeBuffer(logKey(name), 0, -1);
  for (const u of items) Y.applyUpdate(room.doc, u, 'redis');
  await pub.expire(logKey(name), LOG_TTL_S);
  // Tell instances already in the room we're here, so they start sharing presence.
  await pub.publish(channelOf(name), frame(KIND_HELLO, new Uint8Array(0)));
  if (items.length > COMPACT_AFTER) void compact(name);
}

/** Replace the first n log entries by one garbage-collected snapshot of them. */
async function compact(name) {
  if (!(await pub.set(lockKey(name), '1', 'EX', 20, 'NX'))) return;
  try {
    const items = await pub.lrangeBuffer(logKey(name), 0, -1);
    if (items.length < 2) return;
    const d = new Y.Doc();
    for (const u of items) Y.applyUpdate(d, u);
    const merged = Buffer.from(Y.encodeStateAsUpdate(d));
    d.destroy();
    // Appends by other instances land after index n and survive the trim.
    await pub.multi().ltrim(logKey(name), items.length, -1).lpush(logKey(name), merged).expire(logKey(name), LOG_TTL_S).exec();
  } catch (e) {
    console.error('[rooms] compact', e.message);
  } finally {
    await pub.del(lockKey(name)).catch(() => {});
  }
}

function onRemote(channel, msg) {
  if (msg.length < 9 || msg.subarray(0, 8).equals(INSTANCE)) return;
  const room = rooms.get(nameOf(channel));
  if (!room) return;
  room.othersSeen = Date.now();
  const payload = new Uint8Array(msg.buffer, msg.byteOffset + 9, msg.length - 9);
  try {
    if (msg[8] === KIND_DOC) Y.applyUpdate(room.doc, payload, 'redis');
    else if (msg[8] === KIND_AWARENESS) awarenessProtocol.applyAwarenessUpdate(room.awareness, payload, 'redis');
    else if (msg[8] === KIND_HELLO) shareAllPresence(nameOf(channel), room);
  } catch (e) {
    console.error('[rooms] remote message', e.message);
  }
}

async function othersInRoom(name, room) {
  if (Date.now() - room.othersSeen < 45 * 1000) return true;
  if (Date.now() - room.numsubAt > NUMSUB_TTL_MS) {
    room.numsubAt = Date.now();
    try {
      const [, n] = await pub.pubsub('NUMSUB', channelOf(name));
      room.numsub = Number(n);
    } catch {
      room.numsub = 2; // can't tell: assume company
    }
  }
  return room.numsub > 1;
}

function shareAllPresence(name, room) {
  const ids = [...room.conns.values()].flatMap((s) => [...s]);
  if (ids.length) pub.publish(channelOf(name), frame(KIND_AWARENESS, awarenessProtocol.encodeAwarenessUpdate(room.awareness, ids))).catch(() => {});
}

// ------------------------------------------------------------------------------------------
// Rooms

/** @type {Map<string, any>} */
const rooms = new Map();

function getRoom(name) {
  let room = rooms.get(name);
  if (room) {
    clearTimeout(room.idle);
    return room;
  }
  if (rooms.size >= MAX_ROOMS) return null;
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null);
  room = { doc, awareness, conns: new Map(), ready: Promise.resolve(), appended: 0, othersSeen: 0, numsub: 0, numsubAt: 0, pending: new Set(), flush: null, keepAlive: null };
  doc.on('update', (update, origin) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const msg = encoding.toUint8Array(enc);
    for (const conn of room.conns.keys()) if (conn !== origin) send(conn, msg);
    if (pub && origin !== 'redis') {
      pub.pipeline().rpush(logKey(name), Buffer.from(update)).expire(logKey(name), LOG_TTL_S).publish(channelOf(name), frame(KIND_DOC, update)).exec().catch((e) => console.error('[rooms] persist', e.message));
      if (++room.appended >= COMPACT_AFTER) {
        room.appended = 0;
        void compact(name);
      }
    }
  });
  awareness.on('update', ({ added, updated, removed }, origin) => {
    const changed = added.concat(updated, removed);
    const ids = origin && room.conns.get(origin);
    if (ids) {
      for (const id of added) ids.add(id);
      for (const id of removed) ids.delete(id);
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
    const msg = encoding.toUint8Array(enc);
    for (const conn of room.conns.keys()) send(conn, msg);
    // Share our own clients' presence (not echoes of remote presence, not local timeouts).
    if (pub && (ids || origin === 'leave')) {
      for (const id of changed) room.pending.add(id);
      room.flush ??= setTimeout(async () => {
        room.flush = null;
        const ids = [...room.pending];
        room.pending.clear();
        if (ids.length && (await othersInRoom(name, room))) {
          pub.publish(channelOf(name), frame(KIND_AWARENESS, awarenessProtocol.encodeAwarenessUpdate(awareness, ids))).catch(() => {});
        }
      }, AWARENESS_FLUSH_MS);
    }
  });
  if (pub) {
    room.ready = loadRoom(name, room).catch((e) => console.error('[rooms] load', e.message));
    room.keepAlive = setInterval(() => pub.expire(logKey(name), LOG_TTL_S).catch(() => {}), 10 * 60 * 1000);
  }
  rooms.set(name, room);
  return room;
}

function send(conn, msg) {
  if (conn.readyState !== 1) return;
  try {
    conn.send(msg);
  } catch {
    conn.close();
  }
}

function leave(name, conn) {
  const room = rooms.get(name);
  if (!room) return;
  const ids = room.conns.get(conn);
  room.conns.delete(conn);
  if (ids?.size) awarenessProtocol.removeAwarenessStates(room.awareness, [...ids], 'leave');
  if (!room.conns.size) {
    room.idle = setTimeout(() => {
      clearInterval(room.keepAlive);
      clearTimeout(room.flush);
      room.awareness.destroy();
      room.doc.destroy();
      rooms.delete(name);
      sub?.unsubscribe(channelOf(name)).catch(() => {});
    }, ROOM_TTL_MS);
  }
}

// ------------------------------------------------------------------------------------------
// HTTP + WebSocket. Locally the room is the whole path (ws://host:8720/<room>); hosted, the site
// routes /rooms/<room> here.

const roomFromUrl = (url) => decodeURIComponent((url ?? '/').split('?')[0].replace(/^\/(rooms\/?)?/, ''));

const server = http.createServer((req, res) => {
  if (roomFromUrl(req.url) === 'health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, shared: Boolean(pub) }));
    return;
  }
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('Study rooms speak WebSocket.');
});

const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  const name = roomFromUrl(req.url);
  const room = ROOM_RE.test(name) ? getRoom(name) : null;
  if (!room) {
    ws.close(1008, ROOM_RE.test(name) ? 'Too many rooms' : 'Bad room name');
    return;
  }
  ws.binaryType = 'arraybuffer';
  room.conns.set(ws, new Set());
  // Messages can arrive while the room is still loading from Redis; handle them in order after.
  let queue = room.ready;
  ws.on('message', (data) => {
    queue = queue.then(() => {
      try {
        const dec = decoding.createDecoder(new Uint8Array(data));
        const enc = encoding.createEncoder();
        const type = decoding.readVarUint(dec);
        if (type === MSG_SYNC) {
          encoding.writeVarUint(enc, MSG_SYNC);
          syncProtocol.readSyncMessage(dec, enc, room.doc, ws);
          if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
        } else if (type === MSG_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(dec), ws);
        }
      } catch (e) {
        console.error('[rooms] bad message', e.message);
      }
    });
  });
  let alive = true;
  ws.on('pong', () => (alive = true));
  const ping = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }, 30000);
  ws.on('close', () => {
    clearInterval(ping);
    leave(name, ws);
  });
  // Greet with our state vector and current presence once the room is loaded.
  queue = queue.then(() => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, room.doc);
    send(ws, encoding.toUint8Array(enc));
    const states = room.awareness.getStates();
    if (states.size) {
      const aw = encoding.createEncoder();
      encoding.writeVarUint(aw, MSG_AWARENESS);
      encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]));
      send(ws, encoding.toUint8Array(aw));
    }
  });
});

// On Vercel the platform drives the exported server; anywhere else, listen.
if (!process.env.VERCEL) server.listen(PORT, () => console.log(`Orbital rooms relay on :${PORT}${pub ? ' (shared via Redis)' : ''}`));

export default server;
