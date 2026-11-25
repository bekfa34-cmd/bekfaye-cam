// Bek. Faye v3 - datamosh engine (job C). Ported from v2.1 (flow pre-pass + MFS shader) to run inside the engine
// Viewer's WebGL2 context through the `viewer.pre` hook: pre(gl, srcTex, w, h) -> texture | null.
// Clean until hold(true); then the first frame is the base and every next frame moves the previous OUTPUT along
// 16px-block motion vectors (P-frame style). Own textures live on units 8..15. Output stays in the source texture's
// space (same flip, same size ratio) so the viewer's crop/zoom/look sample it exactly like the raw camera.

export const MOSH_MODES = [
  ['smear', 'Smear', 0], ['bloom', 'Bloom', 1], ['radial', 'Radial', 2], ['swirl', 'Swirl', 3], ['drag', 'Drag', 4],
  ['blocks', 'Blocks', 5], ['drip', 'Drip', 6], ['melt', 'Melt', 7], ['paint', 'Paint', 8], ['stutter', 'Stutter', 9],
  ['ghost', 'Ghost', 10], ['split', 'Split', 11], ['freeze', 'Freeze', 12], ['videob', 'Video B', 13],
].map(([id, name, n]) => ({ id, name, n }));
const NO_FLOW = [5, 6, 9, 12, 13];
const KEYS = { off: 0, sky: 1, dark: 2, motion: 3 };

const VS = `#version 300 es
out vec2 uv;
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));uv=p;gl_Position=vec4(p*2.-1.,0.,1.);}`;
// GLSL ES 1.00 style bodies from v2.1 run under 3.00 through these defines
const HEAD = `#version 300 es
precision highp float;
in vec2 uv;out vec4 fc;
#define texture2D texture
#define gl_FragColor fc
float h(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
float lum(vec3 c){return dot(c,vec3(.299,.587,.114));}
`;
const COPY_FS = HEAD + `uniform sampler2D tc;void main(){fc=vec4(texture(tc,uv).rgb,1.);}`;

// one block-matching motion estimate per 16x16 block (like a codec's P-frame search) -> tiny texture.
// Finds where the block's pixels were in the previous source frame; stores content motion v (=-d) as whole pixels.
const FLOW_FS = HEAD + `uniform sampler2D tc,tp;uniform vec2 res;
float LP(vec2 p){return lum(texture2D(tp,p).rgb);}
float c[16];
float sad(vec2 b0,vec2 d){float s=0.;for(int i=0;i<4;i++)for(int j=0;j<4;j++)s+=abs(c[i*4+j]-LP((b0+(vec2(float(i),float(j))+.5)*4.+d)/res));return s/16.;}
void main(){
  vec2 b0=floor(gl_FragCoord.xy)*16.;
  for(int i=0;i<4;i++)for(int j=0;j<4;j++)c[i*4+j]=lum(texture2D(tc,(b0+(vec2(float(i),float(j))+.5)*4.)/res).rgb);
  vec2 bd=vec2(0.);float bs=sad(b0,bd)*.85-.004;        // zero vector wins unless clearly beaten (no jitter in flat areas)
  for(int a=-10;a<=10;a++)for(int b=-10;b<=10;b++){vec2 d=vec2(float(a),float(b))*2.;float s=sad(b0,d)+.0004*length(d);if(s<bs){bs=s;bd=d;}}
  vec2 c0=bd;
  for(int a=-1;a<=1;a++)for(int b=-1;b<=1;b++){vec2 d=c0+vec2(float(a),float(b));float s=sad(b0,d)+.0004*length(d);if(s<bs){bs=s;bd=d;}}
  gl_FragColor=vec4(clamp(-bd/64.+.5,0.,1.),step(.09,bs),1.);   // b = no usable match: the block is new content (intra block)
}`;

