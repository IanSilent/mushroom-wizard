#!/usr/bin/env node
// Headless-Chrome screenshot tool for visual work (no network, opens index.html via file://).
//
// Usage:
//   node tools/shot.js --out /tmp/a.png [--level main|sandbox] [--cp 3] [--stage 1..4] [--clarity]
//                      [--frames 90] [--script "[[0.5,'right'],[0.4,'right jump']]"] [--overlay] [--title]
//                      [--js "MW.CHEATS.god=true"] [--width 1280 --height 720]
//   Several shots in one run: --multi '[{"out":"/tmp/a.png","cp":0,"stage":1},{"out":"/tmp/b.png","stage":4,"clarity":true}]'
// Prints console errors / exceptions from the page. Exit code 1 if any exception was thrown.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.MW_URL || ('file://' + path.join(__dirname, '..', 'index.html'));

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); if (i < 0) return d; const v = argv[i + 1]; return v === undefined || v.startsWith('--') ? true : v; };

function shotsFromArgs() {
  if (arg('multi')) return JSON.parse(arg('multi'));
  return [{
    out: arg('out', path.join(os.tmpdir(), 'mw-shot.png')), level: arg('level', 'main'), cp: arg('cp') !== undefined ? +arg('cp') : undefined,
    stage: arg('stage') !== undefined ? +arg('stage') : undefined, clarity: !!arg('clarity'), frames: +arg('frames', 90),
    script: arg('script') ? eval(arg('script')) : null, overlay: !!arg('overlay'), title: !!arg('title'), js: arg('js') || '',
  }];
}

function launch(width, height, prof) {
  return new Promise((res, rej) => {
    const p = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + prof, '--no-first-run',
      '--no-default-browser-check', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required',
      `--window-size=${width},${height}`, 'about:blank']);
    let buf = '';
    p.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res({ p, ws: m[1] }); });
    setTimeout(() => rej(new Error('Chrome did not start: ' + buf.slice(0, 500))), 20000);
  });
}

// Runs inside the page: drives MW.Game deterministically by calling frame() with synthetic time.
function pageSetup(s) {
  return `(async () => {
    const G = MW.Game, s = ${JSON.stringify(s)};
    let T = performance.now(); G.last = T;
    const frames = n => { for (let i = 0; i < n; i++) { T += 1000 / 60; G.frame(T); } };
    const map = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', jump: 'Space', focus: 'KeyX', spell1: 'Digit1', spell2: 'Digit2', spell3: 'Digit3', restart: 'KeyR', cast: 'KeyX' };
    const fire = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
    if (s.js) eval(s.js);
    if (s.title) { frames(s.frames || 60); return 'ok'; }
    G.start(s.level || 'main');
    MW.CHEATS.overlay = !!s.overlay;
    if (s.cp !== undefined && s.cp !== null) G.world.teleportToCheckpoint(s.cp);
    frames(10);
    if (s.stage) G.world.setStage(s.stage);
    if (s.script) {
      let held = new Set();
      for (const [d, k] of s.script) {
        const want = new Set(String(k).split(/[\\s+]+/).filter(Boolean).map(x => map[x]));
        for (const c of held) if (!want.has(c)) fire('keyup', c);
        for (const c of want) if (!held.has(c)) fire('keydown', c);
        held = want;
        frames(Math.max(1, Math.round(d * 60)));
      }
      for (const c of held) fire('keyup', c);
    }
    if (s.clarity) { fire('keydown', 'KeyX'); frames(1); fire('keyup', 'KeyX'); }
    frames(s.frames || 60);
    return 'ok';
  })()`;
}

async function main() {
  const shots = shotsFromArgs();
  const width = +arg('width', 1280), height = +arg('height', 720);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-chrome-'));
  const { p, ws } = await launch(width, height, prof);
  const sock = new WebSocket(ws);
  await new Promise(r => sock.onopen = r);
  let id = 0; const pend = {}; const logs = []; let exceptions = 0;
  sock.onmessage = m => {
    const msg = JSON.parse(m.data);
    if (msg.id && pend[msg.id]) { pend[msg.id](msg); delete pend[msg.id]; return; }
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning'))
      logs.push('[console.' + msg.params.type + '] ' + msg.params.args.map(a => a.value !== undefined ? a.value : (a.description || a.type)).join(' '));
    if (msg.method === 'Runtime.exceptionThrown') { exceptions++; logs.push('[EXCEPTION] ' + (msg.params.exceptionDetails.exception ? msg.params.exceptionDetails.exception.description : msg.params.exceptionDetails.text)); }
  };
  let sid = null;
  const send = (method, params) => new Promise(r => { const i = ++id; pend[i] = r; sock.send(JSON.stringify({ id: i, method, params: params || {}, sessionId: sid || undefined })); });
  try {
    const t = await send('Target.createTarget', { url: 'about:blank' });
    const att = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
    sid = att.result.sessionId;
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const s of shots) {
      await send('Page.navigate', { url: URL });
      // Wait until the game has booted (MW.Game.world exists).
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 100));
        const ready = await send('Runtime.evaluate', { expression: "typeof MW !== 'undefined' && !!(MW.Game && MW.Game.world)", returnByValue: true });
        if (ready.result && ready.result.result && ready.result.result.value === true) break;
      }
      const ev = await send('Runtime.evaluate', { expression: pageSetup(s), awaitPromise: true, returnByValue: true });
      if (ev.result && ev.result.exceptionDetails) { exceptions++; logs.push('[setup EXCEPTION] ' + JSON.stringify(ev.result.exceptionDetails.exception && ev.result.exceptionDetails.exception.description)); }
      await new Promise(r => setTimeout(r, 150));
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(s.out, Buffer.from(shot.result.data, 'base64'));
      console.log('wrote ' + s.out);
    }
  } finally {
    try { sock.close(); } catch (e) { /* ignore */ }
    p.kill();
    setTimeout(() => { try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) { /* ignore */ } }, 500);
  }
  logs.forEach(l => console.log(l));
  if (exceptions) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
