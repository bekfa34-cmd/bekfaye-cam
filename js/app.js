/* Bek. Faye v3: camera page. Tabs WEST | VHS | MOSH share one viewfinder (engine Viewer), one shutter, one roll.
   VHS and MOSH modules are loaded on the side; if one is missing the app still runs with WEST. */
import { Viewer } from './engine/gl.js';
import { openCamera, openMic, createRecorder, recorderExtension } from './engine/media.js';
import { createTiers } from './engine/tiers.js';
import { WEST_LOOKS } from './west.js';

const VERSION = 'v3.1';
const FPS = 30;
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pad = (n) => String(n).padStart(2, '0');
const stamp = () => new Date().toISOString().slice(0, 23).replace(/[:T.]/g, '-');

/* every look starts from this, so one look's options never leak into the next */
const BASE = {
  blur: 0, glow: 0, grain: 0, vignette: 0, pixel: 0, levels: 0, paletteMix: 0, bloom: 0, halation: 0, diffuse: 0,
  softX: 0, softY: 0, bleed: 0, shift: 0, fringe: 0, scan: 0, scanPeriod: 0, block: 0, grainAmount: 0, grainChroma: 0,
  grainCell: 0, letterbox: 0, sharpen: 0, dof: 0, monitor: 0, compare: false, split: 0,
};
const DEF = {
  tab: 'west', video: true, look: { west: 'main', vhs: 'truevhs', mosh: 'smear' }, codec: 'auto',
  westRatio: 'full', vhsRatio: '4:3', tape: true, shake: true,
};
const S = JSON.parse(JSON.stringify(DEF));
try {
  const o = JSON.parse(localStorage.getItem('bekfaye.v3') || '{}');
  Object.assign(S, o, { look: { ...DEF.look, ...(o.look || {}) } });
} catch { /* first run or private mode */ }
const save = () => { try { localStorage.setItem('bekfaye.v3', JSON.stringify(S)); } catch { /* not remembered */ } };

const canvas = $('cam');
const video = $('camVideo');
const viewer = new Viewer(canvas);
const tiers = createTiers();
const mods = {};
const modsReady = Promise.allSettled([
  import('./vhs.js').then((m) => (mods.vhs = m)),
  import('./mosh.js').then((m) => (mods.mosh = m)),
  import('./mosh-editor.js').then((m) => (mods.editor = m)),
]);

const cs = {
  tab: 'west', open: true, stream: null, track: null, stop: null, facing: 'environment', zoom: 1, hw: false,
  mode: S.video ? 'video' : 'photo', rec: null, starting: false, locked: false, mic: null, crop: [0, 0, 1, 1],
  srcKey: '', loop: 0, loopAt: 0, lastDraw: 0, seed: 0, frames: 0, fpsAt: 0, slow: 0, startedAt: 0, importV: null, thumbAt: 0,
};
let tier = null;
let vhs = null;
let mosh = null;
const sourceEl = () => cs.importV || video;

/* ---------- toast ---------- */
let toastT;
function toast(m, ms = 3000) {
  const t = $('toast');
  t.textContent = m;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), ms);
}
// the long hint shows once; after that a short note is enough
function addedToast() {
  const first = !S.hintRoll;
  if (first) { S.hintRoll = 1; save(); }
  toast(first ? 'Added to Roll \u2014 open Roll to save to Photos' : 'Added to Roll', first ? 5000 : 2200);
}
const NAMES = { green: 'Green', pink: 'Pink' };
function message(text) {
  const el = $('msg');
  el.textContent = text;
  el.hidden = !text;
}

/* ---------- looks ---------- */
const looks = () => (cs.tab === 'west' ? WEST_LOOKS : cs.tab === 'vhs' ? (mods.vhs && mods.vhs.VHS_LOOKS) || [] : []);
const curLook = () => { const l = looks(); return l.find((x) => x.id === S.look[cs.tab]) || (cs.tab === 'west' ? l[1] : l[0]) || null; };

function applyLook() {
  if (!viewer.ok) return;
  const l = curLook();
  const lut = l && l.lut;
  if (lut) viewer.setLut(lut, Math.round(Math.cbrt(lut.length / 3)));
  else viewer.clearLut();
  if (cs.tab === 'vhs' && vhs && l) vhs.setLook(l.id);
}

function pickLook(id) {
  S.look[cs.tab] = id;
  save();
  if (cs.tab === 'mosh') { if (mosh) { mosh.setMode(id); mosh.reset(); } } else applyLook();
  buildStrip();
}

