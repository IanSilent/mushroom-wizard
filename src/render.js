// Game-layer renderer «Грибной трип» (DESIGN.md §5): camera, organic terrain, abyss, entities, the wizard,
// particles, stage-change FX, HUD and the debug overlay. Draws on a TRANSPARENT 960x540 canvas that sits above
// the background canvas. It only READS the world; everything stored here is presentation state.
//
// Terrain: the tile grid is traced into smooth silhouettes (rounded corners, slightly irregular ink outline with
// deterministic jitter) and cached per 16x16-tile chunk into offscreen canvases, one canvas per "look"
// (the D1..D4 palettes and the Clarity ink etching). The bioluminescent fringe is cached once per chunk as a
// white mask and tinted live, so its colour follows the palette continuously and hue-cycles at D4.
// Collision geometry never changes: outlines follow tile edges within ~2 px. Crumbling tiles, the abyss,
// hazards and everything that moves are drawn live, so crumble / respawn never invalidate the cache.
//
// Reserved colours: red-orange = danger only (crisp, never warped), gold = checkpoints, cyan = Clarity and
// spells, violet = rune walls. The camera never rotates; hazards, platforms and the wizard are never warped.
var MW = MW || {};

(function () {
  'use strict';
  var TAU = Math.PI * 2;
  var MAX_PARTICLES = 700;
  var LOOK_AHEAD = 3;       // tiles ahead in the facing direction
  var LOOK_DOWN_MAX = 4;    // tiles of extra view below when falling fast
  var LOOK_DOWN_VY = 8;     // fall speed (t/s) above which the camera looks down
  var PIT_VIEW = 1;         // tiles of pit darkness the camera may show below a room
  var FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  var SERIF = 'Georgia, "Palatino Linotype", "Book Antiqua", Palatino, serif';
  var MONO = 'ui-monospace, Menlo, Consolas, monospace';

  // Terrain cache.
  var CH = 16;              // chunk side, tiles
  var APRON = 2;            // extra tiles traced around a chunk so silhouettes continue seamlessly
  var MAX_CANVASES = 84;    // live chunk canvases (512x512, ~1 MB each)
  var RENDER_BUDGET = 2;    // chunk looks rendered per frame when a fallback exists
  var SAMPLE = 8;           // outline sample step, px (world-aligned)
  var R_CONVEX = 11, R_CONCAVE = 6;   // corner radii, px

  // Palette transitions (seconds).
  var STAGE_BLEND = 0.25, INK_IN = 0.15, INK_OUT = 0.3, STAGE_FX_LIFE = 0.4;

  // Cell kinds as the renderer sees them.
  var K_EMPTY = 0, K_EARTH = 1, K_RUNE = 2, K_PLANK = 3, K_CRUMBLE = 4, K_SPIKE = 5, K_ABYSS = 6;

  // ---------------------------------------------------------------- palette

  var PAL = MW.PALETTE;
  var hex = MW.hexToRgb;
  var mix = MW.mixRgb;
  var SKEYS = ['ground', 'groundDeep', 'groundEdge', 'fringe', 'accent', 'glow', 'ink'];
  var CYCLE = { fringe: 1, accent: 1, glow: 1, groundEdge: 1 };   // D4 hue-cycles these
  var SRGB = {};
  for (var si = 1; si <= 4; si++) {
    SRGB[si] = {};
    for (var sk = 0; sk < SKEYS.length; sk++) SRGB[si][SKEYS[sk]] = hex(PAL.stages[si][SKEYS[sk]]);
  }
  var INK = {
    paper: hex(PAL.clarity.paper), paperShade: hex(PAL.clarity.paperShade), paperDeep: hex(PAL.clarity.paperDeep),
    ink: hex(PAL.clarity.ink), inkSoft: hex(PAL.clarity.inkSoft), hatch: hex(PAL.clarity.hatch),
  };
  var INK_MAP = {
    ground: INK.paperShade, groundDeep: INK.paperDeep, groundEdge: INK.paper, fringe: INK.ink,
    accent: INK.inkSoft, glow: INK.inkSoft, ink: INK.ink,
  };
  // Stage signature colours (HUD, labels, aura). Never cyan (Clarity) and never red-orange (danger).
  var SIG = [null, hex('#f4c7a1'), hex('#ffb05a'), hex('#ff3fd0'), hex('#ffe14a')];
  var AURA = [null, hex('#f4c7a1'), hex('#ff6fb5'), hex('#ff3fd0'), hex('#ffe14a')];

  var HZ = PAL.hazard, HZ_LIGHT = PAL.hazardLight, HZ_DARK = PAL.hazardDark, HZ_MID = '#c8340f';
  var CYAN = PAL.cyan, CYAN_HI = '#d6fbff', CYAN_DEEP = PAL.cyanDeep;
  var CYAN_RGB = hex(CYAN), CYAN_DEEP_RGB = hex(CYAN_DEEP);
  var GOLD = PAL.gold, GOLD_HI = '#fff1b8', GOLD_DIM = '#b8954a';
  var ABYSS = hex(PAL.abyss), ABYSS_RIM = hex(PAL.abyssRim), ABYSS_STAR = hex('#e6ccff');
  var RUNE = hex(PAL.rune), RUNE_DARK = hex('#1f1038'), RUNE_HI = hex('#c9a6ff');

  var C = {
    robe: hex('#3a4cc2'), robeDark: hex('#26327f'), hat: hex('#2b3590'), skin: hex('#f2d0b0'), nose: hex('#ea93a2'),
    beard: hex('#efeaf7'), boot: hex('#2a1d14'), staff: hex('#7a4f2a'), white: hex('#fffaf2'),
    line: hex('#140d1c'),
    mush: '#b04ee0', mushDark: '#4a1a66', mushSpot: '#fff0dc', stem: '#f1e4c8',
    portal: '#7dff9a', portalPink: '#ffb3e6',
    wood: hex('#8b5a2b'), crumble: hex('#c7a57a'), crumbleDark: hex('#4d3a26'),
    ui: hex('#f4eeff'), uiBg: hex('#0d0818'),
  };

  // ---------------------------------------------------------------- small helpers

  function ease(rate, dt) { return 1 - Math.exp(-rate * dt); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  // Clamp into [lo, hi]; when the range is empty (view larger than the area) centre it.
  function clampRange(v, lo, hi) { return hi < lo ? (lo + hi) / 2 : clamp(v, lo, hi); }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
  function hash(x, y) {
    var h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }
  function css(c, a) { return MW.rgbToCss(c, a); }
  function settings() { return MW.settings || { fx: 0.5, shake: true }; }
  // Screen-effect intensity multiplier: 1 at the moderate default (fx = 0.5), 0..2 overall.
  function fxk() {
    var f = settings().fx;
    if (typeof f !== 'number' || f !== f) f = 0.5;
    return clamp(f / 0.5, 0, 2);
  }
  function fmtTime(s) {
    var t10 = Math.floor(Math.max(0, s || 0) * 10);
    var m = Math.floor(t10 / 600), sec = Math.floor((t10 % 600) / 10);
    return m + ':' + (sec < 10 ? '0' : '') + sec + '.' + (t10 % 10);
  }
  function rgb2hsl(c) {
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, h = 0, s = 0;
    if (mx !== mn) {
      var d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function hsl2rgb(h, s, l) {
    h = ((h % 1) + 1) % 1;
    if (s === 0) return [l * 255, l * 255, l * 255];
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    var f = function (t) {
      t = ((t % 1) + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 0.5) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }
  function hueShift(c, turns) { var h = rgb2hsl(c); return hsl2rgb(h[0] + turns, h[1], h[2]); }
  function hsl(deg, s, l, a) {
    deg = ((deg % 360) + 360) % 360;
    return a === undefined ? 'hsl(' + deg.toFixed(1) + ',' + s + '%,' + l + '%)'
      : 'hsla(' + deg.toFixed(1) + ',' + s + '%,' + l + '%,' + a + ')';
  }
  function rrect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function star4(ctx, x, y, r, rot) {
    for (var i = 0; i < 8; i++) {
      var a = rot + i * Math.PI / 4, rr = i % 2 ? r * 0.36 : r;
      if (i) ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      else ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
  }
  function spiral(ctx, cx, cy, r, turns, rot) {
    ctx.moveTo(cx, cy);
    for (var i = 1; i <= 18; i++) {
      var f = i / 18, a = rot + f * turns * TAU;
      ctx.lineTo(cx + Math.cos(a) * r * f, cy + Math.sin(a) * r * f);
    }
  }
  function outlinedText(ctx, s, x, y, fill, stroke, lw) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = lw;
    ctx.strokeStyle = stroke;
    ctx.strokeText(s, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(s, x, y);
  }
  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  // Deterministic outline offset (px) for a world-space point: identical in every chunk that traces it.
  function jitter(x, y, amp) {
    var xi = Math.round(x), yi = Math.round(y);
    var h = hash(xi * 3 + 11, yi * 5 - 7);
    var hf = ((h & 1023) / 1023) * 2 - 1;
    var low = Math.sin(xi * 0.043 + yi * 0.071) * 0.6 + Math.sin(xi * 0.017 - yi * 0.023 + 1.3) * 0.5;
    return amp * (0.32 * hf + 0.68 * low);
  }

  // Spike tooth layout in the tile's "base space": u along the base (0..1), v = height from the base.
  var TEETH = [[0.04, 0.36, 0.6], [0.34, 0.66, 0.68], [0.64, 0.96, 0.6]];
  function spikeMap(c, x, y, u, v, T) {
    switch (c) {
      case '^': return [(x + u) * T, (y + 1 - v) * T];
      case 'v': return [(x + u) * T, (y + v) * T];
      case '<': return [(x + 1 - v) * T, (y + u) * T];
      default: return [(x + v) * T, (y + u) * T]; // '>'
    }
  }

  // Rune glyph strokes in tile-local 0..1 coordinates (each glyph: list of polylines).
  var GLYPHS = [
    [[[0.5, 0.2], [0.5, 0.8]], [[0.3, 0.27], [0.5, 0.47], [0.7, 0.27]]],
    [[[0.5, 0.2], [0.76, 0.5], [0.5, 0.8], [0.24, 0.5], [0.5, 0.2]]],
    [[[0.36, 0.8], [0.36, 0.2], [0.63, 0.34], [0.36, 0.48], [0.66, 0.8]]],
    [[[0.28, 0.25], [0.72, 0.75], [0.72, 0.25], [0.28, 0.75], [0.28, 0.25]]],
  ];

  // Hat curl (total turning of the cone, in units of ~7 rad) and length per stage. [0] = Clarity.
  var CURL = [0, 0.16, 0.4, 0.62, 0.98];
  var HAT_LEN = [27, 25, 28, 32, 40];
  var SPORE_RATE = [0, 2.5, 4.5, 7, 10];   // ambient spores per second by stage
  var STAGE_NAME = [null, PAL.stages[1].name, PAL.stages[2].name, PAL.stages[3].name, PAL.stages[4].name];

  // ---------------------------------------------------------------- renderer

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = canvas.width || 960;
    this.H = canvas.height || 540;
    this.T = MW.TILE || 32;
    this.camera = { x: 0, y: 0 };
    this.world = null;
    this.colBottom = [];   // per column: first row below the column's room (the pit starts there)
    this.bufSp = []; this.bufKr = []; this.bufRn = []; this.bufAb = []; this.visChunks = [];
    this.wrapCache = {};
    this.wrapCount = 0;
    this.fps = 60;
    this.vb = { l: 0, t: 0, r: 30, b: 17 };  // visible bounds in tiles (with margin)
    this.chunks = {};
    this.pool = [];
    this.canvasCount = 0;
    this.frameNo = 0;
    this.renders = 0;
    this.rs = 1;             // render scale: backing-store px per logical px (crisp on big / hi-DPI screens)
    this.tint = makeCanvas(this.W, this.H);
    this.tintCtx = this.tint.getContext('2d');
    this.pal = { c: {}, d: {}, s: {} };
    this.stageFrom = 1; this.stageTo = 1; this.stageK = 1; this.stageF = 1; this.sfFrom = 1;
    this.inkK = 0;
    this.clearFx();
  }

  Renderer.prototype.clearFx = function () {
    this.particles = [];
    this.texts = [];
    this.afterimages = [];
    this.stageFx = [];
    this.hudPop = null;
    this.t = 0;                // presentation clock (stops while paused)
    this.snap = true;          // next camera update jumps straight to the target
    this.lookX = 0; this.lookY = 0; this.anchorY = 0;
    this.shakeT = 0; this.shakeDur = 1; this.shakeAmp = 0;
    this.flashT = 0;
    this.chromaT = 0;          // stage change: chromatic edge flash
    this.washT = -1;           // focusOff colour wash timer (-1 = off)
    this.clarityVis = 0;       // smoothed 0..1 visibility of the Clarity frame
    this.framePulse = 0;
    this.orbPulse = 0; this.orbShake = 0;
    this.sq = 0; this.sqV = 0; // squash & stretch spring (+ = stretch)
    this.curl = 0; this.curlV = 0;
    this.sporeAcc = 0; this.featherAcc = 0; this.moteAcc = 0;
    this.hiccupWarnT = 0;
    this.signA = 0; this.signText = '';
  };

  Renderer.prototype.reset = function (world) {
    this.world = world;
    this.clearFx();
    this.flushChunks();
    var cb = this.colBottom = [];
    if (world && world.level) {
      var lvl = world.level;
      for (var x = 0; x < lvl.w; x++) cb[x] = lvl.h;
      (lvl.rooms || []).forEach(function (r) {
        for (var cx = r.ox; cx < r.ox + r.w; cx++) cb[cx] = r.oy + r.h;
      });
    }
    var p = world && world.player;
    var st = p ? clamp(p.stage | 0, 1, 4) : 1;
    this.stageFrom = this.stageTo = st; this.stageK = 1; this.stageF = this.sfFrom = st;
    this.inkK = p && p.clarity ? 1 : 0;
    this.curl = CURL[p && p.clarity ? 0 : st];
  };

  // ---------------------------------------------------------------- particles

  Renderer.prototype.spawn = function (o) {
    var ps = this.particles;
    if (ps.length >= MAX_PARTICLES) {
      if (o.low) return null;
      ps.shift();
    } else if (o.low && ps.length >= MAX_PARTICLES * 0.6) {
      return null;  // ambient particles never crowd out bursts
    }
    o.k = o.k || 'dot';
    o.vx = o.vx || 0; o.vy = o.vy || 0;
    o.g = o.g || 0; o.drag = o.drag || 0;
    o.life = o.life || 0.5; o.max = o.life;
    o.size = o.size || 3;
    if (o.size1 === undefined) o.size1 = o.size;
    o.rot = o.rot || 0; o.vr = o.vr || 0;
    o.wob = o.wob || 0; o.wf = o.wf || 3; o.seed = Math.random() * TAU;
    o.color = o.color || '#ffffff';
    ps.push(o);
    return o;
  };

  // o: {k, colors, n, speed:[a,b], life:[a,b], size:[a,b], size1, g, drag, angle, spread, jx, jy, vy0, vr, wob}
  Renderer.prototype.burst = function (x, y, n, o) {
    for (var i = 0; i < n; i++) {
      var a = o.angle !== undefined ? o.angle + (Math.random() - 0.5) * (o.spread || TAU) : Math.random() * TAU;
      var sp = rnd(o.speed[0], o.speed[1]);
      this.spawn({
        k: o.k, x: x + rnd(-(o.jx || 0), o.jx || 0), y: y + rnd(-(o.jy || 0), o.jy || 0),
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + (o.vy0 || 0),
        g: o.g, drag: o.drag, life: rnd(o.life[0], o.life[1]),
        size: rnd(o.size[0], o.size[1]), size1: o.size1, color: pick(o.colors),
        rot: Math.random() * TAU, vr: o.vr ? rnd(-o.vr, o.vr) : 0, wob: o.wob, wf: o.wf,
      });
    }
  };

  Renderer.prototype.ring = function (x, y, r0, r1, life, color, lw) {
    this.spawn({ k: 'ring', x: x, y: y, size: r0, size1: r1, life: life, color: color, lw: lw || 3 });
  };

  Renderer.prototype.floatText = function (s, x, y, color, size, life, serif) {
    this.texts.push({ s: s, x: x, y: y, vy: -1.2, color: color, size: size || 16, life: life || 0.7, max: life || 0.7, serif: !!serif });
    if (this.texts.length > 12) this.texts.shift();
  };

  Renderer.prototype.shake = function (amp, dur) {
    if (amp >= this.shakeAmp * (this.shakeT / this.shakeDur)) {
      this.shakeAmp = amp; this.shakeDur = dur; this.shakeT = dur;
    }
  };

  // Colours of the current drunk palette for particles (spores take the stage's world colours).
  Renderer.prototype.sporeColors = function (stage) {
    var s = stage ? SRGB[clamp(stage, 1, 4)] : null;
    if (s) return [css(s.fringe), css(s.accent), css(s.glow), '#ffffff'];
    var d = this.pal.d;
    if (!d.fringe) return ['#ffb3e6', '#d9ff9e', '#f6d6ff'];
    return [css(d.fringe), css(d.accent), css(d.glow)];
  };

  // ---------------------------------------------------------------- events

  Renderer.prototype.handle = function (e, world) {
    if (!e || !world || !world.player) return;
    var p = world.player;
    // Most events carry the player's top-left in tiles; fall back to the current position.
    var ex = typeof e.x === 'number' ? e.x : p.x, ey = typeof e.y === 'number' ? e.y : p.y;
    var feetX = ex + p.w / 2, feetY = ey + p.h, midY = ey + p.h / 2;
    var pcx = p.x + p.w / 2;
    var i;
    var dust = this.inkK > 0.5 ? ['#3a3128', '#6b5e4c'] : ['#e6dcf2', '#cfc3e2'];
    switch (e.type) {
      case 'jump':
        this.sq = 0.26; this.sqV = 0;
        this.burst(feetX, feetY, 5, { k: 'puff', colors: dust, speed: [0.5, 1.6], angle: Math.PI, spread: Math.PI,
          life: [0.25, 0.4], size: [2, 3], size1: 6, drag: 4 });
        break;
      case 'land': {
        var drop = e.drop || 0;
        this.sq = -clamp(0.12 + Math.max(0, drop) * 0.05, 0.12, 0.4); this.sqV = 0;
        if (drop > 2) {
          var n = Math.min(16, 5 + Math.round(drop * 1.5));
          for (i = 0; i < n; i++) {
            var side = i % 2 ? 1 : -1;
            this.spawn({ k: 'puff', x: feetX + side * rnd(0.1, 0.4), y: feetY - 0.05, vx: side * rnd(1.5, 4), vy: rnd(-1, -0.2),
              drag: 3.5, life: rnd(0.3, 0.55), size: rnd(2, 3.5), size1: rnd(6, 9), color: pick(dust) });
          }
        }
        break;
      }
      case 'bonk':
        this.burst(pcx, p.y, 5, { k: 'star', colors: ['#ffffff', '#eae4ff'], speed: [1.5, 3], angle: -Math.PI / 2, spread: Math.PI,
          life: [0.25, 0.4], size: [2.5, 4] });
        break;
      case 'stageWarn':
        // Take-off of a stage-raising jump: a hint of the next world's colours (the change lands on landing).
        this.burst(pcx, p.y + 0.3, 6, { k: 'spore', colors: this.sporeColors((e.stage | 0) || p.stage + 1), speed: [0.8, 2],
          life: [0.35, 0.6], size: [1.4, 2.4], drag: 2 });
        break;
      case 'stageUp':
      case 'stageDown':
        this.onStage(e, world, e.type === 'stageUp');
        break;
      case 'focusOn':
        this.flashT = 0.12;
        this.framePulse = 1;
        this.ring(ex + p.w / 2, midY, 6, 3.4 * this.T, 0.38, CYAN, 5);
        this.ring(ex + p.w / 2, midY, 4, 2.0 * this.T, 0.24, CYAN_DEEP, 3);
        this.burst(ex + p.w / 2, midY, 12, { k: 'spark', colors: [CYAN, CYAN_DEEP], speed: [5, 9], life: [0.2, 0.35],
          size: [1.5, 2.5], drag: 5 });
        break;
      case 'focusOff':
        this.washT = 0;
        this.burst(ex + p.w / 2, midY, 10, { k: 'spore', colors: this.sporeColors(p.stage), speed: [1, 3], life: [0.3, 0.6],
          size: [1.6, 3], drag: 3 });
        break;
      case 'focusWarn':
        this.framePulse = 1;
        break;
      case 'focusReady':
        this.orbPulse = 1;
        if (!p.dead) this.ring(pcx, p.y + p.h / 2, 4, 0.9 * this.T, 0.3, CYAN, 2);
        break;
      case 'focusDenied':
        this.orbShake = 1;
        this.floatText('×', pcx, p.y - 0.45, '#d8d4e4', 22, 0.6);
        break;
      case 'cast':
        this.handleCast(e, p);
        break;
      case 'fizzle':
        this.burst(pcx + p.facing * 0.38, p.y - 0.05, 8, { k: 'puff', colors: ['#9a96a8', '#bcb8c8'], speed: [0.4, 1.4],
          life: [0.35, 0.6], size: [2, 3], size1: 7, drag: 3, vy0: -0.6 });
        break;
      case 'featherEnd':
        this.burst(pcx, p.y + 0.5, 3, { k: 'feather', colors: ['#eefcff'], speed: [0.3, 0.8], life: [0.8, 1.2],
          size: [4, 6], vy0: 0.4, wob: 1.2, vr: 2 });
        break;
      case 'hiccupWarn':
        this.hiccupWarnT = 0;
        break;
      case 'hiccup':
        this.sq = 0.24; this.sqV = 0;
        this.shake(3, 0.15);
        this.ring(feetX, feetY - 0.1, 3, 0.8 * this.T, 0.3, '#f4eefc', 2);
        this.burst(feetX, feetY - 0.1, 6, { k: 'puff', colors: ['#f4eefc', '#ddd3ee'], speed: [0.8, 2], angle: Math.PI / 2,
          spread: Math.PI * 1.6, life: [0.3, 0.5], size: [2, 3], size1: 7, drag: 3 });
        this.floatText('ик!', ex + p.w / 2 + p.facing * 0.5, ey - 0.6, '#fff8f0', 13, 0.5);
        break;
      case 'death':
        this.shake(7, 0.3);
        // Pit deaths happen just below the view: keep the burst on screen.
        midY = Math.min(midY, this.camera.y + this.H / this.T - 0.6);
        this.burst(ex + p.w / 2, midY, 22, { k: 'sq', colors: [css(C.robe), css(C.robeDark), css(C.hat), css(C.beard)], speed: [3, 8], g: 22,
          life: [0.5, 0.9], size: [2.5, 4.5], vr: 12, vy0: -3 });
        this.burst(ex + p.w / 2, midY, 12, { k: 'star', colors: ['#ffffff', css(C.beard)], speed: [2, 6], life: [0.3, 0.6],
          size: [2.5, 4], drag: 3 });
        this.ring(ex + p.w / 2, midY, 4, 1.4 * this.T, 0.3, '#ffffff', 3);
        break;
      case 'respawn':
        this.snap = true;
        this.sq = -0.2; this.sqV = 2;
        this.ring(feetX, feetY - 0.6, 4, 1.1 * this.T, 0.35, '#efeaff', 2.5);
        this.burst(feetX, feetY - 0.4, 12, { k: 'puff', colors: ['#efeaff', '#d9d0ee'], speed: [1, 2.5], life: [0.3, 0.55],
          size: [2.5, 4], size1: 9, drag: 3 });
        break;
      case 'restart':
        this.burst(ex + p.w / 2, midY, 8, { k: 'puff', colors: ['#bcb8c8'], speed: [0.6, 1.6], life: [0.25, 0.45],
          size: [2, 3], size1: 7, drag: 3 });
        break;
      case 'checkpoint':
        // e.x / e.y are the checkpoint cell; the lantern cap sits ~1.25 tiles above the floor.
        this.ring(ex + 0.5, ey - 0.2, 4, 1.6 * this.T, 0.45, GOLD, 3);
        this.burst(ex + 0.5, ey - 0.2, 18, { k: 'spark', colors: [GOLD, GOLD_HI], speed: [3, 7], life: [0.3, 0.6],
          size: [1.5, 2.5], drag: 3, vy0: -1 });
        break;
      case 'crumble':
        // e.x / e.y are the tile cell.
        this.burst(ex + 0.5, ey + 0.4, 9, { k: 'shard', colors: [css(C.crumble), css(mix(C.crumble, C.crumbleDark, 0.4)), css(C.crumbleDark)],
          speed: [0.5, 2.5], g: 28, life: [0.45, 0.8], size: [3, 6], vr: 8, jx: 0.35, jy: 0.2 });
        this.burst(ex + 0.5, ey + 0.6, 4, { k: 'puff', colors: ['#8a7a68'], speed: [0.3, 1], life: [0.35, 0.6],
          size: [3, 4], size1: 9, drag: 2 });
        break;
      case 'pickup':
        // e.x / e.y are the pickup centre.
        if (e.kind === 'crystal') {
          this.ring(ex, ey, 3, 1.1 * this.T, 0.3, CYAN, 2.5);
          this.burst(ex, ey, 12, { k: 'star', colors: [CYAN, CYAN_HI], speed: [1.5, 4], life: [0.3, 0.55], size: [2.5, 4], drag: 3 });
        } else {
          this.burst(ex, ey, 14, { k: 'star', colors: [C.mush, '#e2a8ff', C.mushSpot], speed: [1.5, 4], life: [0.35, 0.6],
            size: [2.5, 4], drag: 3 });
          this.burst(ex, ey, 10, { k: 'spore', colors: this.sporeColors(), speed: [0.8, 2.5], life: [0.6, 1.1], size: [1.5, 3],
            drag: 2, wob: 0.6 });
        }
        break;
      case 'finish': {
        var exit = world.level.exits && world.level.exits[0];
        var fx0 = exit ? exit.x + 0.5 : pcx, fy0 = exit ? exit.y : p.y + 0.7;
        this.ring(fx0, fy0, 6, 3 * this.T, 0.6, C.portal, 4);
        this.burst(fx0, fy0, 40, { k: 'star', colors: [C.portal, '#ffffff', C.portalPink], speed: [2, 7], life: [0.6, 1.2],
          size: [2.5, 4.5], drag: 2 });
        break;
      }
    }
  };

  // Stage change (now on every jump): strong but short. Chromatic ripple from the wizard, palette snap
  // (via the transition in update()), HUD label pop, a small label above the wizard, a spore burst.
  // Reaching D4 adds a kaleidoscopic bloom. Everything here is thin / additive and drawn under hazards.
  Renderer.prototype.onStage = function (e, world, up) {
    var p = world.player, st = clamp((e.stage | 0) || p.stage, 1, 4);
    var cx = p.x + p.w / 2, cy = p.y + p.h * 0.55;
    var k = fxk();
    this.stageFx.push({ t: 0, life: STAGE_FX_LIFE, x: cx, y: cy, up: up, stage: st, bloom: up && st === 4 });
    if (this.stageFx.length > 4) this.stageFx.shift();
    this.hudPop = { t: 0, stage: st, up: up };
    this.chromaT = 0.3;
    var col = st === 4 ? hsl(this.t * 200, 100, 70) : css(SIG[st]);
    this.floatText('D' + st, cx, p.y - 0.75, col, 20, 0.5, true);
    var cols = this.sporeColors(st);
    if (up) {
      this.burst(cx, cy, Math.round((st === 4 ? 34 : 22) * Math.max(0.5, k)), { k: 'spore', colors: cols, speed: [2, 6],
        life: [0.5, 1.0], size: [1.6, 3.4], drag: 3, vy0: -0.6, wob: 0.6 });
      this.burst(cx, cy, 8, { k: 'star', colors: cols, speed: [3, 7], life: [0.25, 0.45], size: [2.5, 4.2], drag: 4 });
      this.sq = Math.max(this.sq, 0.2); this.sqV = 0;
      this.curlV += 9;   // the hat flips into its new curl with a little overshoot
      if (st === 4) this.shake(4, 0.18); else this.shake(2, 0.12);
    } else {
      this.burst(cx, cy, 12, { k: 'puff', colors: ['#cfe0ff', '#eef2ff'], speed: [0.6, 1.8], life: [0.4, 0.7],
        size: [3, 4], size1: 9, drag: 2.5, vy0: -0.4 });
    }
  };

  Renderer.prototype.handleCast = function (e, p) {
    var T = this.T;
    if (e.spell === 'blink') {
      var fx = typeof e.fromX === 'number' ? e.fromX : p.x, fy = typeof e.fromY === 'number' ? e.fromY : p.y;
      var tx = typeof e.x === 'number' ? e.x : p.x, ty = typeof e.y === 'number' ? e.y : p.y;
      this.afterimages.push({ fx: fx, fy: fy, tx: tx, ty: ty, facing: p.facing, life: 0.4, max: 0.4 });
      if (this.afterimages.length > 4) this.afterimages.shift();
      for (var i = 0; i < 16; i++) {
        var f = Math.random();
        this.spawn({ k: 'spark', x: fx + (tx - fx) * f + p.w / 2, y: fy + (ty - fy) * f + rnd(0.1, p.h - 0.1),
          vx: rnd(-2, 2), vy: rnd(-2.5, 1), drag: 4, life: rnd(0.2, 0.4), size: rnd(1.2, 2.2), color: pick([CYAN, CYAN_HI]) });
      }
      this.ring(tx + p.w / 2, ty + p.h / 2, 4, 1.2 * T, 0.3, CYAN, 3);
      this.sq = -0.16; this.sqV = 0;
    } else if (e.spell === 'levitate') {
      var lx = (typeof e.x === 'number' ? e.x : p.x) + p.w / 2, ly = (typeof e.y === 'number' ? e.y : p.y) + p.h;
      this.ring(lx, ly, 4, 1.3 * T, 0.3, CYAN, 3);
      this.burst(lx, ly, 14, { k: 'spark', colors: [CYAN, CYAN_HI], speed: [5, 10], angle: Math.PI / 2, spread: 0.9,
        life: [0.2, 0.35], size: [1.5, 2.5], drag: 3, jx: 0.3 });
      this.burst(lx, ly - 0.7, 8, { k: 'spark', colors: [CYAN_HI, '#ffffff'], speed: [6, 11], angle: -Math.PI / 2, spread: 0.4,
        life: [0.15, 0.3], size: [1.2, 2], drag: 4, jx: 0.3 });
      this.sq = 0.3; this.sqV = 0;
    } else if (e.spell === 'feather') {
      var cx = (typeof e.x === 'number' ? e.x : p.x) + p.w / 2, cy = (typeof e.y === 'number' ? e.y : p.y) + p.h / 2;
      this.burst(cx, cy, 8, { k: 'feather', colors: ['#eefcff', CYAN_HI, CYAN], speed: [1, 2.5], life: [0.8, 1.3],
        size: [4.5, 6.5], drag: 2.5, wob: 1.2, vr: 3 });
      this.ring(cx, cy, 4, 1.0 * T, 0.3, CYAN_HI, 2);
    }
  };

  // ---------------------------------------------------------------- per-frame update

  Renderer.prototype.update = function (world, dt) {
    var p = world.player, i;

    // Palette transitions: the drunk stage blends in STAGE_BLEND, Clarity ink blends in fast and out slower.
    var st = clamp(p.stage | 0, 1, 4);
    if (st !== this.stageTo) {
      if (this.stageK >= 0.5) this.stageFrom = this.stageTo;   // keep whichever look dominates right now
      this.sfFrom = this.stageF;
      this.stageTo = st;
      this.stageK = 0;
    }
    if (dt <= 0) return;
    if (this.stageK < 1) this.stageK = Math.min(1, this.stageK + dt / STAGE_BLEND);
    this.stageF = this.sfFrom + (this.stageTo - this.sfFrom) * smooth(this.stageK);
    var inkT = p.clarity ? 1 : 0;
    if (this.inkK < inkT) this.inkK = Math.min(1, this.inkK + dt / INK_IN);
    else if (this.inkK > inkT) this.inkK = Math.max(0, this.inkK - dt / INK_OUT);

    var ps = this.particles;
    for (i = 0; i < ps.length; i++) {
      var q = ps[i];
      q.life -= dt;
      if (q.life <= 0) continue;
      q.vy += q.g * dt;
      if (q.drag) { var d = Math.exp(-q.drag * dt); q.vx *= d; q.vy *= d; }
      q.x += q.vx * dt; q.y += q.vy * dt;
      if (q.wob) q.x += Math.sin((q.max - q.life) * q.wf + q.seed) * q.wob * dt;
      if (q.vr) q.rot += q.vr * dt;
    }
    var n = 0;
    for (i = 0; i < ps.length; i++) if (ps[i].life > 0) ps[n++] = ps[i];
    ps.length = n;

    var tx = this.texts;
    for (i = tx.length - 1; i >= 0; i--) {
      tx[i].life -= dt; tx[i].y += tx[i].vy * dt; tx[i].vy *= Math.exp(-3 * dt);
      if (tx[i].life <= 0) tx.splice(i, 1);
    }
    for (i = this.afterimages.length - 1; i >= 0; i--) {
      this.afterimages[i].life -= dt;
      if (this.afterimages[i].life <= 0) this.afterimages.splice(i, 1);
    }
    for (i = this.stageFx.length - 1; i >= 0; i--) {
      this.stageFx[i].t += dt;
      if (this.stageFx[i].t >= this.stageFx[i].life) this.stageFx.splice(i, 1);
    }
    if (this.hudPop) { this.hudPop.t += dt; if (this.hudPop.t > STAGE_FX_LIFE) this.hudPop = null; }

    this.flashT = Math.max(0, this.flashT - dt);
    this.chromaT = Math.max(0, this.chromaT - dt);
    if (this.washT >= 0) { this.washT += dt; if (this.washT > 0.55) this.washT = -1; }
    this.framePulse = Math.max(0, this.framePulse - dt * 2.5);
    this.orbPulse = Math.max(0, this.orbPulse - dt * 2.5);
    this.orbShake = Math.max(0, this.orbShake - dt * 3);
    this.shakeT = Math.max(0, this.shakeT - dt);
    var cT = p.clarity && !p.dead ? 1 : 0;
    this.clarityVis += (cT - this.clarityVis) * ease(cT > this.clarityVis ? 16 : 7, dt);

    // Squash & stretch and the hat curl: damped springs, sub-stepped so long frames stay stable.
    var curlT = p.clarity ? CURL[0] : CURL[st];
    var sub = Math.max(1, Math.ceil(dt * 240)), h = dt / sub;
    for (i = 0; i < sub; i++) {
      this.sqV += (-260 * this.sq - 16 * this.sqV) * h; this.sq += this.sqV * h;
      this.curlV += (-170 * (this.curl - curlT) - (p.clarity ? 30 : 11) * this.curlV) * h; this.curl += this.curlV * h;
    }
    this.sq = clamp(this.sq, -0.45, 0.45);
    this.curl = clamp(this.curl, -0.2, 1.3);
    this.hiccupWarnT = p.hiccupWarned ? this.hiccupWarnT + dt : 0;

    var sTarget = world.activeSign && world.activeSign.text ? 1 : 0;
    if (sTarget) this.signText = world.activeSign.text;
    this.signA += (sTarget - this.signA) * ease(sTarget ? 14 : 8, dt);

    if (p.dead) return;
    var cx = p.x + p.w / 2;
    if (!p.clarity) {
      // Drunk: a little spore cloud in the world's colours, denser with each stage.
      this.sporeAcc += (SPORE_RATE[st] || 0) * (0.5 + 0.5 * fxk()) * dt;
      var cols = this.sporeColors();
      while (this.sporeAcc >= 1) {
        this.sporeAcc -= 1;
        this.spawn({ k: 'spore', x: cx + rnd(-0.5, 0.5), y: p.y + rnd(0.1, 1.2), vx: rnd(-0.25, 0.25), vy: rnd(-0.8, -0.25),
          life: rnd(1.0, 2.0), size: rnd(1.2, 2.6), color: pick(cols), wob: 0.6, wf: rnd(2, 4), low: true });
      }
    } else {
      this.sporeAcc = 0;
      // Clarity: a few crisp ink-and-cyan motes.
      this.moteAcc += 4 * dt;
      while (this.moteAcc >= 1) {
        this.moteAcc -= 1;
        this.spawn({ k: 'star', x: cx + rnd(-0.8, 0.8), y: p.y + rnd(-0.2, 1.4), vy: rnd(-0.6, -0.2), life: rnd(0.4, 0.8),
          size: rnd(2, 3.2), color: Math.random() < 0.6 ? CYAN_DEEP : CYAN, low: true });
      }
    }
    if (p.featherT > 0) {
      this.featherAcc += 9 * dt;
      while (this.featherAcc >= 1) {
        this.featherAcc -= 1;
        this.spawn({ k: 'feather', x: cx + rnd(-0.6, 0.6), y: p.y + rnd(0.2, 1.2), vx: rnd(-0.3, 0.3) + p.vx * 0.15,
          vy: rnd(0.3, 0.9), life: rnd(0.9, 1.5), size: rnd(4, 6), color: Math.random() < 0.7 ? '#eefcff' : CYAN,
          wob: 1.2, wf: rnd(2.5, 4), rot: rnd(-1, 1), vr: rnd(-2, 2), low: true });
      }
    } else {
      this.featherAcc = 0;
    }
  };

  // Current colours: the drunk palette at the continuous stage value (D4 accents hue-cycle), then mixed
  // toward the Clarity ink palette by inkK. pal.d = drunk only, pal.c = final rgb, pal.s = final css.
  Renderer.prototype.computePalette = function () {
    var pal = this.pal, sF = clamp(this.stageF, 1, 4), ink = this.inkK;
    var i = Math.floor(sF), f = sF - i;
    if (i >= 4) { i = 4; f = 0; }
    var w4 = clamp(sF - 3, 0, 1), turn = this.t * 0.22;
    for (var n = 0; n < SKEYS.length; n++) {
      var key = SKEYS[n];
      var c = f > 0 ? mix(SRGB[i][key], SRGB[i + 1][key], f) : SRGB[i][key].slice();
      if (w4 > 0 && CYCLE[key]) c = mix(c, hueShift(c, turn), w4);
      pal.d[key] = c;
      pal.c[key] = ink > 0 ? mix(c, INK_MAP[key], ink) : c;
      pal.s[key] = css(pal.c[key]);
    }
    var a = f > 0 ? mix(AURA[i], AURA[i + 1], f) : AURA[i];
    if (w4 > 0) a = mix(a, hueShift(a, turn * 1.6), w4);
    pal.d.aura = a;
    pal.w4 = w4;
    pal.ink = ink;
    pal.line = ink > 0 ? mix(C.line, INK.ink, ink) : C.line;
    pal.lineS = css(pal.line);
  };

  // ---------------------------------------------------------------- camera

  Renderer.prototype.updateCamera = function (world, dt) {
    var p = world.player, lvl = world.level, cam = this.camera;
    var VW = this.W / this.T, VH = this.H / this.T;
    var pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
    var snap = this.snap;
    this.snap = false;

    var lookX = (p.facing < 0 ? -1 : 1) * LOOK_AHEAD;
    var lookY = !p.grounded && p.vy > LOOK_DOWN_VY ? Math.min(LOOK_DOWN_MAX, (p.vy - LOOK_DOWN_VY) * 0.6) : 0;
    if (snap) {
      this.lookX = lookX; this.lookY = 0; this.anchorY = pcy;
    } else {
      this.lookX += (lookX - this.lookX) * ease(2.2, dt);
      this.lookY += (lookY - this.lookY) * ease(lookY > this.lookY ? 3 : 2, dt);
    }
    // Vertical anchor: follows the feet on the ground; in the air the player may move inside a
    // window (3 tiles up, 1 down) before the camera follows, so every jump doesn't drag the view.
    if (!p.dead) {
      if (p.grounded || snap) this.anchorY = pcy;
      else if (pcy < this.anchorY - 3) this.anchorY = pcy + 3;
      else if (pcy > this.anchorY + 1) this.anchorY = pcy - 1;
    }

    var tx = pcx + this.lookX - VW / 2;
    var ty = this.anchorY + this.lookY - VH * 0.56;
    tx = clampRange(tx, 0, lvl.w - VW);
    // Prefer the current room's vertical extent: show all of it when it fits, else stay inside it.
    var room = world.currentRoom ? world.currentRoom() : null;
    if (room && typeof room.oy === 'number') {
      var top = room.oy, bot = room.oy + room.h + PIT_VIEW;
      if (bot - top <= VH) ty = clampRange(ty, bot - VH, top);
      else ty = clampRange(ty, top, bot - VH);
    }
    ty = clampRange(ty, 0, lvl.h + PIT_VIEW - VH);

    if (snap) {
      cam.x = tx; cam.y = ty;
    } else {
      cam.x += (tx - cam.x) * ease(6, dt);
      cam.y += (ty - cam.y) * ease(4.5, dt);
      // Never lose the player off-screen (fast blinks, long falls): keep the whole box in view.
      if (!p.dead) {
        cam.x = clampRange(cam.x, p.x + p.w + 1 - VW, p.x - 1);
        cam.y = clampRange(cam.y, p.y + p.h + 0.5 - VH, p.y - 0.5);
      }
    }
    cam.x = clampRange(cam.x, 0, lvl.w - VW);
    cam.y = clampRange(cam.y, 0, lvl.h + PIT_VIEW - VH);
  };

  // ---------------------------------------------------------------- frame

  Renderer.prototype.render = function (world, dt, mode) {
    if (!world || !world.level || !world.player) return;
    if (world !== this.world) this.reset(world);
    var ctx = this.ctx, W = this.W, H = this.H, T = this.T;
    var raw = Math.max(0, Math.min(dt || 0, 0.25));
    if (raw > 0) this.fps += (1 / raw - this.fps) * 0.08;
    // Safety net for slow machines (e.g. no GPU canvas): after ~2 s below 40 fps, drop to 1x resolution
    // and skip the additive neon pass for the rest of the session.
    if (!this.lowQ && mode === 'play' && raw > 0) {
      this.slowT = this.fps < 40 ? (this.slowT || 0) + raw : Math.max(0, (this.slowT || 0) - raw);
      if (this.slowT > 2) this.lowQ = true;
    }
    var adt = mode === 'paused' ? 0 : Math.min(raw, 0.1);
    this.t += adt;
    this.frameNo++;
    this.update(world, adt);
    this.updateCamera(world, adt);
    this.computePalette();

    this.fitResolution();
    var rs = this.rs;
    ctx.setTransform(rs, 0, 0, rs, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, W, H);

    var cam = this.camera, lvl = world.level, p = world.player;
    // Offsets are snapped to whole DEVICE pixels so cached chunks meet without seams.
    var shx = 0, shy = 0;
    if (this.shakeT > 0 && settings().shake) {
      var s = this.shakeAmp * (this.shakeT / this.shakeDur);
      shx = Math.round((Math.random() * 2 - 1) * s * rs) / rs;
      shy = Math.round((Math.random() * 2 - 1) * s * rs) / rs;
    }
    var ox = Math.round(cam.x * T * rs) / rs, oy = Math.round(cam.y * T * rs) / rs;
    var tx = -ox + shx, ty = -oy + shy;
    this.vb.l = cam.x - 1; this.vb.t = cam.y - 1; this.vb.r = cam.x + W / T + 1; this.vb.b = cam.y + H / T + 1;
    var x0 = Math.max(0, Math.floor(cam.x) - 1), x1 = Math.min(lvl.w - 1, Math.ceil(cam.x + W / T));
    var y0 = Math.max(0, Math.floor(cam.y) - 1), y1 = Math.min(lvl.h - 1, Math.ceil(cam.y + H / T));
    this.scanCells(world, x0, x1, y0, y1);

    ctx.save();
    ctx.translate(tx, ty);
    this.drawAbyss(ctx, world, x0, x1, y0, y1);
    this.drawTerrain(ctx, tx, ty);
    ctx.restore();
    this.drawGlow(ctx, tx, ty);
    ctx.save();
    ctx.translate(tx, ty);
    this.drawPitFade(ctx, world, x0, x1);
    this.drawRuneGlyphs(ctx);
    this.drawCrumbles(ctx, world);
    this.drawStageFx(ctx);
    this.drawSigns(ctx, world);
    this.drawCheckpoints(ctx, world);
    this.drawExits(ctx, world);
    this.drawSawPaths(ctx, world);
    this.drawSpikes(ctx);
    this.drawSaws(ctx, world);
    this.drawPickups(ctx, world);
    this.drawAfterimages(ctx, p);
    this.drawBlinkPreview(ctx, world);
    this.drawPlayer(ctx, world);
    this.drawParticles(ctx);
    this.drawTexts(ctx);
    if (MW.CHEATS && MW.CHEATS.overlay) this.drawDebugWorld(ctx, world, x0, x1, y0, y1);
    ctx.restore();

    this.drawScreenFx(ctx, world);
    if (mode !== 'title') {
      this.drawHUD(ctx, world);
      this.drawSignBox(ctx);
    }
    this.drawDebugText(ctx, world, mode);
    this.evictChunks();
  };

  // The canvas is 960x540 logical px, scaled by CSS to the window. Render the backing store at the
  // displayed resolution (x1..x2, quarter steps) so lines and text stay crisp instead of upscaled.
  Renderer.prototype.fitResolution = function () {
    var cw = this.canvas.clientWidth || this.W;
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    var want = this.lowQ ? 1 : clamp(Math.round(cw * dpr / this.W * 4) / 4, 1, 2);
    if (want === this.rs && this.canvas.width === Math.round(this.W * want)) return;
    this.rs = want;
    this.canvas.width = Math.round(this.W * want);
    this.canvas.height = Math.round(this.H * want);
    this.tint.width = this.canvas.width;
    this.tint.height = this.canvas.height;
    this.flushChunks();
    this.pool = [];
  };

  // One pass over the visible cells: spikes, crumbling tiles, rune walls and abyss cells.
  Renderer.prototype.scanCells = function (world, x0, x1, y0, y1) {
    var lvl = world.level, grid = lvl.grid, cb = this.colBottom;
    var Sp = this.bufSp, Kr = this.bufKr, Rn = this.bufRn, Ab = this.bufAb;
    Sp.length = 0; Kr.length = 0; Rn.length = 0; Ab.length = 0;
    for (var y = y0; y <= y1; y++) {
      var row = grid[y];
      if (!row) continue;
      for (var x = x0; x <= x1; x++) {
        if (cb[x] !== undefined && y >= cb[x]) continue;
        var c = row[x];
        if (c === '.' || c === '#' || c === '=') continue;
        if (MW.SPIKES[c]) Sp.push(x, y);
        else if (c === '%') { if (!lvl.broken[x + ',' + y]) Kr.push(x, y); }
        else if (c === 'X') Rn.push(x, y);
        else if (c === '~') Ab.push(x, y, y === 0 || grid[y - 1][x] !== '~' ? 1 : 0);
      }
    }
    // Pits open to the bottom edge of a room read exactly like the abyss: a virtual exposed abyss cell
    // right below every open column of the room's last row.
    for (var cx = x0; cx <= x1; cx++) {
      var b = cb[cx];
      if (b === undefined || b < y0 - 1 || b > y1 + 2 || b < 1) continue;
      var above = grid[b - 1] && grid[b - 1][cx];
      if (above === '#' || above === 'X' || above === '%' || above === '~') continue;
      Ab.push(cx, b, 2);
    }
  };

  // ---------------------------------------------------------------- terrain: cells and tracing

  Renderer.prototype.visKind = function (x, y) {
    var lvl = this.world.level;
    if (x < 0 || x >= lvl.w) return K_EARTH;
    if (y < 0) return K_EMPTY;
    var b = this.colBottom[x];
    if (b === undefined) b = lvl.h;
    if (y >= b) {
      // Below a room: solid columns continue down into the darkness, open columns stay open (pits).
      var c0 = b > 0 && lvl.grid[b - 1] ? lvl.grid[b - 1][x] : '.';
      return c0 === '#' ? K_EARTH : c0 === 'X' ? K_RUNE : K_EMPTY;
    }
    var c = lvl.grid[y][x];
    switch (c) {
      case '#': return K_EARTH;
      case 'X': return K_RUNE;
      case '=': return K_PLANK;
      case '%': return K_CRUMBLE;
      case '~': return K_ABYSS;
      case '^': case 'v': case '<': case '>': return K_SPIKE;
    }
    return K_EMPTY;
  };

  Renderer.prototype.chunk = function (cx, cy) {
    var key = cx * 4096 + cy;
    var e = this.chunks[key];
    if (!e) e = this.chunks[key] = { cx: cx, cy: cy, geom: null, looks: {}, glow: null, used: 0 };
    return e;
  };

  // Look-independent geometry of one chunk: traced outlines (Path2D, world px) and decoration seeds.
  Renderer.prototype.buildGeom = function (cx, cy) {
    var T = this.T, n = CH + 2 * APRON, gx0 = cx * CH - APRON, gy0 = cy * CH - APRON;
    var kinds = new Uint8Array(n * n), i, j, x, y;
    for (j = 0; j < n; j++) for (i = 0; i < n; i++) kinds[j * n + i] = this.visKind(gx0 + i, gy0 + j);
    var any = false;
    for (j = APRON - 1; j < APRON + CH + 1 && !any; j++) {
      for (i = APRON - 1; i < APRON + CH + 1; i++) {
        var kk = kinds[j * n + i];
        if (kk === K_EARTH || kk === K_RUNE || kk === K_PLANK) { any = true; break; }
      }
    }
    if (!any) return { empty: true };
    var K = function (xx, yy) {
      var ii = xx - gx0, jj = yy - gy0;
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) return K_EMPTY;
      return kinds[jj * n + ii];
    };
    var S = CH * T;
    var g = { empty: false, ox: cx * S, oy: cy * S, size: S };
    // A top is lit (gets the light band and the fringe) unless a crumbling block sits on it.
    g.earth = this.traceKind(K, K_EARTH, gx0, gy0, n, function (up) { return up !== K_CRUMBLE && up !== K_RUNE; });
    g.rune = this.traceKind(K, K_RUNE, gx0, gy0, n, function () { return false; });

    // Decoration seeds for cells within the chunk +-1 tile (neighbours draw the same ones, clipped).
    var tops = g.tops = [], bottoms = g.bottoms = [], cells = g.cells = [], walls = g.walls = [];
    var xa = cx * CH - 1, xb = cx * CH + CH, ya = cy * CH - 1, yb = cy * CH + CH;
    for (y = ya; y <= yb; y++) {
      for (x = xa; x <= xb; x++) {
        if (K(x, y) !== K_EARTH) continue;
        var deep = K(x - 1, y) === K_EARTH && K(x + 1, y) === K_EARTH && K(x, y - 1) === K_EARTH && K(x, y + 1) === K_EARTH;
        cells.push(x, y, deep ? 1 : 0);
        var up = K(x, y - 1);
        if (up === K_EMPTY || up === K_SPIKE || up === K_ABYSS || up === K_PLANK) {
          // flags: 1 = a hazard on or next to this top (keep it clear), 2 = plank right above
          var fl = 0;
          if (up === K_SPIKE || K(x - 1, y - 1) === K_SPIKE || K(x + 1, y - 1) === K_SPIKE) fl |= 1;
          if (up === K_PLANK || up === K_ABYSS) fl |= 2;
          tops.push(x, y, fl);
        }
        if (K(x, y + 1) === K_EMPTY) bottoms.push(x, y, K(x, y + 2) === K_SPIKE || K(x, y + 1) === K_SPIKE ? 1 : 0);
        if (K(x - 1, y) === K_EMPTY) walls.push(x, y, -1);
        if (K(x + 1, y) === K_EMPTY) walls.push(x, y, 1);
      }
    }
    // Little mushrooms on some tops (deterministic per tile).
    var mush = g.mush = [];
    for (i = 0; i < tops.length; i += 3) {
      if (tops[i + 2]) continue;
      x = tops[i]; y = tops[i + 1];
      var h = hash(x * 7 + 3, y * 11 + 5);
      if (h % 5 !== 0) continue;
      var cnt = 1 + (h >>> 3) % 3;
      for (var m = 0; m < cnt; m++) {
        var hm = hash(x * 13 + m * 5, y * 17 - m);
        mush.push(x * T + 5 + (hm % 22), y * T + 1.2, 5 + ((hm >>> 6) % 7) - m, 3 + ((hm >>> 10) % 3), (((hm >>> 13) % 5) - 2) * 0.9, hm);
      }
    }
    // One-way planks: horizontal runs (runs crossing the window edge are clipped well outside the chunk).
    var planks = g.planks = [];
    for (y = gy0; y < gy0 + n; y++) {
      x = gx0;
      while (x < gx0 + n) {
        if (K(x, y) !== K_PLANK) { x++; continue; }
        var x2 = x;
        while (x2 + 1 < gx0 + n && K(x2 + 1, y) === K_PLANK) x2++;
        var la = K(x - 1, y), ra = K(x2 + 1, y);
        planks.push(x, x2, y, la === K_EARTH || la === K_RUNE ? 1 : 0, ra === K_EARTH || ra === K_RUNE ? 1 : 0);
        x = x2 + 1;
      }
    }
    return g;
  };

  // Traces the boundary of all `kind` cells in the window into closed loops (solid on the right, i.e.
  // clockwise on screen), rounds the corners and jitters the outline. Returns {has, body, top} where body
  // is the closed silhouette and top the open runs along lit top surfaces (both Path2D, world px).
  Renderer.prototype.traceKind = function (K, kind, gx0, gy0, n, litTest) {
    var T = this.T, edges = [], byStart = {};
    var key = function (x, y) { return (x + 64) * 8192 + (y + 64); };
    var add = function (x, y, dx, dy, lit) {
      var e = { x: x, y: y, dx: dx, dy: dy, lit: lit, used: false };
      edges.push(e);
      var k = key(x, y);
      (byStart[k] || (byStart[k] = [])).push(e);
    };
    var x, y;
    for (y = gy0; y < gy0 + n; y++) {
      for (x = gx0; x < gx0 + n; x++) {
        if (K(x, y) !== kind) continue;
        var up = K(x, y - 1);
        if (up !== kind) add(x, y, 1, 0, litTest(up));
        if (K(x + 1, y) !== kind) add(x + 1, y, 0, 1, false);
        if (K(x, y + 1) !== kind) add(x + 1, y + 1, -1, 0, false);
        if (K(x - 1, y) !== kind) add(x, y + 1, 0, -1, false);
      }
    }
    if (!edges.length) return { has: false };
    var body = new Path2D(), top = new Path2D(), hasTop = false;
    for (var i = 0; i < edges.length; i++) {
      if (edges[i].used) continue;
      // Walk the loop. At a saddle (two diagonal cells) always take the right turn: deterministic, and it
      // keeps diagonal neighbours as separate blobs.
      var loop = [], e = edges[i], start = e;
      for (var guard = 0; guard < 100000; guard++) {
        e.used = true;
        loop.push(e);
        var cand = byStart[key(e.x + e.dx, e.y + e.dy)], next = null;
        if (cand) {
          if (cand.length === 1) next = cand[0];
          else for (var c = 0; c < cand.length; c++) if (cand[c].dx === -e.dy && cand[c].dy === e.dx) next = cand[c];
          if (!next) next = cand[0];
        }
        if (!next || next === start || next.used) break;
        e = next;
      }
      if (loop.length < 4) continue;
      var pts = this.loopPoints(loop);
      if (smoothLoop(body, top, pts)) hasTop = true;
    }
    return { has: true, body: body, top: top, hasTop: hasTop };
  };

  // Unit edges of one loop -> jittered, corner-rounded points [x, y, lit, ...] in world px.
  Renderer.prototype.loopPoints = function (loop) {
    var T = this.T, m = loop.length, q, i;
    var s0 = 0;
    for (q = 0; q < m; q++) {
      var a0 = loop[(q + m - 1) % m], b0 = loop[q];
      if (a0.dx !== b0.dx || a0.dy !== b0.dy) { s0 = q; break; }
    }
    var segs = [];
    for (q = 0; q < m; q++) {
      var ed = loop[(s0 + q) % m], last = segs[segs.length - 1];
      if (last && last.dx === ed.dx && last.dy === ed.dy) { last.len++; last.lit.push(ed.lit); }
      else segs.push({ x: ed.x, y: ed.y, dx: ed.dx, dy: ed.dy, len: 1, lit: [ed.lit] });
    }
    var ns = segs.length, rad = [], convex = [];
    for (i = 0; i < ns; i++) {
      var A = segs[(i + ns - 1) % ns], B = segs[i];
      var cross = A.dx * B.dy - A.dy * B.dx;
      convex[i] = cross > 0;
      rad[i] = Math.min(cross > 0 ? R_CONVEX : R_CONCAVE, A.len * T * 0.5, B.len * T * 0.5);
    }
    // Outline wobble: tops stay close to the walking line, walls and undersides are more organic.
    var amp = function (s) { return s.dx > 0 ? 0.8 : s.dx < 0 ? 2.3 : 1.7; };
    var pts = [];
    var push = function (x, y, nx, ny, a, lit) {
      var j = jitter(x, y, a);
      pts.push(x + nx * j, y + ny * j, lit ? 1 : 0);
    };
    for (i = 0; i < ns; i++) {
      var Ai = segs[(i + ns - 1) % ns], Bi = segs[i], r = rad[i];
      var Vx = Bi.x * T, Vy = Bi.y * T;
      var nAx = Ai.dy, nAy = -Ai.dx, nBx = Bi.dy, nBy = -Bi.dx;   // outward normals
      var litA = Ai.lit[Ai.lit.length - 1], litB = Bi.lit[0];
      var ampA = amp(Ai), ampB = amp(Bi);
      var p0x = Vx - Ai.dx * r, p0y = Vy - Ai.dy * r, p1x = Vx + Bi.dx * r, p1y = Vy + Bi.dy * r;
      push(p0x, p0y, nAx, nAy, ampA, litA);
      var mx = 0.25 * p0x + 0.5 * Vx + 0.25 * p1x, my = 0.25 * p0y + 0.5 * Vy + 0.25 * p1y;
      var bx = nAx + nBx, by = nAy + nBy, bl = Math.sqrt(bx * bx + by * by) || 1;
      push(mx, my, bx / bl, by / bl, (ampA + ampB) * 0.5, convex[i] ? (litA || litB) : (litA && litB));
      push(p1x, p1y, nBx, nBy, ampB, litB);
      // World-aligned samples along the straight part of segment i.
      var L = Bi.len * T, rEnd = rad[(i + 1) % ns];
      var dir = Bi.dx || Bi.dy, horiz = Bi.dx !== 0;
      var u0 = horiz ? Vx : Vy;
      var us = u0 + dir * r, ue = u0 + dir * (L - rEnd);
      var u = dir > 0 ? Math.floor(us / SAMPLE) * SAMPLE + SAMPLE : Math.ceil(us / SAMPLE) * SAMPLE - SAMPLE;
      for (; dir > 0 ? u < ue - 3 : u > ue + 3; u += dir * SAMPLE) {
        if (Math.abs(u - us) < 3) continue;
        var idx = clamp(Math.floor((u - u0) * dir / T), 0, Bi.len - 1);
        if (horiz) push(u, Vy, nBx, nBy, ampB, Bi.lit[idx]);
        else push(Vx, u, nBx, nBy, ampB, Bi.lit[idx]);
      }
    }
    return pts;
  };

  // Closed silhouette through the midpoints (quadratic smoothing) + open runs of lit points on the same curve.
  function smoothLoop(body, top, P) {
    var n = P.length / 3;
    if (n < 3) return false;
    var mxp = function (a, b) { return (P[a * 3] + P[b * 3]) / 2; };
    var myp = function (a, b) { return (P[a * 3 + 1] + P[b * 3 + 1]) / 2; };
    body.moveTo(mxp(n - 1, 0), myp(n - 1, 0));
    var k;
    for (k = 0; k < n; k++) {
      var nk = (k + 1) % n;
      body.quadraticCurveTo(P[k * 3], P[k * 3 + 1], mxp(k, nk), myp(k, nk));
    }
    body.closePath();
    // Runs of lit points (cyclic): start the scan right after an unlit point.
    var startK = -1;
    for (k = 0; k < n; k++) if (!P[k * 3 + 2]) { startK = k; break; }
    if (startK < 0) return false;
    var any = false, inRun = false;
    for (var s = 1; s <= n; s++) {
      k = (startK + s) % n;
      var lit = P[k * 3 + 2] === 1;
      if (lit) {
        var pk = (k + n - 1) % n, nk2 = (k + 1) % n;
        if (!inRun) { top.moveTo(mxp(pk, k), myp(pk, k)); inRun = true; any = true; }
        top.quadraticCurveTo(P[k * 3], P[k * 3 + 1], mxp(k, nk2), myp(k, nk2));
      } else {
        inRun = false;
      }
    }
    return any;
  }

  // ---------------------------------------------------------------- terrain: chunk cache

  Renderer.prototype.allocCanvas = function () {
    var S = Math.round(CH * this.T * this.rs);
    var cv = this.pool.pop() || makeCanvas(S, S);
    if (cv.width !== S) { cv.width = S; cv.height = S; }
    this.canvasCount++;
    var c = cv.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, S, S);
    return cv;
  };

  Renderer.prototype.releaseChunk = function (e) {
    for (var k in e.looks) {
      if (this.pool.length < 12) this.pool.push(e.looks[k]);
      this.canvasCount--;
    }
    e.looks = {};
    if (e.glow) {
      if (this.pool.length < 12) this.pool.push(e.glow);
      this.canvasCount--;
      e.glow = null;
    }
  };

  Renderer.prototype.flushChunks = function () {
    for (var k in this.chunks) this.releaseChunk(this.chunks[k]);
    this.chunks = {};
  };

  Renderer.prototype.evictChunks = function () {
    var cap = Math.max(40, Math.round(MAX_CANVASES / (this.rs * this.rs)));
    if (this.canvasCount <= cap) return;
    var list = [], fn = this.frameNo;
    for (var k in this.chunks) {
      var e = this.chunks[k];
      if (e.used < fn - 1 && (e.glow || Object.keys(e.looks).length)) list.push(e);
    }
    list.sort(function (a, b) { return a.used - b.used; });
    for (var i = 0; i < list.length && this.canvasCount > cap * 0.8; i++) this.releaseChunk(list[i]);
  };

  // The cached canvas of chunk `e` in `look` (1..4 or 'ink'). Renders it when the per-frame budget allows
  // or when the chunk has nothing to show yet; otherwise returns another cached look (or null if !need).
  Renderer.prototype.lookOf = function (e, look, need) {
    var cv = e.looks[look];
    if (cv) return cv;
    var hasAny = false, other = null;
    for (var k in e.looks) { hasAny = true; other = e.looks[k]; if (k !== 'ink') break; }
    if (this.renders < RENDER_BUDGET || !hasAny) {
      this.renders++;
      cv = this.allocCanvas();
      var c = cv.getContext('2d');
      c.setTransform(this.rs, 0, 0, this.rs, -e.geom.ox * this.rs, -e.geom.oy * this.rs);
      if (look === 'ink') this.paintInk(c, e.geom); else this.paintColor(c, e.geom, look);
      e.looks[look] = cv;
      return cv;
    }
    return need ? other : null;
  };

  Renderer.prototype.glowOf = function (e) {
    if (e.glow) return e.glow;
    var cv = this.allocCanvas(), c = cv.getContext('2d');
    c.setTransform(this.rs, 0, 0, this.rs, -e.geom.ox * this.rs, -e.geom.oy * this.rs);
    this.paintGlow(c, e.geom);
    e.glow = cv;
    return cv;
  };

  Renderer.prototype.drawTerrain = function (ctx, tx, ty) {
    var S = CH * this.T, W = this.W, H = this.H;
    var cx0 = Math.floor(-tx / S), cx1 = Math.floor((-tx + W - 1) / S);
    var cy0 = Math.floor(-ty / S), cy1 = Math.floor((-ty + H - 1) / S);
    var list = this.visChunks, cx, cy, e, X, Y;
    list.length = 0;
    this.renders = 0;
    var ink = this.inkK, from = this.stageFrom, to = this.stageTo, k = smooth(this.stageK);
    for (cy = cy0; cy <= cy1; cy++) {
      for (cx = cx0; cx <= cx1; cx++) {
        e = this.chunk(cx, cy);
        e.used = this.frameNo;
        if (!e.geom) e.geom = this.buildGeom(cx, cy);
        if (e.geom.empty) continue;
        list.push(e);
        X = cx * S; Y = cy * S;
        if (ink < 1) {
          var cvTo = this.lookOf(e, to, true);
          if (k < 1 && from !== to) {
            var cvFrom = this.lookOf(e, from, false);
            if (cvFrom && cvFrom !== cvTo) { ctx.drawImage(cvFrom, X, Y, S, S); ctx.globalAlpha = k; }
          }
          ctx.drawImage(cvTo, X, Y, S, S);
          ctx.globalAlpha = 1;
        }
        if (ink > 0) {
          var cvi = this.lookOf(e, 'ink', true);
          ctx.globalAlpha = ink;
          ctx.drawImage(cvi, X, Y, S, S);
          ctx.globalAlpha = 1;
        }
      }
    }
    // Idle pre-warm: the next stage (every jump raises it), Clarity, then the rest, for visible chunks
    // and one chunk ahead in the facing direction.
    if (this.renders < 1 && this.world) {
      var st = this.stageTo, order = [st < 4 ? st + 1 : 3, 'ink', st, st > 1 ? st - 1 : 2, 1, 2, 3, 4];
      var face = this.world.player.facing < 0 ? -1 : 1;
      var extra = [], ex = face > 0 ? cx1 + 1 : cx0 - 1;
      if (ex >= 0 && ex * CH < this.world.level.w) for (cy = cy0; cy <= cy1; cy++) extra.push(ex, cy);
      for (var oi = 0; oi < order.length && this.renders < 1; oi++) {
        var look = order[oi];
        for (var li = 0; li < list.length && this.renders < 1; li++) {
          if (!list[li].looks[look]) this.lookOf(list[li], look, false);
        }
        if (oi === 0 || oi === 2) {
          for (var xi = 0; xi < extra.length && this.renders < 1; xi += 2) {
            e = this.chunk(extra[xi], extra[xi + 1]);
            e.used = this.frameNo;
            if (!e.geom) e.geom = this.buildGeom(extra[xi], extra[xi + 1]);
            if (!e.geom.empty && !e.looks[look]) this.lookOf(e, look, false);
          }
        }
      }
    }
  };

  // The bioluminescent fringe: cached white masks of the visible chunks, tinted with the live fringe colour
  // (rainbow-swept at D4) and added once more as neon bloom from D2 up. Fades out into Clarity.
  Renderer.prototype.drawGlow = function (ctx, tx, ty) {
    var a = 1 - this.inkK, list = this.visChunks;
    if (a <= 0.01 || !list.length) return;
    var rs = this.rs, W = this.tint.width, H = this.tint.height, S = CH * this.T, tc = this.tintCtx, pal = this.pal;
    tc.setTransform(1, 0, 0, 1, 0, 0);
    tc.globalCompositeOperation = 'source-over';
    tc.globalAlpha = 1;
    tc.clearRect(0, 0, W, H);
    tc.setTransform(rs, 0, 0, rs, tx * rs, ty * rs);
    for (var i = 0; i < list.length; i++) tc.drawImage(this.glowOf(list[i]), list[i].cx * S, list[i].cy * S, S, S);
    tc.setTransform(1, 0, 0, 1, 0, 0);
    tc.globalCompositeOperation = 'source-in';
    tc.fillStyle = css(pal.d.fringe);
    tc.fillRect(0, 0, W, H);
    if (pal.w4 > 0) {
      tc.globalCompositeOperation = 'source-atop';
      tc.globalAlpha = 0.8 * pal.w4;
      var gr = tc.createLinearGradient(0, 0, W, H * 0.6), sh = this.t * 140;
      for (var k = 0; k <= 6; k++) gr.addColorStop(k / 6, hsl(k * 60 + sh, 100, 64));
      tc.fillStyle = gr;
      tc.fillRect(0, 0, W, H);
      tc.globalAlpha = 1;
    }
    tc.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = a;
    ctx.drawImage(this.tint, 0, 0);
    var neon = clamp((this.stageF - 1.4) / 2.6, 0, 1) * a * Math.min(1.3, 0.4 + 0.6 * fxk());
    if (neon > 0.02 && !this.lowQ) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = neon * 0.6;
      ctx.drawImage(this.tint, 0, 0);
    }
    ctx.restore();
  };

  // ---------------------------------------------------------------- terrain: painting the looks

  // World-aligned diagonal hatching over the chunk (dir 1: "\" lines, -1: "/" lines).
  function hatch(c, g, dir, sp, style, lw) {
    var S = g.size, X = g.ox, Y = g.oy;
    c.beginPath();
    if (dir > 0) {
      // lines x - y = k*sp
      var lo = X - (Y + S), hi = X + S - Y;
      for (var k = Math.ceil(lo / sp); k * sp <= hi; k++) {
        var d = k * sp;
        c.moveTo(Y + d, Y); c.lineTo(Y + S + d, Y + S);
      }
    } else {
      // lines x + y = k*sp
      var lo2 = X + Y, hi2 = X + S + Y + S;
      for (var k2 = Math.ceil(lo2 / sp); k2 * sp <= hi2; k2++) {
        var d2 = k2 * sp;
        c.moveTo(d2 - Y, Y); c.lineTo(d2 - Y - S, Y + S);
      }
    }
    c.strokeStyle = style;
    c.lineWidth = lw;
    c.stroke();
  }

  Renderer.prototype.paintColor = function (c, g, s) {
    var P = SRGB[s], i;
    c.lineJoin = 'round';
    c.lineCap = 'round';
    var earth = g.earth;
    if (earth.has) {
      var body = earth.body, top = earth.top;
      c.fillStyle = css(P.groundDeep);
      c.fill(body);
      c.save();
      c.clip(body);
      var lift = [0, 0.16, 0.08, 0.05, 0.04][s];
      if (earth.hasTop) {
        // Light falls from the lit tops into the mass in soft bands.
        c.strokeStyle = css(mix(P.ground, P.groundEdge, lift * 0.5), 0.6); c.lineWidth = 84; c.stroke(top);
        c.strokeStyle = css(mix(P.ground, P.groundEdge, 0.1 + lift), 0.75); c.lineWidth = 46; c.stroke(top);
        c.strokeStyle = css(mix(P.ground, P.groundEdge, 0.26 + lift), 0.9); c.lineWidth = 20; c.stroke(top);
      }
      c.strokeStyle = css(P.ground, 0.55); c.lineWidth = 14; c.stroke(body);
      this.paintTexture(c, g, s, P);
      // woodcut ticks: short strokes perpendicular to every edge, just inside it
      c.save();
      c.setLineDash([1.3, 5.2]);
      c.lineCap = 'butt';
      c.strokeStyle = css(P.groundEdge, 0.28);
      c.lineWidth = 15;
      c.stroke(body);
      c.restore();
      c.strokeStyle = css(P.groundEdge, 0.35); c.lineWidth = 4; c.stroke(body);
      if (earth.hasTop) { c.strokeStyle = css(P.groundEdge, 0.95); c.lineWidth = 5.5; c.stroke(top); }
      c.restore();
      c.strokeStyle = css(P.ink); c.lineWidth = 3; c.stroke(body);
      // Little mushrooms: pale stems, caps in the stage accent, ink gills.
      var M = g.mush;
      if (M.length) {
        c.lineWidth = 1.8;
        c.strokeStyle = css(mix(P.groundEdge, C.white, 0.45));
        c.beginPath();
        for (i = 0; i < M.length; i += 6) {
          c.moveTo(M[i], M[i + 1]);
          c.quadraticCurveTo(M[i] + M[i + 4] * 0.2, M[i + 1] - M[i + 2] * 0.6, M[i] + M[i + 4], M[i + 1] - M[i + 2]);
        }
        c.stroke();
        c.beginPath();
        for (i = 0; i < M.length; i += 6) {
          var mx = M[i] + M[i + 4], my = M[i + 1] - M[i + 2], w = M[i + 3];
          c.moveTo(mx - w, my + 0.6);
          c.quadraticCurveTo(mx - w * 0.9, my - w * 1.15, mx, my - w * 1.1);
          c.quadraticCurveTo(mx + w * 0.9, my - w * 1.15, mx + w, my + 0.6);
          c.closePath();
        }
        c.fillStyle = css(P.accent);
        c.fill();
        c.strokeStyle = css(P.ink);
        c.lineWidth = 1.1;
        c.stroke();
      }
    }
    if (g.rune.has) {
      var rb = g.rune.body;
      c.fillStyle = css(RUNE_DARK);
      c.fill(rb);
      c.save();
      c.clip(rb);
      c.strokeStyle = css(RUNE, 0.55); c.lineWidth = 16; c.stroke(rb);
      hatch(c, g, 1, 9, css(RUNE, 0.18), 1.2);
      c.strokeStyle = css(RUNE_HI, 0.85); c.lineWidth = 3.5; c.stroke(rb);
      c.restore();
      c.strokeStyle = css(P.ink); c.lineWidth = 3; c.stroke(rb);
    }
    this.paintPlanks(c, g, mix(mix(C.wood, P.groundEdge, 0.35), P.accent, 0.12), P.ink, false);
  };

  // Per-world texture inside the earth (clipped), positions hashed per cell but free inside it:
  // D1 soft strata and pebbles, D2 marbled curls, D3 glowing veins, D4 gills and eyes ("eyes open everywhere").
  Renderer.prototype.paintTexture = function (c, g, s, P) {
    var T = this.T, cells = g.cells, i, x, y, h, h2, X, Y, k;
    var rx = function (hh, sh) { return ((hh >>> sh) & 255) / 255 * T; };
    // stipple
    c.fillStyle = css(P.groundEdge, s === 1 ? 0.24 : 0.17);
    c.beginPath();
    for (i = 0; i < cells.length; i += 3) {
      x = cells[i]; y = cells[i + 1];
      for (k = 0; k < 3; k++) {
        h = hash(x * 5 + k * 101, y * 9 + k * 57);
        var r = 0.6 + (h & 3) * 0.35, px = x * T + rx(h, 4), py = y * T + rx(h, 12);
        c.moveTo(px + r, py);
        c.arc(px, py, r, 0, TAU);
      }
    }
    c.fill();
    c.lineCap = 'round';
    if (s <= 2) {
      // soft mottling: dreamy clouds of lighter colour drifting inside the mass
      var mc = s === 1 ? P.groundEdge : P.glow, ma = s === 1 ? 0.16 : 0.1;
      for (i = 0; i < cells.length; i += 3) {
        x = cells[i]; y = cells[i + 1]; h = hash(x * 29 + 3, y * 31 + 11);
        if (h % 5) continue;
        var mxp = x * T + rx(h, 4), myp = y * T + rx(h, 12), mr = 16 + (h >>> 22) % 18;
        var mg = c.createRadialGradient(mxp, myp, 1, mxp, myp, mr);
        mg.addColorStop(0, css(mc, ma));
        mg.addColorStop(1, css(mc, 0));
        c.fillStyle = mg;
        c.fillRect(mxp - mr, myp - mr, mr * 2, mr * 2);
      }
    }
    if (s === 1) {
      // Dreamy sediment: long soft wavy strata, plus a few pale pebbles.
      c.strokeStyle = css(mix(P.ground, P.groundEdge, 0.45), 0.4);
      c.lineWidth = 1.6;
      c.beginPath();
      for (i = 0; i < cells.length; i += 3) {
        x = cells[i]; y = cells[i + 1]; h = hash(x * 3, y * 7 + 1);
        if (h % 3 === 0) continue;
        X = x * T; Y = y * T + 6 + (h % 20);
        c.moveTo(X - 3, Y + Math.sin(X * 0.05 + y * 1.3) * 2.5);
        c.bezierCurveTo(X + 10, Y - 3, X + 22, Y + 3, X + T + 3, Y + Math.sin((X + T) * 0.05 + y * 1.3) * 2.5);
      }
      c.stroke();
      c.beginPath();
      for (i = 0; i < cells.length; i += 3) {
        x = cells[i]; y = cells[i + 1]; h = hash(x * 13 + 7, y * 5 + 3);
        if (h % 5) continue;
        var pw = 3 + (h >>> 20) % 4, ph = 2 + (h >>> 24) % 2;
        c.moveTo(x * T + rx(h, 4) + pw, y * T + rx(h, 12));
        c.ellipse(x * T + rx(h, 4), y * T + rx(h, 12), pw, ph, ((h >>> 16) & 7) * 0.4, 0, TAU);
      }
      c.fillStyle = css(mix(P.groundEdge, P.accent, 0.35), 0.28);
      c.fill();
      c.strokeStyle = css(P.ink, 0.35);
      c.lineWidth = 1;
      c.stroke();
    } else if (s === 2) {
      // Marbled paper: long flowing magenta lines, tangerine curls riding on them.
      c.strokeStyle = css(P.glow, 0.2);
      c.lineWidth = 1.4;
      c.beginPath();
      for (i = 0; i < cells.length; i += 3) {
        x = cells[i]; y = cells[i + 1]; h = hash(x * 3 + 8, y * 11 + 1);
        if (h % 2) continue;
        X = x * T; Y = y * T + 4 + (h >>> 3) % 24;
        var ph = y * 2.1 + ((h >>> 9) & 3) * 0.7;
        c.moveTo(X - 4, Y + Math.sin(X * 0.07 + ph) * 5);
        for (k = 1; k <= 5; k++) { var ux = X - 4 + k * 8; c.lineTo(ux, Y + Math.sin(ux * 0.07 + ph) * 5); }
      }
      c.stroke();
      c.strokeStyle = css(P.accent, 0.38);
      c.lineWidth = 1.6;
      c.beginPath();
      for (i = 0; i < cells.length; i += 3) {
        x = cells[i]; y = cells[i + 1]; h = hash(x * 11 + 4, y * 3 + 9);
        if (h % 3 !== 0) continue;
        var cxp = x * T + rx(h, 4), cyp = y * T + rx(h, 12), rr = 4 + ((h >>> 20) % 6);
        var rot = ((h >>> 9) % 628) / 100, dirn = (h >>> 27) & 1 ? 1 : -1;
        for (k = 0; k <= 24; k++) {
          var f = k / 24, a = rot + dirn * f * TAU * 1.7;
          var px2 = cxp + Math.cos(a) * rr * (1 - f * 0.9), py2 = cyp + Math.sin(a) * rr * (1 - f * 0.9);
          if (k) c.lineTo(px2, py2); else c.moveTo(px2, py2);
        }
      }
      c.stroke();
    } else if (s === 3) {
      // Neon veins: branching random walks in acid green, with glowing knots.
      var veins = new Path2D(), knots = new Path2D();
      for (i = 0; i < cells.length; i += 3) {
        x = cells[i]; y = cells[i + 1]; h = hash(x * 7 + 2, y * 13 + 3);
        if (h % 2) continue;
        h2 = hash(h, 17);
        var vx = x * T + rx(h2, 3), vy = y * T + rx(h2, 13), ang = ((h >>> 10) % 628) / 100;
        veins.moveTo(vx, vy);
        for (k = 0; k < 5; k++) {
          ang += (((h >>> (14 + k * 3)) & 7) - 3.5) * 0.3;
          vx += Math.cos(ang) * 8; vy += Math.sin(ang) * 8;
          veins.lineTo(vx, vy);
          if (k === 2 && (h2 & 1)) {
            veins.lineTo(vx + Math.cos(ang + 1.2) * 9, vy + Math.sin(ang + 1.2) * 9);
            veins.moveTo(vx, vy);
          }
        }
        if (h % 6 === 0) { knots.moveTo(vx + 2, vy); knots.arc(vx, vy, 2, 0, TAU); }
      }
      c.strokeStyle = css(P.fringe, 0.16); c.lineWidth = 4.5; c.stroke(veins);
      c.strokeStyle = css(P.fringe, 0.5); c.lineWidth = 1.3; c.stroke(veins);
      c.fillStyle = css(P.accent, 0.8); c.fill(knots);
    } else {
      // Peak: gills (concentric arcs) and a few eyes deep in the mass.
      c.strokeStyle = css(P.groundEdge, 0.3);
      c.lineWidth = 1.2;
      c.beginPath();
      for (i = 0; i < cells.length; i += 3) {
        x = cells[i]; y = cells[i + 1]; h = hash(x * 17 + 5, y * 19 + 7);
        if (h % 3) continue;
        var gx = x * T + rx(h, 4), gy = y * T + rx(h, 12), a0 = ((h >>> 20) % 628) / 100, gr = 3.5 + ((h >>> 28) & 3);
        for (k = 1; k <= 3; k++) {
          c.moveTo(gx + Math.cos(a0) * k * gr, gy + Math.sin(a0) * k * gr);
          c.arc(gx, gy, k * gr, a0, a0 + 2.4);
        }
      }
      c.stroke();
      for (i = 0; i < cells.length; i += 3) {
        if (!cells[i + 2]) continue;
        x = cells[i]; y = cells[i + 1]; h = hash(x * 23 + 1, y * 29 + 3);
        if (h % 8) continue;
        var ex = x * T + 8 + rx(h, 4) * 0.5, ey = y * T + 8 + rx(h, 12) * 0.5;
        var ew = 8 + (h >>> 20) % 5, eh = 4 + ((h >>> 24) % 3) * 0.7, er = (((h >>> 26) & 7) - 3.5) * 0.12;
        c.save();
        c.translate(ex, ey);
        c.rotate(er);
        c.beginPath();
        c.moveTo(-ew, 0);
        c.quadraticCurveTo(0, -eh * 2, ew, 0);
        c.quadraticCurveTo(0, eh * 2, -ew, 0);
        c.fillStyle = css(mix(P.groundEdge, C.white, 0.6), 0.9);
        c.fill();
        c.strokeStyle = css(P.ink);
        c.lineWidth = 1.2;
        c.stroke();
        c.beginPath();
        c.arc(0, 0, eh * 0.95, 0, TAU);
        c.fillStyle = css(hsl2rgb(((h >>> 12) % 360) / 360, 1, 0.55));
        c.fill();
        c.beginPath();
        c.ellipse(0, 0, eh * 0.28, eh * 0.8, 0, 0, TAU);
        c.fillStyle = css(P.ink);
        c.fill();
        c.restore();
      }
    }
  };

  // Organic one-way planks: a gnarled root whose top edge is exactly the standing line.
  Renderer.prototype.paintPlanks = function (c, g, bark, inkRgb, inkMode) {
    var Pl = g.planks;
    if (!Pl.length) return;
    var T = this.T, i, u;
    for (i = 0; i < Pl.length; i += 5) {
      var xa = Pl[i] * T, xb = (Pl[i + 1] + 1) * T, y = Pl[i + 2] * T, attL = Pl[i + 3], attR = Pl[i + 4];
      var L = xa - (attL ? 6 : -1), R = xb + (attR ? 6 : -1);
      var th = function (x) {
        var e = Math.min(x - L, R - x);
        var taper = clamp(e / 14, 0.45, 1);
        return (8.5 + Math.sin(x * 0.11) * 1.6 + Math.sin(x * 0.037 + 1) * 1.4) * taper;
      };
      c.beginPath();
      c.moveTo(L, y + 0.5);
      for (u = Math.ceil(L / 8) * 8; u < R; u += 8) c.lineTo(u, y + jitter(u, y, 0.5));
      c.lineTo(R, y + 0.5);
      c.quadraticCurveTo(R + (attR ? 0 : 3), y + th(R) * 0.6, R - 2, y + th(R));
      for (u = Math.floor(R / 8) * 8; u > L; u -= 8) c.lineTo(u, y + th(u) + jitter(u, y + 50, 1.2));
      c.lineTo(L + 2, y + th(L));
      c.quadraticCurveTo(L - (attL ? 0 : 3), y + th(L) * 0.6, L, y + 0.5);
      c.closePath();
      c.fillStyle = css(bark);
      c.fill();
      c.save();
      c.clip();
      // bark grain
      c.strokeStyle = css(inkRgb, inkMode ? 0.55 : 0.35);
      c.lineWidth = 1;
      c.beginPath();
      for (var ln = 0; ln < 2; ln++) {
        var yy = y + 3 + ln * 3;
        c.moveTo(L, yy);
        for (u = Math.ceil(L / 6) * 6; u < R; u += 6) c.lineTo(u, yy + Math.sin(u * 0.2 + ln * 2) * 0.9);
      }
      c.stroke();
      c.fillStyle = css(mix(bark, C.white, 0.35), 0.55);
      c.fillRect(L, y, R - L, 2);
      c.restore();
      // knots
      c.beginPath();
      for (var tx0 = Pl[i]; tx0 <= Pl[i + 1]; tx0++) {
        var h = hash(tx0 * 31 + 7, Pl[i + 2] * 3);
        if (h % 3) continue;
        var kx = tx0 * T + 6 + (h >>> 3) % 20;
        c.moveTo(kx + 2.4, y + 5);
        c.ellipse(kx, y + 5, 2.4, 1.6, 0, 0, TAU);
      }
      c.strokeStyle = css(inkRgb, 0.7);
      c.lineWidth = 1;
      c.stroke();
      // outline
      c.beginPath();
      c.moveTo(L, y + 0.5);
      for (u = Math.ceil(L / 8) * 8; u < R; u += 8) c.lineTo(u, y + jitter(u, y, 0.5));
      c.lineTo(R, y + 0.5);
      c.quadraticCurveTo(R + (attR ? 0 : 3), y + th(R) * 0.6, R - 2, y + th(R));
      for (u = Math.floor(R / 8) * 8; u > L; u -= 8) c.lineTo(u, y + th(u) + jitter(u, y + 50, 1.2));
      c.lineTo(L + 2, y + th(L));
      c.quadraticCurveTo(L - (attL ? 0 : 3), y + th(L) * 0.6, L, y + 0.5);
      c.closePath();
      c.strokeStyle = css(inkRgb);
      c.lineWidth = 2.2;
      c.stroke();
      // hanging rootlets
      c.beginPath();
      for (var t2 = Pl[i]; t2 <= Pl[i + 1]; t2++) {
        var h2 = hash(t2 * 5 + 1, Pl[i + 2] * 7 + 3);
        if (h2 % 2) continue;
        var rx = t2 * T + 4 + (h2 >>> 2) % 24, ry = y + th(rx) - 1, rl = 5 + (h2 >>> 7) % 9;
        c.moveTo(rx, ry);
        c.bezierCurveTo(rx + 3, ry + rl * 0.4, rx - 3, ry + rl * 0.7, rx + 1, ry + rl);
      }
      c.strokeStyle = css(inkRgb, 0.75);
      c.lineWidth = 1.1;
      c.stroke();
    }
  };

  // The fringe mask (white; tinted live): halo, glowing band on lit tops, tufts, fern curls, hanging tendrils,
  // spores and glowing mushroom spots.
  Renderer.prototype.paintGlow = function (c, g) {
    var T = this.T, i, k, x, y, h;
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.strokeStyle = '#ffffff';
    c.fillStyle = '#ffffff';
    var earth = g.earth;
    if (earth.has && earth.hasTop) {
      c.globalAlpha = 0.06; c.lineWidth = 30; c.stroke(earth.top);
      c.globalAlpha = 0.12; c.lineWidth = 14; c.stroke(earth.top);
      c.globalAlpha = 1; c.lineWidth = 2.6; c.stroke(earth.top);
    }
    var tops = g.tops, bottoms = g.bottoms;
    // tufts and blades
    c.globalAlpha = 0.9;
    c.lineWidth = 1.2;
    c.beginPath();
    for (i = 0; i < tops.length; i += 3) {
      x = tops[i]; y = tops[i + 1]; h = hash(x * 3 + 1, y * 5 + 1);
      var tall = tops[i + 2] & 1 ? 0.5 : 1;
      for (k = 0; k < 4; k++) {
        var bx = x * T + 3 + k * 8 + ((h >>> (k * 4)) & 5), bh = (2.5 + ((h >>> (k * 3 + 8)) & 3) * 1.3) * tall;
        var lean = (((h >>> (k * 2 + 20)) & 3) - 1.5) * 1.4;
        c.moveTo(bx, y * T + 1);
        c.quadraticCurveTo(bx + lean * 0.3, y * T - bh * 0.6, bx + lean, y * T - bh);
      }
    }
    c.stroke();
    // fern fiddleheads
    c.lineWidth = 1.3;
    c.beginPath();
    for (i = 0; i < tops.length; i += 3) {
      if (tops[i + 2]) continue;
      x = tops[i]; y = tops[i + 1]; h = hash(x * 19 + 3, y * 7 + 11);
      if (h % 6 !== 2) continue;
      var fx = x * T + 6 + (h >>> 4) % 20, fy = y * T + 1, fh = 8 + (h >>> 9) % 8, fr = 2.6 + ((h >>> 13) % 3) * 0.6;
      var side = (h >>> 16) & 1 ? 1 : -1;
      c.moveTo(fx, fy);
      c.quadraticCurveTo(fx - side * 2, fy - fh * 0.6, fx + side * fr, fy - fh);
      for (k = 1; k <= 14; k++) {
        var f = k / 14, a = Math.PI + side * (-f * TAU * 1.1), rr = fr * (1 - f * 0.75);
        c.lineTo(fx + side * fr + Math.cos(a) * rr * side, fy - fh + Math.sin(a) * rr);
      }
    }
    c.stroke();
    // hanging tendrils with glowing tips
    c.lineWidth = 1.1;
    c.beginPath();
    var tips = [];
    for (i = 0; i < bottoms.length; i += 3) {
      if (bottoms[i + 2]) continue;
      x = bottoms[i]; y = bottoms[i + 1]; h = hash(x * 23 + 9, y * 3 + 2);
      if (h % 3) continue;
      var tx = x * T + 4 + (h >>> 3) % 24, ty = (y + 1) * T + 1, tl = 6 + (h >>> 8) % 14, sw = (((h >>> 14) & 7) - 3.5);
      c.moveTo(tx, ty);
      c.bezierCurveTo(tx + sw, ty + tl * 0.35, tx - sw, ty + tl * 0.7, tx + sw * 0.4, ty + tl);
      tips.push(tx + sw * 0.4, ty + tl);
    }
    c.stroke();
    c.beginPath();
    for (i = 0; i < tips.length; i += 2) { c.moveTo(tips[i] + 1.6, tips[i + 1]); c.arc(tips[i], tips[i + 1], 1.6, 0, TAU); }
    c.fill();
    // floating spores just above the tops
    c.globalAlpha = 0.7;
    c.beginPath();
    for (i = 0; i < tops.length; i += 3) {
      x = tops[i]; y = tops[i + 1]; h = hash(x * 41 + 5, y * 13 + 8);
      if (h % 3) continue;
      var sx = x * T + (h >>> 3) % T, sy = y * T - 5 - (h >>> 9) % 16, sr = 0.8 + ((h >>> 15) & 3) * 0.35;
      c.moveTo(sx + sr, sy);
      c.arc(sx, sy, sr, 0, TAU);
    }
    c.fill();
    // mushroom caps: halo + glowing spots
    var M = g.mush;
    for (i = 0; i < M.length; i += 6) {
      var mx = M[i] + M[i + 4], my = M[i + 1] - M[i + 2] - M[i + 3] * 0.5;
      c.globalAlpha = 0.16;
      c.beginPath(); c.arc(mx, my, M[i + 3] * 2.4, 0, TAU); c.fill();
      c.globalAlpha = 1;
      c.beginPath();
      c.arc(mx - M[i + 3] * 0.35, my - 0.5, 0.9, 0, TAU);
      c.moveTo(mx + M[i + 3] * 0.45 + 0.7, my);
      c.arc(mx + M[i + 3] * 0.45, my, 0.7, 0, TAU);
      c.fill();
    }
    c.globalAlpha = 1;
    // a glowing edge on one-way roots so they read as walkable
    var Pl = g.planks;
    if (Pl.length) {
      c.lineWidth = 2;
      c.globalAlpha = 0.85;
      c.beginPath();
      for (i = 0; i < Pl.length; i += 5) {
        c.moveTo(Pl[i] * T + 2, Pl[i + 2] * T + 0.5);
        c.lineTo((Pl[i + 1] + 1) * T - 2, Pl[i + 2] * T + 0.5);
      }
      c.stroke();
      c.globalAlpha = 1;
    }
  };

  // Clarity «Чернила»: an ink etching on warm paper. Paper-light rim at the surface, single hatching
  // below it and cross-hatching deep inside; dark ink outline with a second sketchy line.
  Renderer.prototype.paintInk = function (c, g) {
    var T = this.T, i, k, x, y, h;
    var paper = INK.paper, shade = INK.paperShade, ink = INK.ink;
    c.lineJoin = 'round';
    c.lineCap = 'round';
    var earth = g.earth;
    if (earth.has) {
      var body = earth.body, top = earth.top;
      c.fillStyle = css(shade);
      c.fill(body);
      c.save();
      c.clip(body);
      hatch(c, g, -1, 7, css(ink, 0.42), 0.9);
      c.strokeStyle = css(shade);
      if (earth.hasTop) { c.lineWidth = 54; c.stroke(top); }
      c.lineWidth = 22; c.stroke(body);
      c.lineCap = 'butt';
      hatch(c, g, 1, 5.5, css(ink, 0.5), 0.9);
      c.lineCap = 'round';
      if (earth.hasTop) { c.strokeStyle = css(paper); c.lineWidth = 11; c.stroke(top); }
      c.strokeStyle = css(paper, 0.6); c.lineWidth = 5; c.stroke(body);
      c.fillStyle = css(ink, 0.55);
      c.beginPath();
      var cells = g.cells;
      for (i = 0; i < cells.length; i += 3) {
        h = hash(cells[i] * 5 + 1, cells[i + 1] * 9 + 2);
        var dx = (h & 31), dy = ((h >>> 5) & 31);
        c.moveTo(cells[i] * T + dx + 0.8, cells[i + 1] * T + dy);
        c.arc(cells[i] * T + dx, cells[i + 1] * T + dy, 0.8, 0, TAU);
      }
      c.fill();
      c.restore();
      c.strokeStyle = css(ink);
      c.lineWidth = 3;
      c.stroke(body);
      c.save();
      c.translate(1.4, 1);
      c.strokeStyle = css(ink, 0.4);
      c.lineWidth = 1;
      c.stroke(body);
      c.restore();
      // ink grass and fern curls on the tops
      var tops = g.tops;
      c.strokeStyle = css(ink, 0.85);
      c.lineWidth = 1;
      c.beginPath();
      for (i = 0; i < tops.length; i += 3) {
        x = tops[i]; y = tops[i + 1]; h = hash(x * 3 + 1, y * 5 + 1);
        var tall = tops[i + 2] & 1 ? 0.5 : 1;
        for (k = 0; k < 4; k++) {
          var bx = x * T + 3 + k * 8 + ((h >>> (k * 4)) & 5), bh = (2.5 + ((h >>> (k * 3 + 8)) & 3) * 1.3) * tall;
          var lean = (((h >>> (k * 2 + 20)) & 3) - 1.5) * 1.4;
          c.moveTo(bx, y * T);
          c.quadraticCurveTo(bx + lean * 0.3, y * T - bh * 0.6, bx + lean, y * T - bh);
        }
      }
      c.stroke();
      var bottoms = g.bottoms;
      c.beginPath();
      for (i = 0; i < bottoms.length; i += 3) {
        if (bottoms[i + 2]) continue;
        x = bottoms[i]; y = bottoms[i + 1]; h = hash(x * 23 + 9, y * 3 + 2);
        if (h % 3) continue;
        var tx = x * T + 4 + (h >>> 3) % 24, ty = (y + 1) * T + 1, tl = 6 + (h >>> 8) % 14, sw = (((h >>> 14) & 7) - 3.5);
        c.moveTo(tx, ty);
        c.bezierCurveTo(tx + sw, ty + tl * 0.35, tx - sw, ty + tl * 0.7, tx + sw * 0.4, ty + tl);
      }
      c.stroke();
      // mushrooms: paper caps, ink outline and gills
      var M = g.mush;
      if (M.length) {
        c.strokeStyle = css(ink);
        c.lineWidth = 1.2;
        c.beginPath();
        for (i = 0; i < M.length; i += 6) {
          c.moveTo(M[i], M[i + 1]);
          c.quadraticCurveTo(M[i] + M[i + 4] * 0.2, M[i + 1] - M[i + 2] * 0.6, M[i] + M[i + 4], M[i + 1] - M[i + 2]);
        }
        c.stroke();
        c.beginPath();
        for (i = 0; i < M.length; i += 6) {
          var mx = M[i] + M[i + 4], my = M[i + 1] - M[i + 2], w = M[i + 3];
          c.moveTo(mx - w, my + 0.6);
          c.quadraticCurveTo(mx - w * 0.9, my - w * 1.15, mx, my - w * 1.1);
          c.quadraticCurveTo(mx + w * 0.9, my - w * 1.15, mx + w, my + 0.6);
          c.closePath();
        }
        c.fillStyle = css(paper);
        c.fill();
        c.stroke();
        c.lineWidth = 0.7;
        c.beginPath();
        for (i = 0; i < M.length; i += 6) {
          var gx = M[i] + M[i + 4], gy = M[i + 1] - M[i + 2], gw = M[i + 3];
          for (k = -1; k <= 1; k++) { c.moveTo(gx + k * gw * 0.4, gy + 0.3); c.lineTo(gx + k * gw * 0.55, gy - gw * 0.55); }
        }
        c.stroke();
      }
    }
    if (g.rune.has) {
      var rb = g.rune.body;
      c.fillStyle = css(mix(ink, INK.inkSoft, 0.25));
      c.fill(rb);
      c.save();
      c.clip(rb);
      hatch(c, g, 1, 7, css(paper, 0.16), 1);
      c.restore();
      c.strokeStyle = css(ink);
      c.lineWidth = 3;
      c.stroke(rb);
    }
    this.paintPlanks(c, g, INK.paper, ink, true);
  };

  // ---------------------------------------------------------------- abyss and pits

  // Abyss '~' (and the open bottom of rooms): a deep black-violet void with slow spiral stars, a thin
  // glowing rim on its exposed top and a faint mist rising from it. On paper: black ink with a red-orange rim.
  Renderer.prototype.drawAbyss = function (ctx, world, x0, x1, y0, y1) {
    var A = this.bufAb;
    if (!A.length) return;
    var T = this.T, t = this.t, ink = this.inkK, i, x, y, X, Y;
    var voidC = mix(ABYSS, INK.ink, ink), rim = mix(ABYSS_RIM, hex(HZ), ink);
    var rimHi = mix(mix(ABYSS_RIM, C.white, 0.45), hex(HZ_LIGHT), ink), star = mix(ABYSS_STAR, INK.paper, ink);
    var viewBot = (y1 + 3) * T;
    var surf = 0.22;   // the visible surface sits a little below the cell top (death triggers at +0.3)
    var wave = function (px) { return Math.sin(px * 0.09 + t * 2.2) * 1.5 + Math.sin(px * 0.031 - t * 1.3) * 1.2; };
    // fill
    var path = new Path2D(), rims = [];
    for (i = 0; i < A.length; i += 3) {
      x = A[i]; y = A[i + 1];
      var exposed = A[i + 2], X0 = x * T, X1 = X0 + T;
      var bottom = A[i + 2] === 2 ? viewBot : (y + 1) * T + 1;
      if (!exposed) { path.rect(X0 - 0.5, y * T - 0.5, T + 1, bottom - y * T + 0.5); continue; }
      var sy = (y + surf) * T;
      path.moveTo(X0 - 0.5, bottom);
      path.lineTo(X0 - 0.5, sy + wave(X0));
      for (var u = X0 + 8; u <= X1; u += 8) path.lineTo(u + (u === X1 ? 0.5 : 0), sy + wave(u));
      path.lineTo(X1 + 0.5, bottom);
      path.closePath();
      var last = rims.length - 3;
      if (last >= 0 && rims[last + 1] === X0 && rims[last + 2] === sy) rims[last + 1] = X1;
      else rims.push(X0, X1, sy);
    }
    // mist rising from exposed surfaces (drawn first, under the void edge)
    if (rims.length) {
      var mist = 0.24 * (1 - ink) + 0.1 * ink;
      for (i = 0; i < rims.length; i += 3) {
        var g = ctx.createLinearGradient(0, rims[i + 2] - 1.3 * T, 0, rims[i + 2]);
        g.addColorStop(0, css(rim, 0));
        g.addColorStop(1, css(rim, mist * (0.85 + 0.15 * Math.sin(t * 2 + rims[i] * 0.01))));
        ctx.fillStyle = g;
        ctx.fillRect(rims[i], rims[i + 2] - 1.3 * T, rims[i + 1] - rims[i], 1.3 * T);
      }
    }
    ctx.fillStyle = css(voidC, 0.97);
    ctx.fill(path);
    // spiral stars inside the void
    ctx.save();
    ctx.clip(path);
    ctx.fillStyle = css(star);
    ctx.beginPath();
    for (i = 0; i < A.length; i += 3) {
      x = A[i]; y = A[i + 1];
      var h = hash(x * 7 + 1, y * 3 + 5);
      var cx = (x + 0.5) * T, cy = (y + 0.75) * T;
      for (var k = 0; k < 3; k++) {
        var rr = 4 + k * 5 + (h >>> (k * 3)) % 4, sp = (0.35 + 0.2 * k) * ((h >>> 12) & 1 ? 1 : -1);
        var a = t * sp + k * 2.1 + (h % 628) / 100;
        var sr = 0.7 + 0.5 * Math.abs(Math.sin(t * 1.7 + h + k));
        var px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr * 0.55;
        ctx.moveTo(px + sr, py);
        ctx.arc(px, py, sr, 0, TAU);
      }
    }
    ctx.globalAlpha = 0.85;
    ctx.fill();
    // slow spiral arms across exposed runs
    ctx.strokeStyle = css(rim, 0.22 + 0.1 * ink);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (i = 0; i < rims.length; i += 3) {
      // a few slow spirals per run, spaced and sized irregularly (world-anchored, so they never jump)
      for (var sxw = Math.floor(rims[i] / (3 * T)) * 3 * T; sxw < rims[i + 1] + 2 * T; sxw += 3 * T) {
        var hs = hash(sxw / T | 0, rims[i + 2] | 0), sx = sxw + (hs % (3 * T)), syy = rims[i + 2] + (0.45 + ((hs >>> 8) % 40) / 100) * T;
        if (sx < rims[i] - 10 || sx > rims[i + 1] + 10) continue;
        var srad = 9 + (hs >>> 14) % 14, sdir = (hs >>> 20) & 1 ? 1 : -1, sspd = 0.35 + ((hs >>> 22) % 5) * 0.12;
        for (var arm = 0; arm < 2; arm++) {
          for (var q = 0; q <= 18; q++) {
            var f = q / 18, ang = sdir * (-t * sspd + arm * Math.PI + f * 5.2), rad = 1.5 + f * srad;
            var qx = sx + Math.cos(ang) * rad, qy = syy + Math.sin(ang) * rad * 0.5;
            if (q) ctx.lineTo(qx, qy); else ctx.moveTo(qx, qy);
          }
        }
      }
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();
    // glowing rim
    if (rims.length) {
      var rp = new Path2D();
      for (i = 0; i < rims.length; i += 3) {
        rp.moveTo(rims[i], rims[i + 2] + wave(rims[i]));
        for (var u2 = rims[i] + 8; u2 <= rims[i + 1]; u2 += 8) rp.lineTo(u2, rims[i + 2] + wave(u2));
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = css(rim, 0.2 * (1 - ink * 0.6)); ctx.lineWidth = 9; ctx.stroke(rp);
      ctx.strokeStyle = css(rim, 0.55); ctx.lineWidth = 3.6; ctx.stroke(rp);
      ctx.strokeStyle = css(rimHi); ctx.lineWidth = 1.5; ctx.stroke(rp);
    }
  };

  // Below every room the world fades into the void (solid columns continue down into it).
  Renderer.prototype.drawPitFade = function (ctx, world, x0, x1) {
    var lvl = world.level, T = this.T, rooms = lvl.rooms || [], ink = this.inkK;
    var voidC = mix(ABYSS, INK.ink, ink);
    var viewBot = (this.camera.y + this.H / T + 2) * T;
    for (var ri = 0; ri < rooms.length; ri++) {
      var r = rooms[ri];
      if (r.ox > x1 + 1 || r.ox + r.w < x0) continue;
      var by = r.oy + r.h;
      var topPx = (by + 0.3) * T;
      if (topPx > viewBot) continue;
      var rx0 = Math.max(r.ox, x0), rx1 = Math.min(r.ox + r.w, x1 + 1);
      var g = ctx.createLinearGradient(0, topPx, 0, (by + 1.1) * T);
      g.addColorStop(0, css(voidC, 0));
      g.addColorStop(1, css(voidC, 0.97));
      ctx.fillStyle = g;
      ctx.fillRect(rx0 * T, topPx, (rx1 - rx0) * T, Math.max(0, viewBot - topPx));
    }
  };

  // ---------------------------------------------------------------- live tiles

  Renderer.prototype.drawRuneGlyphs = function (ctx) {
    var R = this.bufRn;
    if (!R.length) return;
    var T = this.T, ink = this.inkK;
    var col = mix(RUNE_HI, INK.paper, ink);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var grp = 0; grp < 2; grp++) {
      var pulse = 0.65 + 0.35 * Math.sin(this.t * 2.2 + grp * 2.1);
      ctx.beginPath();
      for (var i = 0; i < R.length; i += 2) {
        var x = R[i], y = R[i + 1], h = hash(x * 3 + 1, y * 5 + 2);
        if ((h & 1) !== grp) continue;
        var gl = GLYPHS[(h >>> 1) % GLYPHS.length];
        var X = x * T + T * 0.14, Y = y * T + T * 0.14;
        for (var li = 0; li < gl.length; li++) {
          var line = gl[li];
          ctx.moveTo(X + line[0][0] * T * 0.72, Y + line[0][1] * T * 0.72);
          for (var pi = 1; pi < line.length; pi++) ctx.lineTo(X + line[pi][0] * T * 0.72, Y + line[pi][1] * T * 0.72);
        }
      }
      ctx.strokeStyle = css(col);
      ctx.globalAlpha = (0.3 * pulse) * (1 - ink);
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.globalAlpha = 0.55 + 0.45 * pulse * (1 - ink * 0.5);
      ctx.lineWidth = 1.7;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  };

  // Crumbling tiles: brittle crusts split by a jagged crack, with chipped tops and crumbs hanging below.
  // While breaking they shake and the two halves drift apart.
  Renderer.prototype.drawCrumbles = function (ctx, world) {
    var K = this.bufKr;
    if (!K.length) return;
    var T = this.T, lvl = world.level, ink = this.inkK, pal = this.pal, t = this.t;
    var base = mix(mix(C.crumble, pal.d.groundEdge, 0.3), pal.d.ground, 0.22);
    var fill = mix(base, INK.paperShade, ink);
    var light = mix(mix(base, C.white, 0.3), INK.paper, ink);
    var dark = mix(mix(base, C.line, 0.55), INK.ink, ink);
    var line = pal.line;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (var i = 0; i < K.length; i += 2) {
      var x = K[i], y = K[i + 1], key = x + ',' + y, cr = lvl.crumbling[key];
      var prog = cr !== undefined ? clamp(cr / (MW.P.crumbleDelay || 0.45), 0, 1) : 0;
      var h = hash(x * 7 + 3, y * 5 + 1);
      var shx = cr !== undefined ? Math.sin(t * 70 + x * 1.7) * (0.8 + 2 * prog) : 0;
      var shy = cr !== undefined ? Math.cos(t * 55 + y) * prog : 0;
      var X = x * T + shx, Y = y * T + shy;
      // the crack: a jagged line from the top edge to the bottom edge
      var cx0 = 0.35 + (h % 30) / 100, cz = [];
      for (var k = 0; k <= 5; k++) {
        var f = k / 5;
        cz.push(T * (cx0 + (k === 0 || k === 5 ? 0 : (((h >>> (k * 4)) & 15) - 7.5) / 60) + (f - 0.5) * ((h >>> 24) & 1 ? 0.12 : -0.12)), T * f);
      }
      var gap = 1.6 + prog * 4;
      // dark gap behind the crack
      ctx.beginPath();
      ctx.moveTo(X + cz[0], Y + 2);
      for (k = 1; k <= 5; k++) ctx.lineTo(X + cz[k * 2], Y + Math.min(T - 2, cz[k * 2 + 1]));
      ctx.strokeStyle = css(dark);
      ctx.lineWidth = 2.5 + prog * 4;
      ctx.stroke();
      for (var side = -1; side <= 1; side += 2) {
        ctx.save();
        ctx.translate(X + T / 2 + side * gap / 2, Y + T / 2 + prog * prog * 3);
        ctx.rotate(side * prog * 0.08);
        ctx.translate(-T / 2, -T / 2);
        ctx.beginPath();
        var chip = (h >>> (side < 0 ? 8 : 16)) & 1;
        if (side < 0) {
          ctx.moveTo(2, 6);
          ctx.quadraticCurveTo(2, 1.5, 6, 1.5);
          if (chip) { ctx.lineTo(9, 1.5); ctx.lineTo(11, 4.5); ctx.lineTo(13.5, 1.5); }
          ctx.lineTo(cz[0], 1.5);
          for (k = 1; k <= 5; k++) ctx.lineTo(cz[k * 2], Math.min(T - 2, cz[k * 2 + 1]));
          ctx.lineTo(7, T - 2);
          ctx.quadraticCurveTo(2, T - 2, 2, T - 7);
        } else {
          ctx.moveTo(cz[0], 1.5);
          if (chip) { ctx.lineTo(T - 12, 1.5); ctx.lineTo(T - 9.5, 4); ctx.lineTo(T - 7.5, 1.5); }
          ctx.lineTo(T - 6, 1.5);
          ctx.quadraticCurveTo(T - 2, 1.5, T - 2, 6);
          ctx.lineTo(T - 2, T - 7);
          ctx.quadraticCurveTo(T - 2, T - 2, T - 7, T - 2);
          for (k = 5; k >= 1; k--) ctx.lineTo(cz[k * 2], Math.min(T - 2, cz[k * 2 + 1]));
        }
        ctx.closePath();
        ctx.fillStyle = css(fill);
        ctx.fill();
        ctx.save();
        ctx.clip();
        ctx.fillStyle = css(light, 0.8);
        ctx.fillRect(0, 0, T, 4);
        ctx.fillStyle = css(dark, 0.35);
        ctx.fillRect(0, T * 0.66, T, T);
        // hairline cracks branching off the main crack into this half
        ctx.strokeStyle = css(dark, 0.75);
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (k = 0; k < 2; k++) {
          var hh = hash(h + k * 31 + (side < 0 ? 7 : 13), 5), sxc = cz[(2 + k) * 2], syc = cz[(2 + k) * 2 + 1];
          var ang = (side < 0 ? Math.PI : 0) + (((hh & 255) / 255) - 0.5) * 1.6, len = 5 + (hh >>> 8) % 7;
          ctx.moveTo(sxc, syc);
          ctx.lineTo(sxc + Math.cos(ang) * len * 0.55, syc + Math.sin(ang) * len * 0.55 + (((hh >>> 12) & 3) - 1.5));
          ctx.lineTo(sxc + Math.cos(ang + 0.35) * len, syc + Math.sin(ang + 0.35) * len);
        }
        ctx.stroke();
        ctx.restore();
        ctx.strokeStyle = line;
        ctx.lineWidth = 1.8;
        ctx.stroke();
        ctx.restore();
      }
      // crumbs hanging under the tile, falling while it gives way
      ctx.fillStyle = css(dark, 0.85);
      ctx.beginPath();
      for (k = 0; k < 3; k++) {
        var hx = X + 5 + ((h >>> (k * 5)) % 22), fall = prog > 0 ? ((t * 40 + k * 11) % 16) : 1 + k % 2;
        ctx.moveTo(hx + 1.3, Y + T + fall);
        ctx.arc(hx, Y + T + fall, prog > 0 ? 1.1 : 0.9, 0, TAU);
      }
      ctx.fill();
    }
  };

  // ---------------------------------------------------------------- stage-change FX (under hazards)

  Renderer.prototype.drawStageFx = function (ctx) {
    var F = this.stageFx;
    if (!F.length) return;
    var T = this.T, kfx = Math.max(0.4, Math.min(1.5, fxk()));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (var i = 0; i < F.length; i++) {
      var f = F[i], k = clamp(f.t / f.life, 0, 1), X = f.x * T, Y = f.y * T, fade = 1 - k;
      var e = 1 - (1 - k) * (1 - k) * (1 - k);
      var r = f.up ? (0.4 + 7.5 * e) * T : (6.5 - 6 * k * k) * T;
      // chromatic ripple: three offset rings (red-magenta / green / blue)
      var cols = ['255,50,150', '90,255,150', '110,120,255'];
      for (var c = 0; c < 3; c++) {
        ctx.strokeStyle = 'rgba(' + cols[c] + ',' + (0.75 * fade * kfx).toFixed(3) + ')';
        ctx.lineWidth = 2 + 7 * fade;
        ctx.beginPath();
        ctx.arc(X + (c - 1) * 4 * fade, Y + (c - 1) * 1.5 * fade, Math.max(1, r * (1 + (c - 1) * 0.035)), 0, TAU);
        ctx.stroke();
      }
      if (f.up) {
        // a second, thinner echo
        var r2 = (0.2 + 4.2 * e) * T;
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.5 * fade * kfx).toFixed(3) + ')';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(X, Y, r2, 0, TAU);
        ctx.stroke();
      }
      if (f.bloom) {
        // D4: a kaleidoscope bloom of rainbow petals, two counter-rotating layers.
        for (var layer = 0; layer < 2; layer++) {
          var nP = layer ? 8 : 12, rot = (layer ? -1 : 1) * k * 1.6 + layer * 0.3;
          var r0 = (0.3 + 1.2 * e) * T, r1 = (1.2 + (layer ? 3.6 : 5.4) * e) * T, wdt = (layer ? 0.32 : 0.2);
          ctx.globalAlpha = (layer ? 0.32 : 0.42) * fade * kfx;
          for (var pi = 0; pi < nP; pi++) {
            var a = rot + pi * TAU / nP;
            ctx.beginPath();
            ctx.moveTo(X + Math.cos(a) * r0, Y + Math.sin(a) * r0);
            ctx.quadraticCurveTo(X + Math.cos(a - wdt) * (r0 + r1) * 0.55, Y + Math.sin(a - wdt) * (r0 + r1) * 0.55,
              X + Math.cos(a) * r1, Y + Math.sin(a) * r1);
            ctx.quadraticCurveTo(X + Math.cos(a + wdt) * (r0 + r1) * 0.55, Y + Math.sin(a + wdt) * (r0 + r1) * 0.55,
              X + Math.cos(a) * r0, Y + Math.sin(a) * r0);
            ctx.fillStyle = hsl(pi * (360 / nP) + this.t * 240 + layer * 30, 100, 62);
            ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  };

  // ---------------------------------------------------------------- hazards (crisp red-orange, never warped)

  Renderer.prototype.drawSpikes = function (ctx) {
    var Sp = this.bufSp;
    if (!Sp.length) return;
    var T = this.T, grid = this.world.level.grid, i, j, c, x, y, a, b, m;
    // dark base strip
    ctx.fillStyle = HZ_DARK;
    ctx.beginPath();
    for (i = 0; i < Sp.length; i += 2) {
      x = Sp[i]; y = Sp[i + 1]; c = grid[y][x];
      a = spikeMap(c, x, y, 0.02, 0, T); b = spikeMap(c, x, y, 0.98, 0.1, T);
      ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    }
    ctx.fill();
    // teeth
    ctx.beginPath();
    for (i = 0; i < Sp.length; i += 2) {
      x = Sp[i]; y = Sp[i + 1]; c = grid[y][x];
      for (j = 0; j < TEETH.length; j++) {
        var tt = TEETH[j];
        a = spikeMap(c, x, y, tt[0], 0.04, T);
        m = spikeMap(c, x, y, (tt[0] + tt[1]) / 2, tt[2], T);
        b = spikeMap(c, x, y, tt[1], 0.04, T);
        ctx.moveTo(a[0], a[1]); ctx.lineTo(m[0], m[1]); ctx.lineTo(b[0], b[1]); ctx.closePath();
      }
    }
    ctx.lineJoin = 'miter';
    ctx.strokeStyle = HZ_DARK;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = HZ;
    ctx.fill();
    // lit edge of each tooth
    ctx.beginPath();
    for (i = 0; i < Sp.length; i += 2) {
      x = Sp[i]; y = Sp[i + 1]; c = grid[y][x];
      for (j = 0; j < TEETH.length; j++) {
        var t2 = TEETH[j];
        a = spikeMap(c, x, y, t2[0] + 0.07, 0.12, T);
        m = spikeMap(c, x, y, (t2[0] + t2[1]) / 2 - 0.01, t2[2] - 0.1, T);
        ctx.moveTo(a[0], a[1]); ctx.lineTo(m[0], m[1]);
      }
    }
    ctx.strokeStyle = HZ_LIGHT;
    ctx.lineWidth = 1.3;
    ctx.lineCap = 'round';
    ctx.stroke();
  };

  Renderer.prototype.inView = function (x, y, m) {
    var v = this.vb;
    return x > v.l - m && x < v.r + m && y > v.t - m && y < v.b + m;
  };

  Renderer.prototype.drawSawPaths = function (ctx, world) {
    var saws = world.level.saws, T = this.T;
    var col = mix(hex('#ebe6f5'), INK.ink, this.inkK);
    ctx.setLineDash([3, 6]);
    ctx.strokeStyle = css(col, 0.3);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (var i = 0; i < saws.length; i++) {
      var path = saws[i].path;
      if (!path || path.length < 2 || !saws[i].speed) continue;
      ctx.beginPath();
      ctx.moveTo(path[0][0] * T, path[0][1] * T);
      for (var j = 1; j < path.length; j++) ctx.lineTo(path[j][0] * T, path[j][1] * T);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = css(col, 0.35);
    ctx.beginPath();
    for (var k = 0; k < saws.length; k++) {
      var pt = saws[k].path;
      if (!pt || pt.length < 2 || !saws[k].speed) continue;
      var e0 = pt[0], e1 = pt[pt.length - 1];
      ctx.moveTo(e0[0] * T + 3, e0[1] * T); ctx.arc(e0[0] * T, e0[1] * T, 3, 0, TAU);
      ctx.moveTo(e1[0] * T + 3, e1[1] * T); ctx.arc(e1[0] * T, e1[1] * T, 3, 0, TAU);
    }
    ctx.fill();
  };

  Renderer.prototype.drawSaws = function (ctx, world) {
    var saws = world.level.saws, T = this.T, rot = (world.time || 0) * 10;
    ctx.lineJoin = 'miter';
    for (var i = 0; i < saws.length; i++) {
      var s = saws[i];
      if (!this.inView(s.x, s.y, s.r + 1)) continue;
      var X = s.x * T, Y = s.y * T, R = s.r * T, n = 12, step = TAU / n;
      ctx.beginPath();
      for (var k = 0; k < n; k++) {
        var a0 = rot + k * step;
        if (k) ctx.lineTo(X + Math.cos(a0) * R * 0.8, Y + Math.sin(a0) * R * 0.8);
        else ctx.moveTo(X + Math.cos(a0) * R * 0.8, Y + Math.sin(a0) * R * 0.8);
        ctx.lineTo(X + Math.cos(a0 + step * 0.72) * R * 1.08, Y + Math.sin(a0 + step * 0.72) * R * 1.08);
        ctx.lineTo(X + Math.cos(a0 + step) * R * 0.8, Y + Math.sin(a0 + step) * R * 0.8);
      }
      ctx.closePath();
      ctx.strokeStyle = HZ_DARK;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = HZ;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(X, Y, R * 0.58, 0, TAU);
      ctx.fillStyle = HZ_MID;
      ctx.fill();
      ctx.strokeStyle = HZ_LIGHT;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(X, Y, R * 0.42, rot, rot + 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(X, Y, R * 0.17, 0, TAU);
      ctx.fillStyle = HZ_DARK;
      ctx.fill();
    }
  };

  // ---------------------------------------------------------------- entities

  Renderer.prototype.drawCheckpoints = function (ctx, world) {
    var cps = world.level.checkpoints, T = this.T, ink = this.inkK, line = this.pal.lineS;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (var i = 0; i < cps.length; i++) {
      var c = cps[i];
      if (!this.inView(c.x + 0.5, c.y + 0.5, 2)) continue;
      var idx = c.index !== undefined ? c.index : i;
      var state = idx === world.cpIndex ? 2 : (idx < world.cpIndex ? 1 : 0);  // 2 active, 1 passed, 0 not reached
      // A tall mushroom lamp post (taller than the wizard, so the cap stays visible at spawn).
      var cx = (c.x + 0.5) * T, by = (c.y + 1) * T, capY = by - 40;
      if (state === 2 && ink < 1) {
        var pr = 1.7 * T * (0.92 + 0.08 * Math.sin(this.t * 3));
        var g = ctx.createRadialGradient(cx, capY + 4, 2, cx, capY + 4, pr);
        g.addColorStop(0, 'rgba(245,198,91,' + (0.45 * (1 - ink)).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(245,198,91,0)');
        ctx.fillStyle = g;
        ctx.fillRect(cx - pr, capY + 4 - pr, pr * 2, pr * 2);
      }
      var stemC = state ? hex('#efe2c0') : hex('#6d6458');
      var capC = state === 2 ? hex(GOLD) : (state === 1 ? hex(GOLD_DIM) : hex('#5b5149'));
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = line;
      // stem
      ctx.beginPath();
      ctx.moveTo(cx - 3.6, by + 1);
      ctx.bezierCurveTo(cx - 0.5, by - 14, cx - 4, by - 26, cx - 2, capY + 2);
      ctx.lineTo(cx + 2, capY + 2);
      ctx.bezierCurveTo(cx, by - 26, cx + 3, by - 14, cx + 3.6, by + 1);
      ctx.closePath();
      ctx.fillStyle = css(mix(stemC, INK.paper, ink));
      ctx.fill();
      ctx.stroke();
      // lantern bulb under the cap
      ctx.beginPath();
      ctx.arc(cx, capY + 5, 3.4, 0, TAU);
      ctx.fillStyle = state === 2 ? (ink > 0.5 ? css(INK.ink) : GOLD_HI) : (state === 1 ? 'rgba(232,209,138,0.75)' : '#3a3530');
      ctx.fill();
      // cap
      ctx.beginPath();
      ctx.moveTo(cx - 14, capY + 1);
      ctx.bezierCurveTo(cx - 14, capY - 12, cx - 6, capY - 17, cx + 1, capY - 16);
      ctx.bezierCurveTo(cx + 9, capY - 15, cx + 14, capY - 9, cx + 14, capY + 1);
      ctx.quadraticCurveTo(cx, capY - 4, cx - 14, capY + 1);
      ctx.closePath();
      ctx.fillStyle = css(mix(capC, state === 2 ? INK.inkSoft : INK.paper, ink));
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = state === 2 ? (ink > 0.5 ? css(INK.paper) : GOLD_HI) : (state === 1 ? '#e6d29a' : '#776b60');
      ctx.beginPath();
      ctx.arc(cx - 5, capY - 8, 2, 0, TAU); ctx.moveTo(cx + 6.6, capY - 6); ctx.arc(cx + 5, capY - 6, 1.6, 0, TAU);
      ctx.fill();
      // the checkpoint's stage, in that stage's colour
      var pl = world.player, near = Math.abs(pl.x + pl.w / 2 - (c.x + 0.5)) < 1.2 && Math.abs(pl.y + pl.h - (c.y + 1)) < 2;
      ctx.globalAlpha = near ? 0.25 : 1;
      ctx.font = 'italic bold 12px ' + SERIF;
      var lc = ink > 0.5 ? css(INK.ink) : (state === 0 ? 'rgba(244,238,255,0.6)' : css(SIG[c.stage] || SIG[1]));
      outlinedText(ctx, 'D' + c.stage, cx, capY - 23, lc, ink > 0.5 ? css(INK.paper) : 'rgba(10,6,16,0.85)', 3);
      ctx.globalAlpha = 1;
    }
  };

  Renderer.prototype.drawSigns = function (ctx, world) {
    var signs = world.level.signs, T = this.T, ink = this.inkK, line = this.pal.lineS;
    var wood = mix(mix(C.wood, this.pal.d.groundEdge, 0.25), INK.paper, ink);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (var i = 0; i < signs.length; i++) {
      var s = signs[i];
      if (!this.inView(s.x + 0.5, s.y + 0.5, 1)) continue;
      var sx = (s.x + 0.5) * T, by = (s.y + 1) * T;
      var active = world.activeSign === s;
      var bob = active ? Math.sin(this.t * 6) * 1 : 0;
      ctx.strokeStyle = line;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sx - 1.6, by + 1); ctx.quadraticCurveTo(sx - 2.5, by - 8, sx - 1.2, by - 16);
      ctx.lineTo(sx + 1.6, by - 16); ctx.quadraticCurveTo(sx + 0.5, by - 8, sx + 1.8, by + 1);
      ctx.closePath();
      ctx.fillStyle = css(mix(wood, C.line, 0.3));
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx - 12, by - 26 + bob);
      ctx.quadraticCurveTo(sx, by - 29 + bob, sx + 12, by - 27 + bob);
      ctx.quadraticCurveTo(sx + 14, by - 20 + bob, sx + 11, by - 14 + bob);
      ctx.quadraticCurveTo(sx, by - 12 + bob, sx - 11, by - 14 + bob);
      ctx.quadraticCurveTo(sx - 14, by - 20 + bob, sx - 12, by - 26 + bob);
      ctx.closePath();
      ctx.fillStyle = css(wood);
      ctx.fill();
      ctx.strokeStyle = active ? (ink > 0.5 ? css(CYAN_DEEP_RGB) : 'rgba(255,255,255,0.95)') : line;
      ctx.lineWidth = active ? 2 : 1.5;
      ctx.stroke();
      ctx.strokeStyle = css(this.pal.line, 0.7);
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(sx - 7, by - 22 + bob); ctx.lineTo(sx + 6, by - 22.5 + bob);
      ctx.moveTo(sx - 7, by - 18 + bob); ctx.lineTo(sx + 2, by - 18 + bob);
      ctx.stroke();
    }
  };

  Renderer.prototype.drawExits = function (ctx, world) {
    var exits = world.level.exits, T = this.T;
    for (var i = 0; i < exits.length; i++) {
      var e = exits[i];
      if (!this.inView(e.x + 0.5, e.y, 2)) continue;
      // The exit trigger spans rows y-1..y+1, so the portal is centred on the cell's top edge.
      var cx = (e.x + 0.5) * T, cy = e.y * T, rx = 0.48 * T, ry = 0.98 * T, ink = this.inkK;
      var g = ctx.createRadialGradient(cx, cy, 2, cx, cy, 1.6 * T);
      g.addColorStop(0, 'rgba(125,255,154,' + (0.4 * (1 - ink)).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(125,255,154,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - 1.6 * T, cy - 1.6 * T, 3.2 * T, 3.2 * T);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
      ctx.fillStyle = css(mix(hex('#0a1e14'), INK.paperShade, ink), 0.75);
      ctx.fill();
      var cols = ink > 0.5 ? [css(INK.ink), css(INK.inkSoft), css(INK.ink)] : [C.portal, '#ffffff', C.portalPink];
      ctx.lineCap = 'round';
      for (var arm = 0; arm < 3; arm++) {
        ctx.beginPath();
        for (var k = 0; k <= 20; k++) {
          var f = k / 20, a = this.t * 2.5 + arm * TAU / 3 + f * 4.2, r = 1 - f * 0.92;
          var px = cx + Math.cos(a) * rx * r, py = cy + Math.sin(a) * ry * r;
          if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        }
        ctx.strokeStyle = cols[arm];
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
      ctx.strokeStyle = this.pal.lineS;
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = ink > 0.5 ? css(INK.paper) : C.portal;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  };

  Renderer.prototype.drawPickups = function (ctx, world) {
    var pks = world.level.pickups, T = this.T, ink = this.inkK, line = this.pal.lineS;
    ctx.lineJoin = 'round';
    for (var i = 0; i < pks.length; i++) {
      var q = pks[i];
      if (q.taken || !this.inView(q.x, q.y, 1)) continue;
      var X = q.x * T, Y = q.y * T + Math.sin(this.t * 3 + q.x) * 2.5;
      if (q.type === 'crystal') {
        var gr = 15 + 3 * Math.sin(this.t * 4 + q.x);
        var g = ctx.createRadialGradient(X, Y, 1, X, Y, gr);
        g.addColorStop(0, 'rgba(79,227,240,0.5)');
        g.addColorStop(1, 'rgba(79,227,240,0)');
        ctx.fillStyle = g;
        ctx.fillRect(X - gr, Y - gr, gr * 2, gr * 2);
        ctx.beginPath();
        ctx.moveTo(X, Y - 10); ctx.lineTo(X + 6.5, Y - 1); ctx.lineTo(X, Y + 9.5); ctx.lineTo(X - 6.5, Y - 1); ctx.closePath();
        ctx.fillStyle = CYAN;
        ctx.fill();
        ctx.strokeStyle = ink > 0.5 ? css(INK.ink) : '#0d4a52';
        ctx.lineWidth = 1.3;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(X, Y - 10); ctx.lineTo(X - 6.5, Y - 1); ctx.lineTo(X - 1, Y - 1); ctx.closePath();
        ctx.fillStyle = CYAN_HI;
        ctx.fill();
        var sa = this.t * 3 + q.x;
        ctx.beginPath();
        star4(ctx, X + Math.cos(sa) * 11, Y + Math.sin(sa) * 6, 2.5, 0);
        ctx.fillStyle = ink > 0.5 ? CYAN_DEEP : '#ffffff';
        ctx.fill();
      } else {
        // Mushroom: PURPLE cap with cream spots (never red: red-orange means danger).
        if (ink < 1) {
          ctx.beginPath();
          ctx.arc(X, Y, 14, 0, TAU);
          ctx.fillStyle = 'rgba(176,78,224,' + (0.18 * (1 - ink)).toFixed(3) + ')';
          ctx.fill();
        }
        ctx.strokeStyle = line;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(X - 3, Y + 8); ctx.quadraticCurveTo(X - 3.4, Y + 3, X - 2.4, Y); ctx.lineTo(X + 2.4, Y);
        ctx.quadraticCurveTo(X + 3.4, Y + 3, X + 3, Y + 8); ctx.closePath();
        ctx.fillStyle = css(mix(hex(C.stem), INK.paper, ink));
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(X - 11, Y + 1);
        ctx.bezierCurveTo(X - 11, Y - 9, X - 5, Y - 12, X, Y - 12);
        ctx.bezierCurveTo(X + 5, Y - 12, X + 11, Y - 9, X + 11, Y + 1);
        ctx.quadraticCurveTo(X, Y - 3, X - 11, Y + 1);
        ctx.closePath();
        ctx.fillStyle = css(mix(hex(C.mush), INK.paper, ink));
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(X - 4, Y - 6, 1.9, 0, TAU);
        ctx.moveTo(X + 5.4, Y - 4.5); ctx.arc(X + 4, Y - 4.5, 1.4, 0, TAU);
        ctx.moveTo(X + 1.2, Y - 9); ctx.arc(X, Y - 9, 1.2, 0, TAU);
        ctx.fillStyle = ink > 0.5 ? line : C.mushSpot;
        ctx.fill();
      }
    }
  };

  // ---------------------------------------------------------------- the wizard

  // Hat cone centre line [x, y, angle, halfWidth]*: the turning grows toward the tip, so the cone bends at D1,
  // curls at D2/D3 and rolls into a spiral at D4. Straight in Clarity.
  function hatLine(curl, len) {
    var n = 18, out = [];
    var x = 0.8, y = -37.4, ang = -Math.PI / 2 - 0.12;
    var cc = clamp(curl, 0, 1.2), total = curl * 8.6, pw = 2 + 1.3 * cc;
    for (var i = 0; i <= n; i++) {
      var s = i / n;
      out.push(x, y, ang, 7.4 * Math.pow(1 - s, 0.85) + 0.6);
      if (i === n) break;
      ang -= total * (Math.pow((i + 1) / n, pw) - Math.pow(s, pw));
      var ds = len / n * (1 - 0.62 * s * Math.min(1, cc));
      x += Math.cos(ang) * ds; y += Math.sin(ang) * ds;
    }
    return out;
  }

  function smoothPoly(ctx, xs, ys) {
    var n = xs.length;
    ctx.moveTo((xs[n - 1] + xs[0]) / 2, (ys[n - 1] + ys[0]) / 2);
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      ctx.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[j]) / 2, (ys[i] + ys[j]) / 2);
    }
    ctx.closePath();
  }

  // o: {facing, sx, sy, lean, stage, curl, hatLen, eyes:'droopy'|'spiral'|'rainbow'|'clear', third, ink (0..1),
  //     swing (px), staffRgb, staffGlowRgb, mode:'normal'|'outline'|'flat', color, lw}
  // Local space: facing right, feet centre at (0,0), up is negative.
  Renderer.prototype.drawWizard = function (ctx, px, py, o) {
    var mode = o.mode || 'normal', flat = mode === 'flat', outline = mode === 'outline', normal = mode === 'normal';
    var ink = normal ? (o.ink || 0) : 0, t = this.t, st = o.stage || 1, i;
    var line = normal ? css(ink > 0 ? mix(C.line, INK.ink, ink) : C.line) : o.color;
    var lw = outline ? (o.lw || 2) : 1.7;
    var sw = o.swing || 0;
    ctx.save();
    ctx.translate(px, py);
    if (o.lean) ctx.rotate(o.lean);
    ctx.scale((o.facing < 0 ? -1 : 1) * (o.sx || 1), o.sy || 1);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = line;
    ctx.lineWidth = lw;
    if (flat) ctx.fillStyle = o.color;
    var col = function (rgb) { return css(ink > 0 ? mix(rgb, INK.paper, ink) : rgb); };
    var paint = function (rgb, path) {
      if (outline) { if (path) ctx.stroke(path); else ctx.stroke(); return; }
      if (normal) ctx.fillStyle = col(rgb);
      if (path) ctx.fill(path); else ctx.fill();
      if (normal) { if (path) ctx.stroke(path); else ctx.stroke(); }
    };

    // staff (behind), topped with a little glowing mushroom
    ctx.beginPath();
    ctx.moveTo(9.4, 0.5);
    ctx.quadraticCurveTo(13.2, -19, 11.8, -40);
    if (normal) {
      ctx.lineWidth = 4.4; ctx.stroke();
      ctx.strokeStyle = col(C.staff); ctx.lineWidth = 2.2; ctx.stroke();
      ctx.strokeStyle = line; ctx.lineWidth = lw;
    } else if (outline) {
      ctx.lineWidth = lw + 2.4; ctx.stroke(); ctx.lineWidth = lw;
    } else {
      ctx.strokeStyle = o.color; ctx.lineWidth = 3; ctx.stroke();
    }
    if (normal && o.staffGlowRgb) {
      var gg = ctx.createRadialGradient(12, -42, 1, 12, -42, 9);
      gg.addColorStop(0, css(o.staffGlowRgb, 0.6));
      gg.addColorStop(1, css(o.staffGlowRgb, 0));
      ctx.fillStyle = gg;
      ctx.fillRect(3, -51, 18, 18);
    }
    ctx.beginPath();
    ctx.moveTo(8.2, -39.6);
    ctx.bezierCurveTo(8.3, -43.6, 10.4, -44.8, 12, -44.8);
    ctx.bezierCurveTo(13.6, -44.8, 15.7, -43.6, 15.8, -39.6);
    ctx.quadraticCurveTo(12, -41, 8.2, -39.6);
    ctx.closePath();
    paint(o.staffRgb || C.white);
    if (normal) {
      ctx.fillStyle = css(mix(C.white, INK.paper, ink), 0.9);
      ctx.beginPath();
      ctx.arc(10.6, -42.6, 0.8, 0, TAU); ctx.moveTo(14, -42); ctx.arc(13.4, -42, 0.6, 0, TAU);
      ctx.fill();
    }

    // robe: a bell with a scalloped hem that trails behind the motion
    var robe = new Path2D();
    robe.moveTo(-5.4, -26.8);
    robe.bezierCurveTo(-7.6, -18, -10.8 - sw * 0.4, -9, -12.8 - sw, -1.4);
    var hx0 = -12.8 - sw, hx1 = 12.6 - sw * 0.5;
    for (i = 1; i <= 4; i++) {
      var xa = hx0 + (hx1 - hx0) * (i - 0.5) / 4, xb = hx0 + (hx1 - hx0) * i / 4;
      robe.quadraticCurveTo(xa, 1.6 + Math.sin(t * 5 + i * 1.7) * 0.5, xb, i < 4 ? -1.1 : -1.4);
    }
    robe.bezierCurveTo(10.8 - sw * 0.3, -9, 8.2, -18, 6.2, -26.8);
    robe.quadraticCurveTo(0.4, -29.4, -5.4, -26.8);
    robe.closePath();
    paint(C.robe, robe);
    if (normal) {
      ctx.save();
      ctx.clip(robe);
      // back shading
      ctx.fillStyle = col(C.robeDark);
      ctx.beginPath();
      ctx.moveTo(-14 - sw, 2); ctx.bezierCurveTo(-9, -12, -6, -20, -3, -30); ctx.lineTo(-20, -30); ctx.closePath();
      ctx.fill();
      this.robePattern(ctx, st, ink);
      // hem trim in the stage accent
      ctx.fillStyle = css(mix(SRGB[st].accent, INK.inkSoft, ink), 0.95);
      ctx.fillRect(-20, -4.2, 40, 8);
      ctx.restore();
      ctx.stroke(robe);
    }

    // front sleeve + hand on the staff
    ctx.beginPath();
    ctx.moveTo(1.2, -25.6);
    ctx.quadraticCurveTo(7.8, -26.2, 12, -18.4);
    ctx.lineTo(9.2, -14.4);
    ctx.quadraticCurveTo(5.2, -20, 0.6, -20.6);
    ctx.closePath();
    paint(C.robe);
    ctx.beginPath();
    ctx.arc(11, -16.4, 2.5, 0, TAU);
    paint(C.skin);

    // head
    ctx.beginPath();
    ctx.arc(1.8, -31.2, 6.6, 0, TAU);
    paint(C.skin);
    if (normal && ink < 1 && st > 1) {
      ctx.globalAlpha = 0.45 * (st - 1) / 3 * (1 - ink);
      ctx.fillStyle = '#ff7fb0';
      ctx.beginPath();
      ctx.ellipse(-1.6, -28.6, 2, 1.2, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // beard: long, wavy, the tip curls forward (and wiggles when drunk)
    var bw = normal ? Math.sin(t * 2.3) * 0.7 * (st - 1) * (1 - ink) : 0;
    ctx.beginPath();
    ctx.moveTo(-4.6, -30.4);
    ctx.bezierCurveTo(-5.4, -22, -1.8, -15, 3 + bw, -10.6);
    ctx.bezierCurveTo(3.8 + bw, -13.4, 6.6, -16, 7.8, -19.6);
    ctx.bezierCurveTo(8.8, -23, 9, -27, 8.3, -29.4);
    ctx.quadraticCurveTo(5.4, -26.4, 2.2, -27.3);
    ctx.quadraticCurveTo(-1.6, -26.9, -4.6, -30.4);
    ctx.closePath();
    paint(C.beard);
    if (normal) {
      ctx.strokeStyle = css(ink > 0 ? mix(C.line, INK.ink, ink) : C.line, 0.3);
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(-1.5, -25.5); ctx.quadraticCurveTo(-1, -19, 2.6 + bw * 0.6, -14.5);
      ctx.moveTo(3.4, -25.2); ctx.quadraticCurveTo(4.4, -21, 5.6, -17.6);
      ctx.stroke();
      ctx.strokeStyle = line;
      ctx.lineWidth = lw;
    }
    // nose: big and droopy, a little bigger with every stage
    var ns = 1 + (normal ? 0.07 * (st - 1) * (1 - ink) : 0);
    ctx.beginPath();
    ctx.ellipse(8.3, -29.4, 2.4 * ns, 3.1 * ns, -0.55, 0, TAU);
    paint(C.nose);
    if (normal) this.drawEyes(ctx, o.eyes, st, ink, line);

    // hat: a tapered cone along the curled centre line, a wide floppy brim
    var hl = hatLine(o.curl || 0, o.hatLen || 27), n = hl.length / 4, xs = [], ys = [];
    for (i = 0; i < n; i++) {
      var a = hl[i * 4 + 2], w = hl[i * 4 + 3];
      xs.push(hl[i * 4] - Math.sin(a) * w); ys.push(hl[i * 4 + 1] + Math.cos(a) * w);
    }
    for (i = n - 1; i >= 0; i--) {
      var a2 = hl[i * 4 + 2], w2 = hl[i * 4 + 3];
      xs.push(hl[i * 4] + Math.sin(a2) * w2); ys.push(hl[i * 4 + 1] - Math.cos(a2) * w2);
    }
    ctx.beginPath();
    smoothPoly(ctx, xs, ys);
    paint(C.hat);
    if (normal) {
      // band and little stars in the stage accent
      var acc = css(mix(SRGB[st].accent, INK.inkSoft, ink));
      ctx.strokeStyle = acc;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(xs[2], ys[2]); ctx.lineTo(xs[xs.length - 3], ys[ys.length - 3]);
      ctx.stroke();
      ctx.fillStyle = acc;
      ctx.beginPath();
      var si1 = Math.min(n - 1, 7), si2 = Math.min(n - 1, 11);
      star4(ctx, hl[si1 * 4] + 1.5, hl[si1 * 4 + 1], 1.7, 0.3);
      star4(ctx, hl[si2 * 4] - 0.5, hl[si2 * 4 + 1], 1.3, 0.9);
      ctx.fill();
      ctx.strokeStyle = line;
      ctx.lineWidth = lw;
      // snail-shell spiral drawn on the coiled end (D3 hint, D4 full)
      var sk = clamp(((o.curl || 0) - 0.5) / 0.35, 0, 1);
      if (sk > 0) {
        var i0 = Math.floor(n * 0.55), cxs = 0, cys = 0, cnt = 0;
        for (i = i0; i < n; i++) { cxs += hl[i * 4]; cys += hl[i * 4 + 1]; cnt++; }
        cxs /= cnt; cys /= cnt;
        var rs = 0;
        for (i = i0; i < n; i++) rs += Math.sqrt(Math.pow(hl[i * 4] - cxs, 2) + Math.pow(hl[i * 4 + 1] - cys, 2));
        rs = rs / cnt + 2.2;
        ctx.save();
        ctx.globalAlpha = sk;
        ctx.beginPath();
        for (i = 0; i <= 40; i++) {
          var f = i / 40, aa = -t * 1.5 + f * TAU * 2.2, rr = rs * (1 - f);
          if (i) ctx.lineTo(cxs + Math.cos(aa) * rr, cys + Math.sin(aa) * rr);
          else ctx.moveTo(cxs + Math.cos(aa) * rr, cys + Math.sin(aa) * rr);
        }
        ctx.strokeStyle = acc;
        ctx.lineWidth = 2.2;
        ctx.stroke();
        ctx.strokeStyle = line;
        ctx.lineWidth = 0.9;
        ctx.stroke();
        ctx.restore();
        ctx.strokeStyle = line;
        ctx.lineWidth = lw;
      }
      // tip ornament
      var tx = hl[(n - 1) * 4], ty = hl[(n - 1) * 4 + 1];
      ctx.beginPath();
      star4(ctx, tx, ty, 3, t * 2);
      ctx.fillStyle = st === 4 && ink < 1 ? hsl(t * 200, 100, 70) : acc;
      ctx.fill();
    }
    ctx.beginPath();
    ctx.ellipse(1.2, -36.6, 12.6, 2.9, -0.04, 0, TAU);
    paint(C.hat);
    if (normal && o.third) this.drawThirdEye(ctx, hl[4 * 4], hl[4 * 4 + 1], hl[4 * 4 + 2], line);
    ctx.restore();
  };

  Renderer.prototype.robePattern = function (ctx, st, ink) {
    var t = this.t, k;
    if (ink >= 0.99) return;
    ctx.globalAlpha = 1 - ink;
    ctx.lineCap = 'round';
    if (st === 1) {
      ctx.fillStyle = css(SRGB[1].accent);
      ctx.beginPath();
      star4(ctx, -4.5, -10, 2.1, 0); star4(ctx, 3, -18.5, 1.6, 0.4); star4(ctx, 5.5, -8, 1.4, 0.2);
      ctx.fill();
    } else if (st === 2) {
      ctx.strokeStyle = css(SRGB[2].accent);
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      for (k = 0; k < 2; k++) {
        var yy = -9 - k * 8;
        ctx.moveTo(-15, yy);
        for (var x = -15; x <= 15; x += 2) ctx.lineTo(x, yy + Math.sin(x * 0.55 + t * 3 + k) * 1.6);
      }
      ctx.stroke();
    } else if (st === 3) {
      ctx.strokeStyle = css(SRGB[3].fringe);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      var eyes = [[-5, -9], [3.5, -17], [5.5, -6.5]];
      for (k = 0; k < eyes.length; k++) {
        ctx.moveTo(eyes[k][0] + 2.6, eyes[k][1]);
        ctx.arc(eyes[k][0], eyes[k][1], 2.6, 0, TAU);
      }
      ctx.stroke();
      ctx.fillStyle = css(SRGB[3].accent);
      ctx.beginPath();
      for (k = 0; k < eyes.length; k++) { ctx.moveTo(eyes[k][0] + 1, eyes[k][1]); ctx.arc(eyes[k][0], eyes[k][1], 1, 0, TAU); }
      ctx.fill();
    } else {
      ctx.lineWidth = 2.6;
      for (k = 0; k < 7; k++) {
        ctx.strokeStyle = hsl(k * 50 + t * 160, 100, 62);
        ctx.beginPath();
        ctx.moveTo(-18 + k * 5.5, 2); ctx.lineTo(-6 + k * 5.5, -30);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  };

  Renderer.prototype.drawEyes = function (ctx, kind, st, ink, line) {
    var t = this.t, ey = -32.4, E = [-0.2, 4.6], k, i;
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = line;
    var white = css(mix(C.white, INK.paper, ink));
    if (kind === 'clear') {
      ctx.beginPath();
      for (k = 0; k < 2; k++) { ctx.moveTo(E[k] + 2.4, ey); ctx.arc(E[k], ey, 2.4, 0, TAU); }
      ctx.fillStyle = white; ctx.fill(); ctx.stroke();
      ctx.beginPath();
      for (k = 0; k < 2; k++) { ctx.moveTo(E[k] + 0.4 + 1.6, ey); ctx.arc(E[k] + 0.4, ey, 1.6, 0, TAU); }
      ctx.fillStyle = CYAN; ctx.fill();
      ctx.beginPath();
      for (k = 0; k < 2; k++) { ctx.moveTo(E[k] + 0.5 + 0.75, ey); ctx.arc(E[k] + 0.5, ey, 0.75, 0, TAU); }
      ctx.fillStyle = css(INK.ink); ctx.fill();
      return;
    }
    if (kind === 'droopy') {
      // heavy, half-closed lids; a slow blink now and then
      var blink = (t % 3.7) < 0.14 ? 1 : 0;
      var lid = 0.55 + 0.45 * blink;
      ctx.beginPath();
      for (k = 0; k < 2; k++) { ctx.moveTo(E[k] + 2.2, ey); ctx.ellipse(E[k], ey, 2.2, 2, 0, 0, TAU); }
      ctx.fillStyle = white; ctx.fill();
      ctx.beginPath();
      for (k = 0; k < 2; k++) { ctx.moveTo(E[k] + 0.5 + 1.05, ey + 0.7); ctx.arc(E[k] + 0.5, ey + 0.7, 1.05, 0, TAU); }
      ctx.fillStyle = css(C.line); ctx.fill();
      for (k = 0; k < 2; k++) {
        ctx.save();
        ctx.beginPath(); ctx.ellipse(E[k], ey, 2.25, 2.05, 0, 0, TAU); ctx.clip();
        ctx.fillStyle = css(mix(C.skin, hex('#d9a9c0'), 0.4));
        ctx.fillRect(E[k] - 3, ey - 2.2, 6, 4.4 * lid);
        ctx.restore();
      }
      ctx.beginPath();
      for (k = 0; k < 2; k++) {
        var ly = ey - 2.2 + 4.4 * lid;
        ctx.moveTo(E[k] - 2.4, ly - 0.3); ctx.quadraticCurveTo(E[k], ly + 0.5, E[k] + 2.4, ly - 0.3);
      }
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      for (k = 0; k < 2; k++) { ctx.moveTo(E[k] + 2.2, ey); ctx.ellipse(E[k], ey, 2.2, 2, 0, 0, TAU); }
      ctx.lineWidth = 0.8;
      ctx.stroke();
      return;
    }
    // spirals (D2) / rainbow spirals (D3, D4)
    var r = kind === 'rainbow' ? 2.8 : 2.6;
    ctx.beginPath();
    for (k = 0; k < 2; k++) { ctx.moveTo(E[k] + r, ey); ctx.arc(E[k], ey, r, 0, TAU); }
    ctx.fillStyle = white; ctx.fill(); ctx.stroke();
    var turns = 1.5 + 0.2 * st, rot = t * (2.5 + st);
    if (kind !== 'rainbow') {
      ctx.beginPath();
      spiral(ctx, E[0], ey, r - 0.3, turns, rot);
      spiral(ctx, E[1], ey, r - 0.3, turns, rot + 1.3);
      ctx.strokeStyle = line;
      ctx.lineWidth = 0.85;
      ctx.stroke();
      return;
    }
    ctx.lineWidth = 1;
    for (k = 0; k < 2; k++) {
      var px0 = E[k], py0 = ey, rr0 = rot + k * 1.3;
      for (i = 0; i < 9; i++) {
        ctx.beginPath();
        for (var j = 0; j <= 2; j++) {
          var f = (i * 2 + j) / 18, a = rr0 + f * turns * TAU;
          var qx = E[k] + Math.cos(a) * (r - 0.3) * f, qy = ey + Math.sin(a) * (r - 0.3) * f;
          if (j) ctx.lineTo(qx, qy); else ctx.moveTo(qx, qy);
        }
        ctx.strokeStyle = hsl(i * 40 + t * 300, 100, 50);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = line;
  };

  // D4: a third eye opens on the hat.
  Renderer.prototype.drawThirdEye = function (ctx, x, y, ang, line) {
    var t = this.t, open = 1 - (t % 2.9 < 0.16 ? Math.sin((t % 2.9) / 0.16 * Math.PI) : 0);
    var w = 4.2, h = 2.9 * open;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang + Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(-w, 0);
    ctx.quadraticCurveTo(0, -h * 1.6, w, 0);
    ctx.quadraticCurveTo(0, h * 1.6, -w, 0);
    ctx.closePath();
    ctx.fillStyle = '#fffaf2';
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.beginPath();
    ctx.arc(0, 0, 2.3, 0, TAU);
    ctx.fillStyle = hsl(t * 220, 100, 55);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.55, 1.7, 0, 0, TAU);
    ctx.fillStyle = css(C.line);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-w, 0);
    ctx.quadraticCurveTo(0, -h * 1.6, w, 0);
    ctx.quadraticCurveTo(0, h * 1.6, -w, 0);
    ctx.stroke();
    ctx.restore();
  };

  // Builds the look of the live player and draws it: aura, the wizard, the Clarity timer arc, hiccup bubble.
  Renderer.prototype.drawPlayer = function (ctx, world) {
    var p = world.player;
    if (p.dead) return;
    var T = this.T, P = MW.P, st = clamp(p.stage | 0, 1, 4), clar = p.clarity, ink = this.inkK, pal = this.pal;
    var px = (p.x + p.w / 2) * T, py = (p.y + p.h) * T;

    // aura in the stage colour
    var auraA = (0.2 + 0.07 * this.stageF) * (1 - ink) * (0.85 + 0.15 * Math.sin(this.t * 3.1)) * Math.min(1.3, 0.5 + 0.5 * fxk());
    if (auraA > 0.01) {
      var R = 30 + 8 * this.stageF, cy0 = py - 0.8 * T;
      var g = ctx.createRadialGradient(px, cy0, 2, px, cy0, R);
      g.addColorStop(0, css(pal.d.aura, Math.min(0.75, auraA)));
      g.addColorStop(0.45, css(pal.d.aura, auraA * 0.45));
      g.addColorStop(1, css(pal.d.aura, 0));
      ctx.fillStyle = g;
      ctx.fillRect(px - R, cy0 - R, R * 2, R * 2);
    }

    var s = this.sq + (p.grounded ? 0 : Math.min(0.1, Math.abs(p.vy) * 0.006));
    var sy = 1 + s, sx = 1 - s * 0.7;
    var lean = 0;
    if (!clar) {
      if (!p.grounded && p.swayActive) {
        // Lean with the sway: the sway velocity follows cos() of the curve from take-off.
        var amp = P.swayAmp && P.swayAmp[st] ? P.swayAmp[st] : 0;
        lean = p.swayDir * Math.cos(TAU * p.airT / (P.swayPeriod || 0.9)) * amp * 0.45;
      } else {
        lean = Math.sin(this.t * 1.9) * 0.035 * (st - 1);   // tipsy idle wobble
      }
    }
    lean = clamp(lean + clamp(p.vx / 8, -1, 1) * 0.07, -0.28, 0.28);
    var wob = clar ? 0 : Math.sin(this.t * 3.3) * 0.045 * (st - 1);
    var look = {
      facing: p.facing, sx: sx, sy: sy, lean: lean, stage: st, ink: ink,
      curl: this.curl + wob, hatLen: clar ? HAT_LEN[0] : HAT_LEN[st],
      eyes: clar ? 'clear' : (st === 1 ? 'droopy' : st === 2 ? 'spiral' : 'rainbow'),
      third: !clar && st >= 4,
      swing: clamp(p.vx * (p.facing < 0 ? -1 : 1) * 0.4, -3, 3.5),
      staffRgb: clar ? (p.spellUsed ? hex('#9aa6ab') : CYAN_RGB) : pal.d.accent,
      staffGlowRgb: clar ? (p.spellUsed ? null : CYAN_RGB) : pal.d.aura,
    };
    if (ink > 0.02) {
      // Clarity: a thin cyan halo around the clean ink drawing.
      ctx.globalAlpha = 0.55 * ink;
      this.drawWizard(ctx, px, py, { facing: p.facing, sx: sx, sy: sy, lean: lean, curl: this.curl, hatLen: look.hatLen,
        mode: 'outline', color: CYAN, lw: 4.5 });
      ctx.globalAlpha = 1;
    }
    this.drawWizard(ctx, px, py, look);

    if (clar) {
      // Timer arc drains with the remaining Clarity; it blinks during the warning window.
      var dur = P.clarityDur || 1, frac = clamp(p.clarityT / dur, 0, 1);
      var warn = p.clarityT <= (P.clarityWarn || 0);
      var on = !warn || Math.floor(this.t * 8) % 2 === 0;
      var arcC = mix(CYAN_RGB, CYAN_DEEP_RGB, 0.55 * ink);
      var cy = py - 0.78 * T, r = 1.1 * T;
      ctx.beginPath();
      ctx.arc(px, cy, r, 0, TAU);
      ctx.strokeStyle = css(arcC, 0.2);
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, cy, r, -Math.PI / 2, -Math.PI / 2 + TAU * frac);
      ctx.strokeStyle = css(arcC, on ? 1 : 0.3);
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    if (p.hiccupWarned && !clar) {
      // "ик!" bubble during the hiccup warning.
      var k = Math.min(1, this.hiccupWarnT / 0.12);
      var sc = k < 1 ? k * 1.15 : 1 + 0.05 * Math.sin(this.t * 30);
      var bx = px + p.facing * 15 + Math.sin(this.t * 40), byy = py - 2.25 * T;
      ctx.save();
      ctx.translate(bx, byy);
      ctx.scale(sc, sc);
      ctx.rotate(Math.sin(this.t * 9) * 0.08);
      ctx.beginPath();
      ctx.moveTo(-17, -2);
      ctx.bezierCurveTo(-18, -13, 16, -14, 17, -3);
      ctx.bezierCurveTo(18, 7, 4, 10, -2, 9);
      ctx.lineTo(-p.facing * 10, 17);
      ctx.lineTo(-p.facing * 6, 8);
      ctx.bezierCurveTo(-14, 7, -17, 4, -17, -2);
      ctx.closePath();
      ctx.fillStyle = '#fff8f0';
      ctx.fill();
      ctx.strokeStyle = css(C.line);
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.fillStyle = css(C.line);
      ctx.font = 'italic bold 14px ' + SERIF;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('ик!', 0, -1);
      ctx.restore();
    }
  };

  Renderer.prototype.drawAfterimages = function (ctx, p) {
    var T = this.T;
    for (var i = 0; i < this.afterimages.length; i++) {
      var a = this.afterimages[i], k = a.life / a.max;
      for (var j = 0; j < 5; j++) {
        var f = j / 4;
        var x = a.fx + (a.tx - a.fx) * f, y = a.fy + (a.ty - a.fy) * f;
        ctx.globalAlpha = k * (0.1 + 0.3 * f);
        this.drawWizard(ctx, (x + p.w / 2) * T, (y + p.h) * T, { facing: a.facing, mode: 'flat', color: CYAN });
      }
    }
    ctx.globalAlpha = 1;
  };

  // Ghost silhouette where Blink would land: cyan, red-orange when lethal, dim when a rune wall clips it.
  Renderer.prototype.drawBlinkPreview = function (ctx, world) {
    var p = world.player;
    if (!p.clarity || p.spellUsed || p.dead || !p.blinkTarget) return;
    var bt = p.blinkTarget(world.level, world.hazardTestFn());
    if (!bt || !bt.ok) return;
    var T = this.T;
    var col = bt.lethal ? HZ : css(mix(CYAN_RGB, CYAN_DEEP_RGB, 0.5 * this.inkK));
    var alpha = bt.clipped && !bt.lethal ? 0.22 : 0.45;
    alpha *= 0.85 + 0.15 * Math.sin(this.t * 10);
    ctx.save();
    ctx.setLineDash([2, 5]);
    ctx.strokeStyle = col;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo((p.x + p.w / 2) * T, (p.y + p.h / 2) * T);
    ctx.lineTo((bt.x + p.w / 2) * T, (bt.y + p.h / 2) * T);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    ctx.globalAlpha = alpha;
    this.drawWizard(ctx, (bt.x + p.w / 2) * T, (bt.y + p.h) * T, { facing: p.facing, mode: 'flat', color: col });
    ctx.globalAlpha = Math.min(1, alpha * 2);
    this.drawWizard(ctx, (bt.x + p.w / 2) * T, (bt.y + p.h) * T, { facing: p.facing, mode: 'outline', color: col, lw: 1.2 });
    ctx.globalAlpha = 1;
    if (bt.lethal) {
      ctx.font = 'bold 18px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      outlinedText(ctx, '×', (bt.x + p.w / 2) * T, (bt.y - 0.5) * T, HZ, 'rgba(10,6,16,0.85)', 3);
    }
  };

  // ---------------------------------------------------------------- particles & floating text

  Renderer.prototype.drawParticles = function (ctx) {
    var ps = this.particles, T = this.T, v = this.vb;
    for (var i = 0; i < ps.length; i++) {
      var q = ps[i];
      if (q.x < v.l - 2 || q.x > v.r + 2 || q.y < v.t - 2 || q.y > v.b + 2) continue;
      var a = q.life / q.max, X = q.x * T, Y = q.y * T, r;
      ctx.fillStyle = q.color;
      ctx.strokeStyle = q.color;
      switch (q.k) {
        case 'spark':
          ctx.globalAlpha = Math.min(1, a * 1.6);
          ctx.lineWidth = q.size;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(X, Y);
          ctx.lineTo(X - q.vx * T * 0.03, Y - q.vy * T * 0.03);
          ctx.stroke();
          break;
        case 'ring':
          ctx.globalAlpha = a;
          ctx.lineWidth = Math.max(0.5, (q.lw || 3) * a);
          ctx.beginPath();
          ctx.arc(X, Y, q.size + (q.size1 - q.size) * (1 - a * a), 0, TAU);
          ctx.stroke();
          break;
        case 'puff':
          ctx.globalAlpha = 0.5 * a;
          ctx.beginPath();
          ctx.arc(X, Y, q.size + (q.size1 - q.size) * Math.sqrt(1 - a), 0, TAU);
          ctx.fill();
          break;
        case 'sq':
        case 'shard':
          ctx.globalAlpha = Math.min(1, a * 2);
          ctx.save();
          ctx.translate(X, Y);
          ctx.rotate(q.rot);
          ctx.beginPath();
          if (q.k === 'sq') {
            ctx.moveTo(-q.size / 2, -q.size / 2); ctx.lineTo(q.size / 2, -q.size * 0.4);
            ctx.lineTo(q.size * 0.4, q.size / 2); ctx.lineTo(-q.size * 0.5, q.size * 0.3);
          } else {
            ctx.moveTo(-q.size / 2, -q.size * 0.3); ctx.lineTo(q.size / 2, -q.size / 2); ctx.lineTo(0, q.size / 2);
          }
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          break;
        case 'star':
          ctx.globalAlpha = Math.min(1, a * 1.8);
          ctx.beginPath();
          star4(ctx, X, Y, q.size * (0.5 + 0.5 * a), q.rot);
          ctx.fill();
          break;
        case 'feather':
          ctx.globalAlpha = Math.min(1, a * 2) * 0.9;
          ctx.save();
          ctx.translate(X, Y);
          ctx.rotate(q.rot + Math.sin((q.max - q.life) * 3 + q.seed) * 0.6);
          ctx.beginPath();
          ctx.moveTo(0, -q.size);
          ctx.quadraticCurveTo(q.size * 0.45, 0, 0, q.size);
          ctx.quadraticCurveTo(-q.size * 0.45, 0, 0, -q.size);
          ctx.fill();
          ctx.globalAlpha *= 0.6;
          ctx.lineWidth = 0.6;
          ctx.strokeStyle = '#7fa8b0';
          ctx.beginPath();
          ctx.moveTo(0, -q.size); ctx.lineTo(0, q.size * 1.2);
          ctx.stroke();
          ctx.restore();
          break;
        default: // 'dot', 'spore'
          r = q.size * (q.k === 'spore' ? 1 : 0.4 + 0.6 * a);
          ctx.globalAlpha = q.k === 'spore' ? 0.7 * Math.min(1, a * 2.5) : Math.min(1, a * 1.5);
          ctx.beginPath();
          ctx.arc(X, Y, r, 0, TAU);
          ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  };

  Renderer.prototype.drawTexts = function (ctx) {
    var T = this.T;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var i = 0; i < this.texts.length; i++) {
      var t = this.texts[i], k = t.life / t.max;
      ctx.globalAlpha = Math.min(1, k * 2);
      var sc = t.serif ? 1 + 0.5 * Math.pow(Math.max(0, k - 0.6) / 0.4, 2) : 1;
      ctx.font = (t.serif ? 'italic bold ' : 'bold ') + Math.round(t.size * sc) + 'px ' + (t.serif ? SERIF : FONT);
      outlinedText(ctx, t.s, t.x * T, t.y * T, t.color, 'rgba(10,6,16,0.85)', 3);
    }
    ctx.globalAlpha = 1;
  };

  // ---------------------------------------------------------------- screen-space FX

  // Four edge gradients: a uniform frame regardless of the 16:9 aspect. cols: one "r,g,b" per edge (t r b l).
  Renderer.prototype.edgeFrame = function (ctx, cols, alpha, thick) {
    var W = this.W, H = this.H, g, a = alpha.toFixed(3);
    var c = function (i, al) { return 'rgba(' + cols[i % cols.length] + ',' + al + ')'; };
    g = ctx.createLinearGradient(0, 0, 0, thick); g.addColorStop(0, c(0, a)); g.addColorStop(1, c(0, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, thick);
    g = ctx.createLinearGradient(W, 0, W - thick, 0); g.addColorStop(0, c(1, a)); g.addColorStop(1, c(1, 0));
    ctx.fillStyle = g; ctx.fillRect(W - thick, 0, thick, H);
    g = ctx.createLinearGradient(0, H, 0, H - thick); g.addColorStop(0, c(2, a)); g.addColorStop(1, c(2, 0));
    ctx.fillStyle = g; ctx.fillRect(0, H - thick, W, thick);
    g = ctx.createLinearGradient(0, 0, thick, 0); g.addColorStop(0, c(3, a)); g.addColorStop(1, c(3, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, thick, H);
  };

  function rgbStr(c) { return Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]); }

  Renderer.prototype.drawScreenFx = function (ctx, world) {
    var W = this.W, H = this.H, p = world.player, P = MW.P, k = fxk(), pal = this.pal;

    // Clarity: crisp cyan frame with corner brackets (gameplay information, so never fully off).
    if (this.clarityVis > 0.01) {
      var warn = p.clarity && p.clarityT <= (P.clarityWarn || 0);
      var pulse = warn ? 0.55 + 0.45 * Math.abs(Math.sin(this.t * 9)) : 1;
      var str = clamp(this.clarityVis * pulse * Math.max(0.5, Math.min(1.4, k)) + this.framePulse * 0.6, 0, 1.6);
      var fc = rgbStr(mix(CYAN_RGB, CYAN_DEEP_RGB, 0.5));
      this.edgeFrame(ctx, [fc], Math.min(0.6, 0.2 * str), 56);
      ctx.strokeStyle = 'rgba(' + fc + ',' + Math.min(1, 0.75 * str).toFixed(3) + ')';
      ctx.lineWidth = 3;
      ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
      var L = 34, m = 12;
      ctx.lineWidth = 3;
      ctx.lineCap = 'square';
      ctx.beginPath();
      ctx.moveTo(m, m + L); ctx.lineTo(m, m); ctx.lineTo(m + L, m);
      ctx.moveTo(W - m - L, m); ctx.lineTo(W - m, m); ctx.lineTo(W - m, m + L);
      ctx.moveTo(m, H - m - L); ctx.lineTo(m, H - m); ctx.lineTo(m + L, H - m);
      ctx.moveTo(W - m - L, H - m); ctx.lineTo(W - m, H - m); ctx.lineTo(W - m, H - m - L);
      ctx.stroke();
    }

    // Stage change: a short chromatic split along the screen edges (never over the playfield centre).
    if (this.chromaT > 0 && k > 0) {
      var ca = (this.chromaT / 0.3) * 0.42 * Math.min(1.5, k);
      this.edgeFrame(ctx, ['255,60,170', '90,255,160', '255,230,90', '120,110,255'], ca, 46 + (0.3 - this.chromaT) * 160);
    }

    // focusOff: the world's colours flood back in from the edges over ~0.3 s, then fade.
    if (this.washT >= 0 && k > 0) {
      var u = Math.min(1, this.washT / 0.3);
      var grow = 1 - (1 - u) * (1 - u);
      var fade = this.washT < 0.3 ? 1 : Math.max(0, 1 - (this.washT - 0.3) / 0.25);
      var a = 0.34 * fade * Math.min(1.5, k);
      this.edgeFrame(ctx, [rgbStr(pal.d.accent), rgbStr(pal.d.fringe), rgbStr(pal.d.glow), rgbStr(pal.d.aura)], a, 24 + grow * 150);
    }

    // focusOn: a short paper-white flash.
    if (this.flashT > 0 && k > 0) {
      ctx.fillStyle = 'rgba(255,250,236,' + Math.min(0.6, (this.flashT / 0.12) * 0.3 * k).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
    }
  };

  // ---------------------------------------------------------------- HUD

  Renderer.prototype.textW = function (ctx, s) {
    var m = ctx.measureText(s);
    return m && typeof m.width === 'number' && m.width === m.width ? m.width : s.length * 8;
  };

  Renderer.prototype.stageSig = function (i) {
    return i === 4 ? hueShift(SIG[4], this.t * 0.22) : SIG[i];
  };

  Renderer.prototype.drawHUD = function (ctx, world) {
    var p = world.player, P = MW.P, W = this.W, t = this.t, ink = this.inkK, i;
    var stage = clamp(p.stage | 0, 1, 4);
    var bg = css(mix(C.uiBg, INK.paper, ink), 0.62 + 0.28 * ink);
    var fg = mix(C.ui, INK.ink, ink), fgS = css(fg), dimS = css(fg, 0.62), hair = css(fg, 0.16 + 0.22 * ink);
    var cyanUi = mix(CYAN_RGB, CYAN_DEEP_RGB, ink);
    var shadow = ink > 0.5 ? css(INK.paper) : 'rgba(8,4,14,0.9)';
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // ---- stage panel: the big current stage, its world's name and the D1..D4 track
    ctx.beginPath();
    rrect(ctx, 12, 12, 280, 70, 22);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = hair;
    ctx.lineWidth = 1;
    ctx.stroke();
    var sig = this.stageSig(stage), sigS = css(mix(sig, INK.ink, ink));
    var pop = this.hudPop && this.hudPop.stage === stage ? this.hudPop : null;
    var pk = pop ? clamp(pop.t / STAGE_FX_LIFE, 0, 1) : 1;
    var LX = 52, LY = 42;
    if (pop && pk < 1) {
      // flying ghost of the label + a ring: the big pop
      ctx.save();
      ctx.globalAlpha = 0.5 * (1 - pk);
      ctx.translate(LX, LY);
      ctx.scale(1 + 2.4 * pk, 1 + 2.4 * pk);
      ctx.font = 'italic bold 40px ' + SERIF;
      ctx.textAlign = 'center';
      ctx.fillStyle = sigS;
      ctx.fillText('D' + stage, 0, 2);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(LX, LY, 18 + 46 * (1 - Math.pow(1 - pk, 3)), 0, TAU);
      ctx.strokeStyle = css(mix(sig, INK.ink, ink), 0.8 * (1 - pk));
      ctx.lineWidth = 3 * (1 - pk) + 0.5;
      ctx.stroke();
    }
    var sc = 1;
    if (pop && pk < 1) sc = 1 + (pop.up ? 0.55 : 0.3) * Math.pow(1 - pk, 2) + 0.1 * Math.sin(pk * Math.PI * 3) * (1 - pk);
    ctx.save();
    ctx.translate(LX, LY);
    ctx.scale(sc, sc);
    ctx.font = 'italic bold 40px ' + SERIF;
    ctx.textAlign = 'center';
    if (pop && pk < 1) {
      ctx.globalCompositeOperation = ink > 0.5 ? 'multiply' : 'lighter';
      var off = 5 * (1 - pk);
      ctx.globalAlpha = 0.85 * (1 - pk);
      ctx.fillStyle = 'rgb(255,50,160)'; ctx.fillText('D' + stage, -off, 2);
      ctx.fillStyle = 'rgb(80,255,170)'; ctx.fillText('D' + stage, off, 2 + off * 0.3);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    outlinedText(ctx, 'D' + stage, 0, 2, sigS, shadow, 4);
    ctx.restore();
    ctx.font = 'italic 13px ' + SERIF;
    ctx.textAlign = 'center';
    ctx.fillStyle = dimS;
    ctx.fillText(STAGE_NAME[stage] || '', LX, 70);

    // track
    var nx0 = 116, nsp = 46, ny = 38;
    ctx.beginPath();
    for (var vx = nx0; vx <= nx0 + 3 * nsp; vx += 3) {
      var vy = ny + Math.sin(vx * 0.16 + t * 1.5) * 2.2;
      if (vx === nx0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
    }
    ctx.strokeStyle = hair;
    ctx.lineWidth = 2;
    ctx.stroke();
    for (i = 1; i <= 4; i++) {
      var x = nx0 + (i - 1) * nsp, cur = i === stage, filled = i <= stage;
      var sg = this.stageSig(i), sgS = css(mix(sg, INK.ink, ink));
      var r = cur ? 13 + (pop && pk < 1 ? 5 * Math.sin(pk * Math.PI) : 0) : 8;
      if (cur && ink < 1) {
        var gr = ctx.createRadialGradient(x, ny, 2, x, ny, r + 12);
        gr.addColorStop(0, css(sg, 0.5 * (1 - ink)));
        gr.addColorStop(1, css(sg, 0));
        ctx.fillStyle = gr;
        ctx.fillRect(x - r - 12, ny - r - 12, (r + 12) * 2, (r + 12) * 2);
      }
      ctx.beginPath();
      ctx.arc(x, ny, r, 0, TAU);
      if (filled) { ctx.fillStyle = sgS; ctx.fill(); }
      else { ctx.fillStyle = bg; ctx.fill(); }
      ctx.strokeStyle = filled ? shadow : css(fg, 0.45);
      ctx.lineWidth = filled ? 2 : 1.5;
      ctx.stroke();
      if (i === stage + 1 && p.pendingStageUp) {
        ctx.beginPath();
        ctx.arc(x, ny, r + 3 + 2 * Math.abs(Math.sin(t * 8)), 0, TAU);
        ctx.strokeStyle = sgS;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (cur && p.clarity) {
        ctx.beginPath();
        ctx.arc(x, ny, r + 4, 0, TAU);
        ctx.strokeStyle = css(cyanUi);
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.font = (cur ? 'italic bold 15px ' : 'italic bold 11px ') + SERIF;
      ctx.textAlign = 'center';
      ctx.fillStyle = filled ? (ink > 0.5 ? css(INK.paper) : '#1a1022') : dimS;
      ctx.fillText(String(i), x, ny + 1);
    }
    var cap, capC = dimS;
    if (p.clarity) { cap = 'стадия заморожена'; capC = css(cyanUi); }
    else if (p.pendingStageUp && stage < 4) { cap = 'приземление → D' + (stage + 1); capC = css(mix(this.stageSig(stage + 1), INK.ink, ink)); }
    else if (stage < 4) {
      var jps = Math.max(1, Math.round(P.jumpsPerStage || 1));
      cap = jps > 1 ? 'прыжки ' + Math.min(p.drunkJumps | 0, jps) + '/' + jps + ' → D' + (stage + 1) : 'каждый прыжок → +1';
    }
    else cap = 'пик · икота';
    ctx.font = '11px ' + FONT;
    ctx.textAlign = 'left';
    ctx.fillStyle = capC;
    ctx.fillText(cap, nx0 - 8, 66);

    // ---- Clarity + spells panel
    ctx.beginPath();
    rrect(ctx, 12, 88, 322, 64, 22);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = hair;
    ctx.lineWidth = 1;
    ctx.stroke();
    var mx = 44 + (this.orbShake > 0 ? Math.sin(t * 60) * 3 * this.orbShake : 0);
    this.drawClarityMedallion(ctx, mx, 120, 21, p, cyanUi, fg, ink);
    ctx.textAlign = 'left';
    ctx.font = 'bold 13px ' + FONT;
    ctx.fillStyle = fgS;
    ctx.fillText('Ясность', 74, 110);
    var stat, statC;
    if (p.clarity) { stat = 'ещё ' + Math.max(0, p.clarityT).toFixed(1) + ' с'; statC = css(cyanUi); }
    else if (p.charge >= 1) { stat = 'ЛКМ — готово'; statC = css(cyanUi); }
    else { stat = 'откат ' + Math.max(0, p.cooldownT || 0).toFixed(1) + ' с'; statC = dimS; }
    ctx.font = '11px ' + FONT;
    ctx.fillStyle = statC;
    ctx.fillText(stat, 74, 130);
    var spells = ['blink', 'levitate', 'feather'], names = ['Блинк', 'Взлёт', 'Пёрышко'];
    for (i = 0; i < 3; i++) {
      var stt;
      if (spells[i] === 'feather' && p.featherT > 0) stt = 'active';
      else if (p.clarity && !p.spellUsed) stt = 'ready';
      else if (p.clarity && p.spellUsed) stt = p.lastCast === spells[i] ? 'cast' : 'spent';
      else stt = 'locked';
      this.drawSpellSlot(ctx, 190 + i * 50, 113, i, names[i], stt, cyanUi, fg, bg, ink);
    }

    // ---- top-right: section, deaths, timer
    var room = world.currentRoom ? world.currentRoom() : null;
    var def = room && room.def ? room.def : {};
    var name = def.name || '', sec = def.section || '';
    var st = world.stats || {};
    var line2 = 'Смерти: ' + (st.deaths || 0) + '   ·   ' + fmtTime(st.time);
    ctx.font = 'italic 17px ' + SERIF;
    var wN = this.textW(ctx, name);
    ctx.font = 'bold 11px ' + FONT;
    var wS = sec ? this.textW(ctx, sec) + 14 : 0;
    ctx.font = '12px ' + FONT;
    var w2 = this.textW(ctx, line2);
    var bw = Math.max(wN + wS + (sec ? 8 : 0), w2) + 32;
    ctx.beginPath();
    rrect(ctx, W - 12 - bw, 12, bw, 54, 22);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = hair;
    ctx.stroke();
    var rx = W - 28;
    ctx.textAlign = 'right';
    ctx.font = 'italic 17px ' + SERIF;
    ctx.fillStyle = fgS;
    ctx.fillText(name, rx, 31);
    if (sec) {
      var px0 = rx - wN - 8 - wS;
      ctx.beginPath();
      rrect(ctx, px0, 23, wS, 16, 8);
      ctx.fillStyle = css(mix(sig, INK.ink, ink), 0.9);
      ctx.fill();
      ctx.font = 'bold 11px ' + FONT;
      ctx.textAlign = 'center';
      ctx.fillStyle = ink > 0.5 ? css(INK.paper) : '#1a1022';
      ctx.fillText(sec, px0 + wS / 2, 31.5);
    }
    ctx.textAlign = 'right';
    ctx.font = '12px ' + FONT;
    ctx.fillStyle = dimS;
    ctx.fillText(line2, rx, 52);
    ctx.restore();
  };

  // Clarity indicator: a medallion with a mouse icon (ЛКМ): ready / cooldown / active time.
  Renderer.prototype.drawClarityMedallion = function (ctx, x, y, r, p, cyanUi, fg, ink) {
    var P = MW.P, t = this.t, cS = css(cyanUi);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = css(mix(hex('#06161c'), INK.paper, ink), 0.9);
    ctx.fill();
    ctx.strokeStyle = css(cyanUi, 0.4);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    var lit = false;
    if (p.clarity) {
      var frac = clamp(p.clarityT / (P.clarityDur || 1), 0, 1);
      var warn = p.clarityT <= (P.clarityWarn || 0);
      var on = !warn || Math.floor(t * 8) % 2 === 0;
      ctx.beginPath();
      ctx.arc(x, y, r - 3, 0, TAU);
      ctx.fillStyle = css(cyanUi, 0.22);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r - 1, -Math.PI / 2, -Math.PI / 2 + TAU * frac);
      ctx.strokeStyle = css(cyanUi, on ? 1 : 0.3);
      ctx.lineWidth = 4;
      ctx.stroke();
      lit = true;
    } else if (p.charge >= 1) {
      if (this.orbPulse > 0) {
        ctx.beginPath();
        ctx.arc(x, y, r + 7 * this.orbPulse, 0, TAU);
        ctx.fillStyle = css(cyanUi, 0.35 * this.orbPulse);
        ctx.fill();
      }
      var g = ctx.createRadialGradient(x - 5, y - 6, 1, x, y, r - 1);
      g.addColorStop(0, CYAN_HI);
      g.addColorStop(0.6, cS);
      g.addColorStop(1, css(cyanUi, 0.6));
      ctx.beginPath();
      ctx.arc(x, y, r - 2 + 1.2 * Math.sin(t * 3), 0, TAU);
      ctx.fillStyle = g;
      ctx.fill();
      lit = true;
    } else {
      var cd = P.focusCooldown || 1, f = clamp(1 - (p.cooldownT || 0) / cd, 0, 1);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, (r - 4) * f), 0, TAU);
      ctx.fillStyle = css(cyanUi, 0.18);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r - 1, -Math.PI / 2, -Math.PI / 2 + TAU * f);
      ctx.strokeStyle = css(cyanUi, 0.85);
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    // mouse icon with the left button highlighted
    var mw = 11, mh = 16, mx = x - mw / 2, my = y - mh / 2 - 0.5;
    var ic = p.charge >= 1 && !p.clarity ? '#08222a' : css(fg, lit ? 0.95 : 0.5);
    ctx.beginPath();
    rrect(ctx, mx, my, mw, mh, 5.5);
    ctx.strokeStyle = ic;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(mx + 5.5, my + 5.5);
    ctx.quadraticCurveTo(mx + 5.5, my + 0.8, mx + 1.5, my + 1.2);
    ctx.quadraticCurveTo(mx + 0.2, my + 3, mx + 0.4, my + 6.4);
    ctx.lineTo(mx + 5.5, my + 6.4);
    ctx.closePath();
    ctx.fillStyle = p.clarity ? '#ffffff' : (p.charge >= 1 ? '#08222a' : css(fg, 0.35));
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(mx + 0.6, my + 6.4); ctx.lineTo(mx + mw - 0.6, my + 6.4);
    ctx.moveTo(mx + 5.5, my + 0.8); ctx.lineTo(mx + 5.5, my + 6.4);
    ctx.stroke();
    if (p.bankedCharge) {
      // Crystal taken during Clarity: the charge is ready when Clarity ends.
      var gx = x + r - 3, gy = y - r + 3;
      ctx.beginPath();
      ctx.moveTo(gx, gy - 5); ctx.lineTo(gx + 3.5, gy); ctx.lineTo(gx, gy + 5); ctx.lineTo(gx - 3.5, gy); ctx.closePath();
      ctx.fillStyle = CYAN_HI;
      ctx.fill();
      ctx.strokeStyle = '#0d4a52';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.font = 'bold 9px ' + FONT;
    ctx.textAlign = 'center';
    ctx.fillStyle = css(fg, 0.75);
    ctx.fillText('ЛКМ', x, y + r + 7);
    ctx.restore();
  };

  // One spell slot: key badge, icon, name. stt: 'ready' | 'active' | 'cast' | 'spent' | 'locked'.
  Renderer.prototype.drawSpellSlot = function (ctx, cx, cy, idx, name, stt, cyanUi, fg, bg, ink) {
    var t = this.t, on = stt === 'ready' || stt === 'active', cast = stt === 'cast';
    var cS = css(cyanUi);
    var w = 40, h = 30, x = cx - w / 2, y = cy - h / 2;
    ctx.save();
    if (stt === 'active' || stt === 'ready') {
      var pulse = stt === 'active' ? 0.5 + 0.5 * Math.sin(t * 10) : 0.5 + 0.2 * Math.sin(t * 4 + idx);
      ctx.beginPath();
      rrect(ctx, x - 3, y - 3, w + 6, h + 6, 12);
      ctx.fillStyle = css(cyanUi, 0.18 * pulse + 0.06);
      ctx.fill();
    }
    ctx.beginPath();
    rrect(ctx, x, y, w, h, 10);
    ctx.fillStyle = on ? css(cyanUi, 0.2) : css(fg, 0.05);
    ctx.fill();
    if (cast) ctx.setLineDash([3, 3]);
    ctx.strokeStyle = on ? cS : cast ? css(cyanUi, 0.7) : css(fg, 0.25);
    ctx.lineWidth = on ? 1.8 : 1.2;
    ctx.stroke();
    ctx.setLineDash([]);
    // icon
    var icol = on ? cS : cast ? css(cyanUi, 0.75) : css(fg, 0.32);
    ctx.strokeStyle = icol;
    ctx.fillStyle = icol;
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    var ix = cx + 3, iy = cy;
    ctx.beginPath();
    if (idx === 0) {
      // Blink: a ghost dot, a dashed hop and an arrival star
      ctx.arc(ix - 8, iy + 1, 2.4, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([2, 2.5]);
      ctx.beginPath(); ctx.moveTo(ix - 4.5, iy + 1); ctx.lineTo(ix + 4, iy + 1); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(ix + 3, iy - 2.5); ctx.lineTo(ix + 7, iy + 1); ctx.lineTo(ix + 3, iy + 4.5); ctx.stroke();
      ctx.beginPath(); star4(ctx, ix + 7.5, iy - 6, 2.8, 0); ctx.fill();
    } else if (idx === 1) {
      // Levitate: two chevrons rising
      ctx.moveTo(ix - 6, iy + 1); ctx.lineTo(ix, iy - 5); ctx.lineTo(ix + 6, iy + 1);
      ctx.moveTo(ix - 6, iy + 7); ctx.lineTo(ix, iy + 1); ctx.lineTo(ix + 6, iy + 7);
      ctx.stroke();
    } else {
      // Feather
      ctx.moveTo(ix - 7, iy + 8);
      ctx.quadraticCurveTo(ix - 6, iy - 4, ix + 7, iy - 8);
      ctx.quadraticCurveTo(ix + 3, iy + 4, ix - 5, iy + 5);
      ctx.closePath();
      if (on) { ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 1; }
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ix - 8, iy + 9.5); ctx.lineTo(ix + 3, iy - 3); ctx.lineWidth = 1.1; ctx.stroke();
    }
    // key badge
    ctx.beginPath();
    ctx.arc(x + 2, y + 2, 7, 0, TAU);
    ctx.fillStyle = on ? cS : bg;
    ctx.fill();
    ctx.strokeStyle = on ? cS : css(fg, 0.4);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.font = 'bold 10px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = on ? '#06161c' : css(fg, 0.7);
    ctx.fillText(String(idx + 1), x + 2, y + 2.5);
    if (stt === 'spent') {
      ctx.beginPath();
      ctx.moveTo(x + 6, y + h - 5); ctx.lineTo(x + w - 6, y + 5);
      ctx.strokeStyle = css(fg, 0.35);
      ctx.lineWidth = 1.4;
      ctx.stroke();
    } else if (stt === 'locked') {
      // tiny padlock: spells need Clarity
      var lx = x + w - 6, ly = y + h - 6;
      ctx.beginPath();
      ctx.arc(lx, ly - 3, 2.2, Math.PI, 0);
      ctx.strokeStyle = css(fg, 0.55);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = css(fg, 0.55);
      ctx.fillRect(lx - 3.2, ly - 3, 6.4, 4.6);
    } else if (cast) {
      ctx.beginPath();
      ctx.moveTo(x + w - 11, y + h - 6); ctx.lineTo(x + w - 8, y + h - 3); ctx.lineTo(x + w - 3, y + h - 10);
      ctx.strokeStyle = cS;
      ctx.lineWidth = 1.8;
      ctx.stroke();
    }
    ctx.font = (on ? 'bold ' : '') + '10px ' + FONT;
    ctx.fillStyle = on ? cS : css(fg, 0.6);
    ctx.fillText(name, cx, cy + h / 2 + 9);
    ctx.restore();
  };

  // Sign text: a readable rounded box at the bottom centre, wrapped to several lines.
  Renderer.prototype.wrap = function (ctx, text, maxW) {
    var key = ctx.font + '|' + maxW + '|' + text;
    var hit = this.wrapCache[key];
    if (hit) return hit;
    var self = this, out = [];
    String(text).split('\n').forEach(function (para) {
      var words = para.split(/\s+/).filter(Boolean), line = '';
      for (var i = 0; i < words.length; i++) {
        var test = line ? line + ' ' + words[i] : words[i];
        if (line && self.textW(ctx, test) > maxW) { out.push(line); line = words[i]; }
        else line = test;
      }
      out.push(line);
    });
    if (++this.wrapCount > 64) { this.wrapCache = {}; this.wrapCount = 0; }
    this.wrapCache[key] = out;
    return out;
  };

  Renderer.prototype.drawSignBox = function (ctx) {
    if (this.signA < 0.02 || !this.signText) return;
    var W = this.W, H = this.H, ink = this.inkK;
    ctx.save();
    ctx.globalAlpha = Math.min(1, this.signA);
    ctx.font = '17px ' + FONT;
    var lines = this.wrap(ctx, this.signText, 560);
    var lw = 0;
    for (var i = 0; i < lines.length; i++) lw = Math.max(lw, this.textW(ctx, lines[i]));
    var lineH = 24, bw = Math.min(600, lw) + 44, bh = lines.length * lineH + 22;
    var bx = (W - bw) / 2, by = H - bh - 22 + (1 - this.signA) * 10;
    ctx.beginPath();
    rrect(ctx, bx, by, bw, bh, 18);
    ctx.fillStyle = css(mix(hex('#0e0a1a'), INK.paper, ink), 0.92);
    ctx.fill();
    ctx.strokeStyle = css(mix(this.pal.d.accent || SIG[1], INK.ink, ink), 0.85);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = css(mix(C.ui, INK.ink, ink));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var j = 0; j < lines.length; j++) ctx.fillText(lines[j], W / 2, by + 11 + lineH * (j + 0.5));
    ctx.restore();
  };

  // ---------------------------------------------------------------- debug overlay

  Renderer.prototype.drawDebugWorld = function (ctx, world, x0, x1, y0, y1) {
    var lvl = world.level, p = world.player, P = MW.P, T = this.T, x, y;
    ctx.save();
    // tile grid
    ctx.strokeStyle = this.inkK > 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (x = x0; x <= x1 + 1; x++) { ctx.moveTo(x * T + 0.5, y0 * T); ctx.lineTo(x * T + 0.5, (y1 + 1) * T); }
    for (y = y0; y <= y1 + 1; y++) { ctx.moveTo(x0 * T, y * T + 0.5); ctx.lineTo((x1 + 1) * T, y * T + 0.5); }
    ctx.stroke();

    // hazard hitboxes (spikes, saws, abyss)
    ctx.strokeStyle = 'rgba(255,60,60,0.95)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (y = y0; y <= y1; y++) {
      for (x = x0; x <= x1; x++) {
        var c = lvl.grid[y][x];
        var b = MW.spikeBox(c, x, y);
        if (b) ctx.rect(b.x * T, b.y * T, b.w * T, b.h * T);
        else if (c === '~') ctx.rect(x * T, (y + 0.3) * T, T, 0.7 * T);
      }
    }
    for (var i = 0; i < lvl.saws.length; i++) {
      var s = lvl.saws[i];
      if (!this.inView(s.x, s.y, 1)) continue;
      ctx.moveTo((s.x + s.r) * T, s.y * T);
      ctx.arc(s.x * T, s.y * T, s.r * T, 0, TAU);
    }
    ctx.stroke();

    if (!p.dead) {
      // player box and the (forgiving) box used for hazard tests
      ctx.strokeStyle = '#7dff6a';
      ctx.strokeRect(p.x * T, p.y * T, p.w * T, p.h * T);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255,120,120,0.9)';
      ctx.strokeRect((p.x + 0.1) * T, (p.y + 0.1) * T, (p.w - 0.2) * T, (p.h - 0.15) * T);
      ctx.setLineDash([]);

      // predicted trajectories (side-effect free): jump + facing direction, and jump straight up
      if (world.ghost) {
        var f = p.facing;
        var inDir = function (k) { return { jump: true, jumpPressed: k === 0, left: f < 0, right: f > 0 }; };
        var inUp = function (k) { return { jump: true, jumpPressed: k === 0 }; };
        this.drawGhostPath(ctx, world.ghost(inDir, 1.6), 2.2);
        this.drawGhostPath(ctx, world.ghost(inUp, 1.6), 1.6);
      }

      // blink target and levitate height
      if (p.blinkTarget) {
        var bt = p.blinkTarget(lvl, world.hazardTestFn());
        if (bt && bt.ok) {
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = bt.lethal ? HZ : (bt.clipped ? 'rgba(199,155,255,0.9)' : CYAN);
          ctx.strokeRect(bt.x * T, bt.y * T, p.w * T, p.h * T);
          ctx.setLineDash([]);
        }
      }
      var ly = (p.y - (P.levitateH || 0)) * T;
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(79,227,240,0.85)';
      ctx.beginPath();
      ctx.moveTo((p.x - 0.4) * T, ly); ctx.lineTo((p.x + p.w + 0.4) * T, ly);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '10px ' + MONO;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(79,227,240,0.95)';
      ctx.fillText('взлёт', (p.x + p.w + 0.5) * T, ly + 4);
    }
    ctx.restore();
  };

  Renderer.prototype.drawGhostPath = function (ctx, pts, r) {
    if (!pts || !pts.length) return;
    var T = this.T, lethal = !!pts.lethal;
    for (var i = 0; i < pts.length; i += 3) {
      var q = pts[i];
      ctx.fillStyle = lethal ? HZ : (q.clarity ? CYAN : '#ffe14d');
      ctx.beginPath();
      ctx.arc(q.x * T, q.y * T, r, 0, TAU);
      ctx.fill();
    }
    var last = pts[pts.length - 1];
    if (lethal) {
      ctx.font = 'bold 14px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = HZ;
      ctx.fillText('×', last.x * T, last.y * T);
    }
  };

  Renderer.prototype.drawDebugText = function (ctx, world, mode) {
    var ch = MW.CHEATS || {}, p = world.player, P = MW.P;
    var flags = [];
    if (ch.god) flags.push('бессмертие');
    if (ch.infiniteClarity) flags.push('бесконечная ясность');
    if (ch.overlay) flags.push('оверлей');
    if (!flags.length) return;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    if (ch.overlay) {
      var nCh = 0;
      for (var k in this.chunks) if (this.chunks[k].glow || Object.keys(this.chunks[k].looks).length) nCh++;
      var lines = [
        'FPS ' + Math.round(this.fps),
        'vx ' + p.vx.toFixed(2) + '  vy ' + p.vy.toFixed(2),
        'стадия D' + p.stage + '  прыжки ' + p.drunkJumps + '/' + (P.jumpsPerStage || 1) + (p.pendingStageUp ? ' ↑' : ''),
        'ясность ' + (p.clarityT || 0).toFixed(2) + '  откат ' + (p.cooldownT || 0).toFixed(2),
        'чанки ' + nCh + '  холсты ' + this.canvasCount,
      ];
      var top = mode === 'title' ? 12 : 160;
      ctx.beginPath();
      rrect(ctx, 12, top, 230, lines.length * 16 + 10, 6);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fill();
      ctx.font = '12px ' + MONO;
      ctx.fillStyle = '#e8ffe0';
      for (var i = 0; i < lines.length; i++) ctx.fillText(lines[i], 20, top + 13 + i * 16);
    }
    // Top-centre pill: the UI hint lives bottom-left and the debug panel on the right.
    var s = 'ОТЛАДКА: ' + flags.join(' · ');
    ctx.font = '12px ' + MONO;
    var w = this.textW(ctx, s) + 16, x = (this.W - w) / 2;
    ctx.beginPath();
    rrect(ctx, x, 12, w, 22, 6);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fill();
    ctx.fillStyle = '#ffe066';
    ctx.fillText(s, x + 8, 23);
    ctx.restore();
  };

  MW.Renderer = Renderer;
})();
