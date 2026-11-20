#!/usr/bin/env node
// Level checker: structural validation + replays every room's solution scripts headlessly.
//
// Usage:
//   node tools/check.js                 all rooms of MW.LEVEL_MAIN and MW.LEVEL_SANDBOX
//   node tools/check.js <roomId>        one room
//   node tools/check.js <roomId> --trace [solutionName]   print an ASCII trace of the run
//   node tools/check.js --level         build the stitched main level and validate seams
// Options: --jitter=N (max ±steps of timing noise, default 4 = ±33 ms), --runs=N (default 16)
'use strict';
const { loadMW, run, robustness, renderTrace } = require('./simlib');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const a = args.find(s => s.startsWith('--' + name + '='));
  return a ? Number(a.split('=')[1]) : def;
};
const MW = loadMW();
const JIT = opt('jitter', 4), RUNS = opt('runs', 16);
const KNOWN = new Set('#X%=^v<>O1234PM*ET~. '.split(''));

function structural(id) {
  const r = MW.ROOMS[id];
  const errs = [], warns = [];
  if (!r) return { errs: ['room not found'], warns };
  const w = Math.max.apply(null, r.rows.map(s => s.length));
  r.rows.forEach((row, y) => {
    if (row.length !== w) warns.push(`row ${y} has length ${row.length}, expected ${w}`);
    for (const c of row) if (!KNOWN.has(c)) errs.push(`row ${y}: unknown char '${c}'`);
  });
  const h = r.rows.length;
  const at = (x, y) => (r.rows[y] && r.rows[y][x]) || '.';
  if (r.entryY === undefined || r.exitY === undefined) errs.push('entryY / exitY missing');
  if (id !== 'sandbox') {
    if (!'#X%'.includes(at(0, r.entryY))) errs.push(`entry floor (col 0,row ${r.entryY}) is not solid: '${at(0, r.entryY)}'`);
    if (!'#X%'.includes(at(w - 1, r.exitY))) errs.push(`exit floor (col ${w - 1},row ${r.exitY}) is not solid: '${at(w - 1, r.exitY)}'`);
    for (let k = 1; k <= 3; k++) {
      if ('#X%^v<>'.includes(at(0, r.entryY - k))) errs.push(`entry opening blocked at row ${r.entryY - k}`);
      if ('#X%^v<>'.includes(at(w - 1, r.exitY - k))) errs.push(`exit opening blocked at row ${r.exitY - k}`);
    }
  }
  // Checkpoints: floor below, two free cells.
  let firstCp = null;
  r.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c >= '1' && c <= '4') {
        if (!firstCp || x < firstCp.x) firstCp = { x, y };
        if (!'#X%='.includes(at(x, y + 1))) errs.push(`checkpoint at (${x},${y}) has no floor below`);
        if ('#X%^v<>'.includes(at(x, y - 1))) errs.push(`checkpoint at (${x},${y}) has no headroom`);
      }
    }
  });
  if (!firstCp && id !== 'sandbox') errs.push('no checkpoint');
  if (firstCp && id !== 'sandbox') {
    if (firstCp.x > 8) warns.push(`first checkpoint at column ${firstCp.x} (should be within 8 columns of the entrance)`);
    if (firstCp.y !== r.entryY - 1) warns.push(`first checkpoint row ${firstCp.y} != entryY-1 (${r.entryY - 1})`);
  }
  const signs = r.rows.join('').split('T').length - 1;
  if (signs !== (r.signs || []).length) warns.push(`${signs} T cells but ${(r.signs || []).length} sign texts`);
  if (!r.solutions || !r.solutions.length) warns.push('no solutions');
  return { errs, warns, w, h };
}

function checkRoom(id, traceName) {
  const st = structural(id);
  const r = MW.ROOMS[id];
  const lines = [];
  lines.push(`\n=== ${id} — ${r ? r.section + ' ' + r.name : ''} (${st.w}x${st.h})`);
  st.errs.forEach(e => lines.push('  ERROR ' + e));
  st.warns.forEach(e => lines.push('  warn  ' + e));
  let ok = st.errs.length === 0;
  if (!r) { console.log(lines.join('\n')); return false; }
  (r.solutions || []).forEach(sol => {
    const runOpts = { startCheckpoint: sol.startCheckpoint || 0 };
    if (sol.until === 'finish') runOpts.until = w => w.finished;
    const res = run(MW, [id], sol.script, runOpts);
    let rob = '';
    if (res.success && !sol.noJitter) {
      const r2 = robustness(MW, [id], sol.script, 2, RUNS, runOpts);
      const rj = robustness(MW, [id], sol.script, JIT, RUNS, runOpts);
      rob = ` robust(±2 steps)=${Math.round(r2 * 100)}% robust(±${JIT})=${Math.round(rj * 100)}%`;
    }
    const expectFail = sol.expect === 'fail';
    const pass = expectFail ? !res.success : res.success;
    if (!pass) ok = false;
    const stats = `t=${res.time}s deaths=${res.deaths.length} focus=${res.events.focusOn || 0} casts=${res.events.cast || 0} stage=${res.final.stage}`;
    lines.push(`  ${pass ? 'PASS' : 'FAIL'} [${sol.name}]${expectFail ? ' (expected to fail)' : ''} ${stats}${rob}`);
    if (!res.success && !expectFail) {
      lines.push(`       final pos x=${res.final.x} y=${res.final.y} grounded=${res.final.grounded}` + (res.deaths.length ? ` first death: ${JSON.stringify(res.deaths[0])}` : ''));
    }
    if (traceName !== undefined && (traceName === true || traceName === sol.name)) {
      lines.push(renderTrace(MW, res));
    }
  });
  console.log(lines.join('\n'));
  return ok;
}

function checkLevel() {
  const ids = MW.LEVEL_MAIN || [];
  const lvl = MW.buildLevel(ids);
  console.log(`Main level: ${ids.length} rooms, ${lvl.w}x${lvl.h} tiles, ${lvl.checkpoints.length} checkpoints, ${lvl.saws.length} saws, ${lvl.pickups.length} pickups, exits=${lvl.exits.length}`);
  lvl.rooms.forEach(r => console.log(`  ${r.id.padEnd(16)} x=${String(r.ox).padStart(4)} y=${String(r.oy).padStart(3)} ${r.w}x${r.h} cps=${lvl.checkpoints.filter(c => c.room === lvl.rooms.indexOf(r)).map(c => 'D' + c.stage).join(',')}`));
  if (!lvl.exits.length) console.log('  warn: main level has no E exit');
  return true;
}

let allOk = true;
if (args.includes('--level')) {
  checkLevel();
} else if (args[0] && !args[0].startsWith('--')) {
  const ti = args.indexOf('--trace');
  const traceName = ti >= 0 ? (args[ti + 1] && !args[ti + 1].startsWith('--') ? args[ti + 1] : true) : undefined;
  allOk = checkRoom(args[0], traceName);
} else {
  const ids = (MW.LEVEL_MAIN || []).concat(MW.LEVEL_SANDBOX || []);
  ids.forEach(id => { if (!checkRoom(id)) allOk = false; });
  checkLevel();
}
process.exitCode = allOk ? 0 : 1;
