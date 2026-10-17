'use strict';
/**
 * End-to-end simulation: starts the real server on a spare port with short
 * timers, connects several WebSocket "phones", and plays full rounds.
 *   npm test
 */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3111;
let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name;
    this.state = null;
    this.raw = [];
    this.errors = [];
    this.notices = [];
    this.lobbies = null;
    this.joined = null;
    this.drawings = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${PORT}/ws`);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (d) => {
        const s = d.toString();
        this.raw.push(s);
        const m = JSON.parse(s);
        if (m.t === 'state') {
          this.state = m;
          if (m.drawings) this.drawings = m.drawings;
        } else if (m.t === 'joined') this.joined = m;
        else if (m.t === 'error') this.errors.push(m);
        else if (m.t === 'lobbies') this.lobbies = m.lobbies;
        else if (m.t === 'notice') this.notices.push(m);
      });
    });
  }
  send(o) {
    this.ws.send(JSON.stringify(o));
  }
  async until(fn, label, ms = 4000) {
    const t = Date.now();
    while (Date.now() - t < ms) {
      if (fn(this)) return true;
      await sleep(15);
    }
    throw new Error(`timeout: ${this.name} waiting for ${label}`);
  }
  phase() {
    return this.state && this.state.room.phase;
  }
  close() {
    this.ws.close();
  }
}

const mk = async (name) => {
  const c = new Client(name);
  await c.connect();
  return c;
};
const allPhase = (cs, phase) => Promise.all(cs.map((c) => c.until((x) => x.phase() === phase, `phase ${phase}`)));
const stroke = (x) => [{ e: false, w: 0.016, p: [[x, 0.2], [x, 0.8]] }];
const secretOf = (c) => c.secret || c.state.secret;
const imposterOf = (cs) => cs.find((c) => secretOf(c) && secretOf(c).role === 'imposter');

async function toReveal(cs) {
  await allPhase(cs, 'prompt');
  cs.forEach((c) => c.send({ t: 'ready' }));
  await allPhase(cs, 'draw');
  cs.forEach((c) => { c.secret = c.state.secret; }); // secrets are only sent before voting
  cs.forEach((c, i) => c.send({ t: 'drawing', strokes: stroke(0.1 + i / 10), final: true }));
  await allPhase(cs, 'reveal');
}
async function toVote(cs) {
  await toReveal(cs);
  cs.forEach((c) => c.send({ t: 'ready' }));
  await allPhase(cs, 'vote');
}

async function main() {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DI_READY_MS: '800',
      DI_DRAW_MS: '1500',
      DI_REVEAL_MS: '800',
      DI_VOTE_MS: '1500',
      DI_GUESS_MS: '800',
      DI_GRACE_MS: '500',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => d.toString().includes('listening') && resolve());
    server.on('exit', (c) => reject(new Error(`server exited early (${c})`)));
  });
  const clients = [];
  const track = async (n) => {
    const c = await mk(n);
    clients.push(c);
    return c;
  };

  try {
    // ------------------------------------------------------------ HTTP
    console.log('Static files');
    const home = await fetch(`http://localhost:${PORT}/`);
    ok(home.status === 200 && (await home.text()).includes('Doodle Imposter'), 'serves the front end');
    ok((home.headers.get('content-security-policy') || '').includes("script-src 'self'"), 'sends a CSP header');
    ok((await fetch(`http://localhost:${PORT}/%2e%2e/server.js`)).status >= 400, 'blocks path traversal');
    ok((await fetch(`http://localhost:${PORT}/healthz`)).status === 200, 'health check works');

    // ------------------------------------------------- lobby + joining
    console.log('Lobby and joining');
    const A = await track('Ava');
    const B = await track('Ben');
    const C = await track('Cleo');
    const D = await track('Dan');
    A.send({ t: 'create', name: 'Ava', public: true });
    await A.until((c) => c.state, 'host state');
    const code = A.joined.code;
    ok(/^[A-HJ-NP-Z2-9]{5}$/.test(code), `room code looks right (${code})`);
    B.send({ t: 'list' });
    await B.until((c) => c.lobbies, 'lobby list');
    ok(B.lobbies.some((l) => l.code === code && l.host === 'Ava'), 'public lobby is listed');
    B.send({ t: 'join', code: 'ZZZZZ', name: 'Ben' });
    await B.until((c) => c.errors.length, 'error');
    ok(B.errors[0].code === 'no_room', 'wrong code is rejected');
    B.send({ t: 'join', code: code.toLowerCase(), name: 'Ben' });
    C.send({ t: 'join', code, name: '<b>Cleo</b>' });
    D.send({ t: 'join', code, name: 'Ben' });
    await A.until((c) => c.state.room.players.length === 4, '4 players');
    const names = A.state.room.players.map((p) => p.name);
    ok(names.some((n) => n.includes('Cleo')) && names.every((n) => !/[<>]/.test(n)), 'angle brackets are stripped from names');
    ok(new Set(names.map((n) => n.toLowerCase())).size === 4, `duplicate names are made unique (${names.join(', ')})`);
    A.send({ t: 'setPublic', value: false });
    await A.until((c) => c.state.room.public === false, 'now private');
    B.send({ t: 'list' });
    await sleep(100);
    ok(!B.lobbies.some((l) => l.code === code), 'private rooms leave the public list');
    B.send({ t: 'start' });
    await sleep(100);
    ok(A.phase() === 'lobby', 'only the host can start');

    // --------------------------------------------------- round 1
    console.log('Round 1: secrecy, late drawing, caught imposter, wrong guess');
    const players = [A, B, C, D];
    A.send({ t: 'start' });
    await allPhase(players, 'prompt');
    const imp = imposterOf(players);
    const normals = players.filter((c) => c !== imp);
    ok(players.filter((c) => c.state.secret.role === 'imposter').length === 1, 'exactly one imposter');
    ok(imp.state.secret.hint && !imp.state.secret.word && !imp.state.secret.category, 'imposter gets a hint and no word');
    ok(normals.every((c) => c.state.secret.word && c.state.secret.category), 'everyone else gets the category and word');
    const word = normals[0].state.secret.word;
    ok(imp.raw.every((s) => !s.includes(`"word":"${word}"`)), 'the word never reached the imposter');
    ok(players.every((c) => c.raw.every((s) => !s.includes('imposterId'))), 'imposter identity is never sent during play');
    players.forEach((c) => c.send({ t: 'ready' }));
    await allPhase(players, 'draw');
    ok(players.every((c) => c.raw.every((s) => !s.includes('"drawings"'))), 'no one sees drawings while drawing');
    const late = C;
    players.forEach((c, i) => {
      if (c === late) c.send({ t: 'drawing', strokes: [{ e: false, w: 0.02, p: [[0.9, 0.9]] }] });
      else c.send({ t: 'drawing', strokes: stroke(0.1 + i / 10), final: true });
    });
    await allPhase(players, 'reveal'); // timer ends the draw phase
    ok(A.drawings && A.drawings.length === 4, 'all four drawings are revealed together');
    const lateDrawing = A.drawings.find((d) => d.id === late.state.you);
    ok(lateDrawing && lateDrawing.strokes.length === 1 && lateDrawing.strokes[0].p[0][0] === 0.9, 'a late player’s unsubmitted drawing is auto-submitted');
    players.forEach((c) => c.send({ t: 'ready' }));
    await allPhase(players, 'vote');
    players.forEach((c) => {
      if (c === imp) c.send({ t: 'vote', target: normals[0].state.you });
      else c.send({ t: 'vote', target: imp.state.you });
    });
    await allPhase(players, 'guess');
    ok(imp.state.guess.imposter === true && normals.every((c) => c.state.guess.imposter === false), 'caught imposter gets a last-chance guess');
    ok(normals.every((c) => !c.state.guess.hint), 'others do not see the guess screen hint');
    imp.send({ t: 'guess', word: 'definitely not it' });
    await allPhase(players, 'results');
    let res = A.state.result;
    ok(res.caught && res.winner === 'players' && res.reason === 'guesswrong', 'wrong guess means the players win');
    ok(res.word === word && res.imposterId === imp.state.you, 'results reveal the word and the imposter');
    ok(res.tally[0].id === imp.state.you && res.tally[0].count === 3, 'vote tally is correct (3 votes)');

    // --------------------------------------------------- round 2: tie
    console.log('Round 2: tied vote lets the imposter escape');
    B.send({ t: 'again' });
    await sleep(100);
    ok(A.phase() === 'results', 'only the host can play again');
    A.send({ t: 'again' });
    await toVote(players);
    players.forEach((c, i) => c.send({ t: 'vote', target: players[(i + 1) % 4].state.you }));
    await allPhase(players, 'results');
    res = A.state.result;
    ok(!res.caught && res.winner === 'imposter' && res.reason === 'tie', 'a tie means the imposter wins');

    // --------------------------------------------------- round 3: right guess
    console.log('Round 3: imposter guesses the word');
    A.send({ t: 'again' });
    await toVote(players);
    const imp3 = imposterOf(players);
    const norm3 = players.filter((c) => c !== imp3);
    const word3 = secretOf(norm3[0]).word;
    players.forEach((c) => c.send({ t: 'vote', target: c === imp3 ? norm3[0].state.you : imp3.state.you }));
    await allPhase(players, 'guess');
    imp3.send({ t: 'guess', word: ` ${word3.toUpperCase()} ` });
    await allPhase(players, 'results');
    res = A.state.result;
    ok(res.winner === 'imposter' && res.reason === 'guessright', 'a correct guess (any case) steals the win');

    // --------------------------------------------------- round 4: disconnects
    console.log('Round 4: disconnect, rejoin, host transfer, no votes');
    A.send({ t: 'again' });
    await allPhase(players, 'prompt');
    players.forEach((c) => c.send({ t: 'ready' }));
    await allPhase(players, 'draw');
    const cToken = C.joined.token;
    const cCode = C.joined.code;
    C.close();
    await B.until((c) => c.state.room.players.some((p) => !p.connected), 'C shown as away');
    ok(true, 'others see the disconnected player as away');
    const aId = A.state.you;
    A.close();
    await B.until((c) => c.state.room.host !== aId, 'host moves');
    ok(B.state.room.host === B.state.you, 'host passes to the next player when the host leaves');
    const C2 = await track('Cleo again');
    C2.send({ t: 'rejoin', code: cCode, token: cToken });
    await C2.until((c) => c.state && c.state.you === C.state.you, 'rejoin');
    ok(C2.phase() === 'draw' && C2.state.secret, 'rejoining mid-round restores the screen and secret');
    const A2 = await track('Ava again');
    A2.send({ t: 'rejoin', code, token: A.joined.token });
    await A2.until((c) => c.state, 'A rejoin');
    ok(A2.state.room.host === B.state.you, 'a returning host does not steal host back');
    const bad = await track('Mallory');
    bad.send({ t: 'rejoin', code, token: 'not-a-real-token' });
    await bad.until((c) => c.errors.length, 'rejoin rejected');
    ok(bad.errors[0].code === 'rejoin_failed', 'a wrong token cannot hijack a seat');
    const now4 = [A2, B, C2, D];
    now4.forEach((c, i) => c.send({ t: 'drawing', strokes: stroke(0.2 + i / 10), final: true }));
    await allPhase(now4, 'reveal');
    ok(C2.drawings && C2.drawings.length === 4, 'a rejoined player receives the drawings');
    now4.forEach((c) => c.send({ t: 'ready' }));
    await allPhase(now4, 'vote');
    await allPhase(now4, 'results'); // nobody votes: timer ends it
    res = B.state.result;
    ok(res.winner === 'imposter' && res.reason === 'novotes', 'if nobody votes the imposter wins');

    console.log('Joining after the game started');
    const E = await track('Late Eli');
    E.send({ t: 'join', code, name: 'Eli' });
    await E.until((c) => c.errors.length, 'late join error');
    ok(E.errors[0].code === 'started', 'cannot join a game in progress');
    B.send({ t: 'lobby' });
    await allPhase(now4, 'lobby');
    ok(true, 'host can return everyone to the lobby');

    // ------------------------------------------------------- edge rooms
    console.log('Edge cases');
    const t1 = await track('T1');
    const t2 = await track('T2');
    t1.send({ t: 'create', name: 'T1', public: false });
    await t1.until((c) => c.joined, 'T1 room');
    t2.send({ t: 'join', code: t1.joined.code, name: 'T2' });
    await t1.until((c) => c.state.room.players.length === 2, 'two players');
    t1.send({ t: 'start' });
    await t1.until((c) => c.errors.length, 'too few');
    ok(t1.errors[0].code === 'few', 'cannot start with fewer than 3 players');

    const big = await track('P0');
    big.send({ t: 'create', name: 'P0', public: false });
    await big.until((c) => c.joined, 'big room');
    const crowd = [];
    for (let i = 1; i < 8; i++) {
      const p = await track(`P${i}`);
      p.send({ t: 'join', code: big.joined.code, name: `P${i}` });
      crowd.push(p);
    }
    await big.until((c) => c.state.room.players.length === 8, '8 players');
    const ninth = await track('P9');
    ninth.send({ t: 'join', code: big.joined.code, name: 'P9' });
    await ninth.until((c) => c.errors.length, 'full');
    ok(ninth.errors[0].code === 'full', 'a ninth player is turned away');

    const x = [await track('X1'), await track('X2'), await track('X3')];
    x[0].send({ t: 'create', name: 'X1', public: false });
    await x[0].until((c) => c.joined, 'X room');
    x[1].send({ t: 'join', code: x[0].joined.code, name: 'X2' });
    x[2].send({ t: 'join', code: x[0].joined.code, name: 'X3' });
    await x[0].until((c) => c.state.room.players.length === 3, 'X players');
    x[0].send({ t: 'start' });
    await allPhase(x, 'prompt');
    x.forEach((c) => c.send({ t: 'ready' }));
    await allPhase(x, 'draw');
    x[1].close();
    x[2].close();
    await x[0].until((c) => c.phase() === 'lobby', 'abort to lobby');
    ok(x[0].notices.length === 1, 'the round is cancelled if too many players leave');
  } catch (e) {
    failures++;
    console.log(`  ✗ ${e.message}`);
  } finally {
    clients.forEach((c) => {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    });
    server.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main();