/* ---------- tabs ---------- */
function setTab(t) {
  if (cs.rec || cs.starting) return;
  if (vhs) vhs.detach();
  if (mosh) mosh.detach();
  viewer.pre = null;
  viewer.post = null;
  leaveImport();
  cs.tab = t;
  S.tab = t;
  save();
  $('app').dataset.tab = t;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  if (t === 'vhs') {
    enableMotion(); // inside the tap, iOS only asks for motion access from a gesture
    if (!mods.vhs) toast('VHS is not available in this build.');
    else {
      if (!vhs) vhs = mods.vhs.createVhs(viewer, { toast, settings: S, isRecording: () => !!cs.rec });
      vhs.attach();
    }
  } else if (t === 'mosh') {
    if (!mods.mosh) toast('MOSH is not available in this build.');
    else {
      if (!mosh) mosh = mods.mosh.createMosh(viewer);
      mosh.attach();
      mosh.setMode(S.look.mosh);
      mosh.reset();
    }
  }
  $('plus').hidden = t !== 'mosh';
  $('import').hidden = t !== 'vhs';
  keyBtn.hidden = t !== 'mosh' || !mosh;
  paintKey();
  applyLook();
  buildStrip();
  cs.srcKey = '';
  paintShutter();
}

/* ---------- strip: thumb chips (WEST, VHS) or mode chips (MOSH) ---------- */
const CW = 58;
const CH = 74;
let moshKey = 'off';
function buildStrip() {
  const box = $('strip');
  box.replaceChildren();
  if (cs.tab === 'mosh') {
    const modes = ((mosh && mosh.modes) || []).filter((m) => m.id !== 'freeze' && m.id !== 'videob');
    modes.forEach((m) => {
      const b = document.createElement('button');
      b.className = 'tchip' + (S.look.mosh === m.id ? ' on' : '');
      b.textContent = m.name;
      b.onclick = () => pickLook(m.id);
      box.append(b);
    });
    fadeCues(box);
    return;
  }
  looks().forEach((l) => {
    const b = document.createElement('button');
    b.className = 'chip' + (S.look[cs.tab] === l.id ? ' on' : '');
    b.dataset.id = l.id;
    const c = document.createElement('canvas');
    c.width = CW;
    c.height = CH;
    const s = document.createElement('span');
    s.textContent = NAMES[l.id] || l.name;
    b.append(c, s);
    b.onclick = () => pickLook(l.id);
    box.append(b);
  });
  cs.thumbAt = 0;
  const on = box.querySelector('.on');
  if (on) on.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  fadeCues(box);
}
const keyBtn = $('key');
keyBtn.onclick = () => {
  if (!mosh) return;
  moshKey = { off: 'sky', sky: 'dark', dark: 'motion', motion: 'off' }[moshKey];
  mosh.setKey(moshKey);
  paintKey();
};
function paintKey() { keyBtn.textContent = 'Key: ' + moshKey; keyBtn.classList.toggle('on', moshKey !== 'off'); }
/* soft fade on the side(s) of a scrolling strip that still has more to show */
function fadeCues(box) {
  const f = () => {
    box.style.setProperty('--ml', box.scrollLeft > 4 ? '22px' : '0px');
    box.style.setProperty('--mr', box.scrollLeft + box.clientWidth < box.scrollWidth - 4 ? '22px' : '0px');
  };
  if (!box._fade) { box._fade = 1; box.addEventListener('scroll', () => { f(); cs.thumbAt = 0; }, { passive: true }); }
  f();
}

const thumbCv = document.createElement('canvas');
thumbCv.width = CW;
thumbCv.height = CH;
const thumbCx = thumbCv.getContext('2d', { willReadFrequently: true });
const thumbOut = new ImageData(CW, CH); // reused for every chip
const sheetOpen = () => !!document.querySelector('.sheet:not([hidden])');
function paintThumbs() {
  const el = sourceEl();
  if (cs.tab === 'mosh' || !el.videoWidth || sheetOpen() || editorOpen()) return;
  const box = $('strip'), br = box.getBoundingClientRect();
  const chips = [...box.querySelectorAll('.chip')].filter((c) => { const r = c.getBoundingClientRect(); return r.right > br.left && r.left < br.right; }); // only what can be seen
  if (!chips.length) return;
  const s = Math.max(CW / el.videoWidth, CH / el.videoHeight);
  thumbCx.drawImage(el, (CW - el.videoWidth * s) / 2, (CH - el.videoHeight * s) / 2, el.videoWidth * s, el.videoHeight * s);
  const base = thumbCx.getImageData(0, 0, CW, CH).data;
  const d = thumbOut.data;
  chips.forEach((chip) => {
    const l = looks().find((x) => x.id === chip.dataset.id);
    if (!l) return;
    const lut = l.lut;
    const n = lut ? Math.round(Math.cbrt(lut.length / 3)) : 0;
    d.set(base);
    const vg = (l.options && l.options.vignette) || 0;
    if (lut || vg) for (let y = 0, i = 0; y < CH; y++) {
      for (let x = 0; x < CW; x++, i += 4) {
        if (lut) {
          const k = ((Math.round(d[i + 2] / 255 * (n - 1)) * n + Math.round(d[i + 1] / 255 * (n - 1))) * n + Math.round(d[i] / 255 * (n - 1))) * 3;
          d[i] = lut[k] * 255; d[i + 1] = lut[k + 1] * 255; d[i + 2] = lut[k + 2] * 255;
        }
        if (vg) {
          const px = x / CW * 2 - 1, py = y / CH * 2 - 1, m = 1 - vg * 0.55 * Math.min(1, Math.max(0, (px * px + py * py - 0.35) / 1.35));
          d[i] *= m; d[i + 1] *= m; d[i + 2] *= m;
        }
      }
    }
    chip.firstChild.getContext('2d').putImageData(thumbOut, 0, 0);
  });
}

