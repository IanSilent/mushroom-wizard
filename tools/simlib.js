// Headless simulation helpers (Node). Loads the game's pure-simulation scripts into a VM context.
//
// Input scripts are arrays of [durationSeconds, "keys"] segments, keys separated by spaces:
//   left right up down jump focus cast restart spell1 spell2 spell3
// cast = directional (up = levitate, down = feather, else blink); spell1/2/3 = blink / levitate / feather.
// A key is "pressed" on the first step of a segment where it is held and was not held before.
// To tap the same key twice, put a segment without it in between (e.g. [0.05, 'right']).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CORE = ['src/config.js', 'src/level.js', 'src/player.js', 'src/world.js'];

function loadMW(opts) {
  opts = opts || {};
  const ctx = { console };
  vm.createContext(ctx);
  for (const f of CORE) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  if (opts.levels !== false) {
    const dir = path.join(ROOT, 'src/levels');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
    files.sort((a, b) => (a === 'order.js') - (b === 'order.js') || a.localeCompare(b));
    for (const f of files) {
      // A broken room file (e.g. another author mid-edit) must not break checks of other rooms.
      try {
        vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: 'src/levels/' + f });
      } catch (e) {
        process.stderr.write(`[simlib] skipped src/levels/${f}: ${e.message}\n`);
      }
    }
  }
  return ctx.MW;
}

const KEYS = ['left', 'right', 'up', 'down', 'jump', 'focus', 'cast', 'restart', 'spell1', 'spell2', 'spell3'];

function expandScript(MW, script) {
  const steps = [];
  for (const seg of script) {
    const n = Math.max(1, Math.round(seg[0] / MW.DT));
    const held = {};
    String(seg[1] || '').split(/[\s+]+/).filter(Boolean).forEach(k => {
      if (!KEYS.includes(k)) throw new Error('Unknown key in script: ' + k);
      held[k] = true;
    });
    for (let i = 0; i < n; i++) steps.push(held);
  }
  return steps;
}

function makeInput(held, prev) {
  const inp = {};
  for (const k of KEYS) inp[k] = !!held[k];
  inp.jumpPressed = inp.jump && !prev.jump;
  inp.focusPressed = inp.focus && !prev.focus;
  inp.castPressed = inp.cast && !prev.cast;
  inp.restartPressed = inp.restart && !prev.restart;
  // Explicit spell keys (browser: 1 / 2 / 3).
  inp.spell = (inp.spell1 && !prev.spell1) ? 'blink' : (inp.spell2 && !prev.spell2) ? 'levitate' : (inp.spell3 && !prev.spell3) ? 'feather' : null;
  return inp;
}

// Run a script in a world built from roomIds. Success = exits the right edge of the LAST room
// (or touches an E portal). Returns detailed result.
function run(MW, roomIds, script, opts) {
  opts = opts || {};
  const rooms = opts.rooms || MW.ROOMS;
  const world = new MW.World(roomIds, { rooms, startCheckpoint: opts.startCheckpoint !== undefined ? opts.startCheckpoint : 0, startStage: opts.startStage });
  if (opts.setup) opts.setup(world);
  const steps = expandScript(MW, script);
  const tailSteps = Math.round((opts.tail || 0) / MW.DT);
  const lvl = world.level;
  const trace = [];
  const deaths = [];
  const events = {};
  let prev = {};
  let success = false;
  let t = 0;
  const total = steps.length + tailSteps;
  for (let i = 0; i < total; i++) {
    const held = i < steps.length ? steps[i] : {};
    const inp = makeInput(held, prev);
    prev = held;
    world.update(inp);
    t += MW.DT;
    const p = world.player;
    for (const e of world.events) {
      events[e.type] = (events[e.type] || 0) + 1;
      if (e.type === 'death') deaths.push({ t: +t.toFixed(3), cause: e.cause, x: +e.x.toFixed(2), y: +e.y.toFixed(2) });
    }
    world.events.length = 0;
    trace.push({ x: p.x, y: p.y, clarity: p.clarity, stage: p.stage, dead: p.dead, grounded: p.grounded, feather: p.featherT > 0, lev: p.levitateT > 0 });
    if (opts.stopOnDeath && deaths.length) break;
    if (opts.until && opts.until(world)) { success = true; break; }
    if (!opts.until && (world.finished || p.x + p.w / 2 > lvl.w - 0.5)) { success = true; break; }
  }
  const p = world.player;
  return {
    success: success && deaths.length === 0,
    reached: success,
    deaths, events, time: +t.toFixed(3),
    final: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), stage: p.stage, clarity: p.clarity, grounded: p.grounded },
    trace, world,
  };
}

