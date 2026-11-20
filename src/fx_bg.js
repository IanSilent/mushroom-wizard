// Background FX «Грибной трип» (DESIGN.md §5): the canvas BEHIND the transparent game canvas.
// Every warp, ripple and kaleidoscope lives here, so hazards on the game layer are never distorted.
//
// Four drunk worlds share one mushroom forest (3 parallax layers) whose shapes and styling morph
// with the stage, each with its own sky:
//   D1 «Рассвет»  pastel haze strata, soft rounded mushrooms, a melting moon with oozing drips.
//   D2 «Тепло»    magenta / tangerine dusk, giant swaying parasol mushrooms with glowing teal gills,
//                 slow spirals winding out of a ringed sun.
//   D3 «Неон»     near-black silhouettes with neon rims, domain-warped flowing neon contour bands,
//                 a giant eye for a moon and small eyes blinking in the dark (they watch the wizard).
//   D4 «Пик»      a kaleidoscopic log-polar mandala: rings of open eyes and fractal curls zooming
//                 outward, full-spectrum hue cycling, an eye on every cap, rainbow rims.
//   Clarity «Чернила»: the same scene as an ink etching on warm paper — engraved sky lines, outlined
//                 and cross-hatched mushrooms, a stippled ground. Calm and still (no warp, no hue).
// Stage changes: a 0.3 s morph of shapes and palette plus a chromatic ripple from the screen centre;
// reaching D4 adds a kaleidoscope bloom. Clarity spreads out from the wizard in 0.15 s with a cyan
// flash wave and recedes in 0.3 s; in its last second colour bleeds back in at the paper's edges.
// The fx setting (0..1) scales warp, motion, kaleidoscope folding and event distortion only; at
// fx = 0 the image is still, but palettes and motifs still identify the stage.
// Art-house texture: film grain, vignette (a burnt paper edge in Clarity), chromatic fringing at D3+.
// Hazard guard: background colours near the hazard red-orange are desaturated, so hazards on the
// game layer stay the only vivid red-orange on screen.
//
// Rendering: WebGL1, two passes at half resolution — the scene into a texture, then a post pass
// (ripple, bloom, fringing, flash, grain, vignette, dim). The shader has no big loops (3 layers x 3
// mushrooms, 4 drips). Canvas2D fallback with the same palettes and motifs (no warping) when WebGL is
// unavailable, fails to compile, or a lost context cannot be rebuilt.
//
// API: new MW.BgFx(canvas), .reset(), .handle(e[, world]), .render(state)
//   state = {dt, time, camX, camY, stage (1..4), clarity, clarityT, dead, fx (0..1), roomIndex, mode}
//   camX / camY: camera top-left in tiles (as MW.Renderer.camera). Optional state.px / state.py
//   (player centre, tiles) aim the eyes; otherwise the player is read from the world passed to handle().
var MW = MW || {};