/* ---------- picture ---------- */
function ratioTarget() {
  const el = sourceEl();
  const W = el.videoWidth, H = el.videoHeight;
  const r = cs.tab === 'west' ? S.westRatio : cs.tab === 'vhs' ? S.vhsRatio : 'full';
  if (r === 'full') return W / H;
  if (r === '1:1') return 1;
  const [a, b] = r.split(':').map(Number);
  return H > W ? b / a : a / b;
}
function syncFrame() {
  const el = sourceEl();
  if (!el.videoWidth || cs.rec) return;
  const W = el.videoWidth, H = el.videoHeight, t = ratioTarget();
  let cw = W, ch = H;
  if (W / H > t) cw = Math.round(H * t); else ch = Math.round(W / t);
  const x0 = (W - cw) / 2 / W, y0 = (H - ch) / 2 / H;
  cs.crop = [x0, y0, x0 + cw / W, y0 + ch / H];
  const k = Math.min(1, (tier || tiers.current()).longEdge / Math.max(cw, ch));
  viewer.ensureSize(Math.max(2, Math.round(cw * k) & ~1), Math.max(2, Math.round(ch * k) & ~1));
  const t2 = tier || tiers.current();
  $('tcInfo').textContent = `${Math.min(canvas.width, canvas.height)}p${FPS}${t2.auto ? ' auto' : ''}`;
}

function draw() {
  if (!viewer.ok || viewer.lost) return;
  const l = curLook();
  viewer.setOptions({ ...BASE, ...(l ? l.options : {}), seed: (cs.seed = (cs.seed + 1) % 9973), zoom: cs.zoom, crop: cs.crop, gain: [1, 1, 1] });
  viewer.render();
}

const editorOpen = () => $('editorRoot').childElementCount > 0;

/* ---------- 30 fps loop with watchdog ---------- */
function schedule() {
  if (!cs.open) return;
  if (cs.loop && performance.now() - cs.loopAt < 500) return;
  if (cs.loop) cancelAnimationFrame(cs.loop);
  cs.loopAt = performance.now();
  cs.loop = requestAnimationFrame(step);
}
setInterval(schedule, 1000);

function step(now) {
  cs.loop = 0;
  if (!cs.open) return;
  if (now - cs.lastDraw < 1000 / FPS - 3) return schedule();
  cs.lastDraw = now;
  const el = sourceEl();
  if (el.videoWidth && !editorOpen() && viewer.ok && !viewer.lost) {
    const key = `${el.videoWidth}x${el.videoHeight}|${cs.tab}|${S.westRatio}|${S.vhsRatio}`;
    if (key !== cs.srcKey) { cs.srcKey = key; syncFrame(); }
    viewer.setSource(el);
    draw();
    countFrame(now);
    if (!cs.rec && now - cs.thumbAt > 4000) { cs.thumbAt = now; paintThumbs(); }
  }
  schedule();
}

function countFrame(now) {
  cs.frames++;
  if (!cs.fpsAt) cs.fpsAt = now;
  if (now - cs.fpsAt < 1000) return;
  const fps = (cs.frames * 1000) / (now - cs.fpsAt);
  cs.frames = 0; cs.fpsAt = now; cs.fps = fps;
  // auto tier: a camera that cannot hold ~30 fps drops a tier (never mid-clip)
  if (!cs.rec && !cs.importV && now - cs.startedAt > 4000 && fps < 22) {
    if (++cs.slow >= 3) {
      cs.slow = 0;
      const lower = tiers.stepDown();
      if (lower) { tier = lower; toast(`Stepping down to ${lower.name}`); startCam(); }
    }
  } else cs.slow = 0;
}