const MOSH_FS = HEAD + `uniform sampler2D tc,tf,tm,tv,tx,tb;uniform vec2 res,pv,dd;
uniform float time,amt,mode,reset,maskUse,key,thr,inv,feather,fxUse;
vec3 C(vec2 p){return texture2D(tc,p).rgb;}
float LC(vec2 p){return lum(C(p));}
vec3 F(vec2 p){return texture2D(tf,p).rgb;}
float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+1.),f.x),f.y);}
float maskA(){if(feather<.0005)return texture2D(tm,uv).a;vec2 r=vec2(feather*res.y/res.x,feather);float a=0.;
  for(int i=-1;i<=1;i++)for(int j=-1;j<=1;j++)a+=texture2D(tm,uv+vec2(float(i),float(j))*r).a;return a/9.;}
void main(){
  vec3 cur=C(uv),outc=cur;
  if(reset<.5){
  float B=16.;vec2 bc=(floor(uv*res/B)+.5)*B/res;
  vec2 v=floor((texture2D(tv,uv).rg-.5)*64.+.5)/res;       // whole-pixel block vectors: crisp macroblock copies, no blur build-up
  float mag=length(v*res),k=amt,ar=res.x/res.y,rf=smoothstep(.6,4.,mag)*(1.-k*.6);
  vec3 nw=cur;
  int m=int(mode+.5);vec3 o;
  if(m==0){vec2 vv=floor(v*res*(.5+k*.83)+.5)/res;o=texture2D(tv,uv).b>.5?nw:F(uv-vv);}   // classic P-frame mosh: copy previous output along the block vector, no blend, no refresh
  else if(m==1){vec2 q=pv+(uv-pv)*(1.-.008*(.4+k));
    o=mix(vec3(F(q+vec2(.0015,0.)).r,F(q).g,F(q-vec2(.0015,0.)).b),nw,.015+rf*.5);}
  else if(m==2){vec2 d=uv-pv;d.x*=ar;vec2 dir=normalize(d+1e-5);dir.x/=ar;
    o=mix(F(uv-dir*(.002+.008*k)*(.3+length(d))-v*.5),nw,.01+rf*.35);}
  else if(m==3){vec2 d=uv-pv;d.x*=ar;float an=(.012+.04*k)*exp(-length(d)*2.),ca=cos(an),sa=sin(an);
    vec2 r=vec2(d.x*ca-d.y*sa,d.x*sa+d.y*ca);r.x/=ar;o=mix(F(pv+r),nw,.012+rf*.3);}
  else if(m==4)o=mix(F(uv-dd*(.4+1.6*k)-v*.5),nw,.01+rf*.3);
  else if(m==5){float s=floor(time*10.),r=h(bc*res+s);vec2 d=(vec2(h(bc*7.+s),h(bc*3.+s*1.7))-.5)*6.*B/res;
    if(r<k*.35)o=F(uv+d);else if(r<k*.65)o=F(uv);else o=mix(F(uv),nw,.25);}
  else if(m==6){vec3 best=nw;float bl=lum(nw),th=.8-.5*k;
    for(int i=1;i<24;i++){vec3 s=C(uv+vec2(0.,float(i)*.004*(.5+k)));float l=lum(s);if(l>th&&l>bl){best=s;bl=l;}}
    o=mix(best,F(uv+vec2(0.,.003)),.4*k);}
  else if(m==7){float col=h(vec2(floor(uv.x*res.x/6.),1.));
    o=mix(F(uv+vec2(sin(uv.y*30.+time*2.)*.0015,(.002+.008*col)*(.3+k))),nw,.025+.1*(1.-k)*smoothstep(0.,3.,mag));}
  else if(m==8){vec2 px=1./res,q=uv*res/45.;
    vec2 gr=vec2(LC(uv+vec2(4.,0.)*px)-LC(uv-vec2(4.,0.)*px),LC(uv+vec2(0.,4.)*px)-LC(uv-vec2(0.,4.)*px));
    float an=vn(q)*9.42;if(length(gr)>.05)an=atan(gr.y,gr.x)+1.5708+(vn(q+9.)-.5)*.6;
    vec2 dir=vec2(cos(an),sin(an)),jit=(vec2(vn(q+17.),vn(q+31.))-.5)*10.*px;
    vec3 s=vec3(0.);for(int i=-4;i<=4;i++)s+=C(uv+jit+dir*float(i)*(2.+3.*k)*px);s/=9.;
    s*=.93+.14*h(vec2(floor(dot(uv*res,vec2(-dir.y,dir.x))/2.),floor(vn(q+5.)*9.)));s=mix(vec3(lum(s)),s,1.25);
    o=mix(F(uv-v*1.2),s,mix(.22,.04,k));}
  else if(m==9){float s=floor(time*9.);
    if(h(vec2(s,3.))<k*.7){float sh=(h(vec2(floor(uv.y*14.),s))-.5)*.1*step(.4,h(vec2(s,5.)));o=F(uv+vec2(sh,0.));}else o=nw;}
  else if(m==10)o=mix(nw,F(uv-v*.6),.55+.4*k);
  else if(m==11){float r=mix(.1,.004,k);
    o=vec3(mix(F(uv-v*1.6).r,nw.r,r),mix(F(uv-v).g,nw.g,r),mix(F(uv+v*.6).b,nw.b,r));}
  else if(m==12)o=F(uv);                       // Freeze: loop back to the picture when the span began
  else o=texture2D(tb,uv).rgb;                 // Video B
  float mk=maskUse>.5?maskA():1.,l=lum(cur),kw=.07+feather*2.;
  if(key>.5&&key<1.5)mk*=smoothstep(thr-kw,thr+kw,l);
  else if(key>1.5&&key<2.5)mk*=1.-smoothstep(thr-kw,thr+kw,l);
  else if(key>2.5)mk*=smoothstep(.4+thr*2.,1.2+thr*4.,mag);
  if(inv>.5)mk=1.-mk;
  outc=mix(cur,o,mk);
  }
  if(fxUse>.5){vec3 x=texture2D(tx,uv).rgb,s=outc;                       // region effects: R grey, G colour, B mirror top
    if(x.b>.01){vec2 q=vec2(uv.x,uv.y<.5?1.-uv.y:uv.y);s=mix(s,C(q),x.b);}
    s=mix(s,vec3(lum(s)),x.r);
    s=mix(s,clamp(mix(vec3(lum(s)),s,2.)*1.08,0.,1.),x.g);outc=s;}
  gl_FragColor=vec4(outc,1.);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('mosh shader: ' + gl.getShaderInfoLog(s));
  return s;
}
function prog(gl, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS)); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('mosh link: ' + gl.getProgramInfoLog(p));
  const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const nm = gl.getActiveUniform(p, i).name; u[nm] = gl.getUniformLocation(p, nm); }
  return { p, u };
}
function mkTex(gl, filter) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, filter], [gl.TEXTURE_MAG_FILTER, filter]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  return t;
}

export function createMosh(viewer, { maxSide = 1280 } = {}) {
  const gl = viewer.gl;
  const P = { amt: 0.6, thr: 0.6, feather: 0.012, inv: false, dragDir: [0.004, 0] };
  let modeN = 0, pivot = [0.5, 0.5], keyN = 0, held = false, needReset = true, attached = false;
  let maskC = null, maskDirty = false, fxC = null, fxDirty = false, vidB = null;
  let fn = 0, dims = { w: 0, h: 0 }, fi = 0, ready = false;
  let FL, M, CP, fbT, fbo, prevT, prevFbo, flowT, flowFbo, maskT, fxT, bT, flowW = 1, flowH = 1;
  const api = {};

  function init() {
    if (ready || !viewer.ok) return;
    FL = prog(gl, FLOW_FS); M = prog(gl, MOSH_FS); CP = prog(gl, COPY_FS);
    const un = (Pg, name, n) => { gl.useProgram(Pg.p); if (Pg.u[name]) gl.uniform1i(Pg.u[name], n); };
    un(FL, 'tc', 8); un(FL, 'tp', 9); un(CP, 'tc', 8);
    un(M, 'tc', 8); un(M, 'tf', 10); un(M, 'tm', 11); un(M, 'tv', 12); un(M, 'tx', 13); un(M, 'tb', 14);
    fbT = [mkTex(gl, gl.NEAREST), mkTex(gl, gl.NEAREST)]; prevT = mkTex(gl, gl.NEAREST); flowT = mkTex(gl, gl.NEAREST);
    maskT = mkTex(gl, gl.LINEAR); fxT = mkTex(gl, gl.LINEAR); bT = mkTex(gl, gl.LINEAR);
    fbo = [gl.createFramebuffer(), gl.createFramebuffer()]; prevFbo = gl.createFramebuffer(); flowFbo = gl.createFramebuffer();
    ready = true;
  }
  function filt() { const f = modeN === 0 ? gl.NEAREST : gl.LINEAR; if (!ready) return; gl.activeTexture(gl.TEXTURE15); for (const t of [fbT[0], fbT[1]]) { gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f); } gl.activeTexture(gl.TEXTURE0); }
  function alloc(w, h) {
    const att = (f, t, ww, hh) => {
      gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ww, hh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    };
    gl.activeTexture(gl.TEXTURE15);
    att(fbo[0], fbT[0], w, h); att(fbo[1], fbT[1], w, h); att(prevFbo, prevT, w, h);
    flowW = Math.ceil(w / 16); flowH = Math.ceil(h / 16); att(flowFbo, flowT, flowW, flowH);
    dims = { w, h }; needReset = true;
  }
  const bind = (u, t) => { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, t); };
  const regionsOn = () => !!fxC;

  function pre(_gl, srcTex) {
    if (!ready) return null;
    if (!held && !regionsOn()) { needReset = true; return null; }
    const sw = viewer.srcW || 1, sh = viewer.srcH || 1, k = Math.min(1, maxSide / Math.max(sw, sh));
    const w = Math.max(32, Math.round(sw * k / 16) * 16), h = Math.max(32, Math.round(sh * k / 16) * 16);   // multiples of 16 so flow texels = macroblocks
    // save the viewer's state
    const vp = gl.getParameter(gl.VIEWPORT), fbBind = gl.getParameter(gl.FRAMEBUFFER_BINDING), prg = gl.getParameter(gl.CURRENT_PROGRAM);
    const vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING), flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL), blend = gl.isEnabled(gl.BLEND);
    gl.disable(gl.BLEND); gl.bindVertexArray(viewer.empty);
    if (w !== dims.w || h !== dims.h) alloc(w, h);
    const reset = needReset || !held;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    if (maskDirty) { bind(11, maskT); if (maskC) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskC); maskDirty = false; }
    if (fxDirty) { bind(13, fxT); if (fxC) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fxC); fxDirty = false; }
    if (modeN === 13 && vidB && vidB.readyState >= 2) { bind(14, bT); try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vidB); } catch (e) { /* not ready */ } }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
    bind(8, srcTex); bind(9, prevT); bind(10, fbT[fi]); bind(11, maskT); bind(12, flowT); bind(13, fxT); bind(14, bT);
    if (!reset && (!NO_FLOW.includes(modeN) || keyN === 3)) {
      gl.useProgram(FL.p); gl.uniform2f(FL.u.res, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, flowFbo); gl.viewport(0, 0, flowW, flowH); gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.useProgram(M.p); const u = M.u;
    gl.uniform2f(u.res, w, h); gl.uniform2f(u.pv, pivot[0], 1 - pivot[1]); gl.uniform2f(u.dd, P.dragDir[0], P.dragDir[1]);
    gl.uniform1f(u.time, performance.now() / 1000); gl.uniform1f(u.amt, P.amt); gl.uniform1f(u.mode, modeN); gl.uniform1f(u.reset, reset ? 1 : 0);
    gl.uniform1f(u.maskUse, maskC ? 1 : 0); gl.uniform1f(u.key, keyN); gl.uniform1f(u.thr, P.thr);
    gl.uniform1f(u.inv, P.inv && (maskC || keyN) ? 1 : 0); gl.uniform1f(u.feather, P.feather); gl.uniform1f(u.fxUse, fxC ? 1 : 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[1 - fi]); gl.viewport(0, 0, w, h); gl.drawArrays(gl.TRIANGLES, 0, 3);
    fi ^= 1; fn++;
    // remember this source frame for next frame's motion estimate
    gl.useProgram(CP.p); gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo); gl.drawArrays(gl.TRIANGLES, 0, 3);
    needReset = false;
    // put everything back
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbBind); gl.viewport(vp[0], vp[1], vp[2], vp[3]); gl.useProgram(prg); gl.bindVertexArray(vao);
    if (blend) gl.enable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    return fbT[fi];
  }
  Object.assign(api, {
    attach() { init(); if (!ready) return; viewer.pre = pre; attached = true; },
    detach() { if (viewer.pre === pre) viewer.pre = null; attached = false; },
    hold(b) { b = !!b; if (b && !held) needReset = true; held = b; },
    get held() { return held; },
    setMode(id) { const m = MOSH_MODES.find((x) => x.id === id || x.n === id); if (m) { modeN = m.n; needReset = true; filt(); } },
    setParams(p) { Object.assign(P, p); },
    setPivot(x, y) { pivot = [x, y]; },
    setMask(c) { maskC = c || null; maskDirty = true; },        // alpha = where mosh applies (picture space, top-left origin)
    setFx(c) { fxC = c || null; fxDirty = true; },              // opaque canvas: R grey, G colour, B mirror-top
    setVideoB(el) { vidB = el || null; },
    setKey(k) { keyN = KEYS[k] || 0; },
    reset() { needReset = true; },
    modes: MOSH_MODES.filter((m) => m.n < 12),   // camera chips; Freeze / Video B are editor-region only (MOSH_MODES has all)
  });
  return api;
}
