/* Doodle Imposter: front end. Vanilla JS, no build step. */
(() => {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const INK = '#1E1A2E';
  const COLORS = ['#FFC9A8', '#FFE08A', '#9FC3FF', '#D9B8FF', '#FFB3C7', '#A8E6C3', '#FFCF9E', '#B8E0F0', '#D4EE8E', '#FF9E9E'];
  const SIZES = [0.008, 0.016, 0.032];
  // Paint colours. Strokes store the index (`c`), so keep the order and length in step with server.js.
  const PALETTE = [INK, '#9E9E9E', '#E53935', '#FB8C00', '#FDD835', '#43A047', '#1E88E5', '#8E24AA', '#F48FB1', '#795548'];
  // Reveal-screen reactions. The server only knows them by index, so keep the length in step with server.js.
  const REACTIONS = ['😂', '😭', '❤️', '👍']; // their names are react.0-3 in i18n.js
  // Bucket fills are worked out on a fixed-size copy of the drawing so every screen fills the same area.
  const FILL_W = 320;
  const FILL_H = 400;
  const FILL_TOL = 64;

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
    ui: { round: -1, votePicks: [], myStrokes: [], guessText: '', sizeIdx: 1, colorIdx: 0, tool: 'pencil', codePrefill: urlRoom },
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

  // --------------------------------------------------------------- language
  // Each phone picks its own language; the text lives in i18n.js and prompts carry every language.
  const I18N = window.DI_I18N;
  const LANGS = I18N.langs.map(([code]) => code);
  const FONTS = { ar: 'Baloo+Bhaijaan+2:wght@400;700', zh: 'ZCOOL+KuaiLe', ja: 'Yusei+Magic' }; // scripts the doodle fonts lack
  function startLang() {
    const saved = store.get('di_lang');
    if (LANGS.includes(saved)) return saved;
    for (const l of navigator.languages || [navigator.language || '']) {
      const base = String(l).toLowerCase().split('-')[0];
      if (LANGS.includes(base)) return base;
    }
    return 'en';
  }
  let lang = startLang();
  let plurals = new Intl.PluralRules(lang);

  /** Interface text for `key`, with {placeholders} filled in from `p`. When the key has plural forms, p.n picks one. */
  function t(key, p = {}) {
    const en = I18N.strings.en;
    const keys = `${key}_other` in en ? [`${key}_${plurals.select(Number(p.n))}`, `${key}_other`] : [key];
    const pick = (tbl) => keys.map((k) => tbl[k]).find((v) => v != null);
    const text = pick(I18N.strings[lang]) ?? pick(en) ?? key;
    return text.replace(/\{(\w+)\}/g, (m, x) => (x in p ? String(p[x]) : m));
  }
  /** Like t(), but a placeholder may be a DOM node (a live timer, a bold word). Returns nodes and strings. */
  function tn(key, p = {}) {
    const marked = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v && v.nodeType ? `\u0000${k}\u0000` : v]));
    return t(key, marked).split('\u0000').map((part, i) => (i % 2 ? p[part] : part)).filter((x) => x !== '');
  }
  /** A prompt field ({ en, es, ... }) in this phone's language. */
  const loc = (o) => (o && typeof o === 'object' ? o[lang] || o.en : o || '');
  /** A server message in this phone's language, falling back to the server's English. */
  function srvText(m) {
    const key = `srv.${m.code}`;
    const en = I18N.strings.en;
    if (!m.code || !(key in en || `${key}_other` in en)) return m.message || '';
    const p = m.params || {};
    return p.vote ? `${t(key, p)} ${t('srv.vote_again')}` : t(key, p);
  }
  function applyLang() {
    const root = document.documentElement;
    root.lang = lang;
    root.dir = I18N.rtl.includes(lang) ? 'rtl' : 'ltr';
    if (FONTS[lang] && !document.getElementById(`font-${lang}`)) {
      document.head.append(h('link', { id: `font-${lang}`, rel: 'stylesheet', href: `https://fonts.googleapis.com/css2?family=${FONTS[lang]}&display=swap` }));
    }
    $conn.textContent = t('reconnecting');
  }
  function setLang(code) {
    if (!LANGS.includes(code)) return;
    lang = code;
    plurals = new Intl.PluralRules(lang);
    store.set('di_lang', code);
    applyLang();
    S.key = null; // rebuild the screen in the new language
    route();
  }
  applyLang();

  const ICONS = {
    back: '<path d="M20 12 H5 M11 5 L4 12 L11 19"/>',
    pencil: '<path d="M4 20 L5 15 L16 4 L20 8 L9 19 Z M14 6 L18 10"/>',
    eraser: '<g transform="rotate(-40 12 12)"><rect x="3" y="8" width="18" height="9" rx="2"/><path d="M12 8 V17"/></g>',
    undo: '<path d="M9 7 L4 12 L9 17 M4 12 H15 Q21 12 21 18"/>',
    redo: '<path d="M15 7 L20 12 L15 17 M20 12 H9 Q3 12 3 18"/>',
    bucket: '<path d="M19 11 L11 3 L2.4 11.6 A2 2 0 0 0 2.4 14.4 L7.6 19.6 A2 2 0 0 0 10.4 19.6 Z M5 2 L10 7 M2 13 H17"/><path d="M22 20 A2 2 0 1 1 18 20 C18 18.4 19.7 17.6 20 16 C20.3 17.6 22 18.4 22 20 Z"/>',
    trash: '<path d="M5 7 H19 M9 7 V4 H15 V7 M7 7 L8 20 H16 L17 7 M10 11 V16 M14 11 V16"/>',
    clock: '<circle cx="12" cy="13" r="8"/><path d="M12 9 V13 L15 15 M9 3 H15"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11 V8 A4 4 0 0 1 16 8 V11"/>',
    eye: '<path d="M2 12 Q12 3 22 12 Q12 21 2 12 Z"/><circle cx="12" cy="12" r="3"/><path d="M4 20 L20 4"/>',
    qr: '<path d="M3 8 V4 H8 M16 4 H21 V8 M21 16 V20 H16 M8 20 H3 V16"/><rect x="9" y="9" width="6" height="6"/>',
    share: '<circle cx="6" cy="12" r="3"/><circle cx="18" cy="5" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.7 10.6 L15.3 6.4 M8.7 13.4 L15.3 17.6"/>',
    refresh: '<path d="M20 12 A8 8 0 1 1 17 6 M20 3 V8 H15"/>',
    zoom: '<circle cx="10" cy="10" r="6"/><path d="M15 15 L21 21 M10 7 V13 M7 10 H13"/>',
    x: '<path d="M6 6 L18 18 M18 6 L6 18"/>',
    sound: '<path d="M4 9 H8 L13 5 V19 L8 15 H4 Z"/><path d="M16 9 Q18 12 16 15 M19 6 Q23 12 19 18"/>',
    mute: '<path d="M4 9 H8 L13 5 V19 L8 15 H4 Z"/><path d="M16 9 L22 15 M22 9 L16 15"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12 H21 M12 3 Q16.5 7.5 16.5 12 Q16.5 16.5 12 21 Q7.5 16.5 7.5 12 Q7.5 7.5 12 3 Z"/>',
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
    s.setAttribute('class', `i-${name}`);
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

  // ------------------------------------------------------- sound + vibration
  // Synthesised beeps, so there are no audio files to load. Browsers only allow audio
  // after a tap, so the context is created (and resumed) on the first touch.
  const sound = (() => {
    let ac = null;
    let on = store.get('di_sound') !== 'off';
    const unlock = () => {
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'ambient'; // respect the iPhone silent switch
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!ac && AC) ac = new AC();
        if (ac && ac.state === 'suspended') ac.resume();
      } catch { /* no audio */ }
    };
    document.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    function tone(freq, dur, { type = 'sine', vol = 0.15, at = 0, to = 0 } = {}) {
      const t = ac.currentTime + at;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ac.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
    const sounds = {
      tick: () => tone(1000, 0.07, { type: 'square', vol: 0.05 }),
      warn: () => { tone(660, 0.12, { type: 'triangle' }); tone(880, 0.16, { type: 'triangle', at: 0.14 }); },
      timeup: () => tone(420, 0.45, { type: 'sawtooth', vol: 0.08, to: 140 }),
      reveal: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, { type: 'triangle', at: i * 0.09 })),
    };
    return {
      get on() { return on; },
      toggle() { on = !on; store.set('di_sound', on ? 'on' : 'off'); },
      play(name, vibrate) {
        if (!on) return;
        try { if (ac && ac.state === 'running') sounds[name](); } catch { /* ignore */ }
        try { if (vibrate && navigator.vibrate) navigator.vibrate(vibrate); } catch { /* ignore */ }
      },
    };
  })();

  /** Ticks through the last five seconds of a timer, with an optional earlier warning. Call from a screen's tick(). */
  function countdown(warnAt, onWarn) {
    let last = null;
    let warned = false;
    return (deadline) => {
      if (!deadline) return;
      const sec = Math.ceil((deadline - nowMs()) / 1000);
      if (warnAt && !warned && sec <= warnAt && sec > 5) { warned = true; onWarn(); }
      if (sec >= 1 && sec <= 5 && sec !== last) { last = sec; sound.play('tick', 25); }
    };
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

  function header(title, onBack, right) {
    return h('div', { class: 'row' },
      onBack
        ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('back'), onClick: onBack }, icon('back', 30))
        : h('div', null),
      h('h1', { class: 'h1 grow', text: title }),
      right || h('div', { class: 'icon-btn' }));
  }
  function soundBtn() {
    const b = h('button', { class: 'icon-btn', type: 'button' });
    const paint = () => {
      b.replaceChildren(icon(sound.on ? 'sound' : 'mute', 28));
      b.setAttribute('aria-label', t('sound'));
      b.setAttribute('aria-pressed', String(sound.on));
    };
    b.addEventListener('click', () => { sound.toggle(); paint(); sound.play('tick', 25); });
    paint();
    return b;
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
    const closeBtn = btn(t('close'), close, { secondary: true });
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
      h('div', { class: 'h2', text: t('qr.title') }),
      src ? h('img', { class: 'qr', src, alt: t('qr.alt', { code }) }) : h('p', { text: t('qr.fail') }),
      h('div', { class: 'label', text: code }),
      h('p', { class: 'small center', text: t('qr.hint') }),
    ]);
  }

  function copyText(text) {
    const fallback = () => {
      const ta = h('textarea', { 'aria-hidden': 'true' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
      toast(ok ? t('share.copied') : t('share.manual', { url: text }));
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => toast(t('share.copied')), fallback);
    } else fallback();
  }
  async function shareLink(code) {
    const url = shareUrl(code);
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Doodle Imposter', text: t('share.text', { code }), url });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    copyText(url);
  }

  // ------------------------------------------------------------ drawing pad
  const opColor = (s) => (s.e ? '#fff' : PALETTE[s.c] || INK);

  /** One pen or eraser stroke. */
  function drawOp(ctx, s, W, H) {
    const col = opColor(s);
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, s.w * W);
    const p = s.p;
    if (p.length === 1) {
      ctx.beginPath();
      ctx.arc(p[0][0] * W, p[0][1] * H, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
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

  // Fill results are cached per fill op as flat [y, x0, x1) spans at FILL_W x FILL_H.
  // Ops are only ever pushed or popped at the end, so an op's earlier ops never change under it.
  const fillCache = new WeakMap();
  let refCtx = null;
  let maskCtx = null;
  let maskImg = null;
  const ctx2d = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c.getContext('2d', { willReadFrequently: true });
  };
  const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

  /** Scanline flood fill from the op's point on the reference canvas. */
  function floodSpans(ref, op) {
    const W = FILL_W;
    const H = FILL_H;
    const d = ref.getImageData(0, 0, W, H).data;
    const sx = Math.min(W - 1, Math.floor(op.p[0][0] * W));
    const sy = Math.min(H - 1, Math.floor(op.p[0][1] * H));
    const k0 = (sy * W + sx) * 4;
    const r0 = d[k0];
    const g0 = d[k0 + 1];
    const b0 = d[k0 + 2];
    const [fr, fg, fb] = hexRgb(opColor(op));
    if (Math.max(Math.abs(fr - r0), Math.abs(fg - g0), Math.abs(fb - b0)) <= FILL_TOL) return []; // already that colour
    const seen = new Uint8Array(W * H);
    const match = (k) => !seen[k] && Math.abs(d[k * 4] - r0) <= FILL_TOL && Math.abs(d[k * 4 + 1] - g0) <= FILL_TOL && Math.abs(d[k * 4 + 2] - b0) <= FILL_TOL;
    const spans = [];
    const stack = [sx, sy];
    while (stack.length) {
      const y = stack.pop();
      const x = stack.pop();
      const row = y * W;
      if (!match(row + x)) continue;
      let l = x;
      let r = x;
      while (l > 0 && match(row + l - 1)) l--;
      while (r < W - 1 && match(row + r + 1)) r++;
      seen.fill(1, row + l, row + r + 1);
      spans.push(y, l, r + 1);
      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= H) continue;
        let run = false;
        for (let nx = l; nx <= r; nx++) {
          if (match(ny * W + nx)) {
            if (!run) stack.push(nx, ny);
            run = true;
          } else run = false;
        }
      }
    }
    return spans;
  }

  /** A FILL_W x FILL_H canvas with just this fill painted on it. */
  function fillMask(spans, color) {
    if (!maskCtx) {
      maskCtx = ctx2d(FILL_W, FILL_H);
      maskImg = maskCtx.createImageData(FILL_W, FILL_H);
    }
    const d = maskImg.data;
    d.fill(0);
    const [r, g, b] = hexRgb(color);
    for (let i = 0; i < spans.length; i += 3) {
      for (let k = (spans[i] * FILL_W + spans[i + 1]) * 4, end = (spans[i] * FILL_W + spans[i + 2]) * 4; k < end; k += 4) {
        d[k] = r;
        d[k + 1] = g;
        d[k + 2] = b;
        d[k + 3] = 255;
      }
    }
    maskCtx.putImageData(maskImg, 0, 0);
    return maskCtx.canvas;
  }

  function paintStrokes(ctx, strokes, W, H) {
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    let ref = null; // fill-resolution copy, only kept up to date once a fill needs working out
    strokes.forEach((s, i) => {
      if (!s.f) {
        drawOp(ctx, s, W, H);
        if (ref) drawOp(ref, s, FILL_W, FILL_H);
        return;
      }
      let spans = fillCache.get(s);
      if (!spans) {
        if (!ref) {
          refCtx = refCtx || ctx2d(FILL_W, FILL_H);
          ref = refCtx;
          paintStrokes(ref, strokes.slice(0, i), FILL_W, FILL_H); // earlier fills are cached by now
        }
        spans = floodSpans(ref, s);
        fillCache.set(s, spans);
      }
      if (!spans.length) return;
      const m = fillMask(spans, opColor(s));
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(m, 0, 0, W, H);
      if (ref) ref.drawImage(m, 0, 0);
    });
    ctx.restore();
  }

  /** A read-only drawing at whatever size its box ends up (4:5 ratio). */
  function thumb(strokes) {
    const c = h('canvas', { class: 'thumb', role: 'img', 'aria-label': t('pad.drawing') });
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
    const canvas = h('canvas', { class: 'pad', role: 'img', 'aria-label': t('pad.canvas') });
    wrap.append(canvas);
    const ctx = canvas.getContext('2d');
    const pad = { strokes: initial ? initial.slice() : [], undone: [], tool: S.ui.tool, size: SIZES[S.ui.sizeIdx], color: S.ui.colorIdx, onChange: null, canvas };
    let cur = null;
    let curId = null; // the one pointer drawing `cur`; other fingers and palms are ignored
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
      ctx.strokeStyle = opColor(cur);
      ctx.lineWidth = Math.max(1, cur.w * W);
      ctx.beginPath();
      ctx.moveTo(a[0] * W, a[1] * H);
      ctx.lineTo(b[0] * W, b[1] * H);
      ctx.stroke();
    }
    function down(e) {
      if (e.button != null && e.button > 0) return;
      e.preventDefault();
      if (cur) return;
      if (pad.strokes.length >= 380) { toast(t('pad.tooMany')); return; }
      const p = point(e);
      if (pad.tool === 'fill') {
        const op = { f: true, c: pad.color, p: [p] };
        pad.strokes.push(op);
        redraw();
        const spans = fillCache.get(op);
        if (spans && !spans.length) { pad.strokes.pop(); return; } // tapped an area already that colour
        pad.undone.length = 0;
        if (pad.onChange) pad.onChange(pad.strokes);
        return;
      }
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      curId = e.pointerId;
      const eraser = pad.tool === 'eraser';
      cur = { e: eraser, c: pad.color, w: eraser ? Math.min(0.09, pad.size * 2.5) : pad.size, p: [p] };
      pad.strokes.push(cur);
      pad.undone.length = 0;
      if (ctx) {
        ctx.fillStyle = opColor(cur);
        ctx.beginPath();
        ctx.arc(p[0] * W, p[1] * H, Math.max(1, cur.w * W) / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    function move(e) {
      if (!cur || e.pointerId !== curId) return;
      e.preventDefault();
      // Some in-app browsers return junk coalesced points (often 0,0), which draw a streak
      // across the pad. They all happen within one frame, so drop any far from the real event.
      const near = (ev) => Number.isFinite(ev.clientX) && Number.isFinite(ev.clientY)
        && Math.abs(ev.clientX - e.clientX) < 48 && Math.abs(ev.clientY - e.clientY) < 48;
      const evs = (e.getCoalescedEvents ? e.getCoalescedEvents() : []).filter(near);
      for (const ev of evs.length ? evs : [e]) {
        const p = point(ev);
        const last = cur.p[cur.p.length - 1];
        if (Math.hypot(p[0] - last[0], (p[1] - last[1]) * 1.25) < 0.002 || cur.p.length >= 1500) continue;
        cur.p.push(p);
        seg(last, p);
      }
    }
    function up(e) {
      if (!cur || e.pointerId !== curId) return;
      cur = null;
      curId = null;
      if (pad.onChange) pad.onChange(pad.strokes);
    }
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    const changed = () => { redraw(); if (pad.onChange) pad.onChange(pad.strokes); };
    pad.undo = () => { if (!cur && pad.strokes.length) { pad.undone.push(pad.strokes.pop()); changed(); } };
    pad.redo = () => { if (!cur && pad.undone.length) { pad.strokes.push(pad.undone.pop()); changed(); } };
    pad.clear = () => { pad.strokes.length = 0; pad.undone.length = 0; changed(); };
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
      if (e.code === 4000) { toast(t('otherTab')); return; }
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
        if (m.drawings) { // players who left mid-round drop out of the reveal and the vote
          const ids = new Set(m.room.players.map((p) => p.id));
          m.drawings = m.drawings.filter((d) => ids.has(d.id));
        }
        if (S.ui.round !== m.room.round) {
          S.ui.round = m.room.round;
          S.ui.votePicks = [];
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
        toast(srvText(m));
        break;
      case 'error':
        if (m.code === 'rejoin_failed') {
          clearSession();
          S.local = urlRoom ? 'join' : 'home';
          route();
        } else toast(srvText(m));
        break;
      case 'left':
        clearSession();
        route();
        break;
      case 'kicked':
      case 'ended':
        clearSession();
        route();
        toast(m.t === 'kicked' ? t('kicked') : srvText(m));
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
  const playing = (p) => p.connected && !p.waiting; // in this round and online
  const connectedCount = (st) => st.room.players.filter(playing).length;
  const maxImposters = (n) => Math.max(1, Math.floor((n - 1) / 2)); // innocents always outnumber imposters, as on the server
  const imposterWord = (n) => t('imposters', { n });

  function statusList(st, key, doneText, waitText) {
    return h('div', { class: 'plist' }, st.room.players.map((p) => {
      const done = p[key];
      return h('div', { class: 'prow' },
        avatar(p.color),
        h('span', { class: 'grow', text: p.id === st.you ? t('you', { name: p.name }) : p.name }),
        h('span', { class: `st${done ? ' ok' : ''}`, text: p.waiting ? t('st.nextRound') : !p.connected ? t('st.away') : done ? `✓ ${doneText}` : waitText }));
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
      h('div', { class: 'row end' }, langPicker()),
      h('div', { class: 'spacer' }),
      h('h1', { class: 'logo' }, h('span', { class: 'l1', text: 'DOODLE' }), h('span', { class: 'l2', text: 'IMPOSTER' })),
      h('p', { class: 'tagline', text: t('home.tagline') }),
      art,
      h('div', { class: 'spacer' }),
      btn(t('home.create'), () => { S.local = 'create'; route(); }),
      btn(t('home.join'), () => { S.local = 'join'; route(); }, { secondary: true }),
      h('p', { class: 'small center', text: t('home.foot') })));
  };

  /** The language button on the home screen: each language is listed in its own script. */
  function langPicker() {
    const name = I18N.langs.find(([code]) => code === lang)[1];
    return h('button', { class: 'lang-btn', type: 'button', 'aria-label': `${t('language')}: ${name}`, onClick: () => {
      const close = openSheet([
        h('div', { class: 'h2', text: t('language') }),
        h('div', { class: 'lang-list' }, I18N.langs.map(([code, label]) => h('button', {
          class: 'lang-opt', type: 'button', lang: code, 'aria-pressed': String(code === lang),
          onClick: () => { close(); setLang(code); },
        }, label))),
      ]);
    } }, icon('globe', 24), name);
  }

  // ----- create
  screens.create = (root) => {
    setBg('#FFF6E5');
    const name = h('input', { class: 'input', id: 'cn', type: 'text', maxlength: 14, value: S.name, autocomplete: 'nickname', placeholder: t('create.placeholder') });
    const pub = h('input', { type: 'checkbox', id: 'cp' });
    const go = () => {
      const n = name.value.trim();
      if (!n) { toast(t('name.empty')); name.focus(); return; }
      S.name = n;
      store.set('di_name', n);
      send({ t: 'create', name: n, public: pub.checked });
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    root.append(screenEl('',
      header(t('create.title'), () => { S.local = 'home'; route(); }),
      h('div', { class: 'col' }, h('label', { class: 'label', for: 'cn', text: t('name.label') }), name),
      h('label', { class: 'check', for: 'cp' }, pub, t('create.public')),
      h('p', { class: 'note', text: t('create.privateNote') }),
      h('div', { class: 'spacer' }),
      btn(t('home.create'), go)));
    setTimeout(() => { if (!name.value) name.focus(); }, 50);
  };

  // ----- join (enter a code, or pick a public lobby)
  screens.join = (root) => {
    setBg('#FFF6E5');
    const name = h('input', { class: 'input', id: 'jn', type: 'text', maxlength: 14, value: S.name, autocomplete: 'nickname', placeholder: t('join.placeholder') });
    const code = h('input', {
      class: 'input code', id: 'jc', type: 'text', maxlength: 8, value: S.ui.codePrefill || '',
      autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', placeholder: 'A7K92',
    });
    code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    const doJoin = (c) => {
      const n = name.value.trim();
      if (!n) { toast(t('name.empty')); name.focus(); return; }
      if (!c) { toast(t('join.noCode')); code.focus(); return; }
      S.name = n;
      store.set('di_name', n);
      send({ t: 'join', code: c, name: n });
    };
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(code.value); });

    const list = h('div', { class: 'col' });
    function renderList() {
      list.replaceChildren();
      if (!S.lobbies.length) {
        list.append(h('p', { class: 'note', text: t('join.none') }));
        return;
      }
      for (const l of S.lobbies) {
        list.append(h('div', { class: 'card row' },
          avatar(l.color),
          h('div', { class: 'grow' },
            h('div', { class: 'h2', text: t('join.hostGame', { name: l.host }) }),
            h('div', { class: 'st small' }, h('span', { class: 'dot' }), ` ${t('join.count', { count: l.players, max: l.max })} · ${l.playing ? t('join.playing') : t('join.waiting')}`)),
          h('button', { class: 'btn small-btn', type: 'button', 'aria-label': t('join.joinHost', { name: l.host }), onClick: () => doJoin(l.code) }, t('join.btn'))));
      }
    }
    renderList();
    send({ t: 'list' });
    const timer = setInterval(() => send({ t: 'list' }), 5000);

    root.append(screenEl('',
      header(t('join.title'), () => { S.local = 'home'; route(); }),
      h('div', { class: 'col' }, h('label', { class: 'label', for: 'jn', text: t('name.label') }), name),
      h('div', { class: 'panel col' },
        h('label', { class: 'label', for: 'jc', text: t('join.haveCode') }),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, code), h('button', { class: 'btn small-btn', type: 'button', onClick: () => doJoin(code.value) }, t('join.btn'))),
        h('p', { class: 'small', text: t('join.tip') })),
      h('div', { class: 'divider', text: t('join.or') }),
      h('div', { class: 'row between' },
        h('h2', { class: 'h2', text: t('join.public') }),
        h('button', { class: 'btn secondary small-btn', type: 'button', onClick: () => send({ t: 'list' }) }, icon('refresh', 20), t('join.refresh'))),
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
      header(t('lobby.title'), leaveGame, soundBtn()),
      h('p', { class: 'sub', text: t('lobby.share') }),
      h('div', { class: 'panel center' },
        h('div', { class: 'big-word code-big', text: r.code, 'aria-label': t('lobby.codeAria', { code: r.code.split('').join(' ') }) }),
        h('div', { class: 'caps small', text: t('lobby.code') })),
      h('div', { class: 'row' },
        h('button', { class: 'btn secondary small-btn', type: 'button', onClick: () => showQr(r.code) }, icon('qr', 22), t('lobby.qr')),
        h('button', { class: 'btn secondary small-btn', type: 'button', onClick: () => shareLink(r.code) }, icon('share', 22), t('lobby.link'))),
      h('h2', { class: 'h2', text: t('players', { count: r.players.length, max: r.max }) }),
      h('div', { class: 'plist' }, r.players.map((p) =>
        h('div', { class: 'prow' },
          avatar(p.color),
          h('span', { class: 'grow', text: p.id === st.you ? t('you', { name: p.name }) : p.name }),
          p.id === r.host ? h('span', { class: 'host-tag', text: t('host') }) : null,
          h('span', { class: 'st' }, h('span', { class: `dot${p.connected ? '' : ' off'}` }), p.connected ? t('st.ready') : t('st.away')),
          isHost && p.id !== st.you
            ? h('button', { class: 'kick', type: 'button', 'aria-label': t('lobby.remove', { name: p.name }), onClick: () => {
              if (confirm(t('lobby.removeAsk', { name: p.name }))) send({ t: 'kick', target: p.id });
            } }, icon('x', 18))
            : null))),
      isHost
        ? h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: r.public, onChange: (e) => send({ t: 'setPublic', value: e.target.checked }) }),
          t('create.public'))
        : null,
      imposterSetting(st, isHost),
      h('p', { class: 'note', text: t('lobby.note', { min: r.min, imposters: imposterWord(r.imposters) }) }),
      h('div', { class: 'spacer' }),
      isHost
        ? btn(ready ? t('lobby.start') : t('lobby.need', { n: r.min - connectedCount(st) }), () => send({ t: 'start' }), { disabled: !ready })
        : btn(t('waitingHost'), () => {}, { disabled: true })));
  };

  /** How many imposters: the host can change it, everyone else just sees it. */
  function imposterSetting(st, isHost) {
    const n = st.room.imposters;
    const players = connectedCount(st);
    const most = maxImposters(players);
    const step = (label, sign, disabled) => h('button', {
      class: 'step', type: 'button', 'aria-label': label, disabled, onClick: () => send({ t: 'setImposters', value: n + sign }),
    }, sign < 0 ? '−' : '+');
    const more = 2 * (most + 1) + 1; // players needed for one more imposter
    return h('div', { class: 'col' },
      h('div', { class: 'stepper' },
        h('span', { class: 'label grow', text: t('imp.label') }),
        isHost ? step(t('imp.fewer'), -1, n <= 1) : null,
        h('span', { class: 'step-n', text: String(n), 'aria-live': 'polite' }),
        isHost ? step(t('imp.more'), 1, n >= most) : null),
      isHost
        ? h('p', { class: 'small', text: more <= st.room.max
          ? `${t('imp.rule')} ${t('imp.next', { players: more, count: most + 1 })}`
          : t('imp.rule') })
        : null);
  }

  /** Big text that shrinks until its longest word fits on a line, so words never break in the middle. */
  function bigText(cls, text) {
    const el = h('div', { class: cls });
    for (const w of String(text).split(/\s+/).filter(Boolean)) el.append(h('span', { class: 'bw', text: w }), ' ');
    const fit = () => {
      if (!el.isConnected) return;
      el.style.fontSize = '';
      const room = el.clientWidth;
      for (let i = 0; i < 4 && room; i++) { // letter spacing does not scale, so it can take a second pass
        const widest = Math.max(0, ...[...el.children].map((s) => s.getBoundingClientRect().width));
        if (widest <= room) break;
        el.style.fontSize = `${Math.floor((parseFloat(getComputedStyle(el).fontSize) * room * 0.96) / widest)}px`;
      }
    };
    requestAnimationFrame(fit);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
    return el;
  }

  // ----- prompt (read your word / hint, tap ready)
  function promptScreen(root, st, waiting) {
    const sec = st.secret;
    const imp = sec.role === 'imposter';
    setBg(imp ? '#FFF0B0' : '#CFE8FF');
    const r = st.room;
    const readyN = r.players.filter((p) => playing(p) && p.ready).length;
    root.append(screenEl('',
      h('div', { class: 'row between' },
        h('span', { class: 'label', text: t('prompt.round', { round: r.round }) }),
        imp
          ? h('span', { class: 'pill small-pill' }, icon('hat', 28), t('prompt.impView'))
          : h('span', { class: 'row small' }, icon('eye', 26), t('prompt.secret'))),
      h('h1', { class: 'h1 xl', text: imp ? t('prompt.hintTitle') : t('prompt.promptTitle') }),
      imp
        ? h('div', { class: 'card shadow col center' }, h('div', { class: 'qmark', text: '?' }), bigText('big-word mid', loc(sec.hint)))
        : h('div', { class: 'card shadow col center' }, h('div', { class: 'caps', text: t('prompt.category', { category: loc(sec.category) }) }), bigText('big-word', loc(sec.word))),
      h('p', { class: 'sub tall', text: r.imposters > 1
        ? t(imp ? 'prompt.impTextMany' : 'prompt.textMany', { n: r.imposters })
        : t(imp ? 'prompt.impText' : 'prompt.text') }),
      h('div', { class: 'spacer' }),
      waiting
        ? [h('p', { class: 'small center' }, tn('prompt.readyCount', { ready: readyN, total: connectedCount(st), time: timerText(r.deadline) })),
          btn(t('waitingOthers'), () => {}, { disabled: true })]
        : btn(t('prompt.ready'), () => send({ t: 'ready' }))));
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
      syncHistory();
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
    const swatches = [];
    const setTool = (t) => {
      pad.tool = S.ui.tool = t;
      for (const [k, b] of Object.entries(tools)) b.setAttribute('aria-pressed', String(k === t));
    };
    const toolBtn = (key, ico, label, onClick) => {
      const b = h('button', { class: 'tool', type: 'button', 'aria-pressed': 'false', onClick }, icon(ico, 28), label);
      tools[key] = b;
      return b;
    };
    const actBtn = (ico, label, onClick) => h('button', { class: 'tool', type: 'button', onClick }, icon(ico, 28), label);
    const undoBtn = actBtn('undo', t('tool.undo'), () => pad.undo());
    const redoBtn = actBtn('redo', t('tool.redo'), () => pad.redo());
    const syncHistory = () => {
      undoBtn.disabled = !pad.strokes.length;
      redoBtn.disabled = !pad.undone.length;
    };
    const setColor = (i, keepTool) => {
      pad.color = S.ui.colorIdx = i;
      swatches.forEach((b, j) => b.setAttribute('aria-pressed', String(i === j)));
      sizes.forEach((b) => { b.firstChild.style.background = PALETTE[i]; });
      if (!keepTool && pad.tool === 'eraser') setTool('pencil');
    };
    const swatch = (i) => {
      const b = h('button', { class: 'swatch', type: 'button', 'aria-label': t(`color.${i}`), 'aria-pressed': 'false', onClick: () => setColor(i) });
      b.style.background = PALETTE[i];
      swatches.push(b);
      return b;
    };
    const sizeBtn = (i) => {
      const b = h('button', { class: 'size', type: 'button', 'aria-label': t(`size.${i}`), 'aria-pressed': String(i === S.ui.sizeIdx), onClick: () => {
        S.ui.sizeIdx = i;
        pad.size = SIZES[i];
        sizes.forEach((s, j) => s.setAttribute('aria-pressed', String(i === j)));
        if (pad.tool === 'fill') setTool('pencil');
      } }, h('i'));
      b.firstChild.style.width = b.firstChild.style.height = `${[6, 12, 20][i]}px`;
      sizes.push(b);
      return b;
    };

    const pill = timerPill(st.room.deadline);
    const banner = h('div', { class: 'warn-banner', role: 'status', hidden: true }, t('draw.warn'));
    wrap.append(banner);
    const beeps = countdown(10, () => {
      pill.classList.add('warn');
      banner.hidden = false;
      setTimeout(() => { banner.hidden = true; }, 2600);
      sound.play('warn', [90, 60, 90]);
    });
    root.append(screenEl('fit draw',
      h('div', { class: 'row between' },
        h('h1', { class: 'h1 left', text: t('draw.title') }),
        pill),
      h('div', { class: 'pill paper' }, imp ? t('draw.yourHint') : t('draw.yourWord'), h('b', { class: 'chip-word', text: imp ? loc(sec.hint) : loc(sec.word).toUpperCase() })),
      wrap,
      h('div', { class: 'tools' },
        toolBtn('pencil', 'pencil', t('tool.pencil'), () => setTool('pencil')),
        toolBtn('fill', 'bucket', t('tool.fill'), () => setTool('fill')),
        toolBtn('eraser', 'eraser', t('tool.eraser'), () => setTool('eraser')),
        undoBtn,
        redoBtn,
        actBtn('trash', t('tool.clear'), () => { if (!pad.strokes.length || confirm(t('draw.clearAsk'))) pad.clear(); })),
      h('div', { class: 'palette', role: 'group', 'aria-label': t('draw.colours') }, PALETTE.map((_, i) => swatch(i))),
      h('div', { class: 'sizes' }, t('draw.brush'), sizeBtn(0), sizeBtn(1), sizeBtn(2)),
      btn(t('draw.submit'), submit)));
    setTool(S.ui.tool);
    setColor(S.ui.colorIdx, true);
    syncHistory();

    return {
      update(s) { cur = s; },
      tick() {
        beeps(cur.room.deadline);
        if (!submitted && cur.room.deadline && cur.room.deadline - nowMs() <= 500) {
          submit();
          sound.play('timeup', 300);
        }
      },
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
    const done = r.players.filter((p) => playing(p) && p.submitted).length;
    root.append(screenEl('',
      h('h1', { class: 'h1', text: t('drawWait.title') }),
      h('div', { class: 'locked' }, thumb(S.ui.myStrokes), h('span', { class: 'lockbadge' }, icon('lock', 22))),
      h('div', { class: 'center' },
        h('div', { class: 'h2 big', text: t('waitingOthers') }),
        h('div', { class: 'small' }, tn('drawWait.count', { done, total, time: timerText(r.deadline) }))),
      h('div', { class: 'progress', role: 'img', 'aria-label': t('drawWait.progress', { done, total }) },
        r.players.filter(playing).map((p) => h('i', { class: p.submitted ? 'on' : '' }))),
      statusList(st, 'submitted', t('st.done'), t('st.drawing'))));
  };

  // ----- reveal
  function revealScreen(root, st, waiting) {
    setBg('#E0D8FF');
    const r = st.room;
    if (S.ui.revealed !== r.round) {
      S.ui.revealed = r.round;
      sound.play('reveal', [60, 40, 120]);
    }
    const cards = {}; // drawing id -> { el, buttons, counts }
    const tiles = (st.drawings || []).map((d) => {
      const mine = d.id === st.you;
      const name = mine ? t('you', { name: d.name }) : d.name;
      const card = { counts: [], buttons: REACTIONS.map((emoji, i) => h('button', {
        class: 'react', type: 'button', 'aria-label': t('react.aria', { label: t(`react.${i}`), name }), 'aria-pressed': 'false',
        onClick: () => send({ t: 'react', target: d.id, r: i }),
      }, h('span', { text: emoji }), h('b', { class: 'n' }))) };
      card.el = h('div', { class: 'tile-wrap' },
        h('button', {
          class: `tile${mine ? ' me' : ''}`, type: 'button', 'aria-label': mine ? t('reveal.enlargeYours') : t('reveal.enlarge', { name: d.name }),
          onClick: () => openSheet([h('div', { class: 'h2', text: name }), thumb(d.strokes)]),
        }, thumb(d.strokes), h('span', { class: 'cap', text: name })),
        h('div', { class: 'reacts', role: 'group', 'aria-label': t('react.group', { name }) }, card.buttons));
      cards[d.id] = card;
      return card.el;
    });
    const status = h('p', { class: 'small center' });
    function paint(s) {
      const readyN = s.room.players.filter((p) => playing(p) && p.ready).length;
      const time = timerText(s.room.deadline);
      status.replaceChildren(...(waiting ? tn('reveal.readyCount', { ready: readyN, total: connectedCount(s), time }) : tn('reveal.starts', { time })));
      const here = new Set((s.drawings || []).map((d) => d.id));
      for (const [id, card] of Object.entries(cards)) {
        if (!here.has(id)) { card.el.remove(); continue; } // they left the game
        const counts = (s.reactions || {})[id] || [];
        card.buttons.forEach((b, i) => {
          const c = counts[i] || { n: 0, mine: false };
          b.lastChild.textContent = c.n ? String(c.n) : '';
          b.setAttribute('aria-pressed', String(c.mine));
          if (c.n > (card.counts[i] || 0)) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
          card.counts[i] = c.n;
        });
      }
    }
    paint(st);
    root.append(screenEl('',
      h('div', { class: 'center' },
        h('h1', { class: 'h1', text: t('reveal.title') }),
        h('p', { class: 'sub', text: t('reveal.sub') })),
      h('div', { class: 'grid2' }, tiles),
      h('p', { class: 'small center row' }, icon('zoom', 22, '#3B3560'), t('reveal.tap')),
      h('div', { class: 'spacer' }),
      status,
      waiting ? btn(t('waitingOthers'), () => {}, { disabled: true }) : btn(t('reveal.vote'), () => send({ t: 'ready' }))));
    return { update: paint };
  }
  screens.reveal = (root, st) => revealScreen(root, st, false);
  screens.revealWait = (root, st) => revealScreen(root, st, true);

  // ----- vote
  screens.vote = (root, st) => {
    setBg('#D3EAFF');
    const need = st.room.imposters; // one suspect per imposter
    const others = (st.drawings || []).filter((d) => d.id !== st.you);
    const picks = S.ui.votePicks = S.ui.votePicks.filter((id) => others.some((d) => d.id === id)).slice(0, need);
    const submit = btn('', () => {
      if (picks.length === need) send({ t: 'vote', targets: picks });
    });
    const sync = () => {
      submit.textContent = need > 1 ? t('vote.submitMany', { picked: picks.length, need }) : t('vote.submit');
      submit.disabled = picks.length !== need;
      root.querySelectorAll('.choice').forEach((c) => c.classList.toggle('on', picks.includes(c.dataset.id)));
    };
    const choices = others.map((d) => {
      const input = h('input', { type: need > 1 ? 'checkbox' : 'radio', name: 'vote', 'aria-label': t('vote.for', { name: d.name }), checked: picks.includes(d.id) });
      const label = h('label', { class: 'choice', 'data-id': d.id },
        h('div', { class: 'thumb-sm' }, thumb(d.strokes)),
        h('span', { class: 'nm', text: d.name }),
        input);
      input.addEventListener('change', () => {
        if (need === 1) picks.splice(0, picks.length, d.id);
        else if (!input.checked) picks.splice(picks.indexOf(d.id), 1);
        else if (picks.length >= need) { input.checked = false; toast(t('vote.pickLimit', { n: need })); }
        else picks.push(d.id);
        sync();
      });
      return label;
    });
    root.append(screenEl('',
      h('div', { class: 'row between' }, h('span'), timerPill(st.room.deadline)),
      h('div', { class: 'center' },
        h('h1', { class: 'h1', text: need > 1 ? t('vote.titleMany', { n: need }) : t('vote.title') }),
        h('p', { class: 'sub', text: need > 1 ? t('vote.subMany', { n: need }) : t('vote.sub') })),
      h('div', { class: 'col choices' }, choices),
      h('p', { class: 'small center row' }, icon('lock', 20, '#33405A'), t('vote.hidden')),
      h('div', { class: 'spacer' }),
      submit));
    sync();
    const beeps = countdown(0);
    return { update() {}, tick() { beeps(st.room.deadline); } };
  };

  screens.voteWait = (root, st) => {
    setBg('#D3EAFF');
    const total = connectedCount(st);
    const done = st.room.players.filter((p) => playing(p) && p.voted).length;
    root.append(screenEl('',
      h('h1', { class: 'h1 xl', text: t('voteWait.title') }),
      h('div', { class: 'center' },
        h('div', { class: 'h2 big', text: t('waitingOthers') }),
        h('div', { class: 'small' }, tn('voteWait.count', { done, total, time: timerText(st.room.deadline) }))),
      h('div', { class: 'progress', role: 'img', 'aria-label': t('voteWait.progress', { done, total }) },
        st.room.players.filter(playing).map((p) => h('i', { class: p.voted ? 'on' : '' }))),
      statusList(st, 'voted', t('st.voted'), t('st.thinking'))));
  };

  // ----- imposter's last-chance guess
  screens.guess = (root, st) => {
    setBg('#FFE0C7');
    const input = h('input', { class: 'input big', id: 'gs', type: 'text', maxlength: 40, value: S.ui.guessText, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: t('guess.placeholder') });
    input.addEventListener('input', () => { S.ui.guessText = input.value; });
    const go = () => {
      const w = input.value.trim();
      if (!w) { toast(t('guess.empty')); input.focus(); return; }
      send({ t: 'guess', word: w });
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    root.append(screenEl('',
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), timerPill(st.room.deadline)),
      h('div', { class: 'center' },
        h('h1', { class: 'h1 huge', text: t('guess.title') }),
        h('p', { class: 'sub tall', text: t(st.room.imposters > 1 ? 'guess.subMany' : 'guess.sub') })),
      h('div', { class: 'card shadow col center' }, h('div', { class: 'caps small', text: t('guess.hintWas') }), bigText('big-word mid', loc(st.guess.hint))),
      h('div', { class: 'col' }, h('label', { class: 'label', for: 'gs', text: t('guess.label') }), input,
        h('p', { class: 'small center', text: t(st.room.imposters > 1 ? 'guess.ruleMany' : 'guess.rule') })),
      h('div', { class: 'spacer' }),
      btn(t('guess.lock'), go)));
    return { update() {} };
  };

  screens.guessWait = (root, st) => {
    setBg('#FFE0C7');
    root.append(screenEl('',
      h('div', { class: 'row' }, h('span', { class: 'spacer' }), timerPill(st.room.deadline)),
      h('div', { class: 'spacer' }),
      h('div', { class: 'card shadow col center' },
        h('div', { class: 'qmark', text: '?' }),
        st.guess.imposter
          ? [h('h1', { class: 'h1', text: t('gw.lockedTitle') }), h('p', { class: 'sub', text: t('gw.lockedSub') })]
          : st.room.imposters > 1
            ? [h('h1', { class: 'h1', text: t('gw.manyTitle') }), h('p', { class: 'sub', text: t('gw.manySub') })]
            : [h('h1', { class: 'h1', text: t('gw.title') }), h('p', { class: 'sub', text: t('gw.sub') })]),
      h('div', { class: 'spacer' })));
  };

  // ----- joined mid-round: wait for the next one
  screens.waitNext = (root, st) => {
    setBg('#FFF6E5');
    const r = st.room;
    const doing = ['prompt', 'draw', 'reveal', 'vote', 'guess', 'results'].includes(r.phase) ? r.phase : 'draw';
    root.append(screenEl('',
      header(t('wn.title'), leaveGame, soundBtn()),
      h('div', { class: 'card shadow col center' },
        h('div', { class: 'h2 big center', text: t('wn.card') }),
        h('p', { class: 'sub', text: t(`wn.${doing}`) })),
      h('h2', { class: 'h2', text: t('players', { count: r.players.length, max: r.max }) }),
      h('div', { class: 'plist' }, r.players.map((p) =>
        h('div', { class: 'prow' },
          avatar(p.color),
          h('span', { class: 'grow', text: p.id === st.you ? t('you', { name: p.name }) : p.name }),
          p.id === r.host ? h('span', { class: 'host-tag', text: t('host') }) : null,
          h('span', { class: 'st', text: p.waiting ? t('st.nextRound') : p.connected ? t('st.playing') : t('st.away') })))),
      h('div', { class: 'spacer' }),
      btn(t('wn.btn'), () => {}, { disabled: true })));
  };

  // ----- results
  screens.results = (root, st) => {
    setBg('#FFD9E3');
    const r = st.result;
    const isHost = st.room.host === st.you;
    const win = r.winner === 'players';
    const imps = r.imposters;
    const many = imps.length > 1;
    const one = imps[0];
    const lines = [h('p', { class: 'res-line' }, tn('res.word', { word: h('b', { class: 'chip-word', text: loc(r.word).toUpperCase() }) })),
      h('p', { class: 'res-line', text: many ? t('res.hintMany', { hint: loc(r.hint) }) : t('res.hint', { name: one.name, hint: loc(r.hint) }) })];
    const right = imps.find((i) => i.guessCorrect);
    const guessed = imps.filter((i) => i.guess).map((i) => t('res.guessed', { name: i.name, guess: i.guess }));
    const why = {
      guessright: right && t('res.guessright', { name: right.name, guess: right.guess }),
      guesswrong: t('res.notQuite', { text: guessed.join(lang === 'zh' || lang === 'ja' ? '、' : lang === 'ar' ? '، ' : ', ') }),
      noguess: many ? t('res.noguessMany') : t('res.noguess', { name: one.name }),
      tie: t(many ? 'res.tieMany' : 'res.tie'),
      wrongsuspect: many ? t('res.wrongMany', { caught: imps.filter((i) => i.caught).length, total: imps.length }) : t('res.wrong'),
      novotes: t(many ? 'res.novotesMany' : 'res.novotes'),
    }[r.reason];
    if (why) lines.push(h('p', { class: 'res-line', text: why }));
    const maxVotes = Math.max(1, ...r.tally.map((v) => v.count));

    root.append(screenEl('',
      h('h1', { class: 'h1', text: t(many ? 'res.titleMany' : 'res.title') }),
      h('div', { class: 'card shadow col center' },
        many
          ? h('div', { class: 'col imps' }, imps.map((i) => h('div', { class: 'row' },
            avatar(i.color), h('span', { class: 'h2 grow', text: i.name }),
            h('span', { class: `badge mini ${i.caught ? 'good' : 'bad'}`, text: t(i.caught ? 'res.caughtTag' : 'res.escapedTag') }))))
          : h('div', { class: 'row' }, avatar(one.color, 'av lg'), h('span', { class: 'h1 name', text: one.name })),
        h('span', { class: `badge ${r.caught ? 'good' : 'bad'}`, text: t(r.caught ? (many ? 'res.allCaught' : 'res.caught') : 'res.escaped') }),
        lines),
      h('div', { class: 'center' }, h('span', { class: 'pill' }, t(win ? 'res.playersWin' : many ? 'res.impsWin' : 'res.impWin'))),
      h('div', { class: 'card col' },
        h('div', { class: 'h2', text: t('res.votes') }),
        r.tally.map((v) => h('div', { class: 'row' },
          h('span', { class: 'vname', text: v.name }),
          h('span', { class: 'bar' }, h('i', { 'data-w': v.count / maxVotes })),
          h('span', { class: 'vcount', text: v.count })))),
      h('div', { class: 'spacer' }),
      isHost ? btn(t('res.again'), () => send({ t: 'again' })) : btn(t('waitingHost'), () => {}, { disabled: true }),
      h('div', { class: 'row' },
        isHost ? h('button', { class: 'link grow', type: 'button', onClick: () => send({ t: 'lobby' }) }, t('res.lobby')) : null,
        h('button', { class: 'link grow', type: 'button', onClick: leaveGame }, t('res.leave')))));
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
      if (m && m.waiting && st.room.phase !== 'lobby') name = 'waitNext';
      else switch (st.room.phase) {
        case 'lobby': name = 'lobby'; break;
        case 'prompt': name = m && m.ready ? 'promptWait' : 'prompt'; break;
        case 'draw': name = m && m.submitted ? 'drawWait' : 'draw'; break;
        case 'reveal': name = m && m.ready ? 'revealWait' : 'reveal'; break;
        case 'vote': name = m && m.voted ? 'voteWait' : 'vote'; break;
        case 'guess': name = st.guess && st.guess.imposter && !st.guess.done ? 'guess' : 'guessWait'; break;
        default: name = 'results';
      }
    }
    // the imposter count can drop mid-round (one left), and the vote screen is built around it
    const key = `${name}:${st ? `${st.room.round}:${st.room.imposters}` : ''}`;
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

  if (new URLSearchParams(location.search).has('uitest')) window.diTest = { bigText, setLang }; // hook for test/ui.js

  route();
  connect();
})();
