// Study-room relay (spec §14): Yjs documents over WebSockets, y-websocket wire protocol.
// Rooms live in memory only and disappear a few minutes after the last person leaves —
// nothing is written to disk.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const PORT = Number(process.env.PORT ?? 8720);
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const ROOM_TTL_MS = 5 * 60 * 1000;
const MAX_ROOMS = 500;

/** @type {Map<string, { doc: Y.Doc, awareness: awarenessProtocol.Awareness, conns: Map<import('ws').WebSocket, Set<number>>, idle?: NodeJS.Timeout }>} */
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
  room = { doc, awareness, conns: new Map() };
  doc.on('update', (update, origin) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const msg = encoding.toUint8Array(enc);
    for (const conn of room.conns.keys()) if (conn !== origin) send(conn, msg);
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
  });
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
  if (ids?.size) awarenessProtocol.removeAwarenessStates(room.awareness, [...ids], null);
  if (!room.conns.size) {
    room.idle = setTimeout(() => {
      room.doc.destroy();
      rooms.delete(name);
    }, ROOM_TTL_MS);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const name = decodeURIComponent((req.url ?? '/').split('?')[0].slice(1));
  if (!/^[\w-]{4,64}$/.test(name)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const room = getRoom(name);
    if (!room) {
      ws.close(1013, 'Too many rooms');
      return;
    }
    ws.binaryType = 'arraybuffer';
    room.conns.set(ws, new Set());
    ws.on('message', (data) => {
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
        console.error('bad message', e);
      }
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
    // Greet with our state vector and current presence.
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

server.listen(PORT, () => console.log(`Orbital rooms relay on :${PORT}`));
