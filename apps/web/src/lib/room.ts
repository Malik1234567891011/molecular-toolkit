'use client';
/**
 * Study rooms (spec §14): a shared molecule, live cursors and a shared chat (with tutor answers)
 * over Yjs. Rooms are ephemeral: in the relay's memory locally, and hosted in Redis until an hour
 * after the room goes quiet (services/rooms/server.mjs).
 */
import { create } from 'zustand';
import type { MoleculeDocument } from '@orbital/chem';
import { studio, useStudio } from './store';
import { track } from './analytics';

export interface Peer {
  clientId: number;
  name: string;
  color: string;
  cursor?: { x: number; y: number } | null;
  selection?: string[];
  view?: string;
}

export interface ChatMsg {
  id: string;
  name: string;
  color: string;
  text: string;
  at: number;
  tutor?: boolean;
}

interface RoomState {
  roomId: string | null;
  status: 'idle' | 'connecting' | 'connected' | 'offline';
  me: { name: string; color: string };
  peers: Peer[];
  chat: ChatMsg[];
}

const COLORS = ['#f59f00', '#12b886', '#4dabf7', '#f06595', '#94d82d', '#22b8cf', '#ff922b', '#b197fc'];
const ANIMALS = ['Otter', 'Lynx', 'Heron', 'Fox', 'Koala', 'Orca', 'Ibis', 'Panda', 'Gecko', 'Moth'];
const ADJ = ['Chiral', 'Aromatic', 'Polar', 'Axial', 'Covalent', 'Planar', 'Ionic', 'Staggered'];

function defaultMe() {
  try {
    const saved = JSON.parse(localStorage.getItem('orbital:room-me') ?? 'null');
    if (saved?.name) return saved as { name: string; color: string };
  } catch {
    /* ignore */
  }
  const r = Math.floor(Math.random() * 1e6);
  return { name: `${ADJ[r % ADJ.length]} ${ANIMALS[(r >> 3) % ANIMALS.length]}`, color: COLORS[(r >> 6) % COLORS.length] };
}

export const useRoom = create<RoomState>(() => ({ roomId: null, status: 'idle', me: typeof window === 'undefined' ? { name: 'Guest', color: COLORS[0] } : defaultMe(), peers: [], chat: [] }));

export function roomsUrl(): string {
  const env = process.env.NEXT_PUBLIC_ROOMS_URL;
  if (env) return env;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Local dev (and phones on the same Wi-Fi) reach the relay on its own port; hosted, the site
  // routes /rooms/<room> to it.
  const h = location.hostname;
  const local = h === 'localhost' || h.endsWith('.local') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  return local ? `${proto}://${h}:8720` : `${proto}://${location.host}/rooms`;
}

export function newRoomId(): string {
  const words = ['benzene', 'chair', 'orbital', 'pi', 'sigma', 'mirror', 'ring', 'alkyne'];
  return `${words[Math.floor(Math.random() * words.length)]}-${Math.random().toString(36).slice(2, 8)}`;
}

let cleanup: (() => void) | null = null;
let sendCursor: ((c: { x: number; y: number } | null) => void) | null = null;
let postChat: ((m: Omit<ChatMsg, 'id' | 'at'>) => void) | null = null;

