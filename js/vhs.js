/* Bek. Faye v3 · VHS: eight True-VHS looks (colour LUTs measured in vhs-looks.js), a camcorder post pass on viewer.post,
   and the tape audio chain. Needs the Viewer hooks from engine/gl.js.
   The pass works at whatever size the canvas is: the app sizes the canvas 4:3 (or 16:9) and this fills it. */
import { VHS_DATA, LUT_SIZE } from './vhs-looks.js';

const unb64 = (s) => {
  const bin = atob(s);
  const out = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) / 255;
  return out;
};

/* The colour grade is the LUT. The viewer only adds a touch of glow; softness, chroma bleed, noise are in the post pass. */
export const VHS_LOOKS = VHS_DATA.map((d) => ({
  id: d.id,
  name: d.name,
  lut: unb64(d.lut),
  lutSize: LUT_SIZE,
  options: { softX: 0, softY: 0, bleed: 0, shift: 0, fringe: 0, scan: 0, grain: 0, grainAmount: 0, grainChroma: 0, blur: 0, vignette: 0, glow: Math.min(0.09, d.measured.glow * 1.2) },
  fx: d.fx,
  measured: d.measured,
}));

/* ---------- camcorder pass ---------- */
const VS = `#version 300 es
out vec2 vUv;
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));vUv=p;gl_Position=vec4(p*2.-1.,0.,1.);}`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D uTex,uPrev;
uniform vec2 uRes;
uniform float uT,uSeed,uSoft,uChroma,uDelay,uGhost,uNoise,uFringe,uTop,uHead,uTrack,uWave,uBands,uDrop,uJit,uBlocks,uSnow,uRgb,uStreak,uShake,uFirst;
in vec2 vUv; out vec4 o;
float h21(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
vec3 yuv(vec3 c){float y=dot(c,vec3(.299,.587,.114));return vec3(y,(c.b-y)*.492,(c.r-y)*.877);}
vec3 rgb(vec3 v){return vec3(v.x+1.14*v.z,v.x-.395*v.y-.581*v.z,v.x+2.032*v.y);}
void main(){
  vec2 uv=vUv; vec2 px=1./uRes;
  float fr=floor(uT*30.); float f3=floor(uT*10.);
  float ln=floor(uv.y*480.);
  float aspect=uRes.y/uRes.x;
  float shk=uShake;
  // ---- horizontal line displacement (fraction of width) ----
  float dx=sin(uv.y*9.+uT*1.3)*uWave*.6+sin(uv.y*37.+uT*4.)*uWave*.4;
  dx+=(h21(vec2(ln,fr))-.5)*(.0003+uJit*.004+shk*.012);
  float hs=smoothstep(.024,0.,uv.y);                       // head-switching: bottom ~2.4% of the picture
  dx+=hs*hs*.03*uHead*(.7+.3*sin(uT*3.))+hs*(h21(vec2(ln,fr+7.))-.5)*.02*uHead;
  float y0=fract(uT*.11+uSeed);                              // rare thin tracking line
  float act=max(step(1.-.03-.03*uTrack,fract(uT*(.04+.06*uTrack)+uSeed*3.))*min(uTrack,1.),shk); // a few per minute on true vhs, more on damaged/glitchy
  float band=smoothstep(.012,0.,abs(uv.y-y0))*act;
  dx+=band*(h21(vec2(ln,fr))-.3)*.03;
  float bandMask=0.;
  for(int k=0;k<2;k++){                                      // tall tracking bands (damaged / glitchy)
    float fk=float(k);
    float by=fract(uT*(.045+.03*fk)+fk*.37+uSeed);
    float gate=smoothstep(.2,.7,sin(uT*.7+fk*2.1+uSeed*6.))*uBands;
    float m=smoothstep(.07,.03,abs(uv.y-by))*gate;
    dx+=m*(sin(uv.y*380.+uT*30.)*.012+(h21(vec2(ln,fr+fk))-.5)*.03);
    bandMask=max(bandMask,m);
  }
  float u=uv.x+dx;
  // ---- luma: soft horizontally (~330 TV lines); chroma: wide low-pass, delayed to the right ----
  float sl=uSoft*1.15*aspect, sc=uChroma*aspect*.8;
  vec3 c0=texture(uTex,vec2(u,uv.y)).rgb;
  float Y=yuv(c0).x*.4;
  Y+=(yuv(texture(uTex,vec2(u-sl,uv.y)).rgb).x+yuv(texture(uTex,vec2(u+sl,uv.y)).rgb).x)*.24;
  Y+=(yuv(texture(uTex,vec2(u-2.*sl,uv.y)).rgb).x+yuv(texture(uTex,vec2(u+2.*sl,uv.y)).rgb).x)*.06;
  vec2 uvc=vec2(0.);float ws=0.;
  for(int i=-4;i<=4;i++){float t=float(i);float w=exp(-.5*t*t/2.8);
    vec3 s=yuv(texture(uTex,vec2(u-uDelay+t*sc,uv.y)).rgb);uvc+=w*s.yz;ws+=w;}
  uvc/=ws;
  vec3 c=rgb(vec3(Y,uvc));
  if(uRgb>0.){                                               // rgb look: channel split
    float w=uRgb+sin(uv.y*20.+uT*2.)*uRgb*.25;
    c.r=mix(c.r,texture(uTex,vec2(u+w,uv.y)).r,.8);
    c.b=mix(c.b,texture(uTex,vec2(u-w,uv.y)).b,.8);
  }
  // ---- vertical streak off bright lights ----
  float st=0.;
  for(int i=1;i<=4;i++){float d=float(i)*.014;
    st+=(max(0.,dot(texture(uTex,vec2(u,uv.y+d)).rgb,vec3(.33))-.84)+max(0.,dot(texture(uTex,vec2(u,uv.y-d)).rgb,vec3(.33))-.84))/float(i);}
  c+=st*uStreak*.5*vec3(1.,.92,.85);
  c=(c-.5)*1.06+.5; c=max(c,0.);                              // slightly more contrast
  // ---- tape noise: streaky, never per-pixel soup ----
  float tn=h21(floor(vec2(uv.x*uRes.x/5.,uv.y*uRes.y/1.6))+fract(uT*7.)*311.)-.5;
  c+=tn*uNoise*(1.+shk*3.);
  c+=(h21(vec2(ln,fr+3.))-.5)*.012*uNoise*20.*step(.7,h21(vec2(ln*.07,f3)));  // occasional noisy lines
  // ---- dropouts, snow, glitch blocks ----
  float dr=h21(vec2(floor(uv.x*14.+ln*.3),ln*1.7+fr));
  if(dr>1.-.0009*uDrop) c=mix(c,vec3(.95,.93,.9),.9);
  if(bandMask>0.){float sn=h21(floor(uv*uRes/2.)+fr);c=mix(c,vec3(sn)*.8+vec3(.1,.05,.12),bandMask*.45);}
  if(uSnow>0.){
    vec2 ctr=vec2(.5+.3*sin(uT*.5+uSeed*9.),.55+.25*cos(uT*.37));
    float bl=smoothstep(.3,.05,length((uv-ctr)*vec2(1.,1.3)))*smoothstep(.1,.6,sin(uT*.9+uSeed*5.)*.5+.5)*uSnow;
    float sp=h21(floor(uv*uRes/2.)+fr*3.);
    c=mix(c,c*.7+vec3(sp>.6?.5:0.,sp>.8?.4:0.,sp>.7?.5:0.),bl*.8);
  }
  if(uBlocks>0.){
    vec2 cell=floor(uv*vec2(18.,28.)); float r=h21(cell+f3*17.);
    if(r>1.-.035*uBlocks){float m=h21(cell+f3);
      c=m<.35?c.gbr*1.1:m<.7?mix(c,vec3(.35,.9,.25),.75):mix(c,texture(uTex,vec2(u+.08,uv.y)).bgr,.9);}
  }
  // ---- right-edge yellow-green fringe, pink top line ----
  c=mix(c,vec3(.85,.9,.25),smoothstep(.985,1.,uv.x)*.55*uFringe);
  float tl=smoothstep(.992,1.,uv.y);
  c=mix(c,vec3(1.,.45,.65)*(.75+.25*tn),tl*.6*uTop);
  c*=1.-smoothstep(.006,0.,uv.y)*.5*uHead;                    // dark seam under the head-switch
  // ---- ghosting: previous output ----
  if(uFirst<.5) c=mix(c,texture(uPrev,uv+vec2(px.x*1.5,0.)).rgb,uGhost);
  o=vec4(clamp(c,0.,1.),1.);
}`;

const BLIT_FS = `#version 300 es
precision mediump float; uniform sampler2D uTex; in vec2 vUv; out vec4 o;
void main(){o=vec4(texture(uTex,vUv).rgb,1.);}`;

const UNIFORMS = ['uTex', 'uPrev', 'uRes', 'uT', 'uSeed', 'uSoft', 'uChroma', 'uDelay', 'uGhost', 'uNoise', 'uFringe', 'uTop', 'uHead', 'uTrack', 'uWave', 'uBands', 'uDrop', 'uJit', 'uBlocks', 'uSnow', 'uRgb', 'uStreak', 'uShake', 'uFirst'];

function compile(gl, vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

export function createVhs(viewer, ctx = {}) {
  const lookById = new Map(VHS_LOOKS.map((l) => [l.id, l]));
  let look = VHS_LOOKS[0];
  let shakeV = 0, lastT = 0;
  let attached = false;
  // GL resources (own texture units >= 8)
  let gl = null, prog = null, blit = null, vao = null, loc = null, blitLoc = null;
  let tex = [null, null], fbo = [null, null], size = [0, 0], cur = 0, first = 1;
  const seed = Math.random();

  const settings = () => ctx.settings || {};

  function initGl() {
    gl = viewer.gl;
    prog = compile(gl, VS, FS);
    blit = compile(gl, VS, BLIT_FS);
    loc = {};
    for (const n of UNIFORMS) loc[n] = gl.getUniformLocation(prog, n);
    blitLoc = gl.getUniformLocation(blit, 'uTex');
    vao = gl.createVertexArray();
    tex = [null, null]; fbo = [null, null]; size = [0, 0]; first = 1;
  }

  function makeTarget(i, w, h) {
    if (tex[i]) { gl.deleteTexture(tex[i]); gl.deleteFramebuffer(fbo[i]); }
    tex[i] = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex[i]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    fbo[i] = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[i]);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex[i], 0);
  }

  /* --- the viewer.post hook --- */
  function post(g, srcTex, w, h, time) {
    if (!gl || gl !== g || !gl.isProgram(prog)) { try { initGl(); } catch (e) { viewer.post = null; ctx.toast && ctx.toast('VHS shader failed'); return; } }
    const prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING), prevProg = gl.getParameter(gl.CURRENT_PROGRAM);
    const prevVp = gl.getParameter(gl.VIEWPORT), prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING), prevBlend = gl.isEnabled(gl.BLEND);
    gl.disable(gl.BLEND);
    if (size[0] !== w || size[1] !== h) { makeTarget(0, w, h); makeTarget(1, w, h); size = [w, h]; first = 1; cur = 0; }
    const dt = Math.min(0.2, Math.max(0, time - lastT)); lastT = time;
    shakeV = Math.max(0, shakeV - dt * 1.6);
    const f = look.fx, shakeOn = settings().shake !== false;

    gl.bindVertexArray(vao);
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[cur]);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.activeTexture(gl.TEXTURE9); gl.bindTexture(gl.TEXTURE_2D, tex[1 - cur]);
    gl.uniform1i(loc.uTex, 8); gl.uniform1i(loc.uPrev, 9);
    gl.uniform2f(loc.uRes, w, h);
    gl.uniform1f(loc.uT, time % 3600);
    gl.uniform1f(loc.uSeed, seed);
    gl.uniform1f(loc.uSoft, f.soft); gl.uniform1f(loc.uChroma, f.chroma); gl.uniform1f(loc.uDelay, f.delay);
    gl.uniform1f(loc.uGhost, f.ghost); gl.uniform1f(loc.uNoise, f.noise);
    gl.uniform1f(loc.uFringe, f.fringe || 0); gl.uniform1f(loc.uTop, f.topline || 0); gl.uniform1f(loc.uHead, f.head || 0);
    gl.uniform1f(loc.uTrack, f.track || 0); gl.uniform1f(loc.uWave, f.wave || 0); gl.uniform1f(loc.uBands, f.bands || 0);
    gl.uniform1f(loc.uDrop, f.drop || 0); gl.uniform1f(loc.uJit, f.jit || 0); gl.uniform1f(loc.uBlocks, f.blocks || 0);
    gl.uniform1f(loc.uSnow, f.snow || 0); gl.uniform1f(loc.uRgb, f.rgb || 0); gl.uniform1f(loc.uStreak, f.streak || 0);
    gl.uniform1f(loc.uShake, shakeOn ? Math.min(1, shakeV) : 0);
    gl.uniform1f(loc.uFirst, first);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(blit);
    gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, tex[cur]);
    gl.uniform1i(blitLoc, 8);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    cur = 1 - cur; first = 0;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(prevVao);
    gl.useProgram(prevProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
    if (prevBlend) gl.enable(gl.BLEND);
  }

  const api = {
    looks: VHS_LOOKS,
    attach() { attached = true; viewer.post = post; api.setLook(look.id); },
    detach() { attached = false; if (viewer.post === post) viewer.post = null; closeTape(true); },
    stopTape() { closeTape(false); }, // after a take: the tape chain's oscillators and timer end with it
    setLook(id) {
      const l = lookById.get(id) || look;
      look = l;
      first = 1;
      if (viewer.ok && attached) { viewer.setLut(l.lut, l.lutSize); viewer.setOptions(l.options); }
    },
    shake(m) { shakeV = Math.max(shakeV, Math.min(1, m || 0)); },
    // wake the tape audio engine; call it inside a tap (create=true before a take) or iOS leaves it suspended and the first take is silent
    resume(create) { warmAudio(!!create); },
    audioChain(micStream) { return tapeAudio(micStream, () => (settings().shake === false ? 0 : shakeV)); },
  };
  return api;
}

/* ---------- tape audio: ~80 Hz-10 kHz, soft saturation, slight wow/flutter, quiet hiss. Voice stays up front. ---------- */
let audioCtx = null, warmCtx = null, tapeTick = 0;
function closeTape(warmToo) {
  clearInterval(tapeTick);
  const a = audioCtx; audioCtx = null;
  if (a) a.close().catch(() => {});
  if (warmToo && warmCtx) { warmCtx.close().catch(() => {}); warmCtx = null; }
}
function warmAudio(create) {
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return;
  try {
    if (create && (!warmCtx || warmCtx.state === 'closed')) warmCtx = new AC();
    for (const c of [warmCtx, audioCtx]) if (c && c.state === 'suspended') c.resume().catch(() => {});
  } catch { /* no audio engine */ }
}
function tapeAudio(micStream, getShake) {
  const track = micStream && micStream.getAudioTracks && micStream.getAudioTracks()[0];
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!track || !AC) return micStream; // never lose the mic: pass it straight through
  try {
    closeTape(false);
    const a = (audioCtx = warmCtx && warmCtx.state !== 'closed' ? warmCtx : new AC());
    warmCtx = null;
    const src = a.createMediaStreamSource(new MediaStream([track]));
    const hp = a.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 80;
    const pres = a.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 2800; pres.Q.value = 0.8; pres.gain.value = 3; // keeps speech forward
    const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 10000; lp.Q.value = 0.5;
    const ws = a.createWaveShaper(); const cv = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; cv[i] = Math.tanh(1.4 * x) / Math.tanh(1.4); }
    ws.curve = cv;
    const dl = a.createDelay(0.05); dl.delayTime.value = 0.012;
    for (const [f, amp] of [[0.55, 0.0006], [7.5, 0.00006]]) {
      const o = a.createOscillator(), g = a.createGain(); o.frequency.value = f; g.gain.value = amp; o.connect(g); g.connect(dl.delayTime); o.start();
    }
    const comp = a.createDynamicsCompressor(); comp.threshold.value = -26; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
    const makeup = a.createGain(); makeup.gain.value = 1.7;
    const nb = a.createBuffer(1, a.sampleRate * 2, a.sampleRate), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const hs = a.createBufferSource(); hs.buffer = nb; hs.loop = true;
    const hh = a.createBiquadFilter(); hh.type = 'highpass'; hh.frequency.value = 3000;
    const hg = a.createGain(); hg.gain.value = 0.004;
    hs.connect(hh); hh.connect(hg); hs.start();
    const dest = a.createMediaStreamDestination();
    src.connect(hp); hp.connect(pres); pres.connect(lp); lp.connect(ws); ws.connect(dl); dl.connect(comp); comp.connect(makeup); makeup.connect(dest); hg.connect(dest);
    const tick = tapeTick = setInterval(() => {
      if (a.state === 'closed') return clearInterval(tick);
      const k = getShake();
      dl.delayTime.setTargetAtTime(0.012 + 0.006 * k, a.currentTime, 0.05);
      lp.frequency.setTargetAtTime(10000 - 4500 * k, a.currentTime, 0.08);
    }, 120);
    const resume = () => { if (a.state !== 'running') a.resume().catch(() => {}); };
    resume();
    a.onstatechange = () => { if (a.state === 'suspended') for (const ev of ['touchend', 'click']) addEventListener(ev, resume, { once: true, capture: true }); };
    return dest.stream;
  } catch (e) {
    return micStream;
  }
}

/** Tiny self-check (run `?selftest` or in node: import('./vhs.js').then(m=>m.selfTest())). */
export function selfTest() {
  const ok = (c, m) => { if (!c) throw new Error('vhs selftest: ' + m); };
  ok(VHS_LOOKS.length === 8, '8 looks');
  for (const l of VHS_LOOKS) ok(l.lut.length === 17 ** 3 * 3, 'lut size ' + l.id);
  return true;
}
