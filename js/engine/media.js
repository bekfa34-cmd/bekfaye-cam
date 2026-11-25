/* Media intake: stills, video clips (sampled across the whole clip), camera. */

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
export const isVideoFile = (file) =>
  !!file && ((file.type && file.type.startsWith('video/')) || /\.(mp4|mov|webm|m4v)$/i.test(file.name || ''));

const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_VIDEO_BYTES = 400 * 1024 * 1024;

export function drawToCanvas(source, maxDim) {
  const sw = source.naturalWidth || source.videoWidth || source.width;
  const sh = source.naturalHeight || source.videoHeight || source.height;
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function readPixels(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
}

/** Load a still image file into a decoded canvas. */
export function loadImage(file, maxDim = 1600) {
  return new Promise((resolve, reject) => {
    if (!file || !file.size) return reject(new Error('That file is empty.'));
    if (file.size > MAX_IMAGE_BYTES) return reject(new Error('That image is over 40 MB — export a smaller copy.'));
    if (file.type && !file.type.startsWith('image/')) return reject(new Error('Choose an image or a video clip.'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = drawToCanvas(img, maxDim);
        URL.revokeObjectURL(url);
        resolve({ kind: 'image', name: file.name || 'still', canvas });
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This browser could not decode that image. Try JPEG, PNG or WebP.'));
    };
    img.src = url;
  });
}

function waitForMetadata(video, ms = 15000) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1) return resolve();
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error('This browser could not decode that clip. Try an H.264 MP4 or MOV.'));
    };
    const timer = setTimeout(fail, ms);
    function cleanup() {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', done);
      video.removeEventListener('error', fail);
    }
    video.addEventListener('loadedmetadata', done);
    video.addEventListener('error', fail);
  });
}

function seek(video, time) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Seeking that clip timed out.'));
    }, 8000);
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error('Could not read a frame from that clip.'));
    };
    function cleanup() {
      clearTimeout(timer);
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', fail);
    }
    video.addEventListener('seeked', done);
    video.addEventListener('error', fail);
    video.currentTime = time;
  });
}

/* play() can stay pending for good (Safari, hidden or unallowed): never wait on it. */
const tryPlay = (video, ms = 1500) => {
  const playing = video.play();
  // a play() that loses the race may still reject later (pause() aborts it)
  if (playing && playing.catch) playing.catch(() => {});
  return Promise.race([playing, wait(ms)]);
};

/* After a seek, wait until that frame is really decoded and on the element.
   'seeked' alone can fire before Safari has the picture, which drew black. */
function presented(video, ms = 400) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve(true);
      });
    }
  });
}

/* A decoder that has not started yet hands back black frames. */
function isBlack(canvas) {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 16;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, 16, 16);
  const d = ctx.getImageData(0, 0, 16, 16).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
  return sum / (256 * 3) < 3;
}

/* Some recordings (MediaRecorder WebM) report an infinite duration until the
   end has been visited once. */
async function realDuration(video) {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  try {
    await seek(video, 1e7);
  } catch {
    /* fall through */
  }
  const d = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  return d;
}

/* Fallback when seeking stalls: play the clip (muted, fast) and grab frames
   on the way through. Slower, but playback is the path every browser decodes. */
async function framesByPlaying(video, times, maxDim) {
  const out = [];
  let next = 0;
  video.currentTime = 0;
  video.playbackRate = Math.min(4, Math.max(1, times[times.length - 1] / 4));
  await tryPlay(video);
  const deadline = performance.now() + (times[times.length - 1] / video.playbackRate) * 1000 + 6000;
  while (next < times.length && performance.now() < deadline && !video.ended) {
    await presented(video, 120);
    if (video.currentTime >= times[next]) {
      const c = drawToCanvas(video, maxDim);
      if (!isBlack(c)) out.push(c);
      next++;
    }
  }
  video.pause();
  return out;
}

/** Sample frames across a clip (its first `maxSeconds`, if longer) and keep the
    middle one as the poster frame. */