(function () {
  'use strict';

  var VW = 30;                 // view width in tiles (960 / 32)
  var VH = 540 / 32;           // view height in tiles (16.875)
  var BASE_W = 960, BASE_H = 540;
  var RES_SCALE = 0.5;         // backing store vs the 960x540 layout: half res, cheap on iGPUs
  var MORPH_T = 0.3;           // s, stage morph
  var CLAR_IN = 0.15, CLAR_OUT = 0.3;
  var RIP_LIFE = 0.5;          // s, chromatic ripple on stage changes
  var BLOOM_LIFE = 0.55;       // s, kaleidoscope bloom on reaching D4
  var FLASH_LIFE = 0.5;        // s, Clarity flash wave
  var RING_LIFE = 0.6;         // s, soft rings (casts, pickups, checkpoints)
  var TITLE_STAGE_T = 4.5;     // s per world on the title screen
  var TAU = Math.PI * 2;

  // Mushroom forest layers, far -> near (one table drives the shader source and the fallback).
  //   f: parallax   scale: size   ground: ground line (screen tiles from the top)
  //   cell: mushroom spacing (layer units)   empty: chance that a cell has no mushroom
  var LAYERS = [
    { f: 0.12, scale: 0.55, ground: 11.4, cell: 6.0, seed: 11.0, empty: 0.12 },
    { f: 0.25, scale: 0.80, ground: 13.8, cell: 7.0, seed: 37.0, empty: 0.22 },
    { f: 0.42, scale: 1.15, ground: 17.2, cell: 9.0, seed: 71.0, empty: 0.42 },
  ];

  // Per-stage look of the shared forest; blended by the stage weights, so shapes morph in place.
  //   shape:  cap width mul, cap height ratio, stem height mul, sway (tiles at fx = 0.5)
  //   shape2: gill depth (underside / cap height), gill glow, spot glow, rim glow
  //   shape3: cap tint, darkness, aerial haze, eyes on caps
  var STYLE = {
    1: { shape: [1.0, 0.62, 0.85, 0.15], shape2: [0.30, 0.0, 0.10, 0.06], shape3: [0.45, 0.0, 0.40, 0.0] },
    2: { shape: [1.5, 0.40, 1.25, 0.60], shape2: [0.55, 0.75, 0.30, 0.25], shape3: [0.35, 0.18, 0.30, 0.0] },
    3: { shape: [0.85, 1.05, 1.10, 0.30], shape2: [0.16, 0.35, 0.90, 1.0], shape3: [0.0, 0.72, 0.12, 0.3] },
    4: { shape: [1.15, 0.72, 1.0, 0.45], shape2: [0.30, 0.60, 1.0, 1.0], shape3: [0.0, 0.85, 0.04, 1.0] },
  };
  var SPEED = [0.55, 0.8, 1.0, 1.25];   // motion clock rate per stage (times fx)

  // ---------------------------------------------------------------- small math helpers

  function fract(x) { return x - Math.floor(x); }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function ease(x) { x = clamp01(x); return x * x * (3 - 2 * x); }
  function smooth(a, b, x) { return ease((x - a) / (b - a)); }
  function approach(v, target, delta) { return v < target ? Math.min(v + delta, target) : Math.max(v - delta, target); }
  function expo(v, target, dt, tau) { return v + (target - v) * (1 - Math.exp(-dt / Math.max(1e-4, tau))); }
  function mix3(a, b, k) { return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]; }
  function scale3(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
  function c255(v) { return Math.round(clamp01(v) * 255); }
  function rgb(c) { return 'rgb(' + c255(c[0]) + ',' + c255(c[1]) + ',' + c255(c[2]) + ')'; }
  function rgba(c, a) { return 'rgba(' + c255(c[0]) + ',' + c255(c[1]) + ',' + c255(c[2]) + ',' + clamp01(a).toFixed(3) + ')'; }
  function rainbow(h) {
    return [0.5 + 0.5 * Math.cos(TAU * h), 0.5 + 0.5 * Math.cos(TAU * (h + 0.33)), 0.5 + 0.5 * Math.cos(TAU * (h + 0.67))];
  }
  // Same hash as the shader's h11 (Dave Hoskins' sin-free hash), so the fallback draws the same forest.
  function hash11(p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }

  // ---------------------------------------------------------------- palette (src/palette.js)

  var PAL_KEYS = ['skyTop', 'skyMid', 'skyLow', 'accent', 'glow', 'fringe', 'groundEdge', 'ground'];
  var PAL_SHORT = ['TOP', 'MID', 'LOW', 'ACC', 'GLOW', 'FR', 'EDGE', 'GND'];
  // Used only if palette.js failed to load (same values).
  var FALLBACK_PAL = {
    stages: {
      1: { skyTop: '#2b2340', skyMid: '#5a4870', skyLow: '#c99aa6', accent: '#f4c7a1', glow: '#e9b8d0', fringe: '#b9d6ae', groundEdge: '#9a86ad', ground: '#3a2f47' },
      2: { skyTop: '#2a0f2e', skyMid: '#7a1f5c', skyLow: '#f08a3c', accent: '#ffb05a', glow: '#ff6fb5', fringe: '#3fd1c0', groundEdge: '#d4568f', ground: '#3b1636' },
      3: { skyTop: '#0d0626', skyMid: '#3b0f8a', skyLow: '#ff2fa8', accent: '#ff3fd0', glow: '#7dfcff', fringe: '#b6ff3b', groundEdge: '#9c4dff', ground: '#1d0b3d' },
      4: { skyTop: '#05020a', skyMid: '#2a0a3a', skyLow: '#ffd23f', accent: '#ffe14a', glow: '#ff5ee0', fringe: '#45ffb0', groundEdge: '#ff4fd8', ground: '#12061c' },
    },
    clarity: { paper: '#efe6d2', paperShade: '#d6c7a8', paperDeep: '#b9a682', ink: '#1c1712', inkSoft: '#4a4034', hatch: '#2a241c' },
    cyan: '#4fe3f0',
  };
  function hex01(h) {
    var s = String(h || '#000').replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    var n = parseInt(s, 16) || 0;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function palSrc() { return (MW.PALETTE && MW.PALETTE.stages && MW.PALETTE.clarity) ? MW.PALETTE : FALLBACK_PAL; }
  function stagePal(i) {
    var src = palSrc().stages[i] || FALLBACK_PAL.stages[i], out = {};
    PAL_KEYS.forEach(function (k) { out[k] = hex01(src[k] || FALLBACK_PAL.stages[i][k]); });
    return out;
  }
  function inkPal() {
    var P = palSrc(), c = P.clarity;
    return {
      paper: hex01(c.paper), shade: hex01(c.paperShade), deep: hex01(c.paperDeep),
      ink: hex01(c.ink), soft: hex01(c.inkSoft), hatch: hex01(c.hatch || c.ink), cyan: hex01(P.cyan || '#4fe3f0'),
    };
  }

  // ---------------------------------------------------------------- shared shape helpers

  // One mushroom per cell (layer units). KEEP IN SYNC with shroom() in the shader.
  function shroomParams(id, L, sh, sway, t) {
    var r0 = hash11(id * 3.17 + L.seed), r1 = hash11(id * 5.31 + L.seed + 1.7), r2 = hash11(id * 7.77 + L.seed + 3.9);
    var r3 = hash11(id * 9.13 + L.seed + 5.3), r4 = hash11(id * 11.7 + L.seed + 7.1), r6 = hash11(id * 17.1 + L.seed + 2.2);
    var cw = (1.5 + 1.7 * r3) * sh[0];
    return {
      empty: r6 < L.empty,
      cx: (id + 0.5 + (r1 - 0.5) * 0.4) * L.cell,
      H: (3.2 + 5.0 * r2) * sh[2],
      cw: cw,
      ch: cw * sh[1] * (0.8 + 0.4 * r4),
      sw: 0.22 + 0.2 * r0,
      bend: (r4 - 0.5) * 1.4 + sway * Math.sin(t * 0.55 + r1 * TAU),
      hid: hash11(id * 1.37 + L.seed),
    };
  }
  function hill(lx, seed) { return 0.6 * Math.sin(lx * 0.19 + seed) + 0.35 * Math.sin(lx * 0.47 + seed * 2.0); }

  // ---------------------------------------------------------------- shader sources

  function glf(v) { return (+v).toFixed(4); }
  function glv3(c) { return 'vec3(' + glf(c[0]) + ', ' + glf(c[1]) + ', ' + glf(c[2]) + ')'; }

  var VERT_SRC = [
    'attribute vec2 aPos;',
    'void main() { gl_Position = vec4(aPos, 0.0, 1.0); }',
  ].join('\n');

  var GL_HEAD = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    '#define VW ' + glf(VW),
    '#define VH ' + glf(VH),
    '#define TAU 6.2831853',
    'float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }',
    'float h21(vec2 p) {',
    '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
    '  p3 += dot(p3, p3.yzx + 33.33);',
    '  return fract((p3.x + p3.y) * p3.z);',
    '}',
  ].join('\n');

  function constBlock() {
    var lines = [];
    for (var i = 1; i <= 4; i++) {
      var P = stagePal(i);
      for (var k = 0; k < PAL_KEYS.length; k++) lines.push('const vec3 S' + i + '_' + PAL_SHORT[k] + ' = ' + glv3(P[PAL_KEYS[k]]) + ';');
    }
    var I = inkPal();
    lines.push('const vec3 PAPER = ' + glv3(I.paper) + ';');
    lines.push('const vec3 PAPER_SH = ' + glv3(I.shade) + ';');
    lines.push('const vec3 PAPER_DEEP = ' + glv3(I.deep) + ';');
    lines.push('const vec3 INK = ' + glv3(I.ink) + ';');
    lines.push('const vec3 INK_SOFT = ' + glv3(I.soft) + ';');
    lines.push('const vec3 CYAN = ' + glv3(I.cyan) + ';');
    return lines.join('\n');
  }

  function sceneSrc() {
    var layerCalls = LAYERS.map(function (L, k) {
      return '  vec4 L' + k + ' = layer(s, ' + [L.f, L.scale, L.ground, L.cell, L.seed, L.empty].map(glf).join(', ') + ', h' + k + ');';
    }).join('\n');
    return [
      GL_HEAD,
      'uniform vec2 uRes;',
      'uniform float uT;       // motion clock (runs with fx; frozen at fx = 0 and in Clarity)',
      'uniform vec4 uCam;      // camera x, y (tiles), soft-clamped vertical offset, bounded drift for sky bodies',
      'uniform vec4 uW;        // stage weights D1..D4 (sum 1)',
      'uniform vec4 uK;        // Clarity blend (eased), warp gain 0..2, kaleidoscope 0..1, hue phase (turns)',
      'uniform vec4 uSpread;   // Clarity origin (screen tiles), ending warning, unused',
      'uniform vec4 uLook;     // wizard centre on screen (tiles), unused, unused',
      'uniform vec4 uShape;    // cap width mul, cap height ratio, stem height mul, sway (tiles)',
      'uniform vec4 uShape2;   // gill depth, gill glow, spot glow, rim glow',
      'uniform vec4 uShape3;   // cap tint, darkness, aerial haze, eyes on caps',
      'uniform vec3 uPal[8];   // stage-blended: skyTop skyMid skyLow accent glow fringe groundEdge ground',
      constBlock(),
      'float px;               // one backing pixel in tiles',
      '',
      'vec2 h22(vec2 p) {',
      '  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));',
      '  p3 += dot(p3, p3.yzx + 33.33);',
      '  return fract((p3.xx + p3.yz) * p3.zy);',
      '}',
      'float vn(vec2 p) {',
      '  vec2 i = floor(p); vec2 f = fract(p);',
      '  vec2 u = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y);',
      '}',
      'float fbm3(vec2 p) {',
      '  float v = 0.0; float a = 0.5;',
      '  for (int i = 0; i < 3; i++) { v += a * vn(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }',
      '  return v / 0.875;',
      '}',
      'float smin(float a, float b, float k) {',
      '  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);',
      '  return mix(b, a, h) - k * h * (1.0 - h);',
      '}',
      'vec3 rainbow(float h) { return 0.5 + 0.5 * cos(TAU * (h + vec3(0.0, 0.33, 0.67))); }',
      'vec3 hueRot(vec3 c, float a) {',
      '  vec3 k = vec3(0.57735);',
      '  float ca = cos(a);',
      '  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);',
      '}',
      // Engraving line: 1 line per coord unit, tone 0..1 sets the line width; aa in coord units.
      'float hatchL(float coord, float tone, float aa) {',
      '  float d = abs(fract(coord) - 0.5);',
      '  float w = 0.5 * clamp(tone, 0.0, 1.0);',
      '  return (1.0 - smoothstep(w - aa, w + aa, d)) * smoothstep(0.0, 0.08, tone);',
      '}',
      // Lid opening of a blinking eye (1 = open). Still (always open) at fx = 0.
      'float blink(float seed, float period) {',
      '  float ph = fract(uT / period + seed) * period;',
      '  return mix(1.0, smoothstep(0.015, 0.08, abs(ph - 0.11)), min(uK.y, 1.0));',
      '}',
      '',
      '// Almond eye in eye space (x -1..1 corner to corner, y up). open: lid opening; look: pupil',
      '// direction (-1..1); lid: closed-lid colour. Returns (colour, coverage).',
      'vec4 eye(vec2 p, float open, vec2 look, vec3 iris, vec3 sclera, vec3 lid, float aa) {',
      '  float x2 = min(p.x * p.x, 1.0);',
      '  float hh = 0.5 * (1.0 - x2);',
      '  float dOut = max(abs(p.y) - hh, abs(p.x) - 1.0);',
      '  float cov = 1.0 - smoothstep(-aa, aa, dOut - 0.08);',
      '  if (cov <= 0.0) return vec4(0.0);',
      '  vec2 ip = p - look * vec2(0.3, 0.12);',
      '  float ir = length(ip);',
      '  vec3 c = sclera * (0.72 + 0.28 * (1.0 - x2));',
      '  float ang = atan(ip.y, ip.x);',
      '  vec3 ic = iris * (0.45 + 0.3 * sin(ang * 13.0 + ir * 17.0) * 0.5 + 0.55 * smoothstep(0.08, 0.38, ir));',
      '  c = mix(c, ic, 1.0 - smoothstep(0.38 - aa, 0.38 + aa, ir));',
      '  c = mix(c, vec3(0.015), 1.0 - smoothstep(0.15 - aa, 0.15 + aa, ir));',
      '  c = mix(c, vec3(1.0), 1.0 - smoothstep(0.05, 0.05 + aa, length(ip - vec2(-0.1, 0.11))));',
      '  float ball = 1.0 - smoothstep(-aa, aa, abs(p.y) - hh * open);',
      '  c = mix(lid, c, ball);',
      '  float lash = 1.0 - smoothstep(0.025, 0.025 + aa * 1.5, abs(dOut + 0.02));',
      '  float shut = (1.0 - smoothstep(0.02, 0.02 + aa * 1.5, abs(p.y))) * (1.0 - open) * step(abs(p.x), 1.0);',
      '  c = mix(c, vec3(0.01), max(lash, shut) * 0.92);',
      '  return vec4(c, cov);',
      '}',
      '',
      '// One mushroom in layer space (x along, y = height above the layer ground).',
      '// KEEP IN SYNC with shroomParams() in JS. Returns (distance, cap flag, cap space q).',
      'vec4 shroom(vec2 p, float id, float seed, float cell, float emptyP) {',
      '  float r0 = h11(id * 3.17 + seed);',
      '  float r1 = h11(id * 5.31 + seed + 1.7);',
      '  float r2 = h11(id * 7.77 + seed + 3.9);',
      '  float r3 = h11(id * 9.13 + seed + 5.3);',
      '  float r4 = h11(id * 11.7 + seed + 7.1);',
      '  float r6 = h11(id * 17.1 + seed + 2.2);',
      '  float cx = (id + 0.5 + (r1 - 0.5) * 0.4) * cell;',
      '  float H = (3.2 + 5.0 * r2) * uShape.z;',
      '  float cw = (1.5 + 1.7 * r3) * uShape.x;',
      '  float ch = cw * uShape.y * (0.8 + 0.4 * r4);',
      '  float sw = 0.22 + 0.2 * r0;',
      '  float bend = (r4 - 0.5) * 1.4 + uShape.w * sin(uT * 0.55 + r1 * TAU);',
      '  float yn = clamp(p.y / H, 0.0, 1.0);',
      '  float sx = p.x - cx - bend * yn * yn;',
      '  float dStem = max(abs(sx) - sw * (1.0 + 0.8 * (1.0 - yn) * (1.0 - yn)), max(-2.5 - p.y, p.y - H));',
      '  vec2 q = (p - vec2(cx + bend, H)) / vec2(cw, ch);',
      '  float under = step(q.y, 0.0);',
      '  float gd = mix(1.0, uShape2.x, under);',
      '  float dCap = (length(vec2(q.x, q.y / gd)) - 1.0) * min(cw, ch * gd);',
      '  return vec4(min(dStem, dCap) + step(r6, emptyP) * 99.0, step(dCap, dStem), q);',
      '}',
      '',
      '// Forest layer: (distance in screen tiles, negative inside; cap flag; cap space q). hid = mushroom hash.',
      'vec4 layer(vec2 s, float f, float scale, float ground, float cell, float seed, float emptyP, out float hid) {',
      '  float lx = (s.x + uCam.x * f) / scale;',
      '  float ly = (ground - uCam.z * f - s.y) / scale;',
      '  float id = floor(lx / cell);',
      '  vec4 res = vec4(ly - (0.6 * sin(lx * 0.19 + seed) + 0.35 * sin(lx * 0.47 + seed * 2.0)), 0.0, 9.0, 9.0);',
      '  hid = 0.5;',
      '  for (int i = -1; i <= 1; i++) {',
      '    float idi = id + float(i);',
      '    vec4 m = shroom(vec2(lx, ly), idi, seed, cell, emptyP);',
      '    if (m.x < res.x) { res = m; hid = h11(idi * 1.37 + seed); }',
      '  }',
      '  res.x *= scale;',
      '  return res;',
      '}',
      '',
      'vec3 skyGrad(vec2 s, vec3 top, vec3 mid, vec3 low, float m) {',
      '  float gy = clamp((s.y + uCam.z * 0.12) / VH, 0.0, 1.0);',
      '  vec3 c = mix(top, mid, smoothstep(0.0, m, gy));',
      '  return mix(c, low, smoothstep(m * 0.75, 1.02, gy));',
      '}',
      'vec2 moonPos() { return vec2(21.8 + uCam.w, 4.3 - clamp(uCam.z * 0.05, -1.5, 1.5)); }',
      '',
      '// Small eyes scattered on a parallax grid; they blink and look at the wizard.',
      'vec4 eyeField(vec2 s, vec2 cell, float f, float seed, float dens, vec3 irisA, vec3 irisB, vec3 sclera, vec3 lid) {',
      '  vec2 q = s + uCam.xy * f;',
      '  vec2 id = floor(q / cell);',
      '  if (h21(id + seed) > dens) return vec4(0.0);',
      '  vec2 h = h22(id + seed + 5.0);',
      '  vec2 c = (id + 0.3 + 0.4 * h) * cell;',
      '  float sz = 0.4 + 0.45 * h.x;',
      '  vec2 p = (q - c) / sz;',
      '  p.y = -p.y;',
      '  if (abs(p.x) > 1.15 || abs(p.y) > 0.7) return vec4(0.0);',
      '  vec2 look = clamp((uLook.xy - (c - uCam.xy * f)) / 7.0, -1.0, 1.0);',
      '  vec4 e = eye(p, blink(h.y, 3.0 + 5.0 * h.x), vec2(look.x, -look.y), mix(irisA, irisB, step(0.5, h.y)), sclera, lid, px / sz * 1.5);',
      '  return e;',
      '}',
      '',
      // ---- D1 «Рассвет»
      'vec3 skyD1(vec2 s) {',
      '  vec3 c = skyGrad(s, mix(S1_TOP, S1_MID, 0.3), S1_MID, S1_LOW, 0.62);',
      '  c += S1_ACC * 0.16 * exp(-pow((s.y - 13.0 + uCam.z * 0.1) / 3.5, 2.0));',
      '  c = mix(c, S1_GLOW, 0.22 * exp(-length((s - moonPos()) * vec2(0.12, 0.2))));   // rosy bloom around the moon',
      '  float n = fbm3(vec2(s.x * 0.08 + uCam.x * 0.02 + uT * 0.05, s.y * 0.34 + uCam.z * 0.02));',
      '  float n2 = vn(vec2(s.x * 0.05 - uT * 0.02 + uCam.x * 0.015, s.y * 0.2 + 3.0));',
      '  vec3 hz = mix(S1_GLOW, S1_FR, smoothstep(0.35, 0.7, n2));',
      '  hz = mix(hz, S1_ACC, smoothstep(0.62, 0.85, n));',
      '  hz = mix(hz, mix(rainbow(n * 1.7 + s.x * 0.015 + uT * 0.02), vec3(1.0), 0.5), 0.3);   // pastel iridescence',
      '  c = mix(c, hz, 0.4 * smoothstep(0.4, 0.8, n));',
      '  // melting moon with oozing drips',
      '  vec2 d = s - moonPos();',
      '  float R = 2.4;',
      '  float dm = length(d) - R;',
      '  for (int i = 0; i < 4; i++) {',
      '    float fi = float(i);',
      '    float xo = -1.5 + fi * 0.98 + 0.15 * sin(fi * 2.3);',
      '    float len = 0.7 + 1.9 * fract(fi * 0.618 + 0.35) + 0.45 * sin(uT * 0.3 + fi * 1.7);',
      '    float y0 = sqrt(max(R * R - xo * xo, 0.0)) - 0.4;',
      '    vec2 pa = d - vec2(xo, y0);',
      '    float hh = clamp(pa.y / len, 0.0, 1.0);',
      '    dm = smin(dm, length(pa - vec2(0.0, hh * len)) - (0.3 - 0.1 * hh), 0.45);',
      '  }',
      '  c += S1_GLOW * 0.32 * exp(-max(dm, 0.0) * 0.45);',
      '  float moon = 1.0 - smoothstep(-px, px + 0.03, dm);',
      '  vec3 mc = mix(vec3(1.0, 0.95, 0.88), S1_ACC, 0.2 + 0.55 * smoothstep(0.0, 3.5, d.y));',
      '  mc *= 0.93 + 0.1 * vn(d * 1.4 + 4.0) - 0.1 * smoothstep(0.62, 0.9, vn(d * 0.9 + 9.0));',
      '  return mix(c, mc, moon);',
      '}',
      // ---- D2 «Тепло»
      'vec3 skyD2(vec2 s) {',
      '  vec3 c = skyGrad(s, S2_TOP, S2_MID, S2_LOW, 0.5);',
      '  vec2 d = s - moonPos();',
      '  float r = length(d);',
      '  float a = atan(d.y, d.x);',
      '  float lr = log(r + 0.3);',
      '  float sp = sin(a * 2.0 + lr * 4.5 - uT * 0.3);',
      '  float fade = smoothstep(2.6, 5.0, r);',
      '  c = mix(c, S2_GLOW, 0.22 * smoothstep(0.3, 1.0, sp) * fade);',
      '  c = mix(c, S2_TOP, 0.3 * smoothstep(0.3, 1.0, -sp) * fade * (1.0 - smoothstep(0.3, 0.85, s.y / VH)));',
      '  float fil = abs(fract((a * 2.0 + lr * 4.5 - uT * 0.3) / TAU + 0.5) - 0.5);',
      '  c += S2_FR * 0.3 * (1.0 - smoothstep(0.01, 0.03, fil)) * fade * exp(-r * 0.05);',
      '  float R = 2.7;',
      '  c += S2_ACC * 0.45 * exp(-max(r - R, 0.0) * 0.55);',
      '  float sun = 1.0 - smoothstep(R - px, R + px, r);',
      '  vec3 sc = mix(vec3(1.0, 0.93, 0.62), S2_ACC, smoothstep(0.3, R, r));',
      '  float rings = smoothstep(0.3, 0.7, fract(r * 1.3 - uT * 0.25)) * smoothstep(0.8, R, r);',
      '  sc = mix(sc, mix(S2_GLOW, S2_MID, 0.4), 0.45 * rings);',
      '  return mix(c, sc, sun);',
      '}',
      // ---- D3 «Неон»
      'vec3 skyD3(vec2 s) {',
      '  vec3 c = skyGrad(s, S3_TOP, S3_MID, S3_LOW, 0.72);',
      '  vec2 q = vec2(s.x + uCam.x * 0.08, s.y + uCam.z * 0.08) * 0.14;',
      '  float wa = 0.3 + 0.45 * uK.y;',
      '  q += wa * vec2(sin(q.y * 2.3 + uT * 0.5), sin(q.x * 1.9 - uT * 0.42));',
      '  q += wa * 0.6 * vec2(sin(q.y * 3.7 - uT * 0.33 + 1.3), sin(q.x * 3.1 + uT * 0.37 + 2.1));',
      '  float b = (q.x * 0.8 + q.y * 1.7) * 2.2;',
      '  float fb = abs(fract(b) - 0.5);',
      '  float idx = mod(floor(b), 3.0);',
      '  vec3 lc = idx < 0.5 ? S3_FR : (idx < 1.5 ? S3_ACC : S3_EDGE);',
      '  float line = 1.0 - smoothstep(0.02, 0.06, fb);',
      '  float glow = exp(-fb * fb / 0.015);',
      '  float fade = 0.3 + 0.7 * (1.0 - smoothstep(0.25, 0.95, s.y / VH));',
      '  c += lc * (line * 0.4 + glow * 0.15) * fade;',
      '  vec2 m = moonPos();',
      '  vec2 d = s - m;',
      '  float ES = 2.7;',
      '  c += S3_ACC * 0.22 * exp(-max(length(d * vec2(0.55, 1.1)) - ES * 0.55, 0.0) * 0.6);',
      '  vec2 look = clamp((uLook.xy - m) / 10.0, -1.0, 1.0);',
      '  vec4 e = eye(vec2(d.x, -d.y) / ES, blink(0.37, 6.5), vec2(look.x, -look.y), S3_FR, vec3(0.93, 0.9, 1.0), S3_MID * 0.6, px / ES * 1.5);',
      '  c = mix(c, e.rgb, e.a);',
      '  vec4 f = eyeField(s, vec2(4.6, 3.4), 0.1, 3.0, 0.4, S3_FR, S3_ACC, vec3(0.86, 0.82, 0.96), S3_TOP);',
      '  float dark = 1.0 - smoothstep(0.2, 0.55, dot(c, vec3(0.3, 0.55, 0.15)));',
      '  return mix(c, f.rgb, f.a * dark);',
      '}',
      // ---- D4 «Пик»
      'vec3 skyD4(vec2 s) {',
      '  vec2 d = s - vec2(VW * 0.5 + uCam.w * 0.3, VH * 0.36);',
      '  d.y = -d.y;',
      '  float seg = TAU / 8.0;',
      '  float r0 = length(d) + 1e-3;',
      '  float a0 = atan(d.y, d.x) + uT * 0.05;',
      '  float af = abs(mod(a0, seg) - seg * 0.5);',
      '  vec2 pk = mix(vec2(cos(a0), sin(a0)), vec2(cos(af), sin(af)), uK.z) + vec2(1e-4, 0.0);  // fold blend, no seam',
      '  float a = atan(pk.y, pk.x);',
      '  float z = log(r0) - uT * 0.11;',
      '  float cs = seg * 0.5;',
      '  vec2 u = vec2(a, z) / cs;',
      '  vec2 id = floor(u);',
      '  vec2 f = fract(u) - 0.5;',
      '  float cpx = px / (r0 * cs);',
      '  float ring = mod(id.y, 2.0);',
      '  vec3 rc = rainbow(id.y * 0.17 + mod(id.x, 16.0) * 0.02 + 0.6);',
      '  vec3 c = mix(S4_TOP, S4_MID, smoothstep(1.0, 14.0, r0));',
      '  float web = 1.0 - smoothstep(0.0, 0.04 + cpx, 0.5 - max(abs(f.x), abs(f.y)));',
      '  c += rc * web * 0.22;',
      '  float sp = abs(fract(z * 1.6 + a * 1.27) - 0.5);',
      '  c += rainbow(z * 0.35 + 0.1) * (1.0 - smoothstep(0.0, 0.06 + cpx, sp)) * 0.18;',
      '  if (ring < 0.5) {',
      '    vec4 e = eye(f / 0.44, blink(h11(id.y * 3.1) , 7.0), vec2(0.0, -0.7), rc, mix(vec3(0.9), rc, 0.3) * 0.62, S4_TOP, cpx / 0.44 * 1.5);',
      '    c = mix(c, e.rgb, e.a);',
      '  } else {',
      '    float pr = length(f);',
      '    float pa = atan(f.y, f.x);',
      '    float v = abs(fract(pr * 7.0 - pa / TAU + uT * 0.2) - 0.5);',
      '    float curl = (1.0 - smoothstep(0.12, 0.12 + cpx * 7.0 + 0.06, v)) * (1.0 - smoothstep(0.32, 0.44, pr));',
      '    c = mix(c, rc * 0.78, curl);',
      '  }',
      '  float core = smoothstep(1.2, 2.7, r0);',
      '  c = mix(S4_MID * 0.5 + S4_GLOW * 0.25 * (1.0 - r0 / 2.7), c, core);',
      '  // the third eye at the heart of the mandala, watching the wizard',
      '  vec2 lk = clamp((uLook.xy - vec2(VW * 0.5 + uCam.w * 0.3, VH * 0.36)) / 6.0, -1.0, 1.0);',
      '  vec4 te = eye(d / 2.3, blink(0.71, 9.0), vec2(lk.x, -lk.y), rainbow(uT * 0.04 + 0.1), vec3(0.88, 0.85, 0.95), S4_TOP, px / 2.3 * 1.5);',
      '  return mix(c, te.rgb, te.a);',
      '}',
      '',
      // ---- forest styling (drunk)
      'vec3 silD(vec3 col, vec2 s, vec4 L, float hid, float k) {',
      '  float d = L.x;',
      '  if (d > 0.9) return col;',
      '  float soft = (0.3 - 0.08 * k) * (0.55 + 0.9 * uW.x) + px;',
      '  float a = 1.0 - smoothstep(-soft, soft, d);',
      '  float cap = L.y;',
      '  vec2 q = L.zw;',
      '  vec3 rimC = mix(mix(uPal[5], uPal[3], step(0.55, hid)), rainbow(hid + s.y * 0.03 + s.x * 0.01), uW.w);',
      '  vec3 body = mix(uPal[1], uPal[7], 0.3 + 0.25 * k);',
      '  body = mix(body, uPal[4] * 0.85, cap * uShape3.x * (0.6 + 0.4 * smoothstep(-0.2, 0.8, q.y)));',
      '  body *= 1.0 - uShape3.y * (0.62 + 0.15 * k);',
      '  if (cap > 0.5) {',
      '    if (q.y < 0.0) {',
      '      float g = q.x / (1.0 + 0.85 * q.y / uShape2.x);',
      '      float gl = abs(fract(g * 4.5 + 0.5) - 0.5);',
      '      float gline = 1.0 - smoothstep(0.06, 0.2, gl);',
      '      vec3 gc = mix(uPal[5], uPal[3], step(0.5, fract(g * 2.25 + 0.25)));',
      '      body = body * (1.0 - 0.25 * uShape2.y) + gc * gline * uShape2.y * 0.55;',
      '    } else {',
      '      vec2 sp = q * vec2(3.0, 3.6) + hid * 17.0;',
      '      vec2 sh = h22(floor(sp) + 3.0);',
      '      float spot = 1.0 - smoothstep(0.18 + 0.1 * sh.x, 0.3 + 0.1 * sh.x, length(fract(sp) - 0.5 - (sh - 0.5) * 0.3));',
      '      spot *= step(0.4, sh.y) * smoothstep(0.1, 0.3, q.y) * (1.0 - smoothstep(0.75, 0.92, length(q)));',
      '      vec3 sc = mix(mix(uPal[3], vec3(1.0), 0.35), uPal[4], smoothstep(0.1, 0.5, uShape2.z));',
      '      body = mix(body, sc, spot * (0.35 + 0.3 * uShape2.z)) + uPal[4] * spot * uShape2.z * 0.35;',
      '      if (uShape3.w > 0.01) {',
      '        vec2 ep = vec2(q.x, (q.y - 0.42) * uShape.y) / 0.42;',
      '        vec3 iris = mix(uPal[5], rainbow(hid * 3.0 + 0.2), uW.w);',
      '        vec4 e = eye(ep, blink(hid, 4.0 + 3.0 * hid), vec2(sin(uT * 0.4 + hid * 9.0), 0.0) * 0.7, iris, vec3(0.9, 0.88, 0.95), body * 0.6, px * 1.6 / 0.42);',
      '        body = mix(body, e.rgb, e.a * uShape3.w);',
      '      }',
      '    }',
      '  }',
      '  body = mix(body, col, uShape3.z * (1.0 - 0.35 * k));',
      '  col = mix(col, body, a);',
      '  float rw = 0.05 + 0.04 * k;',
      '  float rim = exp(-(d + rw * 0.5) * (d + rw * 0.5) / (rw * rw));',
      '  return col + rimC * rim * uShape2.w * (0.3 + 0.12 * k);',
      '}',
      '',
      'vec3 drunkScene(vec2 s, vec4 L0, vec4 L1, vec4 L2, float h0, float h1, float h2) {',
      '  vec3 col = vec3(0.0);',
      '  if (uW.x > 0.002) col += uW.x * skyD1(s);',
      '  if (uW.y > 0.002) col += uW.y * skyD2(s);',
      '  if (uW.z > 0.002) col += uW.z * skyD3(s);',
      '  if (uW.w > 0.002) col += uW.w * skyD4(s);',
      '  // low haze between the layers: pastel at D1, warm at D2, a neon mist at D3',
      '  float hn = vn(vec2(s.x * 0.12 + uCam.x * 0.05 + uT * 0.06, s.y * 0.5 + uCam.z * 0.05));',
      '  float gy = clamp((s.y + uCam.z * 0.2) / VH, 0.0, 1.0);',
      '  vec3 hzC = mix(uPal[4], uPal[2], 0.5);',
      '  float hz = dot(uW, vec4(0.32, 0.28, 0.22, 0.0)) * smoothstep(0.35, 0.95, gy) * (0.55 + 0.45 * hn);',
      '  col = silD(col, s, L0, h0, 0.0);',
      '  col = mix(col, hzC, hz * 0.8);',
      '  col = silD(col, s, L1, h1, 1.0);',
      '  col = mix(col, hzC, hz * 0.55);',
      '  col = silD(col, s, L2, h2, 2.0);',
      '  // drifting spores',
      '  float sr = dot(uW, vec4(0.13, 0.1, 0.06, 0.06));',
      '  float ss = dot(uW, vec4(0.1, 0.05, 0.02, 0.02)) + px;',
      '  for (int i = 0; i < 2; i++) {',
      '    float fi = float(i);',
      '    float cell = 2.6 + fi * 1.1;',
      '    vec2 qq = s + vec2(uCam.x, uCam.y) * (0.2 + 0.3 * fi) + vec2(0.0, uT * (0.35 + 0.25 * fi));',
      '    vec2 sid = floor(qq / cell);',
      '    vec2 sh = h22(sid + 3.0 + fi * 16.0);',
      '    vec2 pos = (sid + 0.2 + 0.6 * sh) * cell;',
      '    pos.x += sin(uT * 0.7 + sh.y * TAU) * 0.15 * cell;',
      '    float rr = sr * (0.7 + 0.6 * sh.x) * (1.0 + 0.4 * fi);',
      '    float spr = (1.0 - smoothstep(rr - ss, rr + ss, length(qq - pos))) * step(0.62, h21(sid + 7.0 + fi * 9.0));',
      '    vec3 spc = mix(uPal[4], mix(uPal[5], uPal[3], uW.x), step(0.5, sh.x));',
      '    spc = mix(spc, rainbow(sh.y + uT * 0.1), uW.w);',
      '    col = mix(col, spc, spr * (0.5 + 0.2 * sin(uT * 1.1 + sh.x * TAU)));',
      '  }',
      '  if (uW.w > 0.002) {',
      '    float lum = dot(col, vec3(0.299, 0.587, 0.114));',
      '    col = mix(col, hueRot(col, uK.w * TAU), uW.w * smoothstep(0.06, 0.25, lum));',
      '  }',
      '  // readability: the background dims a little right behind the wizard at the busy stages',
      '  vec2 dl = (s - uLook.xy) * vec2(1.0, 0.75);',
      '  col *= 1.0 - dot(uW, vec4(0.0, 0.14, 0.32, 0.45)) * exp(-dot(dl, dl) / 9.0);',
      '  return col;',
      '}',
      '',
      // ---- Clarity «Чернила»
      'vec3 silInk(vec3 col, vec2 s, vec4 L, float k) {',
      '  float d = L.x + 0.018 * sin(s.x * 5.3 + s.y * 3.1) + 0.012 * sin(s.y * 11.0 - s.x * 2.3);',
      '  if (d > 0.3) return col;',
      '  float aa = px * 0.9;',
      '  float a = 1.0 - smoothstep(-aa, aa, d);',
      '  vec3 fill = mix(PAPER, PAPER_SH, 0.12 + 0.12 * k);',
      '  float under = L.y * step(L.w, 0.0);',
      '  float ground = step(8.0, L.z);',
      '  float stem = (1.0 - L.y) * (1.0 - ground);',
      '  float rimShade = 1.0 - smoothstep(0.0, 0.3, -d);   // contour shading just inside the outline',
      '  float tone = mix(0.1 + 0.07 * k, 0.24 + 0.08 * k + 0.16 * rimShade, stem);',
      '  tone = mix(tone, 0.44, under);',
      '  tone = mix(tone, 0.0, ground);',
      '  float fq = 3.4;',
      '  float hl = hatchL((s.x + s.y) * fq, tone, px * fq * 1.1);',
      '  hl = max(hl, hatchL((s.x - s.y) * fq + 0.5, (tone - 0.3) * 1.6, px * fq * 1.1));',
      '  if (under > 0.5) {',
      '    float g = L.z / (1.0 + 0.85 * L.w / uShape2.x);',
      '    hl = max(hl, (1.0 - smoothstep(0.04, 0.12, abs(fract(g * 4.5 + 0.5) - 0.5))) * 0.8);',
      '  }',
      '  vec3 c = mix(fill, INK_SOFT, hl * (0.55 + 0.12 * k));',
      '  col = mix(col, c, a);',
      '  float lw = 0.03 + 0.014 * k;',
      '  float edge = 1.0 - smoothstep(lw - aa, lw + aa, abs(d + lw));',
      '  return mix(col, INK, edge * (0.5 + 0.15 * k));',
      '}',
      '',
      'vec3 inkScene(vec2 s, vec4 L0, vec4 L1, vec4 L2) {',
      '  float gy = clamp((s.y + uCam.z * 0.12) / VH, 0.0, 1.0);',
      '  float fib = vn(vec2(s.x * 2.2, s.y * 9.0)) * 0.6 + vn(s * 4.3 + 3.0) * 0.4;',
      '  vec3 col = mix(PAPER, PAPER_SH, 0.22 * fib + 0.12 * vn(s * 0.3 + 7.0));',
      '  // engraved sky: wavy horizontal lines, heavier toward the top',
      '  float yl = s.y * 2.2 + 0.22 * sin(s.x * 0.41 + 1.3) + 0.08 * sin(s.x * 1.7);',
      '  float skyTone = 0.3 * (1.0 - smoothstep(0.0, 0.5, gy)) * smoothstep(0.15, 0.55, vn(vec2(s.x * 0.18, floor(yl) * 0.7)));',
      '  col = mix(col, INK_SOFT, hatchL(yl, skyTone, px * 2.2 * 1.1) * 0.34);',
      '  // the moon: outline, a hatched shadow crescent and a few craters',
      '  vec2 d = s - moonPos();',
      '  float R = 2.4;',
      '  float dm = length(d) - R;',
      '  float inMoon = 1.0 - smoothstep(-px, px, dm);',
      '  col = mix(col, PAPER, inMoon * 0.9);',
      '  float shadow = smoothstep(-0.3, 0.6, length(d - vec2(-0.9, -0.6)) - R) * inMoon;',
      '  col = mix(col, INK_SOFT, hatchL((s.x - s.y) * 4.0, 0.5 * shadow, px * 4.4) * 0.6);',
      '  float cr = min(abs(length(d - vec2(0.7, 0.3)) - 0.45), abs(length(d - vec2(-0.4, 1.1)) - 0.3));',
      '  col = mix(col, INK_SOFT, (1.0 - smoothstep(0.02, 0.02 + px, cr)) * inMoon * 0.55);',
      '  col = mix(col, INK, (1.0 - smoothstep(0.035 - px, 0.035 + px, abs(dm))) * 0.6);',
      '  col = silInk(col, s, L0, 0.0);',
      '  col = silInk(col, s, L1, 1.0);',
      '  col = silInk(col, s, L2, 2.0);',
      '  // stippled ground at the bottom',
      '  vec2 st = s + uCam.xy * vec2(0.4, 0.2);',
      '  vec2 sid = floor(st * 3.0);',
      '  float dot1 = 1.0 - smoothstep(0.08, 0.08 + px * 3.0, length(fract(st * 3.0) - 0.5 - (h22(sid) - 0.5) * 0.5));',
      '  col = mix(col, INK_SOFT, dot1 * step(h21(sid + 4.0), smoothstep(0.7, 1.0, gy) * 0.5) * 0.6);',
      '  return col;',
      '}',
      '',
      'void main() {',
      '  px = VW / uRes.x;',
      '  vec2 uv = gl_FragCoord.xy / uRes;',
      '  vec2 s = vec2(uv.x * VW, (1.0 - uv.y) * VH);   // screen tiles, y down',
      '  float h0; float h1; float h2;',
      layerCalls,
      '  // Clarity spreads out from the wizard; in its last second colour bleeds back in at the edges.',
      '  float C = uK.x;',
      '  if (C > 0.0 && (C < 1.0 || uSpread.z > 0.0)) {',
      '    float dS = length(s - uSpread.xy) / 34.0;',
      '    C = smoothstep(dS, dS + 0.35, C * 1.35);',
      '    float dV = length((uv - 0.5) * vec2(1.0, VH / VW)) * 1.743;',
      '    C *= 1.0 - uSpread.z * 0.5 * smoothstep(0.4, 1.0, dV + 0.08 * sin(s.x * 1.3 + s.y * 0.7));',
      '  }',
      '  vec3 col = vec3(0.0);',
      '  if (C < 0.999) col = drunkScene(s, L0, L1, L2, h0, h1, h2);',
      '  if (C > 0.001) col = mix(col, inkScene(s, L0, L1, L2), C);',
      '  gl_FragColor = vec4(col, 1.0);',
      '}',
    ].join('\n');
  }

  function postSrc() {
    return [
      GL_HEAD,
      'uniform sampler2D uTex;',
      'uniform vec2 uRes;',
      'uniform vec4 uRip;      // chromatic ripple: centre (uv), age (s), strength',
      'uniform vec4 uRipCol;   // ripple tint (rgb), displacement gain',
      'uniform vec4 uBloom;    // kaleidoscope bloom: envelope, rotation, zoom, brightness',
      'uniform vec4 uFlash;    // Clarity flash wave: origin (uv), age (s), strength',
      'uniform vec4 uRing;     // soft ring: origin (uv), age (s), strength',
      'uniform vec3 uRingCol;',
      'uniform vec4 uPost;     // fringe, grain amount, grain seed, Clarity (eased)',
      'uniform vec4 uGrade;    // dim, vignette, hazard guard, unused',
      constBlock(),
      'const vec2 ASP = vec2(VW / VH, 1.0);',
      'void main() {',
      '  vec2 uv = gl_FragCoord.xy / uRes;',
      '  vec2 suv = uv;',
      '  if (uBloom.x > 0.001) {',
      '    vec2 d = (uv - 0.5) * ASP;',
      '    float r = length(d);',
      '    float a = atan(d.y, d.x) + uBloom.y;',
      '    float seg = TAU / 8.0;',
      '    a = abs(mod(a, seg) - seg * 0.5);',
      '    vec2 k = vec2(cos(a), sin(a)) * r * uBloom.z;',
      '    suv = mix(uv, k / ASP + 0.5, uBloom.x);',
      '  }',
      '  vec2 off = vec2(0.0);',
      '  float wave = 0.0;',
      '  if (uRip.w > 0.001) {',
      '    vec2 d = (suv - uRip.xy) * ASP;',
      '    float dist = length(d);',
      '    float x = (dist - uRip.z * 2.4) / (0.05 + uRip.z * 0.24);',
      '    wave = exp(-x * x) * uRip.w;',
      '    off = d / max(dist, 1e-3) / ASP * wave * 0.03 * uRipCol.w;',
      '  }',
      '  vec2 rc = suv - 0.5;',
      '  vec2 fr = rc * dot(rc * ASP, rc * ASP) * uPost.x + off * 0.9;',
      '  vec3 col;',
      '  col.r = texture2D(uTex, suv + off + fr).r;',
      '  col.g = texture2D(uTex, suv + off).g;',
      '  col.b = texture2D(uTex, suv + off - fr).b;',
      '  col += uRipCol.rgb * wave * 0.32;',
      '  col *= 1.0 + uBloom.w;',
      '  // hazard guard: background colours near the hazard red-orange lose most of their saturation',
      '  float mx = max(col.r, max(col.g, col.b));',
      '  float chr = mx - min(col.r, min(col.g, col.b));',
      '  if (uGrade.z > 0.0 && col.r >= mx && chr > 0.02) {',
      '    float hh = (col.g - col.b) / chr;',
      '    float z = (1.0 - smoothstep(0.1, 0.17, abs(hh - 0.225))) * smoothstep(0.2, 0.5, chr / max(mx, 1e-3));',
      '    col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))), z * uGrade.z);',
      '  }',
      '  if (uRing.w > 0.0) {',
      '    float x = (length((uv - uRing.xy) * ASP) - uRing.z * 1.3) / (0.02 + uRing.z * 0.12);',
      '    float life = clamp(1.0 - uRing.z / ' + glf(RING_LIFE) + ', 0.0, 1.0);',
      '    col += uRingCol * exp(-x * x) * life * life * uRing.w * 0.3;',
      '  }',
      '  if (uFlash.w > 0.0) {',
      '    float x = (length((uv - uFlash.xy) * ASP) - uFlash.z * 3.2) / (0.025 + uFlash.z * 0.28);',
      '    float life = clamp(1.0 - uFlash.z / ' + glf(FLASH_LIFE) + ', 0.0, 1.0);',
      '    col = mix(col, CYAN, exp(-x * x) * life * 0.6 * uFlash.w);',
      '    col += vec3(0.85, 1.0, 1.0) * exp(-uFlash.z * 14.0) * 0.14 * uFlash.w;',
      '  }',
      '  vec2 vd = (uv - 0.5) * vec2(1.0, VH / VW) * 1.743;',
      '  float v2 = dot(vd, vd);',
      '  vec3 vDrunk = col * (1.0 - uGrade.y * v2);',
      '  vec3 vInk = col * mix(vec3(1.0), PAPER_DEEP / PAPER * 0.92, smoothstep(0.25, 1.05, v2));',
      '  col = mix(vDrunk, vInk, uPost.w);',
      '  col += (h21(gl_FragCoord.xy + vec2(uPost.z * 17.0, uPost.z * 31.0)) - 0.5) * uPost.y;',
      '  float l2 = dot(col, vec3(0.299, 0.587, 0.114));',
      '  col = mix(col, vec3(l2), uGrade.x * 0.5) * (1.0 - 0.5 * uGrade.x);',
      '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
      '}',
    ].join('\n');
  }

  var SCENE_U = ['uRes', 'uT', 'uCam', 'uW', 'uK', 'uSpread', 'uLook', 'uShape', 'uShape2', 'uShape3', 'uPal'];
  var POST_U = ['uTex', 'uRes', 'uRip', 'uRipCol', 'uBloom', 'uFlash', 'uRing', 'uRingCol', 'uPost', 'uGrade'];
  var CSS_FALLBACK = 'linear-gradient(#2b2340, #5a4870 60%, #c99aa6)';

  // ---------------------------------------------------------------- BgFx

  MW.BgFx = function (canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.ctx = null;
    this.backend = 'none';     // 'gl' | '2d' | 'none'
    this.lost = false;
    this.world = null;
    this.pals = [null, stagePal(1), stagePal(2), stagePal(3), stagePal(4)];
    this.ink = inkPal();
    this.palArr = new Float32Array(PAL_KEYS.length * 3);
    try {
      canvas.width = Math.round(BASE_W * RES_SCALE);
      canvas.height = Math.round(BASE_H * RES_SCALE);
    } catch (e) { /* keep whatever size it has */ }
    if (!this._initGL()) this._init2D();
    this.reset();
  };

  MW.BgFx.prototype.reset = function () {
    this.t = 0;                // motion clock (fx-scaled; frozen at fx = 0 and in Clarity)
    this.hue = 0;              // D4 hue cycle phase (turns)
    this.clock = 0;            // real time (grain, title cycle)
    this.snap = true;          // next render snaps smoothed values to the state (no transitions)
    this.clar = 0;             // Clarity blend 0..1 (linear; eased for use)
    this.prevClarity = false;
    this.stageTarget = 1;
    this.W = [1, 0, 0, 0];
    this.morphFrom = [1, 0, 0, 0];
    this.morphTo = [1, 0, 0, 0];
    this.morphP = 1;
    this.fxS = 0.5;
    this.dim = 0;
    this.deathHold = 0;
    this.warn = 0;
    this.camX = 0;
    this.camY = 0;
    this.haveCam = false;
    this.camYRef = null;
    this.look = [VW / 2, VH / 2];
    this.origin = [VW / 2, VH / 2];
    this.rip = { age: 99, str: 0, col: [1, 1, 1] };
    this.bloom = { age: 99, str: 0 };
    this.flash = { age: 99, str: 0 };
    this.ring = { x: VW / 2, y: VH / 2, age: 99, str: 0, col: [1, 1, 1] };
    this.u = {};
    this.pal = this.pals[1];
    this.world = null;
  };

  // Screen position (tiles) of a world event at the player box; falls back to the screen centre.
  MW.BgFx.prototype._screenPos = function (e) {
    if (e && typeof e.x === 'number' && typeof e.y === 'number' && this.haveCam) {
      var sx = e.x + (MW.PLAYER_W || 0.7) / 2 - this.camX;
      var sy = e.y + (MW.PLAYER_H || 1.4) / 2 - this.camY;
      if (sx > -2 && sx < VW + 2 && sy > -2 && sy < VH + 2) return [sx, sy];
    }
    return [this.look[0], this.look[1]];
  };

  MW.BgFx.prototype._startRipple = function (stage, str) {
    var r = this.rip;
    if (r.age < 0.12 && r.str > str) return;   // a weaker event never cuts off a fresh stronger one
    r.age = 0; r.str = str; r.col = this.pals[stage].glow;
  };

  MW.BgFx.prototype._startRing = function (e, col, str) {
    var p = this._screenPos(e), r = this.ring;
    if (r.age < 0.25 && r.str > str) return;
    r.x = p[0]; r.y = p[1]; r.age = 0; r.str = str; r.col = col;
  };

  MW.BgFx.prototype.handle = function (e, world) {
    if (world && world.player) this.world = world;
    if (!e || !e.type) return;
    var s;
    switch (e.type) {
      case 'focusOn':
        this.origin = this._screenPos(e);
        this.flash.age = 0; this.flash.str = 1;
        break;
      case 'stageUp':
      case 'stageDown':
        s = Math.max(1, Math.min(4, num(e.stage, this.stageTarget)));
        this._startRipple(s, e.type === 'stageUp' ? 1 : 0.7);
        if (e.type === 'stageUp' && s === 4 && this.stageTarget < 4) { this.bloom.age = 0; this.bloom.str = 1; }
        break;
      case 'death': this.deathHold = 0.22; break;
      case 'cast': this._startRing(e, this.ink.cyan, 0.6); break;
      case 'hiccup': this._startRing(e, this.pal.glow, 0.3); break;
      case 'pickup': this._startRing(e, e.kind === 'crystal' ? this.ink.cyan : this.pal.glow, 0.45); break;
      case 'checkpoint': this._startRing(e, [1.0, 0.85, 0.45], 0.3); break;
      case 'finish': this.bloom.age = 0; this.bloom.str = 0.8; break;
    }
  };

  // Per-frame smoothing and the values shared by both backends (this.u, this.W, this.pal).
  MW.BgFx.prototype._update = function (st, dt) {
    var mode = st.mode || 'play';
    var stage = Math.max(1, Math.min(4, Math.round(num(st.stage, 1))));
    var clarity = !!st.clarity;
    var fx = clamp01(num(st.fx, 0.5));
    this.clock += dt;
    if (mode === 'title') {
      // Attract screen: tour the four worlds.
      stage = 1 + Math.floor(this.clock / TITLE_STAGE_T) % 4;
      clarity = false;
    }
    if (typeof st.camX === 'number' && typeof st.camY === 'number' && isFinite(st.camX) && isFinite(st.camY)) {
      this.camX = st.camX; this.camY = st.camY; this.haveCam = true;
      if (this.camYRef === null) this.camYRef = st.camY;
    }
    // Where the wizard is on screen (eyes look at him, the Clarity wave starts there).
    var px = num(st.px, NaN), py = num(st.py, NaN);
    if (!isFinite(px) || !isFinite(py)) {
      var w = (MW.Game && MW.Game.world) || this.world, p = w && w.player;
      if (p) { px = p.x + p.w / 2; py = p.y + p.h / 2; }
    }
    if (isFinite(px) && isFinite(py) && this.haveCam) this.look = [px - this.camX, py - this.camY];

    if (this.snap) {
      this.snap = false;
      this.stageTarget = stage;
      this.W = [0, 0, 0, 0]; this.W[stage - 1] = 1;
      this.morphP = 1;
      this.fxS = fx;
      this.clar = clarity ? 1 : 0; this.prevClarity = clarity;
      this.dim = st.dead ? 1 : 0;
    }

    // Stage morph: from the current weights to the new stage in MORPH_T.
    if (stage !== this.stageTarget) {
      this.morphFrom = this.W.slice();
      this.morphTo = [0, 0, 0, 0]; this.morphTo[stage - 1] = 1;
      this.morphP = 0;
      this.stageTarget = stage;
    }
    if (this.morphP < 1) {
      this.morphP = Math.min(1, this.morphP + dt / MORPH_T);
      var k = ease(this.morphP);
      for (var i = 0; i < 4; i++) this.W[i] = this.morphFrom[i] + (this.morphTo[i] - this.morphFrom[i]) * k;
    }
    var W = this.W;

    // Clarity edge straight from the state too (debug toggles, respawn), not only from the event.
    if (clarity && !this.prevClarity && this.flash.age > 0.1) {
      this.origin = this.look.slice(); this.flash.age = 0; this.flash.str = 1;
    }
    this.prevClarity = clarity;
    this.clar = approach(this.clar, clarity ? 1 : 0, dt / (clarity ? CLAR_IN : CLAR_OUT));
    var eC = ease(this.clar);

    this.fxS = expo(this.fxS, fx, dt, 0.15);
    var fxK = this.fxS * 2;                // 0..2, 1 = the moderate default
    var g = Math.min(1, fxK);              // gain for event distortion

    this.deathHold = Math.max(0, this.deathHold - dt);
    var dimT = (st.dead || this.deathHold > 0) ? 1 : (mode === 'paused' ? 0.35 : 0);
    this.dim = expo(this.dim, dimT, dt, dimT > this.dim ? 0.05 : 0.25);
    var warnDur = Math.max(0.05, (MW.P && MW.P.clarityWarn) || 1);
    var warnT = clarity && typeof st.clarityT === 'number' ? clamp01(1 - st.clarityT / warnDur) : 0;
    this.warn = expo(this.warn, warnT, dt, 0.1);

    // Motion: scales with fx (still at 0), faster at higher stages, frozen in Clarity, slow when paused.
    var modeRate = mode === 'paused' ? 0.3 : mode === 'finished' ? 0.5 : 1;
    var speed = W[0] * SPEED[0] + W[1] * SPEED[1] + W[2] * SPEED[2] + W[3] * SPEED[3];
    var rate = fxK * speed * modeRate * (1 - eC);
    this.t += dt * rate;
    this.hue = fract(this.hue + dt * 0.1 * fxK * modeRate * (1 - eC));
    this.rip.age += dt;
    this.bloom.age += dt;
    this.flash.age += dt;
    this.ring.age += dt;

    // Blended palette and forest style.
    var pal = {};
    for (var pk = 0; pk < PAL_KEYS.length; pk++) {
      var key = PAL_KEYS[pk], c = [0, 0, 0];
      for (var si = 0; si < 4; si++) {
        if (W[si] <= 0) continue;
        var src = this.pals[si + 1][key];
        c[0] += src[0] * W[si]; c[1] += src[1] * W[si]; c[2] += src[2] * W[si];
      }
      pal[key] = c;
    }
    this.pal = pal;
    var sh = [0, 0, 0, 0], sh2 = [0, 0, 0, 0], sh3 = [0, 0, 0, 0];
    for (si = 0; si < 4; si++) {
      var S = STYLE[si + 1];
      for (var j = 0; j < 4; j++) { sh[j] += S.shape[j] * W[si]; sh2[j] += S.shape2[j] * W[si]; sh3[j] += S.shape3[j] * W[si]; }
    }
    sh[3] *= fxK * (1 - eC);               // sway follows fx and stops in Clarity

    // Vertical parallax is softly clamped, so silhouettes never leave the screen on tall levels.
    var dy = this.camYRef === null ? 0 : this.camY - this.camYRef;

    var u = this.u;
    u.W = W; u.eC = eC; u.fxK = fxK; u.g = g;
    u.kaleido = clamp01(fxK);
    u.camYOff = 10 * Math.tanh(dy / 10);
    u.drift = -3.5 * Math.sin(this.camX * 0.007);
    u.sh = sh; u.sh2 = sh2; u.sh3 = sh3;
    u.warn = this.warn;
    u.dim = this.dim;
    // Events: distortion and folding scale with fx; at fx = 0 only colour / brightness pulses remain.
    var ra = this.rip.age;
    u.ripStr = ra < RIP_LIFE ? this.rip.str * Math.pow(1 - ra / RIP_LIFE, 1.5) * (0.25 + 0.75 * g) : 0;
    u.ripGain = g;
    var ba = this.bloom.age;
    var benv = ba < BLOOM_LIFE ? smooth(0, 0.07, ba) * (1 - smooth(0.1, BLOOM_LIFE, ba)) * this.bloom.str : 0;
    u.bloomEnv = benv * 0.8 * g;           // no folding at fx = 0: only the brightness lift remains
    u.bloomRot = ba * 0.9 * g;
    u.bloomZoom = 1 - 0.18 * benv * g;
    u.bloomLift = 0.2 * benv;
    u.flashStr = this.flash.age < FLASH_LIFE ? this.flash.str : 0;
    u.ringStr = this.ring.age < RING_LIFE ? this.ring.str : 0;
    u.fringe = (W[2] * 0.55 + W[3] * 1.0) * (0.004 + 0.006 * g) * (1 - eC);
    u.grain = 0.045 * (1 - eC) + 0.03 * eC;
    // Film grain re-rolls at 24 fps (still at fx = 0 and in Clarity).
    u.grainSeed = (fxK > 0.02 && eC < 0.5) ? Math.floor(this.clock * 24) % 997 : 1;
    u.vignette = 0.42 + 0.12 * (W[2] + W[3]);
    u.guard = 0.55 * (1 - eC);
  };

  MW.BgFx.prototype.render = function (state) {
    var st = state || {};
    var dt = Math.max(0, Math.min(0.1, num(st.dt, 1 / 60)));
    this._update(st, dt);
    try {
      if (this.backend === 'gl') this._drawGL();
      else if (this.backend === '2d') this._draw2D();
    } catch (err) {
      // Never take the game loop down because of the background.
      if (!this._errLogged) { this._errLogged = true; console.error('BgFx:', err); }
    }
  };

  // ---------------------------------------------------------------- WebGL backend

  MW.BgFx.prototype._initGL = function () {
    var cv = this.canvas, gl = null;
    var opts = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false };
    try { gl = cv.getContext('webgl', opts) || cv.getContext('experimental-webgl', opts); } catch (e) { gl = null; }
    if (!gl) return false;
    this.gl = gl;
    this._bindContextEvents(cv);
    if (!this._buildGL()) { this._switchTo2D(); return true; } // _switchTo2D sets the backend
    this.backend = 'gl';
    return true;
  };

  MW.BgFx.prototype._compile = function (type, src) {
    var gl = this.gl, sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      if (!gl.isContextLost()) console.warn('BgFx: shader compile failed, using the 2D fallback.\n' + gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  };

  MW.BgFx.prototype._program = function (fragSrc, names) {
    var gl = this.gl;
    var vs = this._compile(gl.VERTEX_SHADER, VERT_SRC);
    var fs = vs && this._compile(gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) return null;
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      if (!gl.isContextLost()) console.warn('BgFx: program link failed, using the 2D fallback.\n' + gl.getProgramInfoLog(prog));
      return null;
    }
    var loc = {};
    names.forEach(function (n) { loc[n] = gl.getUniformLocation(prog, n); });
    return { prog: prog, loc: loc };
  };

  // (Re)creates every GL resource. Also used after a context restore.
  MW.BgFx.prototype._buildGL = function () {
    var gl = this.gl;
    if (!gl || gl.isContextLost()) return false;
    this.scene = this._program(sceneSrc(), SCENE_U);
    if (!this.scene) return false;
    this.post = this._program(postSrc(), POST_U);   // optional: without it the scene goes straight to the canvas
    // One triangle that covers the whole viewport.
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    this.fbo = null; this.tex = null; this.fboW = 0; this.fboH = 0;
    if (this.post) this._ensureTarget();
    return true;
  };

  // Offscreen scene texture for the post pass (same size as the canvas).
  MW.BgFx.prototype._ensureTarget = function () {
    var gl = this.gl, cv = this.canvas;
    if (this.fbo && this.fboW === cv.width && this.fboH === cv.height) return true;
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cv.width, cv.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) {
      gl.deleteFramebuffer(this.fbo); gl.deleteTexture(this.tex);
      this.fbo = null; this.tex = null; this.post = null;
      return false;
    }
    this.fboW = cv.width; this.fboH = cv.height;
    return true;
  };

  MW.BgFx.prototype._bindContextEvents = function (cv) {
    var self = this;
    if (!cv.addEventListener) return;
    cv.addEventListener('webglcontextlost', function (ev) {
      if (self.canvas !== cv) return;          // an old canvas retired by _switchTo2D
      ev.preventDefault();                     // allows the browser to restore it
      self.lost = true;
      self._cssFallback(true);                 // something calm to look at meanwhile
    }, false);
    cv.addEventListener('webglcontextrestored', function () {
      if (self.canvas !== cv) return;
      self.lost = false;
      if (self._buildGL()) self._cssFallback(false);
      else self._switchTo2D();
    }, false);
  };

  MW.BgFx.prototype._cssFallback = function (on) {
    try { if (this.canvas.style) this.canvas.style.background = on ? CSS_FALLBACK : ''; } catch (e) { /* ignore */ }
  };

  MW.BgFx.prototype._drawGL = function () {
    var gl = this.gl;
    if (!gl || this.lost || gl.isContextLost()) return;
    var u = this.u, cv = this.canvas, pal = this.pal, arr = this.palArr, W = u.W;
    for (var i = 0; i < PAL_KEYS.length; i++) {
      var c = pal[PAL_KEYS[i]];
      arr[i * 3] = c[0]; arr[i * 3 + 1] = c[1]; arr[i * 3 + 2] = c[2];
    }
    var usePost = !!(this.post && this._ensureTarget());
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Pass 1: the scene.
    var S = this.scene, L = S.loc;
    gl.bindFramebuffer(gl.FRAMEBUFFER, usePost ? this.fbo : null);
    gl.viewport(0, 0, cv.width, cv.height);
    gl.useProgram(S.prog);
    gl.uniform2f(L.uRes, cv.width, cv.height);
    gl.uniform1f(L.uT, this.t);
    gl.uniform4f(L.uCam, this.camX, this.camY, u.camYOff, u.drift);
    gl.uniform4f(L.uW, W[0], W[1], W[2], W[3]);
    gl.uniform4f(L.uK, u.eC, u.fxK, u.kaleido, this.hue);
    gl.uniform4f(L.uSpread, this.origin[0], this.origin[1], u.warn, 0);
    gl.uniform4f(L.uLook, this.look[0], this.look[1], 0, 0);
    gl.uniform4f(L.uShape, u.sh[0], u.sh[1], u.sh[2], u.sh[3]);
    gl.uniform4f(L.uShape2, u.sh2[0], u.sh2[1], u.sh2[2], u.sh2[3]);
    gl.uniform4f(L.uShape3, u.sh3[0], u.sh3[1], u.sh3[2], u.sh3[3]);
    gl.uniform3fv(L.uPal, arr);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!usePost) return;

    // Pass 2: ripple, bloom, fringing, flash, grade, grain.
    var P = this.post, Q = P.loc;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cv.width, cv.height);
    gl.useProgram(P.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(Q.uTex, 0);
    gl.uniform2f(Q.uRes, cv.width, cv.height);
    gl.uniform4f(Q.uRip, 0.5, 0.5, this.rip.age, u.ripStr);
    var rc = this.rip.col;
    gl.uniform4f(Q.uRipCol, rc[0], rc[1], rc[2], u.ripGain);
    gl.uniform4f(Q.uBloom, u.bloomEnv, u.bloomRot, u.bloomZoom, u.bloomLift);
    gl.uniform4f(Q.uFlash, this.origin[0] / VW, 1 - this.origin[1] / VH, this.flash.age, u.flashStr);
    var r = this.ring;
    gl.uniform4f(Q.uRing, r.x / VW, 1 - r.y / VH, r.age, u.ringStr);
    gl.uniform3f(Q.uRingCol, r.col[0], r.col[1], r.col[2]);
    gl.uniform4f(Q.uPost, u.fringe, u.grain, u.grainSeed, u.eC);
    gl.uniform4f(Q.uGrade, u.dim, u.vignette, u.guard, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  // ---------------------------------------------------------------- Canvas2D fallback

  MW.BgFx.prototype._init2D = function () {
    var ctx = null;
    try { ctx = this.canvas.getContext('2d', { alpha: false }) || this.canvas.getContext('2d'); } catch (e) { ctx = null; }
    this.ctx = ctx;
    this.backend = ctx ? '2d' : 'none';
    this.hatchPat = null;
    if (!ctx) this._cssFallback(true);
  };

  // A canvas that already holds a WebGL context cannot hand out a 2D one: swap in a fresh clone.
  MW.BgFx.prototype._switchTo2D = function () {
    var old = this.canvas, gl = this.gl;
    this.gl = null;
    this.backend = 'none';
    if (gl) {
      if (!old.parentNode || !old.cloneNode) { this._cssFallback(true); return; }
      var fresh = old.cloneNode(false);
      fresh.width = old.width;
      fresh.height = old.height;
      this.canvas = fresh;
      old.parentNode.replaceChild(fresh, old);
      try { var ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch (e) { /* ignore */ }
    }
    this._init2D();
  };

  // Diagonal hatch pattern for the Clarity etching (made once).
  MW.BgFx.prototype._hatch = function (ctx) {
    if (this.hatchPat !== null) return this.hatchPat;
    this.hatchPat = false;
    try {
      var c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      var x = c.getContext('2d');
      x.strokeStyle = rgba(this.ink.soft, 0.55);
      x.lineWidth = 1;
      x.beginPath();
      x.moveTo(-2, 10); x.lineTo(10, -2);
      x.moveTo(-2, 2); x.lineTo(2, -2);
      x.moveTo(6, 10); x.lineTo(10, 6);
      x.stroke();
      var pat = ctx.createPattern(c, 'repeat') || false;
      // The context draws in tiles: map pattern pixels back to device pixels.
      var cv = this.canvas;
      if (pat && pat.setTransform && typeof DOMMatrix === 'function') pat.setTransform(new DOMMatrix([VW / cv.width, 0, 0, VH / cv.height, 0, 0]));
      this.hatchPat = pat;
    } catch (e) { this.hatchPat = false; }
    return this.hatchPat;
  };

  MW.BgFx.prototype._draw2D = function () {
    var ctx = this.ctx, u = this.u, cv = this.canvas, e = u.eC;
    var sx = cv.width / VW, sy = cv.height / VH;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);       // draw in screen tiles
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    if (e < 0.999) this._drunk2D(ctx);
    if (e > 0.001) {
      ctx.globalAlpha = e;
      this._ink2D(ctx);
      ctx.globalAlpha = 1;
    }
    this._overlays2D(ctx);
  };

  MW.BgFx.prototype._drunk2D = function (ctx) {
    var u = this.u, W = u.W, P = this.pal, t = this.t;
    var mx = 21.8 + u.drift, my = 4.3 - Math.max(-1.5, Math.min(1.5, u.camYOff * 0.05));
    // Sky gradient (blended palette)
    var gy0 = -u.camYOff * 0.12;
    var g = ctx.createLinearGradient(0, gy0, 0, gy0 + VH);
    g.addColorStop(0, rgb(P.skyTop));
    g.addColorStop(0.55, rgb(P.skyMid));
    g.addColorStop(1, rgb(P.skyLow));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);

    var i, a;
    // D1: pastel haze bands and the melting moon
    if (W[0] > 0.01) {
      var p1 = this.pals[1];
      ctx.globalAlpha = W[0];
      for (i = 0; i < 4; i++) {
        var hy = 3 + i * 2.6 + Math.sin(t * 0.1 + i) * 0.4;
        var hg = ctx.createLinearGradient(0, hy - 1.2, 0, hy + 1.2);
        var hc = i % 2 ? p1.fringe : p1.glow;
        hg.addColorStop(0, rgba(hc, 0)); hg.addColorStop(0.5, rgba(hc, 0.16)); hg.addColorStop(1, rgba(hc, 0));
        ctx.fillStyle = hg;
        ctx.fillRect(0, hy - 1.2, VW, 2.4);
      }
      this._glow2D(ctx, mx, my, 6, p1.glow, 0.35);
      ctx.fillStyle = rgb(mix3([1, 0.95, 0.88], p1.accent, 0.35));
      ctx.beginPath();
      ctx.arc(mx, my, 2.4, 0, TAU);
      ctx.fill();
      for (i = 0; i < 4; i++) {
        var xo = -1.5 + i * 0.98, len = 0.7 + 1.9 * fract(i * 0.618 + 0.35) + 0.45 * Math.sin(t * 0.3 + i * 1.7);
        var y0 = Math.sqrt(Math.max(0, 2.4 * 2.4 - xo * xo)) - 0.4;
        ctx.beginPath();
        ctx.moveTo(mx + xo - 0.3, my + y0);
        ctx.lineTo(mx + xo - 0.2, my + y0 + len);
        ctx.arc(mx + xo, my + y0 + len, 0.2, Math.PI, 0, true);
        ctx.lineTo(mx + xo + 0.3, my + y0);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // D2: ringed sun and slow spiral arms
    if (W[1] > 0.01) {
      var p2 = this.pals[2];
      ctx.globalAlpha = W[1];
      ctx.lineWidth = 0.5;
      for (i = 0; i < 2; i++) {
        ctx.strokeStyle = rgba(i ? p2.fringe : p2.glow, i ? 0.2 : 0.3);
        ctx.beginPath();
        for (a = 0; a < 14; a += 0.15) {
          var rr = 3 * Math.exp(a * 0.22), aa = a + i * Math.PI + t * 0.07;
          var qx = mx + Math.cos(aa) * rr, qy = my + Math.sin(aa) * rr;
          if (a === 0) ctx.moveTo(qx, qy); else ctx.lineTo(qx, qy);
        }
        ctx.stroke();
      }
      this._glow2D(ctx, mx, my, 7, p2.accent, 0.45);
      for (i = 5; i >= 0; i--) {
        ctx.fillStyle = rgb(i % 2 ? p2.glow : mix3([1, 0.93, 0.62], p2.accent, i / 5));
        ctx.beginPath();
        ctx.arc(mx, my, 2.7 * (i + 1) / 6, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // D3: neon bands, the giant eye and eyes in the dark
    if (W[2] > 0.01) {
      var p3 = this.pals[3], cols = [p3.fringe, p3.accent, p3.groundEdge];
      ctx.globalAlpha = W[2];
      ctx.lineWidth = 0.09;
      for (i = 0; i < 7; i++) {
        ctx.strokeStyle = rgba(cols[i % 3], 0.7);
        ctx.beginPath();
        for (var bx = -1; bx <= VW + 1; bx += 0.75) {
          var by = i * 2.4 - 2 + bx * 0.35 + Math.sin(bx * 0.25 + i + t * 0.4) * 1.2 - (this.camX * 0.04) % 2.4;
          if (bx === -1) ctx.moveTo(bx, by); else ctx.lineTo(bx, by);
        }
        ctx.stroke();
      }
      this._eye2D(ctx, mx, my, 2.7, p3.fringe, p3.skyMid, 1);
      for (i = 0; i < 9; i++) {
        var ex = fract(hash11(i * 7.1 + 1) - this.camX * 0.003) * VW, ey = 1 + hash11(i * 3.3 + 2) * 7;
        if (Math.abs(ex - mx) < 4 && Math.abs(ey - my) < 3) continue;
        this._eye2D(ctx, ex, ey, 0.5 + 0.4 * hash11(i * 1.9), i % 2 ? p3.fringe : p3.accent, p3.skyTop, 1);
      }
      ctx.globalAlpha = 1;
    }
    // D4: rainbow mandala wedges and a ring of eyes
    if (W[3] > 0.01) {
      var p4 = this.pals[4], cx = VW * 0.5 + u.drift * 0.3, cy = VH * 0.36;
      ctx.globalAlpha = W[3];
      ctx.fillStyle = rgb(p4.skyTop);
      ctx.fillRect(0, 0, VW, VH);
      for (i = 0; i < 16; i++) {
        var a0 = i * TAU / 16 + t * 0.05;
        ctx.fillStyle = rgba(rainbow(i / 16 + this.hue), 0.22);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, 30, a0, a0 + TAU / 32);
        ctx.fill();
      }
      for (var ringI = 0; ringI < 3; ringI++) {
        var R = 3 + ringI * 3.5;
        for (i = 0; i < 8; i++) {
          var ea = i * TAU / 8 + ringI * 0.2 + t * 0.05;
          this._eye2D(ctx, cx + Math.cos(ea) * R, cy + Math.sin(ea) * R, 0.5 + ringI * 0.3, rainbow(ringI * 0.17 + this.hue), p4.skyTop, 1);
        }
      }
      ctx.globalAlpha = 1;
    }

    // Shared mushroom forest
    for (var k = 0; k < LAYERS.length; k++) {
      this._forest2D(ctx, LAYERS[k], k, false);
      var hz = 0.32 * W[0] + 0.28 * W[1] + 0.22 * W[2];
      if (k < 2 && hz > 0.01) {
        var hzg = ctx.createLinearGradient(0, VH * 0.35, 0, VH);
        var hzc = mix3(P.glow, P.skyLow, 0.5);
        hzg.addColorStop(0, rgba(hzc, 0));
        hzg.addColorStop(1, rgba(hzc, hz * (k ? 0.5 : 0.75)));
        ctx.fillStyle = hzg;
        ctx.fillRect(0, 0, VW, VH);
      }
    }
    // Spores
    ctx.globalCompositeOperation = 'lighter';
    var sr = 0.2 * W[0] + 0.12 * W[1] + 0.07 * (W[2] + W[3]);
    for (i = 0; i < 26; i++) {
      var spx = fract(hash11(i * 3.7) - this.camX * 0.01) * VW;
      var spy = VH - fract(hash11(i * 5.1) + t * 0.02 * (1 + hash11(i))) * VH;
      ctx.fillStyle = rgba(W[3] > 0.5 ? rainbow(hash11(i) + this.hue) : (i % 2 ? P.glow : P.fringe), 0.45);
      ctx.beginPath();
      ctx.arc(spx, spy, sr * (0.7 + 0.6 * hash11(i * 9.1)), 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  };

  MW.BgFx.prototype._glow2D = function (ctx, x, y, r, col, a) {
    var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(col, a));
    g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };

  // Almond eye (half width hw tiles) with an iris looking at the wizard.
  MW.BgFx.prototype._eye2D = function (ctx, x, y, hw, iris, lid, open) {
    var hh = hw * 0.5 * open;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x - hw, y);
    ctx.quadraticCurveTo(x, y - hh * 2, x + hw, y);
    ctx.quadraticCurveTo(x, y + hh * 2, x - hw, y);
    ctx.closePath();
    ctx.fillStyle = rgb([0.74, 0.71, 0.8]);
    ctx.fill();
    ctx.clip();
    var dx = this.look[0] - x, dy = this.look[1] - y, dl = Math.sqrt(dx * dx + dy * dy) || 1;
    var lk = Math.min(1, dl / 7);
    var ix = x + dx / dl * lk * hw * 0.3, iy = y + dy / dl * lk * hw * 0.12;
    ctx.fillStyle = rgb(iris);
    ctx.beginPath(); ctx.arc(ix, iy, hw * 0.38, 0, TAU); ctx.fill();
    ctx.fillStyle = '#050505';
    ctx.beginPath(); ctx.arc(ix, iy, hw * 0.15, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = Math.max(0.05, hw * 0.06);
    ctx.beginPath();
    ctx.moveTo(x - hw, y);
    ctx.quadraticCurveTo(x, y - hh * 2, x + hw, y);
    ctx.quadraticCurveTo(x, y + hh * 2, x - hw, y);
    ctx.stroke();
  };

  // One forest layer: rolling ground, tapered stems, caps with gills (D2), spots, rims (D3/D4).
  MW.BgFx.prototype._forest2D = function (ctx, L, k, inkMode) {
    var u = this.u, W = u.W, P = this.pal, t = this.t, I = this.ink;
    var sc = L.scale, ox = this.camX * L.f, gy = L.ground - u.camYOff * L.f;
    var body = mix3(P.skyMid, P.ground, 0.3 + 0.25 * k);
    body = scale3(body, 1 - u.sh3[1] * (0.62 + 0.15 * k));
    body = mix3(body, P.skyLow, u.sh3[2] * (1 - 0.35 * k) * 0.6);
    var fill = inkMode ? rgb(mix3(I.paper, I.shade, 0.12 + 0.12 * k)) : rgb(body);
    var rimCol = W[3] > 0.5 ? rainbow(this.hue + k * 0.2) : P.fringe;

    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(-1, VH + 1);
    for (var x = -1; x <= VW + 1.01; x += 0.75) ctx.lineTo(x, gy - hill((x + ox) / sc, L.seed) * sc);
    ctx.lineTo(VW + 1, VH + 1);
    ctx.closePath();
    ctx.fill();
    if (inkMode) { ctx.strokeStyle = rgba(I.ink, 0.5); ctx.lineWidth = 0.05; ctx.stroke(); }

    var id0 = Math.floor(ox / sc / L.cell) - 1, id1 = Math.floor((ox + VW) / sc / L.cell) + 1;
    var ys = [-2.5, 0, 1 / 3, 2 / 3, 1];
    for (var id = id0; id <= id1; id++) {
      var m = shroomParams(id, L, u.sh, u.sh[3], t);
      if (m.empty) continue;
      ctx.beginPath();
      for (var j = 0; j < 10; j++) {
        var jj = j < 5 ? j : 9 - j, side = j < 5 ? -1 : 1;
        var ly = jj === 0 ? -2.5 : ys[jj] * m.H;
        var yn = Math.max(0, ly) / m.H;
        var xo = m.cx + m.bend * yn * yn + side * m.sw * (1 + 0.8 * (1 - yn) * (1 - yn));
        if (j === 0) ctx.moveTo(xo * sc - ox, gy - ly * sc); else ctx.lineTo(xo * sc - ox, gy - ly * sc);
      }
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      if (inkMode) { ctx.strokeStyle = rgba(I.ink, 0.5); ctx.lineWidth = 0.04; ctx.stroke(); }
      // Cap: upper half ellipse + shallow underside ellipse
      var cx = (m.cx + m.bend) * sc - ox, cy = gy - m.H * sc, rx = m.cw * sc, ry = m.ch * sc, gd = Math.max(0.05, u.sh2[0]);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, Math.PI, TAU);
      ctx.ellipse(cx, cy, rx, ry * gd, 0, 0, Math.PI);
      ctx.closePath();
      ctx.fillStyle = inkMode ? fill : rgb(mix3(body, P.glow, u.sh3[0] * 0.6));
      ctx.fill();
      if (inkMode) {
        var pat = this._hatch(ctx);
        if (pat) { ctx.fillStyle = pat; ctx.fill(); }
        ctx.strokeStyle = rgba(I.ink, 0.55); ctx.lineWidth = 0.05; ctx.stroke();
        continue;
      }
      // Gills (D2): lines fanning from the stem to the rim
      if (u.sh2[1] > 0.05) {
        ctx.strokeStyle = rgba(P.fringe, 0.55 * u.sh2[1]);
        ctx.lineWidth = 0.06;
        ctx.beginPath();
        for (var gI = -4; gI <= 4; gI++) {
          ctx.moveTo(cx + gI / 4.5 * rx * 0.15, cy + ry * gd);
          ctx.lineTo(cx + gI / 4.5 * rx, cy + 0.02);
        }
        ctx.stroke();
      }
      // Spots
      if (u.sh2[2] > 0.05) {
        ctx.fillStyle = rgba(mix3(P.accent, P.glow, u.sh2[2]), 0.3 + 0.4 * u.sh2[2]);
        for (var s = 0; s < 4; s++) {
          var qx = (hash11(id * 3.7 + s * 1.31 + L.seed) - 0.5) * 1.3, qy = 0.25 + 0.5 * hash11(id * 5.9 + s * 2.17 + L.seed);
          if (qx * qx + qy * qy > 0.7) continue;
          ctx.beginPath();
          ctx.arc(cx + qx * rx, cy - qy * ry, Math.min(rx, ry) * 0.1, 0, TAU);
          ctx.fill();
        }
      }
      // Eyes on caps (D4)
      if (u.sh3[3] > 0.5) this._eye2D(ctx, cx, cy - ry * 0.42, rx * 0.4, rainbow(m.hid * 3 + this.hue), body, 1);
      // Neon rim (D3/D4)
      if (u.sh2[3] > 0.2) {
        ctx.strokeStyle = rgba(rimCol, 0.5 * u.sh2[3]);
        ctx.lineWidth = 0.08;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, Math.PI, TAU);
        ctx.stroke();
      }
    }
  };

  MW.BgFx.prototype._ink2D = function (ctx) {
    var I = this.ink, u = this.u;
    ctx.fillStyle = rgb(I.paper);
    ctx.fillRect(0, 0, VW, VH);
    // Engraved sky lines, heavier toward the top
    ctx.strokeStyle = rgba(I.soft, 0.4);
    for (var y = 0.2; y < VH * 0.62; y += 0.38) {
      ctx.lineWidth = 0.02 + 0.07 * (1 - y / (VH * 0.62));
      ctx.beginPath();
      for (var x = 0; x <= VW; x += 1.5) {
        var yy = y + 0.08 * Math.sin(x * 0.41 + 1.3);
        if (x === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    // Moon
    var mx = 21.8 + u.drift, my = 4.3 - Math.max(-1.5, Math.min(1.5, u.camYOff * 0.05));
    ctx.fillStyle = rgb(I.paper);
    ctx.beginPath(); ctx.arc(mx, my, 2.4, 0, TAU); ctx.fill();
    ctx.strokeStyle = rgba(I.ink, 0.6); ctx.lineWidth = 0.07; ctx.stroke();
    for (var k = 0; k < LAYERS.length; k++) this._forest2D(ctx, LAYERS[k], k, true);
  };

  MW.BgFx.prototype._overlays2D = function (ctx) {
    var u = this.u, cx = VW / 2, cy = VH / 2, far = Math.sqrt(cx * cx + cy * cy);
    ctx.globalCompositeOperation = 'source-over';
    // Chromatic ripple: three offset colour rings from the centre
    if (u.ripStr > 0.01) {
      var R = this.rip.age * 2.4 * VH, rc = this.rip.col;
      ctx.lineWidth = 0.4 + this.rip.age * 3;
      var chans = [[1, 0.2, 0.3], rc, [0.2, 0.5, 1]];
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < 3; i++) {
        ctx.strokeStyle = rgba(chans[i], 0.3 * u.ripStr);
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(0.01, R + (i - 1) * 0.35 * u.ripGain), 0, TAU);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    // Kaleidoscope bloom (reaching D4): rainbow petals from the centre
    if (u.bloomEnv > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      for (var p = 0; p < 16; p++) {
        var a0 = p * TAU / 16 + u.bloomRot;
        ctx.fillStyle = rgba(rainbow(p / 16 + this.hue), 0.22 * u.bloomEnv);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, far, a0, a0 + TAU / 40);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    if (u.ringStr > 0) {
      var r = this.ring, rl = clamp01(1 - r.age / RING_LIFE);
      ctx.strokeStyle = rgba(r.col, 0.35 * rl * rl * u.ringStr);
      ctx.lineWidth = 0.6 + r.age * 3;
      ctx.beginPath();
      ctx.arc(r.x, r.y, Math.max(0.01, r.age * 1.3 * VH), 0, TAU);
      ctx.stroke();
    }
    if (u.flashStr > 0) {
      var fa = this.flash.age, life = clamp01(1 - fa / FLASH_LIFE);
      ctx.strokeStyle = rgba(this.ink.cyan, 0.6 * life * u.flashStr);
      ctx.lineWidth = 0.5 + fa * 4;
      ctx.beginPath();
      ctx.arc(this.origin[0], this.origin[1], Math.max(0.01, fa * 3.2 * VH), 0, TAU);
      ctx.stroke();
    }
    // Vignette (a burnt paper edge in Clarity) and the death / pause dim
    var vg = ctx.createRadialGradient(cx, cy, far * 0.35, cx, cy, far);
    var edge = mix3([0, 0, 0], scale3(this.ink.deep, 0.6), u.eC);
    vg.addColorStop(0, rgba(edge, 0));
    vg.addColorStop(1, rgba(edge, u.vignette * (1 - u.eC) + 0.45 * u.eC));
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, VW, VH);
    if (u.dim > 0.005) {
      ctx.fillStyle = 'rgba(0,0,0,' + (0.5 * u.dim).toFixed(3) + ')';
      ctx.fillRect(0, 0, VW, VH);
    }
  };
})();