export async function joinRoom(id: string): Promise<void> {
  leaveRoom();
  const [{ WebsocketProvider }, Y] = await Promise.all([import('y-websocket'), import('yjs')]);
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(roomsUrl(), id, ydoc, { connect: true });
  const mol = ydoc.getMap<string | number>('mol');
  const chat = ydoc.getArray<ChatMsg>('chat');
  const me = useRoom.getState().me;
  useRoom.setState({ roomId: id, status: 'connecting', chat: [], peers: [] });
  provider.awareness.setLocalState({ name: me.name, color: me.color, cursor: null, selection: [], view: studio().view });
  provider.on('status', (e: { status: string }) => useRoom.setState({ status: e.status === 'connected' ? 'connected' : e.status === 'connecting' ? 'connecting' : 'offline' }));

  let applyingRemote = false;
  let lastPushed = '';
  let synced = false;
  const pushLocal = () => {
    if (applyingRemote || !synced) return;
    const doc = studio().doc;
    const json = JSON.stringify({ ...doc, provenance: [] });
    if (json === lastPushed) return;
    lastPushed = json;
    ydoc.transact(() => {
      mol.set('doc', json);
      mol.set('by', me.name);
      mol.set('at', Date.now());
    }, 'local');
  };
  const applyRemote = () => {
    const json = mol.get('doc');
    if (typeof json !== 'string' || json === lastPushed) return;
    lastPushed = json;
    applyingRemote = true;
    try {
      const doc = JSON.parse(json) as MoleculeDocument;
      // Remote edits replace the canvas without flooding the local undo history.
      useStudio.setState((s) => ({ doc, version: s.version + 1, landing: false, geometry: doc.conformers.length ? 'relaxed' : 'none' }));
    } finally {
      applyingRemote = false;
    }
  };
  provider.on('sync', (isSynced: boolean) => {
    if (!isSynced || synced) return;
    synced = true;
    // First one in brings the molecule; later arrivals adopt the room's molecule.
    if (typeof mol.get('doc') === 'string') applyRemote();
    else pushLocal();
    track('study_room_joined', { peers: provider.awareness.getStates().size });
  });
  mol.observe((_e, tr) => {
    if (tr.origin !== 'local') applyRemote();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubStudio = useStudio.subscribe((s, prev) => {
    if (s.doc !== prev.doc && !applyingRemote) {
      clearTimeout(timer);
      timer = setTimeout(pushLocal, 120);
    }
    if (s.selection !== prev.selection || s.view !== prev.view) {
      provider.awareness.setLocalStateField('selection', s.selection.atoms);
      provider.awareness.setLocalStateField('view', s.view);
    }
  });
  const onAwareness = () => {
    const peers: Peer[] = [];
    provider.awareness.getStates().forEach((st, clientId) => {
      if (clientId === ydoc.clientID || !st?.name) return;
      peers.push({ clientId, name: st.name, color: st.color, cursor: st.cursor, selection: st.selection, view: st.view });
    });
    useRoom.setState({ peers });
  };
  provider.awareness.on('change', onAwareness);
  const onChat = () => useRoom.setState({ chat: chat.toArray().slice(-200) });
  chat.observe(onChat);
  sendCursor = (c) => provider.awareness.setLocalStateField('cursor', c);
  postChat = (m) => chat.push([{ ...m, id: `${ydoc.clientID}-${Date.now()}`, at: Date.now() }]);
  const url = new URL(location.href);
  url.searchParams.set('room', id);
  history.replaceState(null, '', url.toString());
  cleanup = () => {
    unsubStudio();
    clearTimeout(timer);
    provider.awareness.off('change', onAwareness);
    chat.unobserve(onChat);
    provider.destroy();
    ydoc.destroy();
    sendCursor = null;
    postChat = null;
  };
}

export function leaveRoom(): void {
  cleanup?.();
  cleanup = null;
  if (useRoom.getState().roomId) {
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url.toString());
  }
  useRoom.setState({ roomId: null, status: 'idle', peers: [], chat: [] });
}

export function setMe(p: Partial<{ name: string; color: string }>): void {
  const me = { ...useRoom.getState().me, ...p };
  useRoom.setState({ me });
  try {
    localStorage.setItem('orbital:room-me', JSON.stringify(me));
  } catch {
    /* ignore */
  }
}

export function moveCursor(c: { x: number; y: number } | null): void {
  sendCursor?.(c);
}

export async function say(text: string): Promise<void> {
  const t = text.trim();
  if (!t || !postChat) return;
  const me = useRoom.getState().me;
  postChat({ name: me.name, color: me.color, text: t });
  // "@tutor …" asks the tutor on behalf of the room; its answer is shared.
  if (/^@tutor\b/i.test(t)) {
    const { ask, useTutor } = await import('./tutor');
    await ask(t.replace(/^@tutor\s*/i, ''));
    const msgs = useTutor.getState().messages;
    const last = msgs[msgs.length - 1];
    if (last?.role === 'assistant' && last.text) postChat?.({ name: 'Tutor', color: '#8b7cff', text: last.text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, _ids, label) => label ?? 'this atom').replace(/<\/?name[^>]*>/g, ''), tutor: true });
  }
}
