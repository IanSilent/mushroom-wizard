#!/usr/bin/env node
// Measures the REAL movement envelopes by brute-force simulation (source of truth for level design).
// Usage: node tools/metrics.js [--json]
'use strict';
const { loadMW, run } = require('./simlib');

const MW = loadMW({ levels: false });

function gapRoom(gap, stage, opts) {
  opts = opts || {};
  const L = opts.left || 26, R = 24, H = 22, floor = 16;
  const W = L + gap + R;
  const rows = [];
  for (let y = 0; y < H; y++) {
    let row = '';
    for (let x = 0; x < W; x++) {
      let c = '.';
      if (y >= floor && (x < L || x >= L + gap)) c = '#';
      if (opts.ceil && y === floor - opts.ceil && x >= L - 6 && x < L + gap + 6) c = '#';
      row += c;
    }
    rows.push(row);
  }
  rows[floor - 1] = rows[floor - 1].substring(0, 2) + String(stage) + rows[floor - 1].substring(3);
  return { name: 'gap', rows, entryY: floor, exitY: floor };
}

function ledgeRoom(height, stage) {
  const L = 26, R = 20, H = 34, floor = 28;
  const W = L + R;
  const rows = [];
  for (let y = 0; y < H; y++) {
    let row = '';
    for (let x = 0; x < W; x++) {
      let c = '.';
      if (y >= floor) c = '#';
      if (x >= L && y >= floor - height) c = '#';
      row += c;
    }
    rows.push(row);
  }
  rows[floor - 1] = rows[floor - 1].substring(0, 2) + String(stage) + rows[floor - 1].substring(3);
  return { name: 'ledge', rows, entryY: floor, exitY: floor - height };
}

// Try a parametrised policy over a set of offsets; true if any offset succeeds.
function anyOffset(room, makeScript, offsets, until, stage) {
  for (const off of offsets) {
    const res = run(MW, ['m'], makeScript(off), { rooms: { m: room }, until, stopOnDeath: true, tail: 2.5 });
    if (res.success) return off;
  }
  return null;
}

const range = (a, b, s) => { const out = []; for (let v = a; v <= b + 1e-9; v += s) out.push(+v.toFixed(3)); return out; };

// Start position: checkpoint at col 2 -> player x ≈ 2.15. Running right at speed v.
function runTo(xTarget, v) { return Math.max(0.01, (xTarget - 2.15) / v); }

function landedRight(L, gap, floor) {
  return w => {
    const p = w.player;
    return p.grounded && !p.dead && p.x > L + gap + 0.05 && Math.abs(p.y + p.h - floor) < 0.05;
  };
}

function maxGap(stage, mode) {
  // mode: 'jump' | 'clarityJump' | 'blinkApex' | 'soberBlink'
  const L = 26, floor = 16;
  let best = 0;
  for (let gap = 1; gap <= 20; gap++) {
    const room = gapRoom(gap, stage);
    let found = null;
    if (mode === 'jump') {
      // Run, jump at offset before the edge, hold jump + right.
      found = anyOffset(room, off => [[runTo(L + off, 7.6), 'right'], [1.6, 'right jump']], range(-1.6, 0.6, 0.05), landedRight(L, gap, floor));
    } else if (mode === 'clarityJump') {
      found = anyOffset(room, off => [[runTo(L - 8, 7.6), 'right'], [0.02, 'right focus'], [Math.max(0.02, runTo(L + off, 6.8) - runTo(L - 8, 6.8)), 'right'], [1.6, 'right jump']], range(-1.6, 0.6, 0.05), landedRight(L, gap, floor));
    } else if (mode === 'blinkApex') {
      // Drunk run + jump at the edge, Focus at time tf after takeoff, blink immediately.
      for (const off of [-0.6, -0.3, 0]) {
        found = anyOffset(room, tf => [[runTo(L + off, 7.8), 'right'], [tf, 'right jump'], [0.03, 'right jump focus'], [0.03, 'right jump focus cast'], [2.0, 'right']], range(0.05, 1.3, 0.03), landedRight(L, gap, floor));
        if (found !== null) break;
      }
    } else if (mode === 'soberBlink') {
      for (const off of [-0.6, -0.3, 0]) {
        found = anyOffset(room, tb => [[runTo(L - 8, 7.6), 'right'], [0.02, 'right focus'], [Math.max(0.02, runTo(L + off, 6.8) - runTo(L - 8, 6.8)), 'right'], [tb, 'right jump'], [0.03, 'right jump cast'], [2.0, 'right']], range(0.05, 0.9, 0.03), landedRight(L, gap, floor));
        if (found !== null) break;
      }
    }
    if (found !== null) best = gap; else if (gap > best + 2) break;
  }
  return best;
}

