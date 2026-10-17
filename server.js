'use strict';
/**
 * Doodle Imposter game server.
 *
 * One Node process: serves the static front end and runs every game room in
 * memory over WebSockets. The server is authoritative. It decides who the
 * imposter is, and each player is only ever sent their own secret prompt.
 * Other players' drawings are only sent once the round reaches the reveal.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PROMPTS = require('./prompts');

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const CFG = {
  PORT: num(process.env.PORT, 3000),
  MIN_PLAYERS: 3,
  MAX_PLAYERS: 8,
  READY_MS: num(process.env.DI_READY_MS, 20000), // read the prompt
  DRAW_MS: num(process.env.DI_DRAW_MS, 45000), // draw
  REVEAL_MS: num(process.env.DI_REVEAL_MS, 60000), // discuss
  VOTE_MS: num(process.env.DI_VOTE_MS, 45000), // vote
  GUESS_MS: num(process.env.DI_GUESS_MS, 20000), // imposter's word guess
  GRACE_MS: num(process.env.DI_GRACE_MS, 20000), // lobby disconnect grace
  ROOM_TTL_MS: 10 * 60 * 1000, // empty room lifetime
  MAX_ROOMS: 1000,
};

// ---------------------------------------------------------------- static files
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};
const CSP = [
  "default-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CSP,
      'Referrer-Policy': 'no-referrer',
    });
    res.end(data);
  });
});

// ------------------------------------------------------------------- helpers
const rooms = new Map();
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
}
const normCode = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function cleanName(raw) {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14);
  return s || 'Player';
}
function uniqueName(room, name) {
  const taken = new Set(room.players.map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; i < 30; i++) {
    const n = `${name.slice(0, 12)} ${i}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
  return name;
}
const normWord = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
function sameWord(a, b) {
  const x = normWord(a);
  const y = normWord(b);
  if (!x || !y) return false;
  const strip = (s) => (s.length > 3 && s.endsWith('s') ? s.slice(0, -1) : s);
  return x === y || strip(x) === strip(y);
}

/** Validate and shrink a drawing sent by a client. */
function cleanStrokes(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  let points = 0;
  for (const s of arr.slice(0, 400)) {
    if (!s || !Array.isArray(s.p)) continue;
    const p = [];
    for (const pt of s.p.slice(0, 1500)) {
      if (!Array.isArray(pt)) continue;
      const x = Number(pt[0]);
      const y = Number(pt[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      p.push([Math.round(clamp(x, 0, 1) * 10000) / 10000, Math.round(clamp(y, 0, 1) * 10000) / 10000]);
    }
    if (!p.length) continue;
    points += p.length;
    if (points > 20000) break;
    out.push({ e: !!s.e, w: Math.round(clamp(Number(s.w) || 0.014, 0.003, 0.09) * 10000) / 10000, p });
  }
  return out;
}

// ------------------------------------------------------------- room plumbing
function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      /* socket closing */
    }
  }
  return false;
}

function viewFor(room, p) {
  const r = room.round;
  const view = {
    t: 'state',
    serverNow: Date.now(),
    you: p.id,
    room: {
      code: room.code,
      public: room.public,
      phase: room.phase,
      deadline: room.deadline,
      round: room.roundNo,
      min: CFG.MIN_PLAYERS,
      max: CFG.MAX_PLAYERS,
      host: room.hostId,
      players: room.players.map((q) => ({
        id: q.id,
        name: q.name,
        color: q.color,
        connected: q.connected,
        ready: q.ready,
        submitted: q.submitted,
        voted: q.hasVoted,
      })),
    },
  };
  if (!r) return view;
  const isImposter = p.id === r.imposterId;
  if (room.phase === 'prompt' || room.phase === 'draw') {
    view.secret = isImposter
      ? { role: 'imposter', hint: r.prompt.hint }
      : { role: 'player', category: r.prompt.category, word: r.prompt.word };
  }
  if ((room.phase === 'reveal' || room.phase === 'vote') && p.drawingsSent !== room.roundNo) {
    view.drawings = r.drawings; // sent once per round per player
  }
  if (room.phase === 'guess') {
    view.guess = { imposter: isImposter, hint: isImposter ? r.prompt.hint : undefined };
  }
  if (room.phase === 'results') view.result = r.result;
  return view;
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players) {
    if (!p.connected) continue;
    const view = viewFor(room, p);
    const ok = send(p.ws, view);
    if (ok && view.drawings) p.drawingsSent = room.roundNo;
  }
}

