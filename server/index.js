// WatchTogether server
// 1. Serves the call page at /r/<room>
// 2. Relays sync + call messages between the two people in a room (WebSocket)
// Only dependency: ws

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8080;
const CALL_HTML = readFileSync(new URL('./public/call.html', import.meta.url));

const ROOM_RE = /^[a-z0-9]{4,32}$/;
const USER_RE = /^[A-Za-z0-9-]{4,64}$/;
const ROLES = new Set(['sync', 'call']);
const RELAY_TYPES = new Set(['play', 'pause', 'seek', 'tick', 'offer', 'answer', 'ice', 'media']);
const MAX_USERS = 2;          // people per room
const MAX_SOCKETS = 12;       // tabs + call pages per room

// STUN is free and always on. Add TURN through the ICE_SERVERS env var (JSON array).
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ...parseIce(process.env.ICE_SERVERS),
];

// Accepts strict JSON, or the JavaScript snippet Metered shows under "Instructions"
// (unquoted keys, trailing commas, an "iceServers:" prefix), pasted as-is.
function parseIce(raw) {
  if (!raw) return [];
  let text = raw.trim();
  const start = text.indexOf('['), end = text.lastIndexOf(']');
  if (start !== -1 && end > start) text = text.slice(start, end + 1);
  const attempts = [
    text,
    text
      .replace(/'/g, '"')                              // single quotes -> double
      .replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":') // quote bare keys
      .replace(/,\s*([}\]])/g, '$1'),                  // drop trailing commas
  ];
  for (const t of attempts) {
    try {
      const v = JSON.parse(t);
      const list = Array.isArray(v) ? v : [v];
      console.log(`ICE_SERVERS loaded: ${list.length} entries`);
      return list;
    } catch {}
  }
  console.warn('ICE_SERVERS could not be read, ignoring it');
  return [];
}

// Optional TURN relays, fetched by the server so secrets never reach the browser:
//   Cloudflare (1,000 GB/month free): CF_TURN_KEY_ID + CF_TURN_API_TOKEN
//   Metered: TURN_CREDENTIALS_URL = https://<app>.metered.live/api/v1/turn/credentials?apiKey=...
const CF_API = process.env.CF_TURN_API_BASE || 'https://rtc.live.cloudflare.com/v1';
const CF_TTL = 24 * 60 * 60;           // credentials valid for 24 hours
let cfCache = { at: 0, servers: [] };
let meteredCache = { at: 0, servers: [] };

