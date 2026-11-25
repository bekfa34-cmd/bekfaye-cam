// Bek. Faye v3 - Mosh import editor (job C), modelled on MoshUp's flow:
//   source menu (video / picture) -> trim strip (cap 20 s) -> editor (looping preview, timeline, hold MOSH to paint spans,
//   polygon regions with an effect + time range, Video B) -> Export (1x playback through viewer+mosh, canvas + original audio).
// The editor owns the shared viewer while open: the app should pause its camera loop and resize the canvas on close.

import { MOSH_MODES } from './mosh.js';

const CAP = 20;                       // seconds
const PREVIEW_SIDE = 1280, EXPORT_SIDE = 1920;
const FX = [['mosh', 'Mosh'], ['grey', 'Grey'], ['colour', 'Colour'], ['mirror', 'Mirror top'], ['freeze', 'Freeze'], ['videob', 'Video B']];
const MOSHY = ['mosh', 'freeze', 'videob'];
const PIVOT_MODES = ['bloom', 'radial', 'swirl'];
const RGB = { grey: '#f00', colour: '#0f0', mirror: '#00f' };

const CSS = `
.mx{position:fixed;inset:0;z-index:300;background:#000;color:#F7EDEE;font:15px/1.3 'Babel Sans',system-ui,sans-serif;display:flex;flex-direction:column;
 padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);user-select:none;-webkit-user-select:none;touch-action:manipulation}
.mx *{box-sizing:border-box}.mx [hidden]{display:none!important}
.mx button{font:inherit;color:#F7EDEE;background:#53393A;border:1px solid #835965;border-radius:0;text-transform:uppercase;letter-spacing:.12em;font-size:13px;min-height:44px;min-width:44px;padding:0 14px}
.mx button:active{background:#835965}.mx button.on{background:#C1798D;color:#000;border-color:#C1798D}.mx button[disabled]{opacity:.35}
.mx-bar{display:flex;align-items:center;gap:8px;padding:6px 12px;flex:none}.mx-title{flex:1;text-align:center;font-weight:600;text-transform:uppercase;letter-spacing:.25em;font-size:13px}
.mx-center{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:stretch;gap:14px;padding:24px}
.mx-center button{min-height:60px;font-size:17px}
.mx-stage{position:relative;flex:1;min-height:0;min-width:0;display:flex;align-items:center;justify-content:center;background:#000;touch-action:none;container-type:size}
.mx-stage video{display:block;max-width:100%;max-height:100%}
.mx-stage .box{position:relative;width:min(100cqw,calc(100cqh * var(--ar,1)));aspect-ratio:var(--ar,1)}
.mx-stage .box canvas{display:block;width:100%;height:100%}
.mx-ov{position:absolute;inset:0}.mx-ov svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
.mx-vx{position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;touch-action:none}
.mx-vx::after{content:'';position:absolute;left:50%;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;border:2px solid #C1798D;box-shadow:0 0 0 1px #000,inset 0 0 0 1px #000}
.mx-vx.nopt{pointer-events:none}.mx-vx.nopt::after{width:8px;height:8px;margin:-4px 0 0 -4px;background:#C1798D;border:0}
.mx-vx.first::after{width:18px;height:18px;margin:-9px 0 0 -9px;border-color:#F7EDEE;background:rgba(193,121,141,.5)}
.mx-pv{position:absolute;width:20px;height:20px;margin:-10px 0 0 -10px;border:2px solid #F7EDEE;pointer-events:none;box-shadow:0 0 0 1px #000}
.mx-stage .mx-draw{position:absolute;left:0;right:0;top:8px;text-align:center;font-size:12px;letter-spacing:.15em;text-transform:uppercase;pointer-events:none;text-shadow:0 1px 4px #000}
.mx-strip{position:relative;flex:none;height:56px;margin:6px 14px;background:#53393A;overflow:hidden;touch-action:none}
.mx-strip .th{position:absolute;inset:0;display:flex}.mx-strip .th canvas{flex:1;min-width:0;height:100%;object-fit:cover}
.mx-win{position:absolute;top:0;bottom:0;border:3px solid #C1798D;background:rgba(193,121,141,.15)}
.mx-win i{position:absolute;top:-3px;bottom:-3px;width:14px;background:#C1798D}.mx-win i.l{left:-3px}.mx-win i.r{right:-3px}
.mx-win i::before{content:'';position:absolute;inset:0 -15px}
.mx-time{font:12px ui-monospace,monospace;color:#C1798D;text-align:center;padding:2px;flex:none}
.mx-row{display:flex;gap:8px;padding:6px 12px;flex:none;overflow-x:auto;-webkit-overflow-scrolling:touch;--ml:0px;--mr:0px;-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 var(--ml),#000 calc(100% - var(--mr)),transparent 100%);mask-image:linear-gradient(90deg,transparent 0,#000 var(--ml),#000 calc(100% - var(--mr)),transparent 100%)}.mx-row button{flex:none;font-size:12px;padding:0 12px}
.mx-busy{position:absolute;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;z-index:9;font-size:17px}
.mx-busy button{min-width:120px}.mx-busy .mx-time{min-height:16px}
/* editor: picture first, then the control column (under it in portrait, beside it in landscape) */
.mx-main{flex:1;min-height:0;display:flex;flex-direction:column}
.mx-side{flex:none;display:flex;flex-direction:column;max-height:64%;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.mx-tl{position:relative;margin:2px 12px 0;touch-action:none}
.mx-tlh{display:flex;justify-content:space-between;align-items:baseline;padding:6px 12px 4px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#835965}
.mx-tlh .mx-time{padding:0}
.mx-track{position:relative;height:44px;background:#53393A;overflow:hidden}
.mx-track .th{position:absolute;inset:0;display:flex;opacity:.55}.mx-track .th canvas{flex:1;min-width:0;height:100%}
.mx-span{position:absolute;top:0;bottom:0;background:rgba(193,121,141,.8);border-left:2px solid #F7EDEE;border-right:2px solid #F7EDEE}
.mx-ph{position:absolute;top:-4px;bottom:-4px;width:2px;margin-left:-1px;background:#F7EDEE;pointer-events:none;z-index:5;box-shadow:0 0 0 1px #000}
.mx-lanes{max-height:84px;overflow-y:auto;overscroll-behavior:contain;touch-action:pan-y}
.mx-lane{position:relative;height:36px;margin-top:4px;background:rgba(83,57,58,.45)}
.mx-bar2{position:absolute;top:3px;bottom:3px;background:#53393A;border:1px solid #835965;font-size:11px;letter-spacing:.12em;text-transform:uppercase;line-height:28px;padding:0 18px;overflow:visible;white-space:nowrap}
.mx-lane.sel .mx-bar2{background:#835965;border-color:#F7EDEE}
.mx-bar2 i{position:absolute;top:-1px;bottom:-1px;width:14px;background:#C1798D;touch-action:none}.mx-bar2 i.l{left:-1px}.mx-bar2 i.r{right:-1px}
.mx-bar2 i::before{content:'';position:absolute;top:-4px;bottom:-4px;left:-15px;right:-15px}
.mx-tools,.mx-grid{display:grid;gap:6px;padding:8px 12px 0}.mx-tools{grid-template-columns:repeat(4,1fr)}.mx-grid{grid-template-columns:repeat(3,1fr)}
.mx-tools button,.mx-grid button{min-width:0;padding:0 4px;font-size:12px;letter-spacing:.08em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mx-lbl{padding:10px 12px 0;min-height:24px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#C1798D}
.mx-hold{position:sticky;bottom:0;background:#000;padding:8px 12px 10px;margin-top:auto}
.mx-mosh{width:100%;min-height:64px!important;font-weight:700;font-size:18px!important;letter-spacing:.3em!important;background:#835965!important;border-color:#835965!important;touch-action:none}
.mx-mosh.on{background:#C1798D!important;border-color:#C1798D!important;color:#000!important}
@media (orientation:landscape){.mx-main{flex-direction:row}.mx-side{width:min(380px,46%);max-height:none;border-left:1px solid #53393A}.mx-bar{padding:2px 12px}}
`;

