/* Doodle Imposter: front end. Vanilla JS, no build step. */
(() => {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const INK = '#1E1A2E';
  const COLORS = ['#FFC9A8', '#FFE08A', '#9FC3FF', '#D9B8FF', '#FFB3C7', '#A8E6C3', '#FFCF9E', '#B8E0F0'];
  const SIZES = [0.008, 0.016, 0.032];
  const SIZE_NAMES = ['Small brush', 'Medium brush', 'Large brush'];

  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  const $conn = document.getElementById('conn');

  // ------------------------------------------------------------------ state
  const store = {
    get(k) {
      try { return localStorage.getItem(k); } catch { return null; }
    },
    set(k, v) {
      try { localStorage.setItem(k, v); } catch { /* private mode */ }
    },
    del(k) {
      try { localStorage.removeItem(k); } catch { /* private mode */ }
    },
  };
  function loadSession() {
    try { return JSON.parse(store.get('di_session')) || null; } catch { return null; }
  }
  const urlRoom = (new URLSearchParams(location.search).get('room') || '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

  const S = {
    ws: null, open: false, everOpen: false, queue: [], retry: 0,
    session: loadSession(),
    state: null,
    drawings: {},
    offset: 0,
    local: urlRoom ? 'join' : 'home',
    lobbies: [],
    key: null,
    handle: null,
    name: store.get('di_name') || '',
    ui: { round: -1, voteChoice: null, myStrokes: [], guessText: '', sizeIdx: 1, tool: 'pencil', codePrefill: urlRoom },
  };
  const nowMs = () => Date.now() + S.offset;

  // ---------------------------------------------------------------- helpers
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const ICONS = {
    back: '<path d="M20 12 H5 M11 5 L4 12 L11 19"/>',
    pencil: '<path d="M4 20 L5 15 L16 4 L20 8 L9 19 Z M14 6 L18 10"/>',
    eraser: '<g transform="rotate(-40 12 12)"><rect x="3" y="8" width="18" height="9" rx="2"/><path d="M12 8 V17"/></g>',
    undo: '<path d="M9 7 L4 12 L9 17 M4 12 H15 Q21 12 21 18"/>',
    trash: '<path d="M5 7 H19 M9 7 V4 H15 V7 M7 7 L8 20 H16 L17 7 M10 11 V16 M14 11 V16"/>',
    clock: '<circle cx="12" cy="13" r="8"/><path d="M12 9 V13 L15 15 M9 3 H15"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11 V8 A4 4 0 0 1 16 8 V11"/>',
    eye: '<path d="M2 12 Q12 3 22 12 Q12 21 2 12 Z"/><circle cx="12" cy="12" r="3"/><path d="M4 20 L20 4"/>',
    qr: '<path d="M3 8 V4 H8 M16 4 H21 V8 M21 16 V20 H16 M8 20 H3 V16"/><rect x="9" y="9" width="6" height="6"/>',
    share: '<circle cx="6" cy="12" r="3"/><circle cx="18" cy="5" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.7 10.6 L15.3 6.4 M8.7 13.4 L15.3 17.6"/>',
    refresh: '<path d="M20 12 A8 8 0 1 1 17 6 M20 3 V8 H15"/>',
    zoom: '<circle cx="10" cy="10" r="6"/><path d="M15 15 L21 21 M10 7 V13 M7 10 H13"/>',
    hat: '<path d="M5 11 L7 4 H17 L19 11 Z"/><path d="M3 11 H21"/><circle cx="8" cy="17" r="3"/><circle cx="16" cy="17" r="3"/><path d="M11 17 H13"/>',
  };
  function icon(name, size = 24, color = INK) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size);
    s.setAttribute('height', size);
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', color);
    s.setAttribute('stroke-width', '2.4');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = ICONS[name]; // static, trusted strings only
    return s;
  }
  function avatar(ci, cls = 'av') {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 40 40');
    s.setAttribute('class', cls);
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS(NS, 'use');
    u.setAttribute('href', '#face');
    s.append(u);
    s.style.color = COLORS[ci % COLORS.length];
    return s;
  }

  let toastTimer = null;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $toast.classList.remove('show'), 3000);
  }

  function setBg(color) {
    document.documentElement.style.setProperty('--bg', color);
    const m = document.querySelector('meta[name=theme-color]');
    if (m) m.setAttribute('content', color);
  }

  function fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  const timerText = (deadline) => h('span', { class: 'timer', 'data-deadline': deadline || 0, text: deadline ? fmt(deadline - nowMs()) : '' });
  const timerPill = (deadline) => h('span', { class: 'pill' }, icon('clock', 22), timerText(deadline));

  const btn = (text, onClick, opts = {}) =>
    h('button', { class: `btn${opts.secondary ? ' secondary' : ''}${opts.small ? ' small-btn' : ''}`, type: 'button', disabled: opts.disabled, onClick }, text);

  function header(title, onBack) {
    return h('div', { class: 'row' },
      onBack
        ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onClick: onBack }, icon('back', 30))
        : h('div', null),
      h('h1', { class: 'h1 grow', text: title }),
      h('div', { class: 'icon-btn' }));
  }
  const screenEl = (cls, ...kids) => h('div', { class: `screen ${cls || ''}` }, ...kids);

  // --------------------------------------------------------------- overlays
  function openSheet(children) {
    const prev = document.activeElement;
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (prev && prev.focus) prev.focus();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const closeBtn = btn('Close', close, { secondary: true });
    const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', onClick: (e) => { if (e.target === overlay) close(); } },
      h('div', { class: 'sheet' }, ...children, closeBtn));
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    closeBtn.focus();
    return close;
  }

  const shareUrl = (code) => `${location.origin}/?room=${encodeURIComponent(code)}`;

  function showQr(code) {
    let src = '';
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(shareUrl(code));
      qr.make();
      src = qr.createDataURL(8, 2);
    } catch { /* fall through */ }
    openSheet([
      h('div', { class: 'h2', text: 'Scan to join' }),
      src ? h('img', { class: 'qr', src, alt: `QR code to join room ${code}` }) : h('p', { text: 'Could not draw the QR code.' }),
      h('div', { class: 'label', text: code }),
      h('p', { class: 'small center', text: 'Point a phone camera at this code to open the game.' }),
    ]);
  }

  function copyText(text) {
    const fallback = () => {
      const t = h('textarea', { 'aria-hidden': 'true' });
      t.value = text;
      document.body.append(t);
      t.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      t.remove();
      toast(ok ? 'Link copied' : `Share this link: ${text}`);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => toast('Link copied'), fallback);
    } else fallback();
  }
  async function shareLink(code) {
    const url = shareUrl(code);
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Doodle Imposter', text: `Join my Doodle Imposter game! Room code ${code}`, url });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    copyText(url);
  }

  // ------------------------------------------------------------ drawing pad
  function paintStrokes(ctx, strokes, W, H) {
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      const col = s.e ? '#fff' : INK;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = Math.max(1, s.w * W);
      const p = s.p;
      if (p.length === 1) {
        ctx.beginPath();
        ctx.arc(p[0][0] * W, p[0][1] * H, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(p[0][0] * W, p[0][1] * H);
      for (let i = 1; i < p.length - 1; i++) {
        ctx.quadraticCurveTo(p[i][0] * W, p[i][1] * H, ((p[i][0] + p[i + 1][0]) / 2) * W, ((p[i][1] + p[i + 1][1]) / 2) * H);
      }
      const l = p[p.length - 1];
      ctx.lineTo(l[0] * W, l[1] * H);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** A read-only drawing at whatever size its box ends up (4:5 ratio). */
  function thumb(strokes) {
    const c = h('canvas', { class: 'thumb', role: 'img', 'aria-label': 'Drawing' });
    const paint = () => {
      const w = c.clientWidth;
      if (!w) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = Math.round(w * dpr);
      const ch = Math.round(w * 1.25 * dpr);
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
      const ctx = c.getContext('2d');
      if (ctx) paintStrokes(ctx, strokes, c.width, c.height);
    };
    if ('ResizeObserver' in window) new ResizeObserver(paint).observe(c);
    else requestAnimationFrame(paint);
    return c;
  }

  /** The live canvas. Coordinates are stored as 0..1 of the canvas size. */
  function createPad(wrap, initial) {
    const canvas = h('canvas', { class: 'pad', role: 'img', 'aria-label': 'Drawing canvas' });
    wrap.append(canvas);
    const ctx = canvas.getContext('2d');
    const pad = { strokes: initial ? initial.slice() : [], tool: S.ui.tool, size: SIZES[S.ui.sizeIdx], onChange: null, canvas };
    let cur = null;
    let W = 0;
    let H = 0;

    function redraw() {
      if (ctx && W) paintStrokes(ctx, pad.strokes, W, H);
    }
    function layout() {
      const r = wrap.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) return;
      const pw = Math.floor(Math.min(r.width - 8, (r.height - 8) * 0.8));
      const ph = Math.floor(pw * 1.25);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.style.width = `${pw}px`;
      canvas.style.height = `${ph}px`;
      canvas.width = Math.round(pw * dpr);
      canvas.height = Math.round(ph * dpr);
      W = canvas.width;
      H = canvas.height;
      redraw();
    }
    const point = (e) => {
      const r = canvas.getBoundingClientRect();
      return [
        Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 10000) / 10000,
        Math.round(Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) * 10000) / 10000,
      ];
    };
    function seg(a, b) {
      if (!ctx) return;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = cur.e ? '#fff' : INK;
      ctx.lineWidth = Math.max(1, cur.w * W);
      ctx.beginPath();
      ctx.moveTo(a[0] * W, a[1] * H);
      ctx.lineTo(b[0] * W, b[1] * H);
      ctx.stroke();
    }
    function down(e) {
      if (e.button != null && e.button > 0) return;
      e.preventDefault();
      if (pad.strokes.length >= 380) { toast('That is a lot of strokes! Try undo or clear.'); return; }
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      const eraser = pad.tool === 'eraser';
      const p = point(e);
      cur = { e: eraser, w: eraser ? Math.min(0.09, pad.size * 2.5) : pad.size, p: [p] };
      pad.strokes.push(cur);
      if (ctx) {
        ctx.fillStyle = eraser ? '#fff' : INK;
        ctx.beginPath();
        ctx.arc(p[0] * W, p[1] * H, Math.max(1, cur.w * W) / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    function move(e) {
      if (!cur) return;
      e.preventDefault();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs.length ? evs : [e]) {
        const p = point(ev);
        const last = cur.p[cur.p.length - 1];
        if (Math.hypot(p[0] - last[0], (p[1] - last[1]) * 1.25) < 0.002 || cur.p.length >= 1500) continue;
        cur.p.push(p);
        seg(last, p);
      }
    }
    function up() {
      if (!cur) return;
      cur = null;
      if (pad.onChange) pad.onChange(pad.strokes);
    }
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    pad.undo = () => { pad.strokes.pop(); redraw(); if (pad.onChange) pad.onChange(pad.strokes); };
    pad.clear = () => { pad.strokes.length = 0; redraw(); if (pad.onChange) pad.onChange(pad.strokes); };
    let ro = null;
    if ('ResizeObserver' in window) { ro = new ResizeObserver(layout); ro.observe(wrap); }
    else requestAnimationFrame(layout);
    pad.destroy = () => { if (ro) ro.disconnect(); };
    return pad;
  }

  // ---------------------------------------------------------------- network
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    S.ws = ws;
    ws.onopen = () => {
      S.open = true;
      S.everOpen = true;
      S.retry = 0;
      $conn.hidden = true;
      if (S.session) ws.send(JSON.stringify({ t: 'rejoin', code: S.session.code, token: S.session.token }));
      for (const m of S.queue.splice(0)) ws.send(JSON.stringify(m));
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      onMessage(m);
    };
    ws.onclose = (e) => {
      S.open = false;
      if (S.everOpen) $conn.hidden = false;
      if (e.code === 4000) { toast('This game is open in another tab.'); return; }
      setTimeout(connect, Math.min(4000, 400 * 2 ** S.retry++));
    };
    ws.onerror = () => {};
  }
  function send(m) {
    if (S.open && S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m));
    else if (m.t !== 'drawing' && m.t !== 'list') S.queue.push(m);
  }
  window.addEventListener('online', () => { if (!S.open) connect(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !S.open && (!S.ws || S.ws.readyState > 1)) connect();
  });

  function onMessage(m) {
    switch (m.t) {
      case 'joined':
        S.session = { code: m.code, token: m.token, id: m.id };
        store.set('di_session', JSON.stringify(S.session));
        S.ui.codePrefill = '';
        if (urlRoom) history.replaceState(null, '', location.pathname);
        break;
      case 'state': {
        S.offset = m.serverNow - Date.now();
        if (m.drawings) S.drawings[m.room.round] = m.drawings;
        m.drawings = S.drawings[m.room.round];
        if (S.ui.round !== m.room.round) {
          S.ui.round = m.room.round;
          S.ui.voteChoice = null;
          S.ui.myStrokes = [];
          S.ui.guessText = '';
        }
        S.state = m;
        route();
        break;
      }
      case 'lobbies':
        S.lobbies = m.lobbies;
        if (S.handle && S.handle.renderList) S.handle.renderList();
        break;
      case 'notice':
        toast(m.message);
        break;
      case 'error':
        if (m.code === 'rejoin_failed') {
          clearSession();
          S.local = urlRoom ? 'join' : 'home';
          route();
        } else toast(m.message);
        break;
      case 'left':
        clearSession();
        route();
        break;
      default:
    }
  }
  function clearSession() {
    S.session = null;
    S.state = null;
    S.local = 'home';
    store.del('di_session');
  }
  function leaveGame() {
    send({ t: 'leave' });
    clearSession();
    route();
  }

  // ---------------------------------------------------------------- screens
  const me = (st) => st.room.players.find((p) => p.id === st.you);
  const connectedCount = (st) => st.room.players.filter((p) => p.connected).length;

  function statusList(st, key, doneText, waitText) {
    return h('div', { class: 'plist' }, st.room.players.map((p) => {
      const done = p[key];
      return h('div', { class: 'prow' },
        avatar(p.color),
        h('span', { class: 'grow', text: p.id === st.you ? `${p.name} (You)` : p.name }),
        h('span', { class: `st${done ? ' ok' : ''}`, text: !p.connected ? 'away' : done ? `✓ ${doneText}` : waitText }));
    }));
  }

  const screens = {};

  // ----- home
  screens.home = (root) => {
    setBg('#FFF6E5');
    const art = h('div', { class: 'art' });
    art.innerHTML = `<svg width="300" height="160" viewBox="0 0 330 170" aria-hidden="true">
      <g fill="none" stroke="#1E1A2E" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 28 L25 36 L33 39 L25 42 L22 50 L19 42 L11 39 L19 36 Z"/><path d="M300 30 L302 36 L308 38 L302 40 L300 46 L298 40 L292 38 L298 36 Z"/><path d="M118 20 L124 12 M130 24 L140 18"/></g>
      <g transform="rotate(35 70 95)"><rect x="55" y="40" width="30" height="92" rx="3" fill="#FFD84D" stroke="#1E1A2E" stroke-width="3"/><rect x="55" y="40" width="30" height="16" rx="3" fill="#FF8FA3" stroke="#1E1A2E" stroke-width="3"/><path d="M55 132 L70 160 L85 132 Z" fill="#FFE9C7" stroke="#1E1A2E" stroke-width="3" stroke-linejoin="round"/><path d="M64 151 L70 160 L76 151 Z" fill="#1E1A2E"/></g>
      <path d="M135 150 L135 80 Q135 36 175 36 Q215 36 215 80 L215 150 L201 136 L188 150 L175 136 L162 150 L149 136 Z" fill="#FFFDF8" stroke="#1E1A2E" stroke-width="3" stroke-linejoin="round"/>
      <circle cx="159" cy="80" r="4.5" fill="#1E1A2E"/><circle cx="191" cy="80" r="4.5" fill="#1E1A2E"/><path d="M169 96 Q175 102 181 96" fill="none" stroke="#1E1A2E" stroke-width="3" stroke-linecap="round"/>
      <g transform="translate(232 62) scale(0.92)"><g fill="#FFFDF8" stroke="#1E1A2E" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M28 40 L26 16 L43 29 Q50 27 57 29 L74 16 L72 40 Q77 53 66 61 Q50 69 34 61 Q23 53 28 40 Z"/><path d="M36 62 Q29 84 40 93 L60 93 Q71 84 64 62"/><path d="M66 86 Q90 88 85 62" fill="none"/><path d="M30 50 L14 47 M30 55 L14 58 M70 50 L86 47 M70 55 L86 58" fill="none"/></g><circle cx="41" cy="44" r="2.6" fill="#1E1A2E"/><circle cx="59" cy="44" r="2.6" fill="#1E1A2E"/><path d="M47.5 50 L52.5 50 L50 53.5 Z" fill="#1E1A2E"/></g>
    </svg>`;
    root.append(screenEl('',
      h('div', { class: 'spacer' }),
      h('h1', { class: 'logo' }, h('span', { class: 'l1', text: 'DOODLE' }), h('span', { class: 'l2', text: 'IMPOSTER' })),
      h('p', { class: 'tagline', text: 'Draw carefully. Trust nobody.' }),
      art,
      h('div', { class: 'spacer' }),
      btn('Create game', () => { S.local = 'create'; route(); }),
      btn('Join game', () => { S.local = 'join'; route(); }, { secondary: true }),
      h('p', { class: 'small center', text: '3–8 players · no account needed' })));
  };

  // ----- create
  screens.create = (root) => {
    setBg('#FFF6E5');
    const name = h('input', { class: 'input', id: 'cn', type: 'text', maxlength: 14, value: S.name, autocomplete: 'nickname', placeholder: 'e.g. Sophie' });
    const pub = h('input', { type: 'checkbox', id: 'cp' });
    const go = () => {
      const n = name.value.trim();
      if (!n) { toast('Enter your name first'); name.focus(); return; }
      S.name = n;
      store.set('di_name', n);
      send({ t: 'create', name: n, public: pub.checked });
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    root.append(screenEl('',
      header('New game', () => { S.local = 'home'; route(); }),
      h('div', { class: 'col' }, h('label', { class: 'label', for: 'cn', text: 'Your name' }), name),
      h('label', { class: 'check', for: 'cp' }, pub, 'Show in the public lobby list'),
      h('p', { class: 'note', text: 'Leave this off and only people with your code or QR can join.' }),
      h('div', { class: 'spacer' }),
      btn('Create game', go)));
    setTimeout(() => { if (!name.value) name.focus(); }, 50);
  };

  // ----- join (enter a code, or pick a public lobby)
  screens.join = (root) => {
    setBg('#FFF6E5');
    const name = h('input', { class: 'input', id: 'jn', type: 'text', maxlength: 14, value: S.name, autocomplete: 'nickname', placeholder: 'e.g. Maya' });
    const code = h('input', {
      class: 'input code', id: 'jc', type: 'text', maxlength: 8, value: S.ui.codePrefill || '',
      autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', placeholder: 'A7K92',
    });
    code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    const doJoin = (c) => {
      const n = name.value.trim();
      if (!n) { toast('Enter your name first'); name.focus(); return; }
      if (!c) { toast('Enter a room code'); code.focus(); return; }
      S.name = n;
      store.set('di_name', n);
      send({ t: 'join', code: c, name: n });
    };
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(code.value); });

    const list = h('div', { class: 'col' });
    function renderList() {
      list.replaceChildren();
      if (!S.lobbies.length) {
        list.append(h('p', { class: 'note', text: 'No public lobbies right now. Create one, or enter a code.' }));
        return;
      }
      for (const l of S.lobbies) {
        list.append(h('div', { class: 'card row' },
          avatar(l.color),
          h('div', { class: 'grow' },
            h('div', { class: 'h2', text: `${l.host}'s game` }),
            h('div', { class: 'st small' }, h('span', { class: 'dot' }), ` ${l.players}/${l.max} players · Waiting`)),
          h('button', { class: 'btn small-btn', type: 'button', 'aria-label': `Join ${l.host}'s game`, onClick: () => doJoin(l.code) }, 'Join')));
      }
    }
    renderList();
    send({ t: 'list' });
    const timer = setInterval(() => send({ t: 'list' }), 5000);

    root.append(screenEl('',
      header('Join a game', () => { S.local = 'home'; route(); }),
      h('div', { class: 'col' }, h('label', { class: 'label', for: 'jn', text: 'Your name' }), name),
      h('div', { class: 'panel col' },
        h('label', { class: 'label', for: 'jc', text: 'Have a room code?' }),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, code), h('button', { class: 'btn small-btn', type: 'button', onClick: () => doJoin(code.value) }, 'Join')),
        h('p', { class: 'small', text: 'Tip: scanning the host’s QR code with your camera fills this in for you.' })),
      h('div', { class: 'divider', text: 'or jump into a public lobby' }),
      h('div', { class: 'row between' },
        h('h2', { class: 'h2', text: 'Public lobbies' }),
        h('button', { class: 'btn secondary small-btn', type: 'button', onClick: () => send({ t: 'list' }) }, icon('refresh', 20), 'Refresh')),
      list));
    return { renderList, destroy: () => clearInterval(timer) };
  };

  // ----- lobby
  screens.lobby = (root, st) => {
    setBg('#FFFDF8');
    const r = st.room;
    const isHost = r.host === st.you;
    const ready = connectedCount(st) >= r.min;
    root.append(screenEl('',
      header('Game Lobby', leaveGame),
      h('p', { class: 'sub', text: 'Share this code with your friends' }),
      h('div', { class: 'panel center' },
        h('div', { class: 'big-word code-big', text: r.code, 'aria-label': `Room code ${r.code.split('').join(' ')}` }),
        h('div', { class: 'caps small', text: 'Room code' })),
      h('div', { class: 'row' },
        h('button', { class: 'btn secondary small-btn', type: 'button', onClick: () => showQr(r.code) }, icon('qr', 22), 'Show QR'),
        h('button', { class: 'btn secondary small-btn', type: 'button', onClick: () => shareLink(r.code) }, icon('share', 22), 'Share link')),
      h('h2', { class: 'h2', text: `Players (${r.players.length}/${r.max})` }),
      h('div', { class: 'plist' }, r.players.map((p) =>
        h('div', { class: 'prow' },
          avatar(p.color),
          h('span', { class: 'grow', text: p.id === st.you ? `${p.name} (You)` : p.name }),
          p.id === r.host ? h('span', { class: 'host-tag', text: 'Host' }) : null,
          h('span', { class: 'st' }, h('span', { class: `dot${p.connected ? '' : ' off'}` }), p.connected ? 'ready' : 'away')))),
      isHost
        ? h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: r.public, onChange: (e) => send({ t: 'setPublic', value: e.target.checked }) }),
          'Show in the public lobby list')
        : null,
      h('p', { class: 'note', text: `Min. ${r.min} players · 45 sec drawing · 1 imposter` }),
      h('div', { class: 'spacer' }),
      isHost
        ? btn(ready ? 'Start game' : `Need ${r.min - connectedCount(st)} more`, () => send({ t: 'start' }), { disabled: !ready })
        : btn('Waiting for host…', () => {}, { disabled: true })));
  };

  // ----- prompt (read your word / hint, tap ready)
  function promptScreen(root, st, waiting) {
    const sec = st.secret;
    const imp = sec.role === 'imposter';
    setBg(imp ? '#FFF0B0' : '#CFE8FF');
    const r = st.room;
    const readyN = r.players.filter((p) => p.connected && p.ready).length;
    root.append(screenEl('',
      h('div', { class: 'row between' },
        h('span', { class: 'label', text: `ROUND ${r.round}` }),
        imp
          ? h('span', { class: 'pill small-pill' }, icon('hat', 28), 'IMPOSTER VIEW')
          : h('span', { class: 'row small' }, icon('eye', 26), 'Keep this secret')),
      h('h1', { class: 'h1 xl', text: imp ? 'Your hint' : 'Your prompt' }),
      imp
        ? h('div', { class: 'card shadow col center' }, h('div', { class: 'qmark', text: '?' }), h('div', { class: 'big-word mid', text: sec.hint }))
        : h('div', { class: 'card shadow col center' }, h('div', { class: 'caps', text: `Category: ${sec.category}` }), h('div', { class: 'big-word', text: sec.word })),
      h('p', { class: 'sub tall', text: imp ? "You don't know the secret word. Draw something that fits the hint." : 'Draw the word without showing anyone your screen.' }),
      h('div', { class: 'spacer' }),
      waiting
        ? [h('p', { class: 'small center' }, `${readyN} of ${connectedCount(st)} ready · drawing starts in `, timerText(r.deadline)),
          btn('Waiting for others…', () => {}, { disabled: true })]
        : btn("I'm ready", () => send({ t: 'ready' }))));
  }
  screens.prompt = (root, st) => promptScreen(root, st, false);
  screens.promptWait = (root, st) => promptScreen(root, st, true);

  // ----- draw
  screens.draw = (root, st) => {
    setBg('#CFF3DC');
    let cur = st;
    const sec = st.secret;
    const imp = sec.role === 'imposter';
    const wrap = h('div', { class: 'pad-wrap' });
    const pad = createPad(wrap, S.ui.myStrokes);
    let submitted = false;
    let lastSent = 0;
    let tmr = null;

    const sendDraft = () => { lastSent = Date.now(); send({ t: 'drawing', strokes: pad.strokes }); };
    pad.onChange = () => {
      S.ui.myStrokes = pad.strokes.slice();
      if (tmr) return;
      tmr = setTimeout(() => { tmr = null; if (!submitted) sendDraft(); }, Math.max(0, 1500 - (Date.now() - lastSent)));
    };
    const submit = () => {
      if (submitted) return;
      submitted = true;
      clearTimeout(tmr);
      S.ui.myStrokes = pad.strokes.slice();
      send({ t: 'drawing', strokes: pad.strokes, final: true });
    };
    const onHide = () => { if (document.visibilityState === 'hidden' && !submitted) sendDraft(); };
    document.addEventListener('visibilitychange', onHide);

    const tools = {};
    const sizes = [];
    const setTool = (t) => {
      pad.tool = S.ui.tool = t;
      tools.pencil.setAttribute('aria-pressed', String(t === 'pencil'));
      tools.eraser.setAttribute('aria-pressed', String(t === 'eraser'));
    };
    const toolBtn = (key, ico, label, onClick) => {
      const b = h('button', { class: 'tool', type: 'button', 'aria-pressed': 'false', onClick }, icon(ico, 28), label);
      tools[key] = b;
      return b;
    };
    const sizeBtn = (i) => {
      const b = h('button', { class: 'size', type: 'button', 'aria-label': SIZE_NAMES[i], 'aria-pressed': String(i === S.ui.sizeIdx), onClick: () => {
        S.ui.sizeIdx = i;
        pad.size = SIZES[i];
        sizes.forEach((s, j) => s.setAttribute('aria-pressed', String(i === j)));
      } }, h('i'));
      b.firstChild.style.width = b.firstChild.style.height = `${[6, 12, 20][i]}px`;
      sizes.push(b);
      return b;
    };

    root.append(screenEl('fit',
      h('div', { class: 'row between' },
        h('h1', { class: 'h1 left', text: 'Draw your answer' }),
        timerPill(st.room.deadline)),
      h('div', { class: 'pill paper' }, imp ? 'Your hint: ' : 'Your word: ', h('b', { class: 'chip-word', text: imp ? sec.hint : sec.word.toUpperCase() })),
      wrap,
      h('div', { class: 'tools' },
        toolBtn('pencil', 'pencil', 'Pencil', () => setTool('pencil')),
        toolBtn('eraser', 'eraser', 'Eraser', () => setTool('eraser')),
        h('button', { class: 'tool', type: 'button', onClick: () => pad.undo() }, icon('undo', 28), 'Undo'),
        h('button', { class: 'tool', type: 'button', onClick: () => { if (!pad.strokes.length || confirm('Clear your whole drawing?')) pad.clear(); } }, icon('trash', 28), 'Clear')),
      h('div', { class: 'sizes' }, 'Brush size', sizeBtn(0), sizeBtn(1), sizeBtn(2)),
      btn('Submit drawing', submit)));
    setTool(S.ui.tool);

    return {
      update(s) { cur = s; },
      tick() { if (!submitted && cur.room.deadline && cur.room.deadline - nowMs() <= 500) submit(); },
      destroy() {
        document.removeEventListener('visibilitychange', onHide);
        clearTimeout(tmr);
        S.ui.myStrokes = pad.strokes.slice();
        pad.destroy();
      },
    };
  };

  // ----- waiting for others to submit drawings
  screens.drawWait = (root, st) => {
    setBg('#E3F6EA');
    const r = st.room;
    const total = connectedCount(st);
    const done = r.players.filter((p) => p.connected && p.submitted).length;
    root.append(screenEl('',
      h('h1', { class: 'h1', text: 'Drawing locked in!' }),
      h('div', { class: 'locked' }, thumb(S.ui.myStrokes), h('span', { class: 'lockbadge' }, icon('lock', 22))),
      h('div', { class: 'center' },
        h('div', { class: 'h2 big', text: 'Waiting for others…' }),
        h('div', { class: 'small' }, `${done} of ${total} submitted · `, timerText(r.deadline), ' left')),
      h('div', { class: 'progress', role: 'img', 'aria-label': `${done} of ${total} drawings submitted` },
        r.players.filter((p) => p.connected).map((p) => h('i', { class: p.submitted ? 'on' : '' }))),
      statusList(st, 'submitted', 'done', '✎ still drawing…')));
  };

  // ----- reveal
  function revealScreen(root, st, waiting) {
    setBg('#E0D8FF');
    const r = st.room;
    const readyN = r.players.filter((p) => p.connected && p.ready).length;
    const tiles = (st.drawings || []).map((d) => {
      const mine = d.id === st.you;
      return h('button', {
        class: `tile${mine ? ' me' : ''}`, type: 'button', 'aria-label': `Enlarge ${mine ? 'your' : `${d.name}'s`} drawing`,
        onClick: () => openSheet([h('div', { class: 'h2', text: mine ? `${d.name} (You)` : d.name }), thumb(d.strokes)]),
      }, thumb(d.strokes), h('span', { class: 'cap', text: mine ? `${d.name} (You)` : d.name }));
    });
    root.append(screenEl('',
      h('div', { class: 'center' },
        h('h1', { class: 'h1', text: 'Who looks suspicious?' }),
        h('p', { class: 'sub', text: 'Discuss the drawings before voting.' })),
      h('div', { class: 'grid2' }, tiles),
      h('p', { class: 'small center row' }, icon('zoom', 22, '#3B3560'), 'Tap a drawing to enlarge it'),
      h('div', { class: 'spacer' }),
      h('p', { class: 'small center' }, waiting ? `${readyN} of ${connectedCount(st)} ready · ` : '', 'voting starts in ', timerText(r.deadline)),
      waiting ? btn('Waiting for others…', () => {}, { disabled: true }) : btn('Vote now', () => send({ t: 'ready' }))));
  }
  screens.reveal = (root, st) => revealScreen(root, st, false);
  screens.revealWait = (root, st) => revealScreen(root, st, true);

  // ----- vote
  screens.vote = (root, st) => {
    setBg('#D3EAFF');
    const submit = btn('Submit vote', () => {
      if (S.ui.voteChoice) send({ t: 'vote', target: S.ui.voteChoice });
    }, { disabled: !S.ui.voteChoice });
    const choices = (st.drawings || []).filter((d) => d.id !== st.you).map((d) => {
      const radio = h('input', { type: 'radio', name: 'vote', 'aria-label': `Vote for ${d.name}`, checked: S.ui.voteChoice === d.id });
      const label = h('label', { class: `choice${S.ui.voteChoice === d.id ? ' on' : ''}` },
        h('div', { class: 'thumb-sm' }, thumb(d.strokes)),
        h('span', { class: 'nm', text: d.name }),
        radio);
      radio.addEventListener('change', () => {
        S.ui.voteChoice = d.id;
        root.querySelectorAll('.choice').forEach((c) => c.classList.remove('on'));
        label.classList.add('on');
        submit.disabled = false;
      });
      return label;
    });
    root.append(screenEl('',
      h('div', { class: 'row between' }, h('span'), timerPill(st.room.deadline)),
      h('div', { class: 'center' },
        h('h1', { class: 'h1', text: 'Find the imposter' }),
        h('p', { class: 'sub', text: 'Choose one player. Your vote is private.' })),
      h('div', { class: 'col choices' }, choices),
      h('p', { class: 'small center row' }, icon('lock', 20, '#33405A'), 'Votes stay hidden until everyone has voted.'),
      h('div', { class: 'spacer' }),
      submit));
    return { update() {} };
  };

  screens.voteWait = (root, st) => {
    setBg('#D3EAFF');
    const total = connectedCount(st);
    const done = st.room.players.filter((p) => p.connected && p.voted).length;
    root.append(screenEl('',
      h('h1', { class: 'h1 xl', text: 'Vote locked in!' }),
      h('div', { class: 'center' },
        h('div', { class: 'h2 big', text: 'Waiting for others…' }),
        h('div', { class: 'small' }, `${done} of ${total} voted · `, timerText(st.room.deadline), ' left')),
      h('div', { class: 'progress', role: 'img', 'aria-label': `${done} of ${total} votes in` },
        st.room.players.filter((p) => p.connected).map((p) => h('i', { class: p.voted ? 'on' : '' }))),
      statusList(st, 'voted', 'voted', 'thinking…')));
  };

  // ----- imposter's last-chance guess
  screens.guess = (root, st) => {
    setBg('#FFE0C7');
    const input = h('input', { class: 'input big', id: 'gs', type: 'text', maxlength: 40, value: S.ui.guessText, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'Type your guess' });
    input.addEventListener('input', () => { S.ui.guessText = input.value; });
    const go = () => {
      const w = input.value.trim();
      if (!w) { toast('Type a guess first'); input.focus(); return; }
      send({ t: 'guess', word: w });
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    root.append(screenEl('',
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), timerPill(st.room.deadline)),
      h('div', { class: 'center' },
        h('h1', { class: 'h1 huge', text: 'Caught!' }),
        h('p', { class: 'sub tall', text: 'The group voted for you. You still have one shot to steal the win.' })),
      h('div', { class: 'card shadow col center' }, h('div', { class: 'caps small', text: 'Your hint was' }), h('div', { class: 'big-word mid', text: st.guess.hint || '' })),
      h('div', { class: 'col' }, h('label', { class: 'label', for: 'gs', text: 'What was the secret word?' }), input,
        h('p', { class: 'small center', text: 'One guess only. Get it right and the imposter wins.' })),
      h('div', { class: 'spacer' }),
      btn('Lock in guess', go)));
    return { update() {} };
  };

  screens.guessWait = (root, st) => {
    setBg('#FFE0C7');
    root.append(screenEl('',
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), timerPill(st.room.deadline)),
      h('div', { class: 'spacer' }),
      h('div', { class: 'card shadow col center' },
        h('div', { class: 'qmark', text: '?' }),
        h('h1', { class: 'h1', text: 'Imposter caught!' }),
        h('p', { class: 'sub', text: 'They get one chance to guess the secret word. Fingers crossed…' })),
      h('div', { class: 'spacer' })));
  };

  // ----- results
  screens.results = (root, st) => {
    setBg('#FFD9E3');
    const r = st.result;
    const isHost = st.room.host === st.you;
    const win = r.winner === 'players';
    const lines = [h('p', { class: 'res-line' }, 'The secret word was ', h('b', { class: 'chip-word', text: r.word.toUpperCase() }), '.'),
      h('p', { class: 'res-line', text: `${r.imposterName}’s hint was “${r.hint}”.` })];
    const why = {
      guessright: `${r.imposterName} guessed “${r.guess}” and stole the win!`,
      guesswrong: `${r.imposterName} guessed “${r.guess}”. Not quite.`,
      noguess: `${r.imposterName} ran out of time to guess.`,
      tie: 'The vote was tied, so the imposter slipped away.',
      wrongsuspect: 'The group voted for the wrong person.',
      novotes: 'Nobody voted, so the imposter got away.',
    }[r.reason];
    if (why) lines.push(h('p', { class: 'res-line', text: why }));
    const maxVotes = Math.max(1, ...r.tally.map((t) => t.count));

    root.append(screenEl('',
      h('h1', { class: 'h1', text: 'The imposter was…' }),
      h('div', { class: 'card shadow col center' },
        h('div', { class: 'row' }, avatar(r.imposterColor, 'av lg'), h('span', { class: 'h1 name', text: r.imposterName })),
        h('span', { class: `badge ${r.caught ? 'good' : 'bad'}`, text: r.caught ? 'CAUGHT!' : 'ESCAPED!' }),
        lines),
      h('div', { class: 'center' }, h('span', { class: 'pill' }, win ? 'Players win!' : 'Imposter wins!')),
      h('div', { class: 'card col' },
        h('div', { class: 'h2', text: 'Votes' }),
        r.tally.map((t) => h('div', { class: 'row' },
          h('span', { class: 'vname', text: t.name }),
          h('span', { class: 'bar' }, h('i', { 'data-w': t.count / maxVotes })),
          h('span', { class: 'vcount', text: t.count })))),
      h('div', { class: 'spacer' }),
      isHost ? btn('Play again', () => send({ t: 'again' })) : btn('Waiting for host…', () => {}, { disabled: true }),
      h('div', { class: 'row' },
        isHost ? h('button', { class: 'link grow', type: 'button', onClick: () => send({ t: 'lobby' }) }, 'Return to lobby') : null,
        h('button', { class: 'link grow', type: 'button', onClick: leaveGame }, 'Leave game'))));
    root.querySelectorAll('.bar i').forEach((i) => { i.style.width = `${Math.round(Number(i.dataset.w) * 100)}%`; });
  };

  // ----------------------------------------------------------------- router
  function route() {
    const st = S.state;
    let name;
    if (!st) {
      name = S.local;
    } else {
      const m = me(st);
      switch (st.room.phase) {
        case 'lobby': name = 'lobby'; break;
        case 'prompt': name = m && m.ready ? 'promptWait' : 'prompt'; break;
        case 'draw': name = m && m.submitted ? 'drawWait' : 'draw'; break;
        case 'reveal': name = m && m.ready ? 'revealWait' : 'reveal'; break;
        case 'vote': name = m && m.voted ? 'voteWait' : 'vote'; break;
        case 'guess': name = st.guess && st.guess.imposter ? 'guess' : 'guessWait'; break;
        default: name = 'results';
      }
    }
    const key = `${name}:${st ? st.room.round : ''}`;
    if (key === S.key && S.handle && S.handle.update) {
      S.handle.update(st);
      return;
    }
    const changed = key !== S.key;
    const sy = window.scrollY;
    if (S.handle && S.handle.destroy) S.handle.destroy();
    S.key = key;
    $app.replaceChildren();
    S.handle = screens[name]($app, st) || {};
    window.scrollTo(0, changed ? 0 : sy);
  }

  setInterval(() => {
    const t = nowMs();
    document.querySelectorAll('[data-deadline]').forEach((el) => {
      const d = Number(el.dataset.deadline);
      if (d) el.textContent = fmt(d - t);
    });
    if (S.handle && S.handle.tick) S.handle.tick();
  }, 250);

  route();
  connect();
})();
