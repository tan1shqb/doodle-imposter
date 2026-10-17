'use strict';
/**
 * Browser tests: runs the real server, drives phone-sized Chromium pages, and uses
 * WebSocket "phones" for the other players.
 *   npm run test:ui
 * Needs Playwright's Chromium once: npx playwright install chromium
 * UI_SHOTS=some/folder npm run test:ui  also saves screenshots of the key screens.
 */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const { chromium } = require('playwright');
const PROMPTS = require('../prompts');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label, ms = 5000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(20);
  }
  throw new Error(`timeout waiting for ${label}`);
};

function startServer(port, env) {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DI_READY_MS: '60000', DI_DRAW_MS: '60000', DI_REVEAL_MS: '60000', DI_VOTE_MS: '60000', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => d.toString().includes('listening') && resolve(server));
    server.on('exit', (c) => reject(new Error(`server exited early (${c})`)));
  });
}

/** A player on a WebSocket, standing in for another phone. */
function phone(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const c = { ws, msgs: [], send: (o) => ws.send(JSON.stringify(o)) };
    c.last = (t) => c.msgs.filter((m) => m.t === t).pop();
    ws.on('message', (d) => c.msgs.push(JSON.parse(d)));
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

/** A room with one phone per name; the first creates it. */
async function makeRoom(port, names) {
  const ps = [];
  for (const n of names) ps.push(await phone(port));
  ps[0].send({ t: 'create', name: names[0] });
  const code = (await until(() => ps[0].last('joined'), 'room created')).code;
  ps.slice(1).forEach((p, i) => p.send({ t: 'join', code, name: names[i + 1] }));
  for (const p of ps) p.seat = await until(() => p.last('joined'), 'joined');
  return { code, ps };
}

async function newPage(browser, port, errors, query = '') {
  const page = await browser.newPage({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  page.setDefaultTimeout(5000);
  // Count sounds and vibrations: browsers give no other way to observe them.
  await page.addInitScript(() => {
    window.diSounds = 0;
    window.diBuzz = [];
    const AC = window.AudioContext;
    if (AC) {
      const make = AC.prototype.createOscillator;
      AC.prototype.createOscillator = function () { window.diSounds++; return make.call(this); };
    }
    navigator.vibrate = (p) => { window.diBuzz.push(p); return true; };
  });
  await page.goto(`http://localhost:${port}/${query}`);
  return page;
}

/** Hand a phone's seat to a browser page (the page rejoins with the phone's token). */
async function takeSeat(page, p) {
  await page.evaluate((s) => localStorage.setItem('di_session', JSON.stringify(s)), { code: p.seat.code, token: p.seat.token, id: p.seat.id });
  await page.reload();
}

/** From the lobby to the draw screen, with the page holding seat `pageSeat`. */
async function toDraw(page, ps) {
  ps[0].send({ t: 'start' });
  await page.getByRole('button', { name: "I'm ready" }).click();
  ps.forEach((p) => p.send({ t: 'ready' }));
  await page.waitForSelector('canvas.pad');
  await sleep(300);
}

const shot = (page, name) => (process.env.UI_SHOTS ? page.screenshot({ path: path.join(process.env.UI_SHOTS, `${name}.png`) }) : null);

const pixel = (page, fx, fy) => page.evaluate(([x, y]) => {
  const c = document.querySelector('canvas.pad');
  const d = c.getContext('2d').getImageData(Math.floor(x * c.width), Math.floor(y * c.height), 1, 1).data;
  return `${d[0]},${d[1]},${d[2]}`;
}, [fx, fy]);
const WHITE = '255,255,255';
const BLUE = '30,136,229';
const RED = '229,57,53';
const GREEN = '67,160,71';

async function main() {
  const PORT = 3112;
  const server = await startServer(PORT, {});
  const browser = await chromium.launch();
  const errors = [];
  try {
    // ------------------------------------------------------------ drawing tools
    console.log('Drawing tools');
    {
      const { ps } = await makeRoom(PORT, ['Ava', 'Ben', 'Cleo']);
      const page = await newPage(browser, PORT, errors);
      await takeSeat(page, ps[2]);
      await toDraw(page, ps.slice(0, 2));
      const box = await page.locator('canvas.pad').boundingBox();
      const at = (fx, fy) => [box.x + fx * box.width, box.y + fy * box.height];
      await page.mouse.move(...at(0.75, 0.5));
      await page.mouse.down();
      for (let a = 0; a <= Math.PI * 2 + 0.2; a += 0.15) await page.mouse.move(...at(0.5 + 0.25 * Math.cos(a), 0.5 + 0.2 * Math.sin(a)));
      await page.mouse.up();
      ok(await page.getByRole('button', { name: 'Redo' }).isDisabled(), 'redo starts disabled');
      await page.getByRole('button', { name: 'Fill' }).click();
      await page.getByRole('button', { name: 'Blue' }).click();
      await page.mouse.click(...at(0.5, 0.5));
      ok(await pixel(page, 0.5, 0.5) === BLUE && await pixel(page, 0.1, 0.1) === WHITE, 'fill colours inside a closed shape only');
      await page.getByRole('button', { name: 'Red', exact: true }).click();
      await page.mouse.click(...at(0.1, 0.1));
      ok(await pixel(page, 0.1, 0.1) === RED && await pixel(page, 0.5, 0.5) === BLUE, 'filling outside leaves the inside alone');
      await page.getByRole('button', { name: 'Undo' }).click();
      ok(await pixel(page, 0.1, 0.1) === WHITE && await pixel(page, 0.5, 0.5) === BLUE, 'undo removes the last fill');
      await page.getByRole('button', { name: 'Undo' }).click();
      ok(await pixel(page, 0.5, 0.5) === WHITE, 'undo again removes the one before');
      await page.getByRole('button', { name: 'Redo' }).click();
      ok(await pixel(page, 0.5, 0.5) === BLUE, 'redo brings it back');
      await page.getByRole('button', { name: 'Pencil' }).click();
      await page.getByRole('button', { name: 'Green' }).click();
      await page.mouse.move(...at(0.1, 0.9));
      await page.mouse.down();
      await page.mouse.move(...at(0.9, 0.9), { steps: 10 });
      await page.mouse.up();
      ok(await pixel(page, 0.5, 0.9) === GREEN, 'pencil draws in the chosen colour');
      ok(await page.getByRole('button', { name: 'Redo' }).isDisabled(), 'a new stroke clears redo');
      await shot(page, 'draw-tools');
      await page.getByRole('button', { name: 'Submit drawing' }).click();
      ps.slice(0, 2).forEach((p) => p.send({ t: 'drawing', strokes: [], final: true }));
      const st = await until(() => ps[0].msgs.find((m) => m.t === 'state' && m.drawings), 'reveal');
      const ops = st.drawings.find((d) => d.id === ps[2].seat.id).strokes;
      ok(ops.length === 3 && ops[1].f === true && ops[1].c === 6 && ops[2].c === 5, 'other players receive the colours and the fill');
      await page.close();
    }

    // ------------------------------------------------------------- streaks
    console.log('No streaks across the pad');
    for (const scenario of ['two fingers', 'junk coalesced points']) {
      const { ps } = await makeRoom(PORT, ['Ava', 'Ben', 'Cleo']);
      const page = await newPage(browser, PORT, errors);
      await takeSeat(page, ps[2]);
      await toDraw(page, ps.slice(0, 2));
      await page.evaluate((sc) => {
        const c = document.querySelector('canvas.pad');
        const r = c.getBoundingClientRect();
        const fire = (type, id, fx, fy) => c.dispatchEvent(new PointerEvent(type, {
          pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: r.left + fx * r.width, clientY: r.top + fy * r.height,
          button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
        }));
        if (sc === 'two fingers') {
          // finger 1 draws along the top while a palm lands at the bottom and moves
          fire('pointerdown', 1, 0.2, 0.2);
          for (let i = 0; i < 10; i++) {
            fire('pointermove', 1, 0.2 + i * 0.03, 0.2);
            if (i === 3) fire('pointerdown', 2, 0.8, 0.9);
            if (i > 3) fire('pointermove', 2, 0.8, 0.9 - i * 0.005);
          }
          fire('pointerup', 2, 0.8, 0.85);
          fire('pointerup', 1, 0.5, 0.2);
        } else {
          // some in-app browsers report coalesced points at (0, 0)
          const real = PointerEvent.prototype.getCoalescedEvents;
          PointerEvent.prototype.getCoalescedEvents = function () { return [new PointerEvent('pointermove', { clientX: 0, clientY: 0 }), this]; };
          fire('pointerdown', 1, 0.5, 0.5);
          for (let i = 0; i < 8; i++) fire('pointermove', 1, 0.5 + i * 0.03, 0.5);
          fire('pointerup', 1, 0.74, 0.5);
          PointerEvent.prototype.getCoalescedEvents = real;
        }
      }, scenario);
      await page.getByRole('button', { name: 'Submit drawing' }).click();
      ps.slice(0, 2).forEach((p) => p.send({ t: 'drawing', strokes: [], final: true }));
      const st = await until(() => ps[0].msgs.find((m) => m.t === 'state' && m.drawings), 'reveal');
      const ops = st.drawings.find((d) => d.id === ps[2].seat.id).strokes;
      let jump = 0;
      for (const o of ops) for (let i = 1; i < o.p.length; i++) jump = Math.max(jump, Math.hypot(o.p[i][0] - o.p[i - 1][0], o.p[i][1] - o.p[i - 1][1]));
      ok(ops.length === 1 && jump < 0.05, `${scenario}: one clean line, no jump across the pad (biggest step ${jump.toFixed(3)})`);
      await page.close();
    }

    // ------------------------------------------------------------ prompt text
    console.log('Prompt text fits on phones');
    for (const width of [320, 375]) {
      const page = await newPage(browser, PORT, errors, '?uitest');
      await page.setViewportSize({ width, height: 700 });
      await page.evaluate(() => document.fonts.ready);
      const res = await page.evaluate(async (prompts) => {
        const app = document.getElementById('app');
        app.innerHTML = '<div class="screen"><div class="card shadow col center" id="card"></div></div>';
        const card = document.getElementById('card');
        const bad = [];
        let smallest = Infinity;
        const texts = [...new Set(prompts.flatMap((p) => [`w${p.word}`, `h${p.hint}`]))];
        for (const t of texts) {
          const el = window.diTest.bigText(t[0] === 'w' ? 'big-word' : 'big-word mid', t.slice(1));
          card.replaceChildren(el);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const widest = Math.max(...[...el.children].map((s) => s.getBoundingClientRect().width));
          if (widest > el.clientWidth) bad.push(t.slice(1));
          smallest = Math.min(smallest, parseFloat(getComputedStyle(el).fontSize));
        }
        return { bad, smallest, n: texts.length };
      }, PROMPTS);
      ok(!res.bad.length, `${width}px: all ${res.n} words and hints fit without breaking a word${res.bad.length ? ` (not: ${res.bad.join(', ')})` : ''}`);
      ok(res.smallest >= 24, `${width}px: smallest text is still readable (${res.smallest}px)`);
      await page.close();
    }

    // ------------------------------------------------------------- lobby kick
    console.log('Lobby');
    {
      const { ps } = await makeRoom(PORT, ['Ava', 'Ben', 'Dev']);
      const host = await newPage(browser, PORT, errors);
      await takeSeat(host, ps[0]);
      const dev = await newPage(browser, PORT, errors);
      await takeSeat(dev, ps[2]);
      await host.getByRole('button', { name: 'Remove Dev' }).waitFor();
      ok(await host.locator('.kick').count() === 2 && await dev.locator('.kick').count() === 0, 'only the host sees remove buttons, one per other player');
      await host.getByRole('button', { name: 'Remove Dev' }).click();
      await dev.waitForSelector('.tagline');
      ok((await dev.locator('#toast').textContent()).includes('removed you'), 'a kicked player lands on the home screen and is told why');
      await until(async () => (await host.locator('.prow').count()) === 2, 'host list updates');
      ok(true, 'the host’s list updates');
      ok(await host.getByRole('button', { name: 'Sound and vibration' }).count() === 1, 'the lobby has a sound and vibration toggle');
      await host.close();
      await dev.close();
    }

    // ------------------------------------------------- late arrival + reveal
    console.log('Late arrivals and reactions');
    {
      const { code, ps } = await makeRoom(PORT, ['Ava', 'Ben', 'Cleo']);
      const cleo = await newPage(browser, PORT, errors);
      await takeSeat(cleo, ps[2]);
      await toDraw(cleo, ps.slice(0, 2));
      const late = await newPage(browser, PORT, errors, `?room=${code}`);
      await late.locator('#jn').fill('Lucy');
      await late.locator('.panel').getByRole('button', { name: 'Join' }).click();
      await late.getByText('A round is already going').waitFor();
      ok(await late.getByText('drawing.', { exact: false }).count() === 1, 'a late arrival sees a waiting screen saying what the others are doing');
      ok(await late.locator('.big-word, canvas.pad').count() === 0, 'and no word, hint or drawing pad');
      await shot(late, 'late-arrival');
      await cleo.getByRole('button', { name: 'Submit drawing' }).click();
      ps.slice(0, 2).forEach((p, i) => p.send({ t: 'drawing', strokes: [{ e: false, c: 0, w: 0.02, p: [[0.2 + i / 5, 0.2], [0.3, 0.8]] }], final: true }));
      await cleo.getByText('Who looks suspicious?').waitFor();
      ok(await cleo.evaluate(() => window.diSounds) > 0 && (await cleo.evaluate(() => window.diBuzz)).length > 0, 'the reveal plays a sound and vibrates');
      ok(await cleo.locator('.tile-wrap').count() === 3, 'the reveal shows only the three players in the round');
      const funny = cleo.getByRole('button', { name: 'Funny reaction for Ben' });
      await funny.click();
      await until(async () => (await funny.getAttribute('aria-pressed')) === 'true', 'reaction marked');
      ok((await funny.textContent()).includes('1'), 'tapping a reaction shows its count and marks it as yours');
      await until(() => { const m = ps[0].last('state'); return m.reactions && m.reactions[ps[1].seat.id] && m.reactions[ps[1].seat.id][0].n === 1; }, 'others see it');
      ok(true, 'other players see the reaction count');
      await cleo.evaluate(() => { document.querySelector('.tile-wrap').dataset.mark = '1'; });
      await sleep(200);
      ps[0].send({ t: 'react', target: ps[1].seat.id, r: 0 });
      await until(async () => (await funny.textContent()).includes('2'), 'count updates live');
      ok(await cleo.locator('.tile-wrap[data-mark]').count() === 1, 'counts update in place without rebuilding the screen');
      await shot(cleo, 'reveal-reactions');
      await funny.click();
      await until(async () => (await funny.getAttribute('aria-pressed')) === 'false', 'reaction taken back');
      ok((await funny.textContent()).includes('1'), 'tapping again takes your reaction back');
      await cleo.close();
      await late.close();
    }
  } catch (e) {
    failures++;
    console.log(`  ✗ ${e.message}`);
  }

  // ---------------------------------------------------- 10 second warning
  const FAST = 3113;
  const fast = await startServer(FAST, { DI_DRAW_MS: '13000' });
  try {
    console.log('Drawing timer warnings');
    const { ps } = await makeRoom(FAST, ['Ava', 'Ben', 'Cleo']);
    const page = await newPage(browser, FAST, errors);
    await takeSeat(page, ps[2]);
    await toDraw(page, ps.slice(0, 2));
    ok(await page.locator('.warn-banner').isHidden(), 'no warning while there is plenty of time');
    const before = await page.evaluate(() => window.diSounds);
    await page.locator('.warn-banner').waitFor({ state: 'visible', timeout: 6000 });
    ok((await page.locator('.warn-banner').textContent()).includes('10 seconds'), 'a "10 seconds left" banner appears');
    ok(await page.locator('.pill.warn').count() === 1, 'the timer turns red');
    await shot(page, 'ten-second-warning');
    ok(await page.evaluate(() => window.diSounds) > before && (await page.evaluate(() => window.diBuzz)).length > 0, 'the warning beeps and vibrates');
    await page.locator('.warn-banner').waitFor({ state: 'hidden', timeout: 5000 });
    ok(true, 'the banner gets out of the way after a moment');
    const atFive = await until(async () => {
      const t = await page.locator('.pill .timer').textContent();
      return t && t.endsWith(':04') && page.evaluate(() => window.diSounds);
    }, 'last seconds', 8000);
    await sleep(1200);
    ok(await page.evaluate(() => window.diSounds) > atFive, 'the last seconds tick');
    await page.getByText('Drawing locked in!').waitFor({ timeout: 6000 });
    ok(true, 'when time runs out the drawing is submitted');
    await page.close();
  } catch (e) {
    failures++;
    console.log(`  ✗ ${e.message}`);
  }

  ok(!errors.length, `no errors on any page${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await browser.close();
  server.kill();
  fast.kill();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main();