function setPhase(room, phase, ms, onTimeout) {
  clearTimeout(room.timer);
  room.phase = phase;
  room.phaseId = (room.phaseId || 0) + 1;
  const id = room.phaseId;
  room.deadline = ms ? Date.now() + ms : null;
  room.timer = ms
    ? setTimeout(() => {
        if (room.phaseId === id) onTimeout();
      }, ms)
    : null;
  for (const p of room.players) p.ready = false;
}

const activeOf = (room) => room.players.filter((p) => p.connected);
const allDone = (room, pred) => {
  const a = activeOf(room);
  return a.length > 0 && a.every(pred);
};

function pickPrompt(room) {
  if (!room.used || room.used.size >= PROMPTS.length) room.used = new Set();
  let i;
  do {
    i = crypto.randomInt(PROMPTS.length);
  } while (room.used.has(i));
  room.used.add(i);
  return PROMPTS[i];
}

// ------------------------------------------------------------- game phases
function startRound(room) {
  for (const p of room.players) {
    if (!p.connected) clearTimeout(p.graceTimer);
  }
  room.players = room.players.filter((p) => p.connected);
  if (room.players.length < CFG.MIN_PLAYERS) return false;
  if (!room.players.some((p) => p.id === room.hostId)) room.hostId = room.players[0].id;
  const imposter = room.players[crypto.randomInt(room.players.length)];
  room.roundNo += 1;
  room.round = {
    imposterId: imposter.id,
    prompt: pickPrompt(room),
    drawings: null,
    votes: {},
    guess: null,
    caught: false,
    top: [],
    counts: {},
    result: null,
  };
  for (const p of room.players) {
    p.submitted = false;
    p.strokes = [];
    p.hasVoted = false;
    p.drawingsSent = null;
  }
  setPhase(room, 'prompt', CFG.READY_MS, () => startDraw(room));
  broadcast(room);
  return true;
}

function startDraw(room) {
  if (room.phase !== 'prompt') return;
  setPhase(room, 'draw', CFG.DRAW_MS, () => endDraw(room));
  broadcast(room);
}

function endDraw(room) {
  if (room.phase !== 'draw') return;
  // Late or missing submissions use whatever was last on the canvas.
  room.round.drawings = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    strokes: p.strokes,
  }));
  setPhase(room, 'reveal', CFG.REVEAL_MS, () => startVote(room));
  broadcast(room);
}

function startVote(room) {
  if (room.phase !== 'reveal') return;
  room.round.votes = {};
  for (const p of room.players) p.hasVoted = false;
  setPhase(room, 'vote', CFG.VOTE_MS, () => endVote(room));
  broadcast(room);
}

function endVote(room) {
  if (room.phase !== 'vote') return;
  const r = room.round;
  const counts = {};
  for (const t of Object.values(r.votes)) counts[t] = (counts[t] || 0) + 1;
  const max = Math.max(0, ...Object.values(counts));
  r.counts = counts;
  r.top = max > 0 ? Object.keys(counts).filter((k) => counts[k] === max) : [];
  // Caught only if the imposter is the single most-voted player. A tie lets them escape.
  r.caught = r.top.length === 1 && r.top[0] === r.imposterId;
  if (r.caught) {
    setPhase(room, 'guess', CFG.GUESS_MS, () => finish(room));
    broadcast(room);
  } else {
    finish(room);
  }
}

function finish(room) {
  if (room.phase === 'results' || !room.round) return;
  const r = room.round;
  const imp = room.players.find((p) => p.id === r.imposterId);
  let winner;
  let reason;
  let guessCorrect = null;
  if (!r.caught) {
    winner = 'imposter';
    reason = r.top.length === 0 ? 'novotes' : r.top.length > 1 ? 'tie' : 'wrongsuspect';
  } else {
    guessCorrect = r.guess != null && sameWord(r.guess, r.prompt.word);
    winner = guessCorrect ? 'imposter' : 'players';
    reason = guessCorrect ? 'guessright' : r.guess == null ? 'noguess' : 'guesswrong';
  }
  r.result = {
    imposterId: r.imposterId,
    imposterName: imp ? imp.name : 'The imposter',
    imposterColor: imp ? imp.color : 0,
    word: r.prompt.word,
    category: r.prompt.category,
    hint: r.prompt.hint,
    caught: r.caught,
    winner,
    reason,
    guess: r.guess,
    guessCorrect,
    tally: room.players
      .map((p) => ({ id: p.id, name: p.name, color: p.color, count: r.counts[p.id] || 0 }))
      .sort((a, b) => b.count - a.count),
  };
  setPhase(room, 'results', 0, null);
  broadcast(room);
}