/* ---------- camera ---------- */
let camGen = 0; // a newer startCam / stopCam makes older in-flight ones give up
async function startCam() {
  stopCam();
  const gen = camGen;
  cs.srcKey = '';
  tier = tiers.current();
  message('starting camera…');
  try {
    const cam = await openCamera(video, cs.facing, { width: tier.capW, height: tier.capH });
    if (gen !== camGen) { // superseded while the camera was opening: release it, leave the newer stream on the video
      cam.stream.getTracks().forEach((t) => t.stop());
      if (cs.stream) video.srcObject = cs.stream;
      return;
    }
    cs.stream = cam.stream; cs.track = cam.track; cs.stop = cam.stop;
    cs.startedAt = performance.now(); cs.slow = 0; cs.fpsAt = 0; cs.frames = 0;
    const caps = (cs.track.getCapabilities && cs.track.getCapabilities()) || {};
    cs.hw = !!caps.zoom;
    document.querySelector('#zoom [data-z="0.5"]').hidden = !(caps.zoom && caps.zoom.min <= 0.6);
    if (video.readyState < 1) {
      await new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error('The camera did not start. Tap to retry.')), 8000);
        video.addEventListener('loadedmetadata', () => { clearTimeout(to); res(); }, { once: true });
      });
    }
    if (gen !== camGen) return;
    if (tier.id === 'max' && video.videoWidth * video.videoHeight < 3840 * 2160 * 0.8) { tiers.capAt('high'); tier = tiers.current(); }
    await setZoom(cs.zoom);
    message(viewer.ok ? '' : 'This browser has no WebGL2, so the look cannot be drawn.');
    schedule();
  } catch (err) {
    if (gen !== camGen) return;
    stopCam();
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    message(denied ? 'Camera access is off. Allow the camera for this site, then tap flip to retry.' : (err && err.message) || 'The camera did not start.');
  }
}
function stopCam() {
  camGen++;
  if (cs.stop) cs.stop();
  cs.stop = null; cs.stream = null; cs.track = null;
}
async function setZoom(z) {
  cs.zoom = cs.zUser = z;
  document.querySelectorAll('#zoom button').forEach((b) => b.classList.toggle('on', +b.dataset.z === z));
  if (cs.hw && cs.track) {
    try { await cs.track.applyConstraints({ advanced: [{ zoom: z }] }); cs.zoom = 1; return; } catch { /* digital instead */ }
  }
}
// hardware zoom keeps zoom=1 in the shader; digital zoom is the shader's zoom
document.querySelectorAll('#zoom button').forEach((b) => (b.onclick = async () => {
  const z = +b.dataset.z;
  await setZoom(z);
  document.querySelectorAll('#zoom button').forEach((x) => x.classList.toggle('on', +x.dataset.z === z));
}));

async function ensureMic() {
  if (cs.mic && cs.mic.getAudioTracks().some((t) => t.readyState === 'live')) return cs.mic;
  try { cs.mic = await openMic(); } catch { cs.mic = null; toast('No microphone access. Recording without sound.'); }
  return cs.mic;
}
function closeMic() {
  if (cs.mic) cs.mic.getTracks().forEach((t) => t.stop());
  cs.mic = null;
}

/* ---------- motion (VHS tracking noise) ---------- */
let motionOn = false;
let shakeSm = 0;
async function enableMotion() {
  if (motionOn || !S.shake) return;
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) {
      if ((await DeviceMotionEvent.requestPermission()) !== 'granted') return;
    }
    addEventListener('devicemotion', (e) => {
      if (cs.tab !== 'vhs' || !vhs || !S.shake) return;
      const a = e.acceleration;
      const m = a ? Math.hypot(a.x || 0, a.y || 0, a.z || 0) : 0;
      shakeSm = shakeSm * 0.85 + clamp(m / 10, 0, 1) * 0.15;
      vhs.shake(shakeSm);
    });
    motionOn = true;
  } catch { /* no motion sensor */ }
}

/* ---------- clip import (VHS): run a file through the look ---------- */
function leaveImport() {
  const v = cs.importV;
  if (!v) return;
  v.pause();
  URL.revokeObjectURL(v.src);
  if (cs.impAc) cs.impAc.close().catch(() => {});
  cs.impAc = null; cs.importV = null; cs.srcKey = '';
  $('import').textContent = 'Import';
  $('tc').classList.remove('imp');
}
$('import').onclick = async () => {
  if (cs.rec) return;
  if (cs.importV) { leaveImport(); return; }
  $('file').click();
};
$('file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const v = document.createElement('video');
  v.playsInline = true;
  v.preload = 'auto';
  v.src = URL.createObjectURL(f);
  if (cs.importV) leaveImport();
  try {
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('That clip could not be read.')); });
  } catch (err) { URL.revokeObjectURL(v.src); toast(err.message); return; }
  cs.importV = v; cs.srcKey = '';
  $('import').textContent = 'Camera';
  v.currentTime = 0.01;
  toast('Clip loaded. Press record to run it through the look.');
};
function importAudio() {
  const v = cs.importV;
  if (!cs.impAc) {
    cs.impAc = new (window.AudioContext || window.webkitAudioContext)();
    const src = cs.impAc.createMediaElementSource(v);
    cs.impDest = cs.impAc.createMediaStreamDestination();
    src.connect(cs.impDest);
  }
  cs.impAc.resume().catch(() => {});
  return new MediaStream(cs.impDest.stream.getAudioTracks().map((t) => t.clone()));
}