async function cloudflareIce() {
  const { CF_TURN_KEY_ID: id, CF_TURN_API_TOKEN: token } = process.env;
  if (!id || !token) return [];
  if (Date.now() - cfCache.at < 12 * 60 * 60 * 1000) return cfCache.servers; // refresh twice a day
  try {
    const r = await fetch(`${CF_API}/turn/keys/${id}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: CF_TTL }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { iceServers } = await r.json();
    // Port 53 URLs can time out in browsers, so leave them out.
    const servers = (iceServers || []).map((s) => {
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u));
      return { ...s, urls };
    }).filter((s) => s.urls.length);
    cfCache = { at: Date.now(), servers };
    console.log(`Cloudflare TURN ready: ${servers.length} entries`);
  } catch (e) {
    console.warn('Could not get Cloudflare TURN credentials:', e.message);
  }
  return cfCache.servers;
}

async function meteredIce() {
  const url = process.env.TURN_CREDENTIALS_URL;
  if (!url) return [];
  if (Date.now() - meteredCache.at < 60 * 60 * 1000) return meteredCache.servers;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const servers = await r.json();
    if (Array.isArray(servers)) meteredCache = { at: Date.now(), servers };
  } catch (e) {
    console.warn('Could not fetch Metered TURN credentials:', e.message);
  }
  return meteredCache.servers;
}

async function getIceServers() {
  const [cf, metered] = await Promise.all([cloudflareIce(), meteredIce()]);
  return [...ICE_SERVERS, ...cf, ...metered];
}

function newRoomCode() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alike characters
  return [...randomBytes(8)].map((b) => alphabet[b % alphabet.length]).join('');
}

// ---------- Access key ----------
// Set ACCESS_KEY in Render. Every link must then carry ?k=<key>; without it the
// call page and the TURN credentials (/config) behave as if they don't exist.
const ACCESS_KEY = process.env.ACCESS_KEY || '';
if (!ACCESS_KEY) console.warn('ACCESS_KEY is not set: anyone with the URL can use this server');
const sha = (s) => createHash('sha256').update(s).digest();
function keyOk(url) {
  if (!ACCESS_KEY) return true;
  return timingSafeEqual(sha(url.searchParams.get('k') || ''), sha(ACCESS_KEY)); // constant-time compare
}

// ---------- HTTP: call page + config ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const { pathname } = url;

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (!keyOk(url)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  if (pathname === '/') {
    const k = url.searchParams.get('k');
    res.writeHead(302, { Location: `/r/${newRoomCode()}` + (k ? `?k=${encodeURIComponent(k)}` : '') });
    return res.end();
  }
  const m = pathname.match(/^\/r\/([a-z0-9]{4,32})\/?$/);
  if (m) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    return res.end(CALL_HTML);
  }
  if (pathname === '/config') {
    getIceServers().then((iceServers) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ iceServers }));
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ---------- WebSocket: rooms + relay ----------
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const rooms = new Map(); // room -> Set of members { ws, room, user, role }

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function presenceFor(members, user) {
  const list = [...members];
  const others = list.filter((m) => m.user !== user);
  const mine = list.filter((m) => m.user === user);
  return {
    type: 'presence',
    partner: {
      online: others.length > 0,
      call: others.some((m) => m.role === 'call'),
      sync: others.filter((m) => m.role === 'sync').length,
    },
    you: {
      call: mine.some((m) => m.role === 'call'),
      sync: mine.filter((m) => m.role === 'sync').length,
    },
  };
}

function broadcastPresence(room) {
  const members = rooms.get(room);
  if (!members) return;
  for (const m of members) send(m.ws, presenceFor(members, m.user));
}

function join(ws, msg) {
  const room = String(msg.room || '').toLowerCase();
  const user = String(msg.user || '');
  const role = msg.role;
  if (!ROOM_RE.test(room) || !USER_RE.test(user) || !ROLES.has(role)) {
    send(ws, { type: 'error', reason: 'bad-join' });
    ws.close();
    return null;
  }

  const members = rooms.get(room) ?? new Set();
  const users = new Set([...members].map((m) => m.user));
  if ((!users.has(user) && users.size >= MAX_USERS) || members.size >= MAX_SOCKETS) {
    send(ws, { type: 'full' });
    ws.close();
    return null;
  }

  // One call page per person: a newer one replaces the older one.
  if (role === 'call') {
    for (const m of [...members]) {
      if (m.user === user && m.role === 'call') {
        members.delete(m); // removed first, so its close event stays silent
        send(m.ws, { type: 'replaced' });
        m.ws.close();
      }
    }
  }

  const me = { ws, room, user, role };
  members.add(me);
  rooms.set(room, members);
  send(ws, { type: 'joined', room });

  // Tell the partner's sockets of the same role that someone new arrived.
  for (const m of members) {
    if (m !== me && m.role === role && m.user !== user) send(m.ws, { type: 'peer-joined' });
  }
  broadcastPresence(room);
  return me;
}

function leave(me) {
  const members = rooms.get(me.room);
  if (!members || !members.delete(me)) return;
  if (members.size === 0) {
    rooms.delete(me.room);
    return;
  }
  const stillHere = [...members].some((m) => m.user === me.user && m.role === me.role);
  if (!stillHere) {
    for (const m of members) {
      if (m.role === me.role && m.user !== me.user) send(m.ws, { type: 'peer-left' });
    }
  }
  broadcastPresence(me.room);
}

function relay(me, msg) {
  if (!RELAY_TYPES.has(msg.type)) return;
  const out = JSON.stringify(msg);
  for (const m of rooms.get(me.room) ?? []) {
    if (m !== me && m.role === me.role && m.ws.readyState === 1) m.ws.send(out);
  }
}

wss.on('connection', (ws) => {
  let me = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string' || msg.type === 'ping') return;
    if (msg.type === 'join') {
      if (!me) me = join(ws, msg);
      return;
    }
    if (me) relay(me, msg);
  });

  ws.on('close', () => { if (me) leave(me); });
  ws.on('error', () => {});
});

// Drop connections that died without saying goodbye (laptop slept, Wi-Fi cut).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

server.listen(PORT, () => {
  console.log(`WatchTogether running: open http://localhost:${PORT} to start a watch party`);
});