/** Re-check whether the current phase can advance (after a disconnect, say). */
function checkProgress(room) {
  switch (room.phase) {
    case 'prompt':
      if (allDone(room, (p) => p.ready)) startDraw(room);
      break;
    case 'draw':
      if (allDone(room, (p) => p.submitted)) endDraw(room);
      break;
    case 'reveal':
      if (allDone(room, (p) => p.ready)) startVote(room);
      break;
    case 'vote':
      if (allDone(room, (p) => p.hasVoted)) endVote(room);
      break;
    default:
  }
}

function abortToLobby(room, message) {
  setPhase(room, 'lobby', 0, null);
  room.round = null;
  for (const p of room.players) {
    p.ready = p.submitted = p.hasVoted = false;
    p.strokes = [];
  }
  for (const p of activeOf(room)) send(p.ws, { t: 'notice', message });
  broadcast(room);
}

function removePlayer(room, p) {
  clearTimeout(p.graceTimer);
  room.players = room.players.filter((q) => q.id !== p.id);
  if (room.hostId === p.id) {
    const next = room.players.find((q) => q.connected) || room.players[0];
    room.hostId = next ? next.id : null;
  }
  if (!room.players.length) {
    clearTimeout(room.timer);
    rooms.delete(room.code);
    return;
  }
  broadcast(room);
}

function onDisconnect(room, p, left) {
  p.connected = false;
  p.ws = null;
  if (left) p.token = null;
  room.lastActive = Date.now();
  if (room.hostId === p.id) {
    const next = room.players.find((q) => q.connected);
    if (next) room.hostId = next.id; // host passes to the next player in join order
  }
  if (room.phase === 'lobby' || room.phase === 'results') {
    if (left) return removePlayer(room, p);
    p.graceTimer = setTimeout(() => {
      if (!p.connected) removePlayer(room, p);
    }, CFG.GRACE_MS);
    return broadcast(room);
  }
  if (activeOf(room).length < 2) return abortToLobby(room, 'Too many players left, so the round was cancelled.');
  checkProgress(room);
  if (room.phase === 'draw' || room.phase === 'prompt' || room.phase === 'reveal' || room.phase === 'vote' || room.phase === 'guess') {
    broadcast(room);
  }
}