const $el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const ptr = (e, el) => { const r = el.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
const seeked = (v) => new Promise((res) => { const f = () => { v.removeEventListener('seeked', f); res(); }; v.addEventListener('seeked', f); });

export function mergeSpans(spans) {
  const s = spans.map((x) => ({ ...x })).sort((p, q) => p.a - q.a), out = [];
  for (const x of s) { const l = out[out.length - 1]; if (l && x.a <= l.b + 0.02) l.b = Math.max(l.b, x.b); else if (x.b - x.a > 0.03) out.push(x); }
  return out;
}

/* fade the edge of a scrolling row that has more to show */
function fadeCues(row) {
  const f = () => { row.style.setProperty('--ml', row.scrollLeft > 4 ? '22px' : '0px'); row.style.setProperty('--mr', row.scrollLeft + row.clientWidth < row.scrollWidth - 4 ? '22px' : '0px'); };
  row.addEventListener('scroll', f, { passive: true }); const ro = new ResizeObserver(f); ro.observe(row); f();
  return ro;
}

export function openMoshEditor(rootEl, { viewer, mosh, createRecorder, onSaved, onClose }) {
  if (!document.getElementById('mx-css')) { const st = $el('style'); st.id = 'mx-css'; st.textContent = CSS; document.head.appendChild(st); }
  const saved = { crop: viewer.options.crop, zoom: viewer.options.zoom };
  viewer.setOptions({ crop: [0, 0, 1, 1], zoom: 1 });
  const root = $el('div', 'mx'); rootEl.appendChild(root);
  const S = {
    kind: null, url: null, el: null, w: 0, h: 0, full: 0, start: 0, dur: 0, spans: [], regions: [], gmode: 'smear', amt: 0.6, key: 'off',
    pivot: [0.5, 0.5], sel: null, drawing: null, manual: false, spanA: 0, playing: true, vb: null, rev: 0, exporting: false, thumbs: [],
  };
  let raf = 0, closed = false, lastT = -1, lastRender = 0, imgT = 0, imgLast = 0, uid = 1;
  let maskKey = '', fxKey = '', curMode = null, wasHold = false, ros = [];
  const cm = $el('canvas'), cf = $el('canvas'); cm.width = cf.width = 320; cm.height = cf.height = 180;
  const api = { state: S };

  const close = () => {
    if (closed) return; closed = true; cancelAnimationFrame(raf);
    ros.forEach((o) => o.disconnect()); ros = [];
    mosh.hold(false); mosh.setMask(null); mosh.setFx(null); mosh.setVideoB(null); mosh.reset();
    viewer.setOptions(saved); [S.el, S.vb].forEach((v) => v && v.pause && v.pause());
    if (S.url) URL.revokeObjectURL(S.url);
    if (S.vbUrl) URL.revokeObjectURL(S.vbUrl);
    root.remove(); onClose && onClose();
  };
  api.close = close;

  // ---------- step 1: source menu ----------
  function stepSource() {
    root.innerHTML = '';
    const bar = $el('div', 'mx-bar', '<button data-x>Cancel</button><div class="mx-title">Mosh a clip</div><span style="width:44px"></span>');
    bar.querySelector('[data-x]').onclick = close;
    const c = $el('div', 'mx-center', '<button data-v>Load video</button><button data-p>Load picture</button>');
    const fv = $el('input'); fv.type = 'file'; fv.accept = 'video/*'; fv.hidden = true;
    const fp = $el('input'); fp.type = 'file'; fp.accept = 'image/*'; fp.hidden = true;
    c.querySelector('[data-v]').onclick = () => fv.click(); c.querySelector('[data-p]').onclick = () => fp.click();
    fv.onchange = () => fv.files[0] && loadVideo(fv.files[0]);
    fp.onchange = () => fp.files[0] && loadPicture(fp.files[0]);
    root.append(bar, c, fv, fp);
    api.pickVideo = loadVideo; api.pickPicture = loadPicture;
  }
  const busy = (msg) => { const b = $el('div', 'mx-busy', msg); root.appendChild(b); return b; };

  async function loadPicture(file) {
    const b = busy('Loading picture...');
    const img = new Image(); img.src = S.url = URL.createObjectURL(file);
    try { await img.decode(); } catch (e) { URL.revokeObjectURL(S.url); S.url = null; b.textContent = 'Could not read that picture.'; setTimeout(stepSource, 1500); return; }
    Object.assign(S, { kind: 'image', el: img, w: img.naturalWidth, h: img.naturalHeight, start: 0, dur: 5 });
    stepEditor();
  }
  async function loadVideo(file) {
    const b = busy('Preparing video...');
    const v = $el('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = S.url = URL.createObjectURL(file);
    try { await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('bad')); }); }
    catch (e) { URL.revokeObjectURL(S.url); S.url = null; b.textContent = 'Could not read that video.'; setTimeout(stepSource, 1500); return; }
    Object.assign(S, { kind: 'video', el: v, w: v.videoWidth, h: v.videoHeight, full: v.duration, start: 0, dur: Math.min(CAP, v.duration) });
    stepTrim();
  }

  // ---------- step 2: trim ----------
  async function thumbs(v, n, h = 64) {
    const out = [], t = $el('video'); t.muted = true; t.playsInline = true; t.src = v.src;
    try {
      await new Promise((r) => { t.onloadeddata = r; t.onerror = r; });
      for (let i = 0; i < n && !closed && t.videoWidth; i++) {
        t.currentTime = Math.min(v.duration - 0.05, (i + 0.5) * v.duration / n); await seeked(t);
        const c = $el('canvas'); c.height = h; c.width = Math.round(h * t.videoWidth / t.videoHeight);
        c.getContext('2d').drawImage(t, 0, 0, c.width, c.height); out.push(c);
      }
    } finally { t.pause(); t.removeAttribute('src'); t.load(); } // free the decoder
    return out;
  }
  async function stepTrim() {
    root.innerHTML = '';
    const bar = $el('div', 'mx-bar', '<button data-x>Cancel</button><div class="mx-title">Choose Video</div><button data-ok>Choose</button>');
    const stage = $el('div', 'mx-stage'); const v = S.el; v.controls = false; v.loop = false;
    stage.appendChild(v);
    const strip = $el('div', 'mx-strip'), th = $el('div', 'th'), win = $el('div', 'mx-win', '<i class="l"></i><i class="r"></i>');
    strip.append(th, win);
    const info = $el('div', 'mx-time'), row = $el('div', 'mx-row'), play = $el('button', null, 'Play');
    row.appendChild(play);
    root.append(bar, stage, strip, info, row);
    bar.querySelector('[data-x]').onclick = () => { if (S.url) URL.revokeObjectURL(S.url); S.url = null; stepSource(); };
    bar.querySelector('[data-ok]').onclick = () => { v.pause(); stepEditor(); };
    const full = S.full, pxs = () => strip.clientWidth;
    const paint = () => { win.style.left = (S.start / full * 100) + '%'; win.style.width = (S.dur / full * 100) + '%';
      info.textContent = `${fmt(S.start)} - ${fmt(S.start + S.dur)}  (${S.dur.toFixed(1)} s, max ${CAP})`; };
    paint();
    let drag = null;
    strip.onpointerdown = (e) => { strip.setPointerCapture(e.pointerId); const x = ptr(e, strip)[0] * full, a = S.start, b = S.start + S.dur;
      drag = { m: e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : (x > a && x < b ? 'm' : 'n'), x, a, b }; if (drag.m === 'n') drag = null; };
    strip.onpointermove = (e) => { if (!drag) return; const x = ptr(e, strip)[0] * full, d = x - drag.x; let a = drag.a, b = drag.b;
      if (drag.m === 'm') { const L = b - a; a = clamp(a + d, 0, full - L); b = a + L; }
      else if (drag.m === 'l') { a = clamp(a + d, Math.max(0, b - CAP), b - 0.5); }
      else b = clamp(b + d, a + 0.5, Math.min(full, a + CAP));
      S.start = a; S.dur = b - a; paint(); if (drag.m !== 'r') v.currentTime = a; else v.currentTime = b - 0.05; };
    strip.onpointerup = strip.onpointercancel = () => { drag = null; };
    play.onclick = () => { if (v.paused) { v.currentTime = S.start; v.muted = false; v.play(); play.textContent = 'Pause'; } else { v.pause(); play.textContent = 'Play'; } };
    v.ontimeupdate = () => { if (v.currentTime >= S.start + S.dur) { v.currentTime = S.start; } };
    v.currentTime = 0;
    thumbs(v, 12).then((cs) => { cs.forEach((c) => th.appendChild(c)); S.thumbs = cs; });
    api.trim = { set(a, d) { S.start = a; S.dur = Math.min(CAP, d); paint(); } };
  }

  // ---------- step 3: editor ----------
  let disp, dctx, ov, svg, track, tlHost, phEl, laneBox, timeEl, modeRow, fxRow, fxHint, playBtn, moshBtn, stageBox, vxHost, pvEl, addBtn, delBtn, doneBtn, bBtn, fb, drawMsg;
  const media = () => S.el;
  const tNow = () => S.kind === 'video' ? clamp(S.el.currentTime - S.start, 0, S.dur) : imgT;
  const seek = (t) => { t = clamp(t, 0, S.dur - 0.001); if (S.kind === 'video') S.el.currentTime = S.start + t; else imgT = t; lastT = -1; };
  const sel = () => S.regions.find((r) => r.id === S.sel);

  function stepEditor() {
    root.innerHTML = '';
    const bar = $el('div', 'mx-bar', '<button data-x>✕</button><div class="mx-title">Edit</div><button data-ex class="on">Export</button>');
    const stage = $el('div', 'mx-stage'); stageBox = $el('div', 'box');
    disp = $el('canvas'); dctx = disp.getContext('2d');
    ov = $el('div', 'mx-ov'); svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('preserveAspectRatio', 'none');
    vxHost = $el('div'); pvEl = $el('div', 'mx-pv'); drawMsg = $el('div', 'mx-draw'); ov.append(svg, vxHost, pvEl, drawMsg);
    stageBox.append(disp, ov); stage.appendChild(stageBox);
    timeEl = $el('div', 'mx-time');
    const tlh = $el('div', 'mx-tlh', '<span>Timeline</span>'); tlh.appendChild(timeEl);
    tlHost = $el('div', 'mx-tl'); track = $el('div', 'mx-track'); const th = $el('div', 'th'); S.thumbs.forEach((c) => { const d = $el('canvas'); d.width = c.width; d.height = c.height; d.getContext('2d').drawImage(c, 0, 0); th.appendChild(d); });
    phEl = $el('div', 'mx-ph'); track.append(th); laneBox = $el('div', 'mx-lanes'); tlHost.append(track, laneBox, phEl);
    // one row of tools, then the effect / style choice, then the big HOLD
    playBtn = $el('button', null, 'Pause'); addBtn = $el('button', null, '+ Region'); doneBtn = $el('button', 'on', 'Done');
    delBtn = $el('button', null, 'Delete'); bBtn = $el('button', null, 'Video B');
    fb = $el('input'); fb.type = 'file'; fb.accept = 'video/*'; fb.hidden = true;
    const tools = $el('div', 'mx-tools'); tools.append(playBtn, addBtn, doneBtn, delBtn, bBtn, fb);
    fxHint = $el('div', 'mx-lbl'); fxRow = $el('div', 'mx-grid'); modeRow = $el('div', 'mx-row');
    moshBtn = $el('button', 'mx-mosh', 'Hold to mosh'); const hold = $el('div', 'mx-hold'); hold.appendChild(moshBtn);
    const side = $el('div', 'mx-side'); side.append(tlh, tlHost, tools, fxHint, fxRow, modeRow, hold);
    const main = $el('div', 'mx-main'); main.append(stage, side);
    root.append(bar, main);
    ros.push(fadeCues(modeRow));

    bar.querySelector('[data-x]').onclick = askClose; bar.querySelector('[data-ex]').onclick = doExport;
    playBtn.onclick = () => { setPlaying(!S.playing); };
    // hold MOSH: paint a span while pressed
    const down = (e) => { e.preventDefault(); moshBtn.setPointerCapture && moshBtn.setPointerCapture(e.pointerId); if (S.manual) return; S.manual = true; S.spanA = tNow(); moshBtn.classList.add('on'); if (!S.playing) setPlaying(true); };
    const up = () => { if (!S.manual) return; S.manual = false; moshBtn.classList.remove('on'); S.spans = mergeSpans([...S.spans, { a: S.spanA, b: tNow() }]); drawTl(); };
    moshBtn.onpointerdown = down; moshBtn.onpointerup = moshBtn.onpointercancel = up;
    api.holdMosh = (b) => (b ? down({ preventDefault() {}, pointerId: 1 }) : up());
    addBtn.onclick = () => { S.drawing = []; S.sel = null; refresh(); };
    doneBtn.onclick = closeShape;
    delBtn.onclick = () => { S.regions = S.regions.filter((r) => r.id !== S.sel); S.sel = null; S.rev++; refresh(); };
    bBtn.onclick = () => fb.click();
    fb.onchange = () => { if (!fb.files[0]) return; if (S.vb) { S.vb.pause(); S.vb.removeAttribute('src'); } if (S.vbUrl) URL.revokeObjectURL(S.vbUrl); const v = $el('video'); v.muted = true; v.loop = true; v.playsInline = true; v.src = S.vbUrl = URL.createObjectURL(fb.files[0]); fb.value = ''; v.play().catch(() => {}); S.vb = v; mosh.setVideoB(v);
      const r = sel(); if (r) { r.fx = 'videob'; S.rev++; } refresh(); };
    api.setVideoB = (v) => { S.vb = v; mosh.setVideoB(v); refresh(); };

    ov.onpointerdown = (e) => { if (e.target !== ov) return; const [x, y] = ptr(e, ov);
      if (S.drawing) { const f = S.drawing[0]; if (f && S.drawing.length >= 3 && Math.hypot((x - f[0]) * disp.clientWidth, (y - f[1]) * disp.clientHeight) < 28) closeShape(); else S.drawing.push([x, y]); refresh(); return; }
      if (PIVOT_MODES.includes(S.gmode)) { S.pivot = [x, y]; mosh.setPivot(x, y); refresh(); return; }
      S.sel = null; refresh(); };
    api.tapStage = (x, y) => ov.onpointerdown({ target: ov, clientX: ov.getBoundingClientRect().left + x * ov.clientWidth, clientY: ov.getBoundingClientRect().top + y * ov.clientHeight });
    api.closeShape = closeShape;

    // timeline: drag to scrub; tap on red span deletes it
    let sd = null;
    track.onpointerdown = (e) => { track.setPointerCapture(e.pointerId); const x = ptr(e, track)[0]; sd = { x0: e.clientX, moved: false, sp: e.target.closest('.mx-span') };
      if (!sd.sp) { setPlaying(false); seek(x * S.dur); } };
    track.onpointermove = (e) => { if (!sd) return; if (Math.abs(e.clientX - sd.x0) > 6) sd.moved = true; if (sd.moved) { setPlaying(false); seek(ptr(e, track)[0] * S.dur); } };
    track.onpointerup = () => { if (!sd) return; if (sd.sp && !sd.moved) { S.spans.splice(+sd.sp.dataset.i, 1); drawTl(); } sd = null; };
    track.onpointercancel = () => { sd = null; };
    api.deleteSpan = (i) => { S.spans.splice(i, 1); drawTl(); };
    api.sizeStage = sizeStage; sizeStage();
    refresh(); drawTl();
    if (S.kind === 'video') { S.el.ontimeupdate = null; S.el.muted = true; S.el.loop = false; S.el.currentTime = S.start; }
    setPlaying(true); mosh.setPivot(...S.pivot);
    cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
  }

  function sizeStage() { // output size = clip size capped, used for the preview canvas
    const k = Math.min(1, PREVIEW_SIDE / Math.max(S.w, S.h)), w = Math.round(S.w * k / 2) * 2, h = Math.round(S.h * k / 2) * 2;
    viewer.ensureSize(w, h); disp.width = w; disp.height = h;
    stageBox.parentNode.style.setProperty('--ar', w / h);
  }
  function setPlaying(p) { S.playing = p; if (playBtn) playBtn.textContent = p ? 'Pause' : 'Play';
    if (S.kind === 'video') { if (p) S.el.play().catch(() => {}); else S.el.pause(); } imgLast = performance.now(); }

  function closeShape() {
    if (S.drawing && S.drawing.length >= 3) { const r = { id: uid++, pts: S.drawing, fx: 'mosh', mode: S.gmode, t0: 0, t1: S.dur }; S.regions.push(r); S.sel = r.id; S.rev++; }
    S.drawing = null; refresh();
  }

  // ---------- region / chip UI ----------
  function refresh() {
    if (!fxRow) return;
    const r = sel();
    fxRow.innerHTML = ''; modeRow.innerHTML = '';
    const idx = r ? S.regions.indexOf(r) + 1 : 0;
    fxHint.textContent = S.drawing ? 'Drawing a region' : r ? `Region ${idx} effect` : S.vb ? (S.regions.length ? 'Tap a region, then pick Video B' : 'Draw a region, then pick Video B') : 'Mosh style';
    addBtn.hidden = !!S.drawing; doneBtn.hidden = !S.drawing; delBtn.disabled = !r; bBtn.textContent = S.vb ? 'Video B ✓' : 'Video B';
    drawMsg.textContent = S.drawing ? (S.drawing.length >= 3 ? 'Tap the first dot or Done to close' : 'Tap to place points') : '';
    // region effects only once a region is selected; Video B goes first when a clip is loaded
    fxRow.hidden = !r;
    if (r) (S.vb ? [FX[5], ...FX.slice(0, 5)] : FX).forEach(([id, name]) => { const b = $el('button', r.fx === id ? 'on' : '', name);
      b.onclick = () => { if (id === 'videob' && !S.vb) fb.click(); r.fx = id; if (id === 'mosh') r.mode = S.gmode; S.rev++; refresh(); drawTl(); }; fxRow.appendChild(b); });
    const cur = r && r.fx === 'mosh' ? r.mode : S.gmode;
    modeRow.hidden = !!S.drawing || (r && r.fx !== 'mosh');
    MOSH_MODES.filter((m) => m.n < 12).forEach((m) => { const b = $el('button', m.id === cur ? 'on' : '', m.name);
      b.onclick = () => { if (r && r.fx === 'mosh') { r.mode = m.id; S.rev++; } else S.gmode = m.id; refresh(); }; modeRow.appendChild(b); });
    // overlay
    drawPolys(); vxHost.innerHTML = '';
    const pts = S.drawing || (r ? r.pts : []);
    pts.forEach((p, i) => { const d = $el('div', 'mx-vx' + (S.drawing ? (i === 0 && pts.length >= 3 ? ' first' : ' nopt') : '')); d.style.left = p[0] * 100 + '%'; d.style.top = p[1] * 100 + '%';
      if (S.drawing && i === 0 && pts.length >= 3) d.onpointerdown = (e) => { e.stopPropagation(); e.preventDefault(); closeShape(); };
      if (!S.drawing) d.onpointerdown = (e) => { e.stopPropagation(); d.setPointerCapture(e.pointerId);
        d.onpointermove = (ev) => { const [x, y] = ptr(ev, ov); p[0] = clamp(x, 0, 1); p[1] = clamp(y, 0, 1); S.rev++; d.style.left = p[0] * 100 + '%'; d.style.top = p[1] * 100 + '%'; drawPolys(); }; // no refresh(): it would rebuild d and drop the capture
        d.onpointerup = d.onpointercancel = () => { d.onpointermove = null; }; };
      vxHost.appendChild(d); });
    ov.style.cursor = S.drawing ? 'crosshair' : '';
    pvEl.style.display = PIVOT_MODES.includes(S.gmode) ? '' : 'none'; pvEl.style.left = S.pivot[0] * 100 + '%'; pvEl.style.top = S.pivot[1] * 100 + '%';
    // region polygons are hit-tested by tapping inside them
    ov.onclick = (e) => { if (e.target !== ov || S.drawing) return; const [x, y] = ptr(e, ov); const hit = [...S.regions].reverse().find((g) => inside(g.pts, x, y)); if (hit) { S.sel = hit.id; refresh(); drawTl(); } };
    drawTl();
  }
  function drawPolys() {
    const poly = (pts) => pts.map((p) => `${p[0] * 100},${p[1] * 100}`).join(' ');
    let h = '';
    S.regions.forEach((g) => { h += `<polygon points="${poly(g.pts)}" fill="rgba(193,121,141,${g.id === S.sel ? .15 : .07})" stroke="#C1798D" stroke-width="2" vector-effect="non-scaling-stroke"/>`; });
    if (S.drawing && S.drawing.length) h += `<polyline points="${poly(S.drawing)}" fill="none" stroke="#C1798D" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
    svg.innerHTML = h;
  }
  function inside(pts, x, y) { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }

  // ---------- timeline drawing ----------
  const pc = (t) => (t / S.dur * 100) + '%';
  function drawTl() {
    if (!track) return;
    track.querySelectorAll('.mx-span').forEach((n) => n.remove());
    S.spans.forEach((s, i) => { const d = $el('div', 'mx-span'); d.dataset.i = i; d.style.left = pc(s.a); d.style.width = ((s.b - s.a) / S.dur * 100) + '%'; track.appendChild(d); });
    laneBox.innerHTML = ''; laneBox.hidden = !S.regions.length;
    S.regions.forEach((g, i) => {
      const lane = $el('div', 'mx-lane' + (g.id === S.sel ? ' sel' : '')), bar = $el('div', 'mx-bar2', `${i + 1} ${FX.find((f) => f[0] === g.fx)[1]}`);
      bar.style.left = pc(g.t0); bar.style.width = ((g.t1 - g.t0) / S.dur * 100) + '%';
      const l = $el('i', 'l'), r = $el('i', 'r'); bar.append(l, r); lane.appendChild(bar); laneBox.appendChild(lane);
      lane.onpointerdown = (e) => { S.sel = g.id; const m = e.target === l ? 'l' : e.target === r ? 'r' : null;
        if (!m) { refresh(); return; } lane.setPointerCapture(e.pointerId);
        lane.onpointermove = (ev) => { const t = clamp(ptr(ev, lane)[0] * S.dur, 0, S.dur); if (m === 'l') g.t0 = Math.min(t, g.t1 - 0.2); else g.t1 = Math.max(t, g.t0 + 0.2); S.rev++; bar.style.left = pc(g.t0); bar.style.width = ((g.t1 - g.t0) / S.dur * 100) + '%'; };
        lane.onpointerup = lane.onpointercancel = () => { lane.onpointermove = null; refresh(); }; };
    });
  }

  // ---------- frame state ----------
  function applyAt(t) {
    const inSpan = S.manual || S.spans.some((s) => t >= s.a && t < s.b);
    const act = S.regions.filter((r) => t >= r.t0 && t < r.t1), mr = act.filter((r) => MOSHY.includes(r.fx));
    const hold = inSpan || mr.length > 0;
    const m0 = mr[0], mode = inSpan ? S.gmode : m0 ? (m0.fx === 'mosh' ? m0.mode : m0.fx === 'freeze' ? 'freeze' : 'videob') : S.gmode;
    if (mode !== curMode) { mosh.setMode(mode); curMode = mode; }
    mosh.setParams({ amt: S.amt }); mosh.setKey(S.key);
    const mk = !inSpan && m0 ? 'm' + S.rev + ':' + mr.filter((r) => r.fx === m0.fx && r.mode === m0.mode).map((r) => r.id) : 'none';
    if (mk !== maskKey) { maskKey = mk;
      if (mk === 'none') mosh.setMask(null);
      else { const g = cm.getContext('2d'); g.clearRect(0, 0, cm.width, cm.height); g.fillStyle = '#fff';
        mr.filter((r) => r.fx === m0.fx && r.mode === m0.mode).forEach((r) => { g.beginPath(); r.pts.forEach((p, i) => g[i ? 'lineTo' : 'moveTo'](p[0] * cm.width, p[1] * cm.height)); g.fill(); }); mosh.setMask(cm); } }
    const fr = act.filter((r) => RGB[r.fx]), fk = fr.length ? 'f' + S.rev + ':' + fr.map((r) => r.id) : 'none';
    if (fk !== fxKey) { fxKey = fk;
      if (fk === 'none') mosh.setFx(null);
      else { const g = cf.getContext('2d'); g.globalCompositeOperation = 'source-over'; g.fillStyle = '#000'; g.fillRect(0, 0, cf.width, cf.height); g.globalCompositeOperation = 'lighter';
        fr.forEach((r) => { g.fillStyle = RGB[r.fx]; g.beginPath(); r.pts.forEach((p, i) => g[i ? 'lineTo' : 'moveTo'](p[0] * cf.width, p[1] * cf.height)); g.fill(); }); mosh.setFx(cf); } }
    if (hold !== wasHold) { wasHold = hold; mosh.hold(hold); }
  }
  function renderFrame(src, t) {
    if (Math.abs(t - lastT) > 0.3 || t < lastT) mosh.reset();
    lastT = t; applyAt(t);
    viewer.setSource(src); viewer.render();
  }

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (S.exporting || closed) return;
    if (S.playing) {
      if (S.kind === 'image') { imgT += (now - imgLast) / 1000; if (imgT >= S.dur) imgT = 0; }
      else if (S.el.currentTime >= S.start + S.dur - 0.03 || S.el.ended) {
        if (S.manual) { S.spans = mergeSpans([...S.spans, { a: S.spanA, b: S.dur }]); S.spanA = 0; drawTl(); }
        S.el.currentTime = S.start; mosh.reset(); }
    }
    imgLast = now;
    if (S.playing && S.kind === 'video' && S.el.paused && S.el.readyState >= 2) S.el.play().catch(() => {});   // first play can be rejected mid-seek
    const tt = tNow(), fresh = S.kind === 'video' ? tt !== lastRender : now - lastRender > 33 || tt !== lastRender;
    if (fresh || S.manual) { lastRender = tt; if (S.kind === 'video' && S.el.readyState < 2) return; renderFrame(S.el, tt); dctx.drawImage(viewer.canvas, 0, 0, disp.width, disp.height); }
    phEl.style.left = `calc(${(tt / S.dur) * 100}% )`; phEl.style.display = '';
    timeEl.textContent = `${fmt(tt)} / ${fmt(S.dur)}`;
  }

  // ---------- close with confirm (in-page, window.confirm is blocked in standalone PWAs) ----------
  function askClose() {
    if (S.exporting) return;
    if (!(S.spans.length || S.regions.length || S.vb)) return close();
    const b = busy('<div>Discard your edits?</div><button data-d class="on">Discard</button><button data-k>Keep editing</button>');
    b.querySelector('[data-d]').onclick = close; b.querySelector('[data-k]').onclick = () => b.remove();
  }

  // ---------- export ----------
  async function doExport() {
    if (S.exporting) return; S.exporting = true; S.cancel = false;
    // the audio engine has to be made inside the tap, before any await, or iOS leaves it suspended and the clip is silent
    let actx = null;
    if (S.kind === 'video') { try { actx = new (window.AudioContext || window.webkitAudioContext)(); actx.resume().catch(() => {}); } catch (e) { actx = null; } }
    setPlaying(false); mosh.hold(false); wasHold = false; maskKey = fxKey = 'x'; curMode = null;
    const b = busy('<div data-p>Rendering 0%</div><div class="mx-time" data-n></div><button data-c>Cancel</button>');
    const pEl = b.querySelector('[data-p]'), nEl = b.querySelector('[data-n]');
    b.querySelector('[data-c]').onclick = () => { S.cancel = true; };
    let ev = null, rec = null, recDone = false, done = false;
    const stopRec = () => { if (!rec || recDone) return null; recDone = true; return rec.stop(); };
    try {
      const k = Math.min(1, EXPORT_SIDE / Math.max(S.w, S.h)), w = Math.round(S.w * k / 2) * 2, h = Math.round(S.h * k / 2) * 2;
      viewer.ensureSize(w, h);
      let dest = null;
      if (S.kind === 'video') {
        ev = $el('video'); ev.playsInline = true; ev.preload = 'auto'; ev.src = S.url;
        await new Promise((res, rej) => { ev.onloadeddata = res; ev.onerror = () => rej(new Error('The clip could not be read')); setTimeout(() => rej(new Error('The clip took too long to load')), 10000); });
        if (actx) { try { dest = actx.createMediaStreamDestination(); actx.createMediaElementSource(ev).connect(dest); } catch (e) { dest = null; } }
        if (!dest) { ev.muted = true; nEl.textContent = 'Sound is not available: this export will be silent'; }
        ev.currentTime = S.start; await seeked(ev);
      }
      mosh.reset(); lastT = -1;
      rec = createRecorder(viewer.canvas, { fps: 30, audioStream: dest ? dest.stream : null });
      const t0 = performance.now();
      if (ev) { try { await ev.play(); } catch (e) { throw new Error('The clip would not play for the export'); } }
      await new Promise((resolve, reject) => {
        let lastProg = performance.now(), lastCur = -1;
        const step = (now) => {
          if (S.cancel || closed) return resolve();
          const t = ev ? ev.currentTime - S.start : (now - t0) / 1000;
          if (t >= S.dur || (ev && ev.ended)) return resolve();
          if (ev) { if (ev.currentTime !== lastCur) { lastCur = ev.currentTime; lastProg = now; } else if (now - lastProg > 8000) return reject(new Error('The clip stalled')); }
          if (!ev || ev.readyState >= 2) { renderFrame(ev || S.el, Math.max(0, t)); dctx.drawImage(viewer.canvas, 0, 0, disp.width, disp.height); }
          pEl.textContent = `Rendering ${Math.round(clamp(t / S.dur, 0, 1) * 100)}%`; requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      if (ev) ev.pause();
      const blob = await stopRec();
      if (!S.cancel && !closed) {
        const name = `bekfaye-mosh-${Date.now()}.${rec.mime && rec.mime.includes('mp4') ? 'mp4' : 'webm'}`;
        api.lastExport = { blob, name };
        onSaved && onSaved(blob, name);
        done = true;
      }
    } catch (err) {
      pEl.textContent = 'Export failed: ' + (err.message || err);
      b.querySelector('[data-c]').remove();
      await new Promise((r) => setTimeout(r, 2500));
    } finally {
      try { await stopRec(); } catch (e) { /* recorder already ended */ }
      if (actx) actx.close().catch(() => {});
      if (ev) { ev.pause(); ev.removeAttribute('src'); ev.load(); }
      mosh.hold(false); wasHold = false;
      S.exporting = false;
    }
    if (done) close();
    else if (!closed) { b.remove(); sizeStage(); setPlaying(true); }
  }

  stepSource();
  return api;
}