/* ---------- recording ---------- */
const timecode = (ms) => {
  const f = Math.floor((ms / 1000) * FPS), s = Math.floor(f / FPS);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}:${pad(f % FPS)}`;
};
function smallThumb() {
  const c = document.createElement('canvas');
  c.width = 120; c.height = 160;
  const s = Math.max(120 / canvas.width, 160 / canvas.height);
  c.getContext('2d').drawImage(canvas, (120 - canvas.width * s) / 2, (160 - canvas.height * s) / 2, canvas.width * s, canvas.height * s);
  return c.toDataURL('image/jpeg', 0.7);
}
const lookLabel = () => (cs.tab === 'mosh' ? 'mosh-' + S.look.mosh : (curLook() || { id: cs.tab }).id);

async function startRec() {
  if (cs.rec || cs.starting) return false;
  if (!cs.stream && !cs.importV) { toast('The camera is not running yet.'); return false; }
  cs.starting = true;
  const tracks = [];
  try {
    let audio = null;
    if (cs.importV) audio = importAudio();
    else if (await ensureMic()) audio = new MediaStream(cs.mic.getAudioTracks().map((t) => t.clone()));
    if (audio) tracks.push(...audio.getTracks());
    if (audio && cs.tab === 'vhs' && vhs && S.tape) {
      try {
        const chained = vhs.audioChain(audio);
        const c = new MediaStream(chained.getAudioTracks().map((t) => t.clone()));
        tracks.push(...c.getTracks());
        audio = c;
      } catch { /* untreated sound is better than none */ }
    }
    draw();
    const rec = createRecorder(canvas, { fps: FPS, audioStream: audio, prefer: S.codec });
    cs.rec = { rec, tracks, start: performance.now(), thumb: smallThumb() };
    cs.timer = setInterval(() => ($('tcTime').textContent = timecode(performance.now() - cs.rec.start)), 1000 / FPS);
    if (cs.importV) {
      const v = cs.importV;
      v.currentTime = 0;
      v.onended = () => { if (cs.rec) stopAndKeep(); };
      v.play().catch(() => toast('Tap again to play the clip.'));
    }
    paintShutter();
    return true;
  } catch (err) {
    tracks.forEach((t) => t.stop());
    cs.rec = null;
    toast(err.message || 'Recording is not available here.');
    return false;
  } finally {
    cs.starting = false;
  }
}

/* resolves to {blob,name,thumb} or null */
async function stopRec() {
  const r = cs.rec;
  if (!r) return null;
  cs.rec = null;
  clearInterval(cs.timer);
  if (cs.importV) cs.importV.pause();
  paintShutter();
  let blob = null;
  try { blob = await r.rec.stop(); } catch { /* empty clip below */ }
  r.tracks.forEach((t) => t.stop());
  cs.srcKey = ''; // sizes were frozen while recording
  if (!blob || !blob.size) { toast('That clip came back empty.'); return null; }
  const mime = r.rec.mime.split(';')[0];
  return { blob: new Blob([blob], { type: mime }), name: `${lookLabel()}-${stamp()}.${recorderExtension(r.rec.mime)}`, thumb: r.thumb, ms: performance.now() - r.start };
}
async function stopAndKeep() {
  if (cs.locked) return finishMosh();
  const c = await stopRec();
  if (c) { await addToRoll(c.blob, c.name, c.thumb); addedToast(); }
}

async function takePhoto() {
  if (!cs.stream && !cs.importV) return toast('The camera is not running yet.');
  const st = $('stage');
  st.classList.remove('flash'); void st.offsetWidth; st.classList.add('flash');
  draw();
  const thumb = smallThumb();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.94));
  if (!blob) return toast('That frame could not be saved.');
  await addToRoll(blob, `${lookLabel()}-${stamp()}.jpg`, thumb);
  addedToast();
}

function paintShutter() {
  const live = !!cs.rec;
  const sh = $('shutter');
  sh.classList.toggle('video', cs.mode === 'video');
  sh.classList.toggle('live', live);
  if (!live) sh.classList.remove('hold');
  $('tc').classList.toggle('live', live);
  if (!live) $('tcTime').textContent = timecode(0);
  ['flip', 'gear', 'plus', 'import'].forEach((id) => ($(id).disabled = live));
  document.querySelectorAll('#tabs button, #mode button').forEach((b) => (b.disabled = live));
  document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.m === cs.mode));
  sh.setAttribute('aria-label', live ? 'Stop recording' : cs.mode === 'video' ? 'Start recording' : 'Take a photo');
}

/* shutter: WEST/VHS click toggles; MOSH video is hold-to-mosh (tap = lock until next tap) */
const moshVideo = () => cs.tab === 'mosh' && cs.mode === 'video';
let hold = null;
// audio engines must be created/resumed inside the tap itself, before any await (iOS keeps later ones suspended)
const wakeAudio = () => { if (vhs && cs.tab === 'vhs' && S.tape) vhs.resume(true); };
$('shutter').addEventListener('pointerdown', wakeAudio);
$('shutter').addEventListener('click', () => {
  wakeAudio();
  if (moshVideo()) return;
  if (cs.mode === 'photo') return takePhoto();
  if (cs.rec) stopAndKeep(); else startRec();
});
$('shutter').addEventListener('pointerdown', (e) => {
  if (!moshVideo()) return;
  e.preventDefault();
  try { $('shutter').setPointerCapture(e.pointerId); } catch { /* fine */ }
  if (cs.rec && cs.locked) { finishMosh(); return; }
  if (cs.rec || cs.starting || hold) return;
  $('shutter').classList.add('hold');
  if (mosh) { mosh.reset(); mosh.hold(true); }
  hold = { t: performance.now(), p: startRec() };
});
const release = async () => {
  if (!hold) return;
  const h = hold;
  hold = null;
  const ok = await h.p;
  if (!ok) { if (mosh) mosh.hold(false); paintShutter(); return; }
  if (performance.now() - h.t > 250) finishMosh();
  else { cs.locked = true; toast('Locked on. Tap to stop.'); }
};
$('shutter').addEventListener('pointerup', release);
$('shutter').addEventListener('pointercancel', release);

async function finishMosh() {
  if (mosh) { mosh.hold(false); mosh.reset(); }
  cs.locked = false;
  const c = await stopRec();
  if (c) openReview(c);
}

/* ---------- mosh review ---------- */
let reviewClip = null, reviewUrl = null;
function openReview(c) {
  reviewClip = c;
  reviewUrl = URL.createObjectURL(c.blob);
  const v = document.createElement('video');
  v.src = reviewUrl; v.loop = true; v.playsInline = true; v.autoplay = true; v.controls = false;
  v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
  $('reviewMedia').replaceChildren(v);
  $('review').hidden = false;
}
function closeReview() {
  $('review').hidden = true;
  $('reviewMedia').replaceChildren();
  if (reviewUrl) URL.revokeObjectURL(reviewUrl);
  reviewUrl = null; reviewClip = null;
}
$('reviewTrash').onclick = closeReview;
$('reviewSave').onclick = () => {
  const c = reviewClip;
  if (!c) return;
  const it = newItem(c.blob, c.name, c.thumb);
  const added = addToRoll(it);  // starts the IDB write
  const shared = shareItems([it]); // navigator.share runs now, still inside the tap
  closeReview();
  addedToast();
  Promise.all([added, shared]).catch(() => {});
};

/* ---------- roll (IndexedDB) ---------- */
const DB = {
  db: null,
  open() {
    if (!this.db) {
      this.db = new Promise((res, rej) => {
        const r = indexedDB.open('bekfaye', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('roll', { keyPath: 'id' });
        r.onsuccess = () => { const d = r.result; d.onclose = () => { this.db = null; }; d.onversionchange = () => { d.close(); this.db = null; }; res(d); };
        r.onerror = () => { this.db = null; rej(r.error); };
      });
    }
    return this.db;
  },
  async run(mode, fn, retry = true) { // iOS closes idle connections after suspend: reopen once
    try {
      const db = await this.open();
      return await new Promise((res, rej) => {
        const t = db.transaction('roll', mode), q = fn(t.objectStore('roll'));
        t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
    } catch (e) {
      this.db = null;
      if (retry) return this.run(mode, fn, false);
      throw e;
    }
  },
  put(it) { return this.run('readwrite', (s) => s.put(it)); },
  del(id) { return this.run('readwrite', (s) => s.delete(id)); },
  clear() { return this.run('readwrite', (s) => s.clear()); },
  get(id) { return this.run('readonly', (s) => s.get(id)); },
  patch(id, p) { return this.run('readwrite', (s) => { const g = s.get(id); g.onsuccess = () => { if (g.result) s.put({ ...g.result, ...p }); }; return g; }); },
  meta() { // cursor: each blob is dropped as soon as its metadata is copied, so the roll never sits in memory
    return this.run('readonly', (s) => {
      const out = [], c = s.openCursor();
      c.onsuccess = () => { const cur = c.result; if (!cur) return; const { blob, ...m } = cur.value; out.push({ ...m, type: m.type || (blob && blob.type) || '', size: blob ? blob.size : 0 }); cur.continue(); };
      return { get result() { return out; } };
    });
  },
};
let roll = [], selecting = false;
const picked = new Set();
const fileType = (it) => (it.type || (it.blob && it.blob.type) || '').split(';')[0];
const blobOf = async (it) => it.blob || ((await DB.get(it.id)) || {}).blob;

function paintRoll() {
  $('rollImg').removeAttribute('src');
  if (roll[0]) $('rollImg').src = roll[0].thumb;
  $('rollN').textContent = roll.length ? String(roll.length) : '';
}
function newItem(blob, name, thumb) {
  return { id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), name, type: blob.type, size: blob.size, blob, thumb: thumb || smallThumb(), ts: Date.now(), saved: false };
}
async function addToRoll(blobOrItem, name, thumb) {
  const it = blobOrItem instanceof Blob ? newItem(blobOrItem, name, thumb) : blobOrItem;
  roll.unshift(it);
  paintRoll();
  try { await DB.put(it); delete it.blob; } catch { toast('Could not keep this in the roll (storage full?). Save it now.'); } // blob stays in memory only if it could not be stored
  return it;
}
async function loadRoll() {
  try { roll = (await DB.meta()).sort((a, b) => b.ts - a.ts); paintRoll(); } catch { /* no storage */ }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* ok */ }
}
function download(file) {
  const url = URL.createObjectURL(file), a = document.createElement('a');
  a.href = url; a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
/* items that still hold their blob (just recorded, or the open viewer) share inside the tap; others are read from IDB first */
async function shareItems(items) {
  if (!items.length) return false;
  let blobs = items.map((it) => it.blob || it._blob);
  if (blobs.some((b) => !b)) blobs = await Promise.all(items.map(blobOf));
  if (blobs.some((b) => !b)) { toast('That item could not be read from the roll.'); return false; }
  const files = items.map((it, i) => new File([blobs[i]], it.name, { type: fileType(it) || blobs[i].type }));
  try {
    if (navigator.canShare && navigator.canShare({ files })) await navigator.share({ files });
    else { files.forEach(download); toast('Downloaded'); }
    items.forEach((it) => { it.saved = true; DB.patch(it.id, { saved: true }).catch(() => {}); });
    return true;
  } catch (e) {
    if (e.name !== 'AbortError') toast('Share failed: ' + e.message);
    return false;
  }
}
function armConfirm(btn, fn) {
  if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; fn(); return; }
  btn.dataset.label = btn.textContent; btn.dataset.armed = 1; btn.textContent = 'Tap again to delete';
  setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; } }, 2500);
}
function drawRoll() {
  $('rollTitle').textContent = selecting ? `${picked.size} selected` : `Roll · ${roll.length}`;
  const grid = $('rollGrid');
  grid.replaceChildren();
  $('rollEmpty').hidden = !!roll.length;
  roll.forEach((it) => {
    const b = document.createElement('button');
    b.style.backgroundImage = `url(${it.thumb})`;
    b.setAttribute('aria-label', it.name);
    if (fileType(it).startsWith('video')) { const i = document.createElement('i'); i.textContent = '▶ VIDEO'; b.append(i); }
    if (it.saved) { const s = document.createElement('em'); s.textContent = '✓'; b.append(s); }
    if (selecting) { b.append(document.createElement('u')); if (picked.has(it)) b.classList.add('sel'); }
    b.onclick = () => { if (!selecting) return openViewer(it); picked.has(it) ? picked.delete(it) : picked.add(it); drawRoll(); };
    grid.append(b);
  });
  $('rollSel').textContent = selecting ? 'Cancel' : 'Select';
  $('rollSel').disabled = !roll.length;
  $('rollSave').textContent = selecting ? `Save (${picked.size})` : 'Save all';
  $('rollDel').textContent = selecting ? `Delete (${picked.size})` : 'Clear roll';
  $('rollSave').disabled = $('rollDel').disabled = selecting ? !picked.size : !roll.length;
}
async function removeItems(items) {
  const set = new Set(items);
  roll = roll.filter((x) => !set.has(x));
  for (const it of items) { try { await DB.del(it.id); } catch { /* gone anyway */ } }
  paintRoll();
}
$('roll').onclick = () => { selecting = false; picked.clear(); drawRoll(); $('rollSheet').hidden = false; };
$('rollSel').onclick = () => { selecting = !selecting; picked.clear(); drawRoll(); };
$('rollSave').onclick = async () => {
  const items = selecting ? [...picked] : roll.filter((i) => !i.saved).length ? roll.filter((i) => !i.saved) : roll;
  if (await shareItems(items)) { selecting = false; picked.clear(); }
  drawRoll();
};
$('rollDel').onclick = () => armConfirm($('rollDel'), async () => { await removeItems(selecting ? [...picked] : [...roll]); selecting = false; picked.clear(); drawRoll(); });
let viewing = null, viewUrl = null;
async function openViewer(it) {
  viewing = it;
  const blob = await blobOf(it);
  if (viewing !== it) return; // closed or replaced while reading
  if (!blob) return toast('That item could not be read from the roll.');
  it._blob = blob; // held only while the viewer is open, so Save can share inside the tap
  if (viewUrl) URL.revokeObjectURL(viewUrl);
  viewUrl = URL.createObjectURL(blob);
  const el = document.createElement(fileType(it).startsWith('image') ? 'img' : 'video');
  el.src = viewUrl;
  if (el.tagName === 'VIDEO') { el.controls = true; el.playsInline = true; el.loop = true; el.autoplay = true; el.play().catch(() => {}); }
  $('viewMedia').replaceChildren(el);
  $('viewer').hidden = false;
}
function closeViewer() {
  $('viewer').hidden = true;
  const v = $('viewMedia').querySelector('video');
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  $('viewMedia').replaceChildren();
  if (viewUrl) URL.revokeObjectURL(viewUrl);
  if (viewing) delete viewing._blob;
  viewUrl = null; viewing = null;
}
$('viewSave').onclick = async () => { if (viewing && (await shareItems([viewing])) && !$('rollSheet').hidden) drawRoll(); };
$('viewDel').onclick = () => armConfirm($('viewDel'), async () => { const it = viewing; closeViewer(); await removeItems([it]); if (!$('rollSheet').hidden) drawRoll(); });
const closeSheet = (sh) => { if (sh.id === 'viewer') closeViewer(); else sh.hidden = true; };
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => closeSheet(b.closest('.sheet'))));
// tap on the dim backdrop closes a sheet (not the mosh review: that one decides if a clip is kept)
document.querySelectorAll('.sheet').forEach((sh) => { if (sh.id !== 'review') sh.addEventListener('click', (e) => { if (e.target === sh) closeSheet(sh); }); });

/* ---------- settings ---------- */
function paintTier() { const t = tiers.current(); $('s-tier').textContent = `${tiers.choice === 'auto' ? 'Auto' : t.name} · ${t.note.split(' · ')[0]}`; }
['codec', 'westRatio', 'vhsRatio', 'tape', 'shake'].forEach((k) => {
  const el = $('s-' + k);
  if (el.type === 'checkbox') el.checked = !!S[k]; else el.value = S[k];
  el.onchange = () => {
    S[k] = el.type === 'checkbox' ? el.checked : el.value;
    save();
    if (k === 'shake') enableMotion();
    cs.srcKey = '';
  };
});
$('s-tier').onclick = () => { if (cs.rec) return; tiers.next(); paintTier(); startCam(); };
$('gear').onclick = () => { paintTier(); $('settings').hidden = false; };
$('ver').textContent = VERSION;

/* ---------- wiring ---------- */
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.t)));
document.querySelectorAll('#mode button').forEach((b) => (b.onclick = () => { cs.mode = b.dataset.m; S.video = cs.mode === 'video'; save(); paintShutter(); }));
$('flip').onclick = () => { if (cs.rec) return; cs.facing = cs.facing === 'environment' ? 'user' : 'environment'; startCam(); };
$('plus').onclick = () => {
  if (!mods.editor || !mosh) return toast('The mosh editor is not available in this build.');
  mosh.hold(false);
  mods.editor.openMoshEditor($('editorRoot'), { viewer, mosh, createRecorder, onSaved: (blob, name) => { addToRoll(blob, name || `mosh-${stamp()}.mp4`); addedToast(); }, onClose: () => syncFrame() });
};
// tap/drag on the picture moves the mosh pivot
function pivotFrom(e) {
  const r = canvas.getBoundingClientRect();
  if (mosh) mosh.setPivot(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1));
}
/* one finger on the picture moves the mosh pivot; two fingers pinch-zoom (hardware if the camera has it, else digital) */
const ZMAX = 3, ptrs = new Map();
let pinch = null, zrT = 0, zAt = 0;
const zmin = () => (cs.hw && !document.querySelector('#zoom [data-z="0.5"]').hidden ? 0.5 : 1);
function showZoom(z) {
  const r = $('zr');
  r.textContent = z.toFixed(1) + 'x';
  r.classList.add('show');
  clearTimeout(zrT);
  zrT = setTimeout(() => r.classList.remove('show'), 900);
}
const gap = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
canvas.addEventListener('pointerdown', (e) => {
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { canvas.setPointerCapture(e.pointerId); } catch { /* fine */ }
  if (ptrs.size === 2) pinch = { d: gap(), z: cs.zUser || 1, last: cs.zUser || 1 };
  else if (cs.tab === 'mosh') pivotFrom(e);
});
canvas.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && ptrs.size >= 2) {
    const z = clamp(pinch.z * gap() / pinch.d, zmin(), ZMAX);
    pinch.last = z;
    showZoom(z);
    if (!cs.hw) { cs.zoom = cs.zUser = z; } else if (performance.now() - zAt > 90) { zAt = performance.now(); setZoom(z); }
  } else if (cs.tab === 'mosh' && e.buttons) pivotFrom(e);
});
const pinchEnd = (e) => {
  ptrs.delete(e.pointerId);
  if (pinch && ptrs.size < 2) {
    const z = pinch.last; pinch = null;
    setZoom(z);
  }
};
canvas.addEventListener('pointerup', pinchEnd);
canvas.addEventListener('pointercancel', pinchEnd);

// the audio engines wake only inside a gesture; iOS also suspends them in the background
for (const ev of ['touchend', 'click']) addEventListener(ev, () => { if (vhs) vhs.resume(); if (cs.impAc && cs.impAc.state !== 'running') cs.impAc.resume().catch(() => {}); }, { capture: true, passive: true });

viewer.onLost = () => { if (cs.rec) stopAndKeep(); message('The graphics were reset by the system. Tap to restart.'); };
viewer.onRestored = () => location.reload(); // programs and textures are gone; the roll is safe in IndexedDB
$('msg').onclick = () => { if (viewer.lost) location.reload(); else startCam(); };

/* release camera and mic first (iOS may freeze the page right after), then let the recorder finish */
function suspendApp() {
  cs.open = false;
  const pending = cs.rec ? stopAndKeep() : null;
  if (hold) { hold = null; if (mosh) mosh.hold(false); }
  stopCam(); closeMic();
  return pending;
}
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) await suspendApp();
  else {
    cs.open = true;
    if (!cs.importV) startCam(); else schedule();
  }
});
addEventListener('pagehide', () => { suspendApp(); });

window.bekfaye = { viewer, cs, S, step: (t) => step(t), startRec, stopAndKeep, takePhoto, roll: () => roll };

(async () => {
  if (!viewer.ok) message('This browser has no WebGL2, so the look cannot be drawn.');
  await modsReady;
  setTab(S.tab);
  paintShutter();
  loadRoll();
  startCam();
})();