// ------------------------------------------------------------ connections
function lobbyList() {
  const out = [];
  for (const room of rooms.values()) {
    if (!room.public || room.phase !== 'lobby') continue;
    const n = activeOf(room).length;
    if (!n || room.players.length >= CFG.MAX_PLAYERS) continue;
    const host = room.players.find((p) => p.id === room.hostId) || room.players[0];
    out.push({
      code: room.code,
      host: host.name,
      color: host.color,
      players: room.players.length,
      max: CFG.MAX_PLAYERS,
      at: room.createdAt,
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 20);
}

function addPlayer(room, name, ws) {
  const used = new Set(room.players.map((p) => p.color));
  let color = 0;
  while (used.has(color)) color++;
  const p = {
    id: crypto.randomBytes(4).toString('hex'),
    token: crypto.randomBytes(16).toString('hex'),
    name: uniqueName(room, cleanName(name)),
    color: color % 8,
    ws,
    connected: true,
    ready: false,
    submitted: false,
    strokes: [],
    hasVoted: false,
    drawingsSent: null,
    graceTimer: null,
  };
  room.players.push(p);
  return p;
}

function attach(ws, room, p) {
  ws.ctx = { room, player: p };
  send(ws, { t: 'joined', code: room.code, token: p.token, id: p.id });
  broadcast(room);
}

function detach(ws, left) {
  const ctx = ws.ctx;
  ws.ctx = null;
  if (!ctx) return;
  const { room, player } = ctx;
  if (player.ws === ws) onDisconnect(room, player, left);
}

const err = (ws, code, message) => send(ws, { t: 'error', code, message });

function handle(ws, msg) {
  const ctx = ws.ctx;
  const room = ctx && ctx.room;
  const p = ctx && ctx.player;

  switch (msg.t) {
    case 'list':
      return send(ws, { t: 'lobbies', lobbies: lobbyList() });

    case 'create': {
      if (rooms.size >= CFG.MAX_ROOMS) return err(ws, 'busy', 'The server is busy. Try again in a minute.');
      detach(ws, true);
      const r = {
        code: newCode(),
        public: !!msg.public,
        phase: 'lobby',
        phaseId: 0,
        players: [],
        hostId: null,
        round: null,
        roundNo: 0,
        deadline: null,
        timer: null,
        used: new Set(),
        createdAt: Date.now(),
        lastActive: Date.now(),
      };
      rooms.set(r.code, r);
      const host = addPlayer(r, msg.name, ws);
      r.hostId = host.id;
      return attach(ws, r, host);
    }

    case 'join': {
      const r = rooms.get(normCode(msg.code));
      if (!r) return err(ws, 'no_room', "We couldn't find that room. Check the code and try again.");
      if (r.phase !== 'lobby') return err(ws, 'started', 'That game has already started.');
      if (r.players.length >= CFG.MAX_PLAYERS) return err(ws, 'full', 'That room is full.');
      detach(ws, true);
      const np = addPlayer(r, msg.name, ws);
      return attach(ws, r, np);
    }

    case 'rejoin': {
      const r = rooms.get(normCode(msg.code));
      const found = r && r.players.find((q) => q.token && q.token === msg.token);
      if (!found) return err(ws, 'rejoin_failed', 'That game is no longer available.');
      detach(ws, true);
      if (found.ws && found.ws !== ws) {
        found.ws.ctx = null;
        try {
          found.ws.close(4000, 'replaced');
        } catch {
          /* already closed */
        }
      }
      clearTimeout(found.graceTimer);
      found.ws = ws;
      found.connected = true;
      found.drawingsSent = null; // fresh page: resend drawings
      return attach(ws, r, found);
    }

    case 'leave':
      detach(ws, true);
      return send(ws, { t: 'left' });
  }

  if (!room || !p) return err(ws, 'no_session', 'You are not in a game.');

  switch (msg.t) {
    case 'setPublic':
      if (p.id !== room.hostId || room.phase !== 'lobby') return;
      room.public = !!msg.value;
      return broadcast(room);

    case 'start':
      if (p.id !== room.hostId || room.phase !== 'lobby') return;
      if (activeOf(room).length < CFG.MIN_PLAYERS) return err(ws, 'few', `You need at least ${CFG.MIN_PLAYERS} players.`);
      return void startRound(room);

    case 'ready':
      if (room.phase !== 'prompt' && room.phase !== 'reveal') return;
      p.ready = true;
      if (allDone(room, (q) => q.ready)) return room.phase === 'prompt' ? startDraw(room) : startVote(room);
      return broadcast(room);

    case 'drawing':
      if (room.phase !== 'draw' || p.submitted) return;
      p.strokes = cleanStrokes(msg.strokes);
      if (msg.final) {
        p.submitted = true;
        if (allDone(room, (q) => q.submitted)) return endDraw(room);
        return broadcast(room);
      }
      return;

    case 'vote': {
      if (room.phase !== 'vote' || p.hasVoted) return;
      const target = String(msg.target ?? '');
      if (target === p.id || !room.players.some((q) => q.id === target)) return;
      room.round.votes[p.id] = target;
      p.hasVoted = true;
      if (allDone(room, (q) => q.hasVoted)) return endVote(room);
      return broadcast(room);
    }

    case 'guess':
      if (room.phase !== 'guess' || p.id !== room.round.imposterId) return;
      room.round.guess = String(msg.word ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || null;
      return finish(room);

    case 'again':
      if (p.id !== room.hostId || room.phase !== 'results') return;
      if (!startRound(room)) return err(ws, 'few', `You need at least ${CFG.MIN_PLAYERS} players.`);
      return;

    case 'lobby':
      if (p.id !== room.hostId || room.phase !== 'results') return;
      room.players = room.players.filter((q) => q.connected);
      room.round = null;
      setPhase(room, 'lobby', 0, null);
      return broadcast(room);

    default:
  }
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.ctx = null;
  ws.bucket = { tokens: 60, last: Date.now() };
  ws.on('pong', () => {
    ws.alive = true;
  });
  ws.on('message', (data) => {
    const b = ws.bucket;
    const now = Date.now();
    b.tokens = Math.min(60, b.tokens + ((now - b.last) / 1000) * 40);
    b.last = now;
    if (b.tokens < 1) return; // too chatty: drop
    b.tokens -= 1;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      handle(ws, msg);
    } catch (e) {
      console.error('handler error', msg.t, e);
    }
  });
  ws.on('close', () => detach(ws, false));
  ws.on('error', () => {});
});

// Drop dead sockets and old empty rooms.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!activeOf(room).length && now - room.lastActive > CFG.ROOM_TTL_MS) {
      clearTimeout(room.timer);
      rooms.delete(code);
    }
  }
}, 25000).unref();

if (require.main === module) {
  server.listen(CFG.PORT, () => console.log(`Doodle Imposter listening on http://localhost:${CFG.PORT}`));
}

module.exports = { server, rooms, CFG };