// Deterministic PRNG for jitter tests.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// Perturb each segment duration by up to ±maxSteps simulation steps.
function jitterScript(MW, script, seed, maxSteps) {
  const r = rng(seed * 7919 + 13);
  return script.map(seg => {
    const d = Math.round((r() * 2 - 1) * maxSteps);
    return [Math.max(MW.DT, seg[0] + d * MW.DT), seg[1]];
  });
}

function robustness(MW, roomIds, script, maxSteps, n, opts) {
  let ok = 0;
  for (let i = 1; i <= n; i++) {
    const res = run(MW, roomIds, jitterScript(MW, script, i, maxSteps), Object.assign({ stopOnDeath: true }, opts || {}));
    if (res.success) ok++;
  }
  return ok / n;
}

// ASCII trace of a single-room run.
function renderTrace(MW, res, opts) {
  opts = opts || {};
  const lvl = res.world.level;
  const g = lvl.grid.map(r => r.map(c => (c === '.' ? ' ' : c)));
  for (const c of lvl.checkpoints) g[c.y][c.x] = String(c.stage);
  for (const pk of lvl.pickups) g[Math.floor(pk.y)][Math.floor(pk.x)] = pk.type === 'mushroom' ? 'M' : '*';
  for (const e of lvl.exits) g[e.y][e.x] = 'E';
  for (const s of lvl.signs) g[s.y][s.x] = 'T';
  let lastClar = null;
  res.trace.forEach((tp, i) => {
    if (i % 3 !== 0 && !tp.dead) return;
    const cx = Math.floor(tp.x + MW.PLAYER_W / 2), cy = Math.floor(tp.y + MW.PLAYER_H - 0.01);
    if (cy < 0 || cy >= lvl.h || cx < 0 || cx >= lvl.w) return;
    const cur = g[cy][cx];
    if (cur !== ' ' && cur !== ':' && cur !== '+' && cur !== 'f' && cur !== 'l') return;
    let ch = tp.clarity ? '+' : ':';
    if (tp.feather) ch = 'f';
    if (tp.lev) ch = 'l';
    g[cy][cx] = ch;
    lastClar = tp.clarity;
  });
  for (const d of res.deaths) {
    const cx = Math.floor(d.x + MW.PLAYER_W / 2), cy = Math.floor(d.y + MW.PLAYER_H - 0.01);
    if (cy >= 0 && cy < lvl.h && cx >= 0 && cx < lvl.w) g[cy][cx] = '@';
  }
  const ruler = (w) => {
    let a = '', b = '';
    for (let x = 0; x < w; x++) { a += x % 10 === 0 ? String((x / 10) % 10) : ' '; b += String(x % 10); }
    return '    ' + a + '\n    ' + b;
  };
  const lines = [ruler(lvl.w)];
  g.forEach((r, y) => lines.push(String(y).padStart(3) + ' ' + r.join('')));
  return lines.join('\n') + '\n  legend: ":" drunk path (feet)  "+" clarity path  "l" levitate  "f" feather  "@" death';
}

module.exports = { loadMW, run, robustness, jitterScript, renderTrace, expandScript, makeInput, KEYS, ROOT };