export async function loadClip(file, maxDim = 1400, frameCount = 5, maxSeconds = 0) {
  if (!file || !file.size) throw new Error('That file is empty.');
  if (file.size > MAX_VIDEO_BYTES) throw new Error('That clip is over 400 MB — trim it and try again.');
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  // Safari decodes more willingly for an element that is in the page.
  video.setAttribute('aria-hidden', 'true');
  video.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.appendChild(video);
  video.src = url;
  try {
    await waitForMetadata(video);
    const full = (await realDuration(video)) || 2;
    const duration = maxSeconds ? Math.min(full, maxSeconds) : full;
    // A muted play/pause wakes the decoder on iOS; without it, seeks far into
    // a clip that Safari had not buffered yet could stall.
    try {
      await tryPlay(video);
      video.pause();
    } catch {
      /* not allowed here: seeking still works on most browsers */
    }
    const times = Array.from({ length: frameCount }, (_, i) => Math.min(duration - 0.05, Math.max(0.02, (duration * (i + 0.5)) / frameCount)));
    let canvases = [];
    let misses = 0;
    // if this browser never confirms a paused frame, stop waiting long for it
    let frameWait = 400;
    for (const t of times) {
      try {
        await seek(video, t);
        if (!(await presented(video, frameWait))) frameWait = 100;
      } catch {
        if (++misses >= 3) break;
        continue;
      }
      const c = drawToCanvas(video, maxDim);
      if (isBlack(c)) {
        // one retry: the frame is often there a moment later
        await wait(120);
        const again = drawToCanvas(video, maxDim);
        if (!isBlack(again)) canvases.push(again);
        continue;
      }
      canvases.push(c);
    }
    if (canvases.length < Math.ceil(frameCount / 2)) {
      try {
        const played = await framesByPlaying(video, times, maxDim);
        if (played.length > canvases.length) canvases = played;
      } catch {
        /* keep what seeking found */
      }
    }
    if (!canvases.length) throw new Error('Could not read any frames from that clip. Try an H.264 MP4 or a MOV from Photos.');
    const mid = canvases[Math.floor(canvases.length / 2)];
    return { kind: 'clip', name: file.name || 'clip', canvas: mid, canvases, url, duration: full, used: duration };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  } finally {
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

/** Load any reference file: still, or clip sampled into several frames. */
export async function loadReference(file, maxDim = 1200, { maxSeconds = 0, clipFrames = 5 } = {}) {
  if (isVideoFile(file)) {
    const clip = await loadClip(file, maxDim, clipFrames, maxSeconds);
    return { kind: 'clip', name: clip.name, canvases: clip.canvases, canvas: clip.canvas, url: clip.url, duration: clip.duration, used: clip.used };
  }
  const image = await loadImage(file, maxDim);
  return { kind: 'image', name: image.name, canvases: [image.canvas], canvas: image.canvas };
}

/** Thumbnail data URL for a canvas. */
export function thumbnail(canvas, size = 160) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = Math.round(size * 0.75);
  const ctx = c.getContext('2d');
  const scale = Math.max(c.width / canvas.width, c.height / canvas.height);
  const w = canvas.width * scale;
  const h = canvas.height * scale;
  ctx.drawImage(canvas, (c.width - w) / 2, (c.height - h) / 2, w, h);
  return c.toDataURL('image/jpeg', 0.72);
}

/**
 * Open the camera at the highest resolution the device will hand over.
 * The old path asked for 1080p with no follow-up, so phones often served a
 * 640×480 preview and the grade was applied to an upscale. Here we start high,
 * then push the track to its reported maximum before giving the stream back.
 */
export async function openCamera(video, facing = 'environment', { width = 1920, height = 1080 } = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('The camera needs Safari or Chrome over HTTPS.');
  }
  // Ask for the tier's size at 30 fps. Some cameras refuse a hard frame-rate
  // cap, so fall back to asking nicely.
  const ask = (strict) =>
    navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facing },
        width: { ideal: width },
        height: { ideal: height },
        frameRate: strict ? { ideal: 30, max: 30 } : { ideal: 30 },
      },
      audio: false,
    });
  let stream;
  try {
    stream = await ask(true);
  } catch (err) {
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) throw err;
    stream = await ask(false);
  }
  const track = stream.getVideoTracks()[0];

  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  try {
    await video.play();
  } catch {
    /* autoplay can be blocked until a gesture; the frame callback retries */
  }
  return {
    stream,
    track,
    settings: track.getSettings ? track.getSettings() : {},
    stop() {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}

/** Microphone for the recording path. Flat, no voice processing. */
export async function openMic() {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
}

const H264_MIMES = [
  'video/mp4;codecs=avc1.640034',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

/* HEVC is what a phone camera would write, and Safari will record it on recent
   hardware — but only if the container really is offered. Probe, never assume. */
const HEVC_MIMES = [
  'video/mp4;codecs=hvc1.1.6.L93.B0',
  'video/mp4;codecs=hvc1',
  'video/mp4;codecs=hev1',
];

const supports = (type) => {
  try {
    return MediaRecorder.isTypeSupported(type);
  } catch {
    return false;
  }
};

/** Does this browser expose HEVC recording at all? */
export function hasHevc() {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return false;
  return HEVC_MIMES.some(supports);
}

/** Best container this browser can actually record, honouring a codec request. */
export function pickVideoMime(prefer = 'auto') {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return '';
  const ordered =
    prefer === 'hevc' ? [...HEVC_MIMES, ...H264_MIMES]
      : prefer === 'h264' ? H264_MIMES
      : [...H264_MIMES, ...HEVC_MIMES];
  for (const type of ordered) {
    if (supports(type)) return type;
  }
  return '';
}

export const recorderExtension = (mime) => (mime && mime.includes('mp4') ? 'mp4' : 'webm');

/**
 * Record the live, already-graded canvas. Whatever the viewer shows — LUT,
 * grain, halation, vignette — lands in the file, so nothing depends on a LUT
 * surviving a trip through another app.
 */
export function createRecorder(canvas, { fps = 30, audioStream = null, bitrate = 0, prefer = 'auto' } = {}) {
  const mime = pickVideoMime(prefer);
  if (!mime) throw new Error('This browser cannot record video. Open it in Safari or Chrome.');
  if (typeof canvas.captureStream !== 'function') throw new Error('Canvas capture is unavailable here.');

  const stream = canvas.captureStream(fps);
  const audioTracks = audioStream ? audioStream.getAudioTracks() : [];
  audioTracks.forEach((track) => stream.addTrack(track));

  const width = canvas.width;
  const height = canvas.height;
  // Grain is what encoders throw away first, so aim well above a normal phone
  // bitrate: ~20 Mbps at 1080p30, ~80 Mbps at 4K30.
  const rate = bitrate || Math.min(160e6, Math.max(20e6, Math.round(width * height * fps * 0.32)));
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: rate,
    audioBitsPerSecond: 192000,
  });

  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  };

  const finished = new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
    recorder.onerror = () => resolve(new Blob(chunks, { type: mime }));
  });

  recorder.start(1000);

  return {
    mime,
    bitrate: rate,
    get state() {
      return recorder.state;
    },
    async stop() {
      if (recorder.state !== 'inactive') recorder.stop();
      const blob = await finished;
      stream.getTracks().forEach((track) => track.stop());
      return blob;
    },
  };
}
