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
        else if (m.t === 'ended' || m.t === 'kicked') this.ended = m;
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
      DI_DROP_MS: '1500',
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
    const K = await track('Kim');
    K.send({ t: 'join', code, name: 'Kim' });
    await A.until((c) => c.state.room.players.length === 5, 'Kim joins');
    B.send({ t: 'kick', target: K.joined.id });
    await sleep(100);
    ok(A.state.room.players.length === 5 && !K.ended, 'only the host can kick');
    A.send({ t: 'kick', target: A.state.you });
    await sleep(100);
    ok(A.state.room.players.length === 5, 'the host cannot kick themselves');
    A.send({ t: 'kick', target: K.joined.id });
    await A.until((c) => c.state.room.players.length === 4, 'Kim kicked');
    ok(K.ended && K.ended.t === 'kicked', 'a kicked player is told and sent home');
    ok(B.state.room.players.every((p) => p.id !== K.joined.id), 'everyone sees the kicked player gone');
    K.send({ t: 'rejoin', code, token: K.joined.token });
    await K.until((c) => c.errors.length, 'kicked rejoin');
    ok(K.errors[0].code === 'rejoin_failed', 'a kicked player cannot rejoin with their old seat');

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
    const painted = [
      { e: false, c: 2, w: 0.016, p: [[0.1, 0.1], [0.5, 0.5]] },
      { f: true, c: 6, w: 0.5, e: true, p: [[0.3, 0.7], [0.4, 0.4]] },
      { f: 1, c: 99, p: [[0.2, 0.2]] },
      { e: false, c: 'red', w: 0.016, p: [[0.6, 0.6]] },
    ];
    players.forEach((c, i) => {
      if (c === late) c.send({ t: 'drawing', strokes: [{ e: false, w: 0.02, p: [[0.9, 0.9]] }] });
      else if (c === A) c.send({ t: 'drawing', strokes: painted, final: true });
      else c.send({ t: 'drawing', strokes: stroke(0.1 + i / 10), final: true });
    });
    await allPhase(players, 'reveal'); // timer ends the draw phase
    const aOps = A.drawings.find((d) => d.id === A.state.you).strokes;
    ok(aOps[0].c === 2 && !aOps[0].f, 'stroke colours survive the server');
    ok(aOps[1].f === true && aOps[1].c === 6 && aOps[1].p.length === 1 && !('e' in aOps[1]) && !('w' in aOps[1]), 'fill ops keep one point and drop pen fields');
    ok(aOps[2].c === 9 && aOps[3].c === 0, 'bad colours are clamped to the palette');
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
    ok(res.word === word && res.imposters.length === 1 && res.imposters[0].id === imp.state.you, 'results reveal the word and the imposter');
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
    await E.until((c) => c.state, 'late join state');
    ok(E.state.room.players.find((p) => p.id === E.state.you).waiting && !E.state.result, 'joining at the results waits for the next round, without seeing them');
    B.send({ t: 'lobby' });
    await allPhase([...now4, E], 'lobby');
    ok(E.state.room.players.every((p) => !p.waiting), 'host can return everyone to the lobby, late arrivals included');
    E.send({ t: 'leave' });
    await B.until((c) => c.state.room.players.length === 4, 'Eli leaves');

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
    await sleep(300);
    ok(x[0].phase() === 'draw' && !x[0].ended, 'a dropped connection gets time to come back');
    await x[0].until((c) => c.ended, 'game ends after the drop window', 4000);
    ok(x[0].ended.t === 'ended', 'the game ends once a dropped player leaves too few behind');

    const room = async (prefix, n) => {
      const cs = [];
      for (let i = 0; i < n; i++) cs.push(await track(`${prefix}${i}`));
      cs[0].send({ t: 'create', name: `${prefix}0`, public: false });
      await cs[0].until((c) => c.joined, `${prefix} room`);
      cs.slice(1).forEach((c, i) => c.send({ t: 'join', code: cs[0].joined.code, name: `${prefix}${i + 1}` }));
      await cs[0].until((c) => c.state.room.players.length === n, `${prefix} players`);
      cs[0].send({ t: 'start' });
      return cs;
    };
    console.log('Late arrivals and reactions');
    const L = await room('L', 3);
    await allPhase(L, 'prompt');
    L.forEach((c) => c.send({ t: 'ready' }));
    await allPhase(L, 'draw');
    const late2 = await track('Lucy');
    late2.send({ t: 'join', code: L[0].joined.code, name: 'Lucy' });
    await late2.until((c) => c.state, 'Lucy state');
    const lucyId = late2.state.you;
    ok(late2.state.room.players.find((p) => p.id === lucyId).waiting, 'joining mid-round puts you on the bench');
    ok(!late2.state.secret && late2.raw.every((m) => !m.includes('"secret"')), 'a late arrival never sees the word or hint');
    await L[0].until((c) => c.state.room.players.some((p) => p.id === lucyId && p.waiting), 'others see Lucy waiting');
    ok(true, 'everyone else sees the late arrival waiting');
    late2.send({ t: 'drawing', strokes: stroke(0.5), final: true });
    L.forEach((c, i) => c.send({ t: 'drawing', strokes: stroke(0.1 + i / 10), final: true }));
    await allPhase(L, 'reveal');
    ok(L[0].drawings.length === 3 && L[0].drawings.every((d) => d.id !== lucyId), 'the round goes on without them, and their drawing is not used');
    ok(late2.raw.every((m) => !m.includes('"drawings"')), 'a late arrival does not get the drawings');
    const [La, Lb, Lc] = L;
    const bId = Lb.state.you;
    La.send({ t: 'react', target: bId, r: 1 });
    await Lc.until((c) => c.state.reactions && c.state.reactions[bId] && c.state.reactions[bId][1].n === 1, 'reaction shows');
    ok(La.state.reactions[bId][1].mine && !Lc.state.reactions[bId][1].mine, 'reactions show counts to everyone and your own as yours');
    const lastRaw = Lc.raw[Lc.raw.length - 1];
    ok(!JSON.stringify(JSON.parse(lastRaw).reactions).includes(La.state.you), 'reactions never say who reacted');
    await sleep(200);
    La.send({ t: 'react', target: bId, r: 1 });
    await Lc.until((c) => c.state.reactions[bId][1].n === 0, 'reaction removed');
    ok(true, 'tapping a reaction again takes it back');
    await sleep(200);
    La.send({ t: 'react', target: bId, r: 9 });
    La.send({ t: 'react', target: 'nobody', r: 0 });
    late2.send({ t: 'react', target: bId, r: 0 });
    await sleep(200);
    ok(Lc.state.reactions[bId].every((x) => x.n === 0) && !Lc.state.reactions.nobody, 'bad reactions and late arrivals are ignored');
    L.forEach((c) => c.send({ t: 'ready' }));
    await allPhase(L, 'vote');
    ok(!L[0].state.reactions, 'reactions are only on the reveal screen');
    La.send({ t: 'vote', target: lucyId });
    await sleep(150);
    ok(!La.state.room.players.find((p) => p.id === La.state.you).voted, 'you cannot vote for someone who is not in the round');
    const Lrest = L.filter((c) => c !== Lb);
    Lb.send({ t: 'leave' });
    await Promise.all([...Lrest, late2].map((c) => c.until((x2) => x2.phase() === 'lobby', 'back to lobby')));
    ok(!late2.ended && late2.state.room.players.length === 3, 'if the round runs short, waiting players keep the game alive in the lobby');
    ok(late2.state.room.players.every((p) => !p.waiting), 'everyone in the lobby plays the next round');

    console.log('Leaving mid-round');
    const y = await room('Y', 5);
    await toVote(y);
    const yImp = imposterOf(y);
    const [n1, n2, n3, n4] = y.filter((c) => c !== yImp);
    n1.send({ t: 'vote', target: n2.state.you });
    await n1.until((c) => c.state.room.players.find((p) => p.id === c.state.you).voted, 'n1 voted');
    n2.send({ t: 'leave' });
    await n1.until((c) => c.state.room.players.length === 4, 'n2 removed');
    ok(n1.phase() === 'vote' && n1.notices.some((m) => m.message.includes('left')), 'a leaving player is removed and the round goes on');
    ok(!n1.state.room.players.find((p) => p.id === n1.state.you).voted, 'a vote for a player who left is cleared');
    n3.send({ t: 'leave' });
    await n1.until((c) => c.state.room.players.length === 3, 'n3 removed');
    n4.send({ t: 'leave' });
    await Promise.all([n1, yImp].map((c) => c.until((x2) => x2.ended, 'ended')));
    ok(n1.ended.t === 'ended' && yImp.ended.t === 'ended', 'the game ends for everyone when too few are left');
    const lateY = await track('LateY');
    lateY.send({ t: 'join', code: y[0].joined.code, name: 'LateY' });
    await lateY.until((c) => c.errors.length, 'room gone');
    ok(lateY.errors[0].code === 'no_room', 'the ended room is closed');

    const z = await room('Z', 4);
    await allPhase(z, 'prompt');
    z.forEach((c) => c.send({ t: 'ready' }));
    await allPhase(z, 'draw');
    const zImp = imposterOf(z);
    const zRest = z.filter((c) => c !== zImp);
    zImp.send({ t: 'leave' });
    await allPhase(zRest, 'lobby');
    ok(zRest[0].state.room.players.length === 3 && zRest[0].notices.some((m) => m.message.includes('imposter')), 'the round is cancelled if the imposter leaves');

    console.log('More than one imposter');
    const M = [];
    for (let i = 0; i < 5; i++) M.push(await track(`M${i}`));
    M[0].send({ t: 'create', name: 'M0', public: false });
    await M[0].until((c) => c.joined, 'M room');
    for (let i = 1; i < 4; i++) M[i].send({ t: 'join', code: M[0].joined.code, name: `M${i}` });
    await M[0].until((c) => c.state.room.players.length === 4, 'M four');
    M[0].send({ t: 'setImposters', value: 2 });
    await M[0].until((c) => c.errors.some((e) => e.code === 'imposters'), 'too many imposters');
    ok(M[0].state.room.imposters === 1, 'with 4 players you cannot have 2 imposters (innocents must outnumber them)');
    M[4].send({ t: 'join', code: M[0].joined.code, name: 'M4' });
    await M[0].until((c) => c.state.room.players.length === 5, 'M five');
    M[1].send({ t: 'setImposters', value: 2 });
    await sleep(100);
    ok(M[0].state.room.imposters === 1, 'only the host can change the number of imposters');
    M[0].send({ t: 'setImposters', value: 2 });
    await Promise.all(M.map((c) => c.until((x2) => x2.state.room.imposters === 2, 'two imposters')));
    ok(true, 'with 5 players the host can pick 2 imposters, and everyone sees it');
    M[0].send({ t: 'setImposters', value: 3 });
    await sleep(100);
    ok(M[0].state.room.imposters === 2, 'but not 3');
    M[4].send({ t: 'leave' });
    await M[0].until((c) => c.state.room.players.length === 4, 'M4 leaves');
    ok(M[0].state.room.imposters === 1, 'if players leave the lobby, the count drops to keep innocents ahead');
    M[4] = await track('M4b');
    M[4].send({ t: 'join', code: M[0].joined.code, name: 'M4' });
    await M[0].until((c) => c.state.room.imposters === 2, 'back to 2');
    ok(true, 'and comes back to the host’s choice when they return');

    const roleOf = (c) => secretOf(c) && secretOf(c).role;
    const playMulti = async (votesFor) => {
      M[0].send({ t: M[0].phase() === 'results' ? 'again' : 'start' });
      await toVote(M);
      const imps = M.filter((c) => roleOf(c) === 'imposter');
      const inn = M.filter((c) => roleOf(c) !== 'imposter');
      M.forEach((c) => c.send({ t: 'vote', targets: votesFor(c, imps, inn).map((x2) => x2.state.you) }));
      return { imps, inn };
    };

    let mr = await playMulti((c, imps, inn) => (imps.includes(c) ? inn.slice(0, 2) : imps));
    ok(mr.imps.length === 2 && mr.inn.length === 3, 'the round has exactly 2 imposters');
    ok(M.every((c) => c.raw.every((m) => !m.includes('imposterIds'))) && mr.imps.every((c) => !JSON.stringify(secretOf(c)).includes(mr.imps.find((x2) => x2 !== c).state.you)),
      'imposters are not told who the other imposter is');
    await allPhase(M, 'guess');
    ok(mr.imps.every((c) => c.state.guess.imposter) && mr.inn.every((c) => !c.state.guess.imposter), 'catching both imposters gives each of them a guess');
    mr.imps[0].send({ t: 'guess', word: 'nope' });
    await mr.imps[0].until((c) => c.state.guess.done, 'first guess in');
    ok(M[0].phase() === 'guess', 'the round waits for the other imposter to guess');
    mr.imps[1].send({ t: 'guess', word: 'still nope' });
    await allPhase(M, 'results');
    res = M[0].state.result;
    ok(res.winner === 'players' && res.reason === 'guesswrong' && res.imposters.length === 2 && res.imposters.every((i) => i.caught && i.guess), 'two wrong guesses: the players win');

    mr = await playMulti((c, imps, inn) => (imps.includes(c) ? inn.slice(0, 2) : imps));
    await allPhase(M, 'guess');
    const mWord = secretOf(mr.inn[0]).word;
    mr.imps[1].send({ t: 'guess', word: mWord });
    await allPhase(M, 'results');
    ok(M[0].state.result.reason === 'guessright' && M[0].state.result.winner === 'imposter', 'one right guess steals the win for all the imposters');

    mr = await playMulti((c, imps, inn) => {
      // imposter 0 and innocent 1 get 3 votes each; nobody else gets more than 2, so they are the accused
      if (imps.includes(c)) return [inn[0], inn[1]];
      return c === inn[2] ? [imps[0], inn[1]] : [imps[0], inn[2]];
    });
    await allPhase(M, 'results');
    res = M[0].state.result;
    ok(res.winner === 'imposter' && res.reason === 'wrongsuspect', 'catching only one of two imposters lets them win');
    ok(res.imposters.filter((i) => i.caught).length === 1, 'results show which imposter was caught and which escaped');

    mr = await playMulti((c, imps, inn) => {
      // imposter 0 gets 3 votes, then three players tie on 2 for the second spot
      const [I0, I1] = imps;
      const [N0, N1, N2] = inn;
      return { [I0.name]: [N0, N1], [I1.name]: [N0, N2], [N0.name]: [I0, I1], [N1.name]: [I0, N2], [N2.name]: [I0, N1] }[c.name];
    });
    await allPhase(M, 'results');
    ok(M[0].state.result.reason === 'tie' && M[0].state.result.winner === 'imposter', 'a tie for the last accused spot lets the imposters escape');

    M[0].send({ t: 'again' });
    await allPhase(M, 'prompt');
    M.forEach((c) => c.send({ t: 'ready' }));
    await allPhase(M, 'draw');
    M.forEach((c) => { c.secret = c.state.secret; }); // this round's roles, not last round's
    const imp2 = M.filter((c) => roleOf(c) === 'imposter');
    const inn2 = M.filter((c) => roleOf(c) !== 'imposter');
    M.forEach((c) => c.send({ t: 'drawing', strokes: stroke(0.5), final: true }));
    await allPhase(M, 'reveal');
    M.forEach((c) => c.send({ t: 'ready' }));
    await allPhase(M, 'vote');
    const v = inn2[0];
    v.send({ t: 'vote', target: imp2[0].state.you });
    v.send({ t: 'vote', targets: [imp2[0].state.you, imp2[0].state.you] });
    v.send({ t: 'vote', targets: [v.state.you, imp2[0].state.you] });
    await sleep(150);
    ok(!M[0].state.room.players.find((p) => p.id === v.state.you).voted, 'a vote must name one different player per imposter, and not yourself');
    v.send({ t: 'vote', targets: [imp2[0].state.you, imp2[1].state.you] });
    await M[0].until((c) => c.state.room.players.find((p) => p.id === v.state.you).voted, 'valid vote');
    ok(true, 'a vote with two different suspects is accepted');
    const one = inn2.find((c) => c !== v);
    one.send({ t: 'leave' });
    const stay = M.filter((c) => c !== one);
    await allPhase(stay, 'lobby');
    ok(stay[0].notices.some((m) => m.message.includes('this many imposters')), 'the round is cancelled if innocents would no longer outnumber the imposters');

    const twoImposters = async (prefix) => {
      const cs = [];
      for (let i = 0; i < 5; i++) cs.push(await track(`${prefix}${i}`));
      cs[0].send({ t: 'create', name: `${prefix}0`, public: false });
      await cs[0].until((c) => c.joined, `${prefix} room`);
      cs.slice(1).forEach((c, i) => c.send({ t: 'join', code: cs[0].joined.code, name: `${prefix}${i + 1}` }));
      await cs[0].until((c) => c.state.room.players.length === 5, `${prefix} players`);
      cs[0].send({ t: 'setImposters', value: 2 });
      await cs[0].until((c) => c.state.room.imposters === 2, `${prefix} two imposters`);
      cs[0].send({ t: 'start' });
      await allPhase(cs, 'prompt');
      cs.forEach((c) => c.send({ t: 'ready' }));
      await allPhase(cs, 'draw');
      cs.forEach((c) => { c.secret = c.state.secret; });
      return { cs, imps: cs.filter((c) => roleOf(c) === 'imposter'), inn: cs.filter((c) => roleOf(c) !== 'imposter') };
    };
    const P = await twoImposters('P');
    P.cs.forEach((c) => c.send({ t: 'drawing', strokes: stroke(0.5), final: true }));
    await allPhase(P.cs, 'reveal');
    P.cs.forEach((c) => c.send({ t: 'ready' }));
    await allPhase(P.cs, 'vote');
    P.inn[0].send({ t: 'vote', targets: P.imps.map((c) => c.state.you) });
    await P.inn[1].until((c) => c.state.room.players.find((q) => q.id === P.inn[0].state.you).voted, 'P vote in');
    P.imps[0].send({ t: 'leave' });
    const pStay = P.cs.filter((c) => c !== P.imps[0]);
    await Promise.all(pStay.map((c) => c.until((x2) => x2.state.room.imposters === 1, 'one imposter left')));
    ok(pStay.every((c) => c.phase() === 'vote'), 'if one of two imposters leaves, the round goes on');
    ok(pStay.every((c) => c.state.room.players.every((q) => !q.voted)), 'and everyone votes again, now for one suspect');
    ok(pStay[0].notices.some((m) => m.message.includes('were an imposter') && m.message.includes('Vote again')), 'everyone is told an imposter left and to vote again');
    pStay.forEach((c) => c.send({ t: 'vote', target: c === P.imps[1] ? P.inn[0].state.you : P.imps[1].state.you }));
    await allPhase(pStay, 'guess');
    P.imps[1].send({ t: 'guess', word: 'nope' });
    await allPhase(pStay, 'results');
    res = pStay[0].state.result;
    ok(res.imposters.length === 1 && res.imposters[0].id === P.imps[1].state.you && res.winner === 'players', 'the remaining imposter can still be caught');

    const Q = await twoImposters('Q');
    Q.imps[0].send({ t: 'leave' });
    const qStay = Q.cs.filter((c) => c !== Q.imps[0]);
    await Promise.all(qStay.map((c) => c.until((x2) => x2.state.room.imposters === 1, 'Q one left')));
    ok(qStay.every((c) => c.phase() === 'draw'), 'an imposter leaving while drawing does not stop the round');
    Q.imps[1].send({ t: 'leave' });
    const qRest = qStay.filter((c) => c !== Q.imps[1]);
    await allPhase(qRest, 'lobby');
    ok(qRest[0].notices.some((m) => m.message === 'The imposters left, so the round was cancelled.'), 'the round is cancelled once every imposter has left');
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