function maxLedge(stage, mode) {
  const L = 26, floor = 28;
  let best = 0;
  for (let h = 1; h <= 18; h++) {
    const room = ledgeRoom(h, stage);
    const until = w => { const p = w.player; return p.grounded && !p.dead && p.x > L - 0.2 && Math.abs(p.y + p.h - (floor - h)) < 0.05; };
    let found = null;
    if (mode === 'jump') {
      found = anyOffset(room, off => [[runTo(L + off, 7.6), 'right'], [1.8, 'right jump']], range(-6.0, -0.3, 0.1), until);
    } else if (mode === 'clarityJump') {
      found = anyOffset(room, off => [[runTo(L - 8, 7.6), 'right'], [0.02, 'right focus'], [Math.max(0.02, runTo(L + off, 6.8) - runTo(L - 8, 6.8)), 'right'], [1.8, 'right jump']], range(-6.0, -0.3, 0.1), until);
    } else if (mode === 'levApex') {
      // Stand close to the wall, drunk jump, Focus at tf, levitate (cast+up), then drift right.
      found = anyOffset(room, tf => [[runTo(L - 1.2, 7.0), 'right'], [0.25, ''], [tf, 'jump'], [0.03, 'jump focus up'], [0.03, 'jump focus up cast'], [0.15, 'up'], [1.5, 'right']], range(0.05, 1.0, 0.03), until);
    } else if (mode === 'soberLev') {
      found = anyOffset(room, tf => [[runTo(L - 1.2, 7.0), 'right'], [0.25, ''], [0.02, 'focus'], [0.1, ''], [tf, 'jump'], [0.03, 'jump up cast'], [0.15, 'up'], [1.5, 'right']], range(0.05, 0.8, 0.03), until);
    }
    if (found !== null) best = h; else if (h > best + 2) break;
  }
  return best;
}

function jumpShape(stage, clarity) {
  // Flat floor, stand still, jump (held vs tapped). Returns apex rise, min hop, airtime, run-jump distance.
  const room = gapRoom(0, stage, { left: 80 });
  const pre = clarity ? [[0.02, 'focus'], [0.1, '']] : [];
  const held = run(MW, ['m'], pre.concat([[0.02, 'jump'], [1.6, 'jump']]), { rooms: { m: room } });
  const tap = run(MW, ['m'], pre.concat([[MW.DT, 'jump'], [1.6, '']]), { rooms: { m: room } });
  const y0 = held.world.spawnPoint().y;
  const minY = a => Math.min.apply(null, a.trace.map(t => t.y));
  const air = held.trace.filter(t => !t.grounded).length * MW.DT;
  return { rise: +(y0 - minY(held)).toFixed(2), minHop: +(y0 - minY(tap)).toFixed(2), air: +air.toFixed(2) };
}

function featherGlide() {
  // Walk off a high ledge (stage 3), focus + feather immediately; measure horizontal tiles per vertical tile.
  const rows = [];
  const W = 60, H = 40;
  for (let y = 0; y < H; y++) {
    let r = '';
    for (let x = 0; x < W; x++) r += (y >= 6 && y <= 7 && x < 8) || y >= 38 ? '#' : '.';
    rows.push(r);
  }
  rows[5] = rows[5].substring(0, 2) + '3' + rows[5].substring(3);
  const room = { rows, entryY: 6, exitY: 38 };
  const res = run(MW, ['m'], [[0.6, 'right'], [0.03, 'right focus'], [0.03, 'right focus down cast'], [3.2, 'right']], { rooms: { m: room }, until: w => w.player.grounded && w.player.y > 30 });
  const tr = res.trace;
  let i0 = tr.findIndex(t => t.feather);
  let i1 = tr.length - 1;
  for (let i = i0; i < tr.length; i++) if (!tr[i].feather) { i1 = i; break; }
  if (i0 < 0) return null;
  const dx = tr[i1].x - tr[i0].x, dy = tr[i1].y - tr[i0].y;
  return { dx: +dx.toFixed(2), dy: +dy.toFixed(2), ratio: +(dx / Math.max(dy, 0.01)).toFixed(2), secs: +((i1 - i0) * MW.DT).toFixed(2) };
}

const out = { states: [] };
const names = ['Clarity', 'D1', 'D2', 'D3', 'D4'];
for (let s = 0; s <= 4; s++) {
  const stage = s === 0 ? 1 : s;
  const shape = jumpShape(stage, s === 0);
  const row = { state: names[s], rise: shape.rise, minHop: shape.minHop, airtime: shape.air };
  row.maxGap = maxGap(stage, s === 0 ? 'clarityJump' : 'jump');
  row.maxLedge = maxLedge(stage, s === 0 ? 'clarityJump' : 'jump');
  if (s > 0) {
    row.gapJumpFocusBlink = maxGap(stage, 'blinkApex');
    row.ledgeJumpFocusLevitate = maxLedge(stage, 'levApex');
  } else {
    row.gapJumpBlink = maxGap(1, 'soberBlink');
    row.ledgeJumpLevitate = maxLedge(1, 'soberLev');
  }
  out.states.push(row);
}
out.feather = featherGlide();
out.params = { blinkDist: MW.P.blinkDist, levitateH: MW.P.levitateH, clarityDur: MW.P.clarityDur, focusCooldown: MW.P.focusCooldown, jumpsPerStage: MW.P.jumpsPerStage, player: [MW.PLAYER_W, MW.PLAYER_H] };

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('MOVEMENT METRICS (measured by simulation; tiles, seconds)');
  console.log('maxGap = widest pit crossable (integer tiles) landing at the same height; maxLedge = tallest step climbable from a run-up.');
  console.table(out.states);
  console.log('Feather fall glide:', out.feather);
  console.log('Params:', out.params);
}
