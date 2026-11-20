// UI overlays inside #ui: title, pause, settings (volume), controls, finish/stats and the debug panel.
// Presentation only: reads MW.Game / world state and calls the MW.Game API. The debug panel is the one
// place that writes tuning state (MW.P, MW.D, MW.CHEATS) and calls world.setStage / teleportToCheckpoint.
//
// Keyboard ownership: a capture-phase keydown listener on window runs BEFORE MW.Input and main.js.
// When the UI owns a key (menu navigation, sub-panels, typing in a debug input) it stops propagation
// right there, so the wizard does not move and MW.Input does not preventDefault the keystroke (which
// would block typing letters, arrow keys on sliders and Space on buttons). capturesKeys(e) reports the
// same decision to main.js for any event that still reaches it.
var MW = MW || {};

MW.UI = (function () {
  'use strict';

  var STAGE_LABELS = ['Ясн', 'D1', 'D2', 'D3', 'D4'];
  var HINT_SECONDS = 9;
  var MENU_CLICK_GUARD_MS = 300;  // mouse clicks on a menu that just opened are ignored (LMB is Clarity in play)
  // Title letters cycle through the stage accents («Грибной трип», DESIGN §5); palette.js wins when loaded.
  var TITLE_COLORS = ['#f4c7a1', '#ffb05a', '#ff6fb5', '#ff3fd0', '#e9b8d0', '#9c4dff', '#7dfcff', '#3fd1c0', '#b6ff3b', '#b9d6ae', '#ffe14a'];
  var READOUT_PERIOD = 0.1;    // debug readout refresh (s): 10 Hz is plenty and keeps DOM churn low
  var EVLOG_SIZE = 6;
  var VOLUME_KEYS = { master: 1, music: 1, sfx: 1 };

  var game = null;
  var root = null;
  var els = {};                // named DOM nodes
  var sub = null;              // sub-panel over title / pause: 'settings' | 'controls' | null
  var subOpener = null;        // element that opened the sub-panel (focus returns there)
  var debugOpen = false;
  var lastWorld = null;        // detects level changes
  var cpWorld = null;          // world the checkpoint <select> was built for
  var hintWorld = null;        // world the corner hint was shown for (once per level load)
  var hintT = 0;
  var fps = 60;
  var readoutT = 0;
  var evLog = [];
  var evDirty = true;
  var settingRows = [];
  var paramRows = [];
  var paramByKey = {};
  var cheatBoxes = {};
  var stageBtns = [];
  var ioMode = null;           // debug JSON area: 'export' | 'import' | null
  var resetArmed = false, resetTimer = 0, statusTimer = 0;
  var pad = { prev: {}, armed: {}, mode: null };
  var finishedAt = 0;          // performance.now() when the finish screen opened
  var modeAt = 0;              // performance.now() of the last mode change (menu click guard)

  // ---------------------------------------------------------------- small helpers

  function h(tag, props, kids) {
    var el = document.createElement(tag);
    if (props) {
      for (var k in props) {
        var v = props[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'checked' || k === 'disabled' || k === 'readOnly' || k === 'hidden') el[k] = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, kids);
    return el;
  }

  function append(el, kids) {
    if (kids === undefined || kids === null || kids === false) return;
    if (!Array.isArray(kids)) kids = [kids];
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
  }

  function btn(label, onClick, cls, title) {
    return h('button', { type: 'button', class: 'mw-btn' + (cls ? ' ' + cls : ''), text: label, title: title, onclick: onClick });
  }

  function kbd(t) { return h('span', { class: 'mw-kbd', text: t }); }
  function show(el, on) { if (el) el.hidden = !on; }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function setText(el, t) { if (el.mwText !== t) { el.mwText = t; el.textContent = t; } }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, d) { return (+v || 0).toFixed(d === undefined ? 2 : d); }
  function fmtP(v) { return String(Math.round(v * 1000) / 1000); }
  function ru(s) { return String(s).replace('.', ','); }
  function padL(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }

  // Seconds -> "m:ss,t" (Russian decimal comma).
  function fmtTime(s) {
    var t = Math.max(0, Math.round((s || 0) * 10));
    var m = Math.floor(t / 600), r = t - m * 600, ss = Math.floor(r / 10);
    return m + ':' + (ss < 10 ? '0' : '') + ss + ',' + (r % 10);
  }

  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b === 1) return one;
    if (b > 1 && b < 5) return few;
    return many;
  }

  function roomLabel(def) {
    if (!def) return '—';
    return [def.section, def.name].filter(Boolean).join(' ');
  }

  function levelAvailable(name) {
    var ids = name === 'sandbox' ? MW.LEVEL_SANDBOX : MW.LEVEL_MAIN;
    return !!(ids && ids.length);
  }

  function otherLevel() { return game && game.levelName === 'sandbox' ? 'main' : 'sandbox'; }
  function otherLevelLabel() { return otherLevel() === 'sandbox' ? 'Песочница' : 'Основной уровень'; }

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  // Clipboard with a fallback for browsers that refuse navigator.clipboard on file://.
  function copyText(text, done) {
    var prev = document.activeElement;
    function fallback() {
      var ta = h('textarea', { class: 'mw-offscreen', readonly: true });
      ta.value = text;
      root.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      root.removeChild(ta);
      if (prev && prev.focus && prev !== document.body) prev.focus();
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    } else {
      fallback();
    }
  }

  // ---------------------------------------------------------------- focus / navigation

  var FOCUSABLE = 'button, input, select, textarea, summary';

  function focusables(card) {
    if (!card) return [];
    return Array.prototype.filter.call(card.querySelectorAll(FOCUSABLE), function (el) {
      return !el.disabled && el.offsetParent !== null;
    });
  }

  function focusIn(el) {
    var a = document.activeElement;
    return !!(el && a && a !== el && el.contains(a));
  }

  // preventScroll: a tall card (controls) must open at its top even when the first control is at the bottom.
  function focusFirst(card) {
    var f = focusables(card);
    if (f.length) f[0].focus({ preventScroll: true });
  }

  function moveFocus(card, dir) {
    var f = focusables(card);
    if (!f.length) return;
    var i = f.indexOf(document.activeElement);
    i = i < 0 ? (dir > 0 ? 0 : f.length - 1) : (i + dir + f.length) % f.length;
    f[i].focus();
  }

  function blurIn(el) {
    var a = document.activeElement;
    if (a && el && el.contains(a) && a.blur) a.blur();
  }

  // The menu card that keyboard / gamepad navigation acts on right now.
  function activeCard() {
    if (sub === 'settings') return els.settingsCard;
    if (sub === 'controls') return els.controlsCard;
    var m = game && game.mode;
    if (m === 'title') return els.titleCard;
    if (m === 'paused') return els.pauseCard;
    if (m === 'finished') return els.finishCard;
    return null;
  }

  // A focused control inside the debug panel: keys go to it, not to the game.
  function focusInDebug() {
    if (!debugOpen) return false;
    var a = document.activeElement;
    return !!(a && a !== els.debug && els.debug.contains(a) && /^(INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY)$/.test(a.tagName));
  }

  function isEnter(code) { return code === 'Enter' || code === 'NumpadEnter'; }

  // Title screen: these keys navigate the menu instead of "press any key to start".
  var TITLE_KEYS = {
    ArrowUp: 1, ArrowDown: 1, Tab: 1,
    ShiftLeft: 1, ShiftRight: 1, ControlLeft: 1, ControlRight: 1, AltLeft: 1, AltRight: 1, MetaLeft: 1, MetaRight: 1,
  };
  // Pause / finish screens.
  var FINISH_GUARD_MS = 750;
  var MENU_KEYS = {
    ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, KeyW: 1, KeyS: 1,
    Tab: 1, Enter: 1, NumpadEnter: 1, Space: 1, Escape: 1,
  };

  function ownsKey(e) {
    if (!game || !root || e.code === 'Backquote') return false;   // ` always reaches main.js (panel toggle)
    if (focusInDebug()) return true;
    if (sub) return e.code !== 'KeyM';                              // M still mutes from the settings panel
    var m = game.mode;
    if (m === 'title') {
      if (TITLE_KEYS[e.code] || e.metaKey || e.ctrlKey || e.altKey) return true;
      return (isEnter(e.code) || e.code === 'Space') && focusIn(els.titleCard);
    }
    if (m === 'paused' || m === 'finished') return !!MENU_KEYS[e.code];
    return false;
  }

  function onKeyCapture(e) {
    if (!ownsKey(e)) return;
    e.stopPropagation();
    uiKey(e);
  }

  function uiKey(e) {
    var a = document.activeElement;
    var code = e.code;

    if (focusInDebug()) {
      if (code === 'Escape') {
        // Revert to the value at focus time, then hand the keys back to the game. Arrow-key steps
        // already committed (Chrome fires 'change' per step), so re-commit the old value as well.
        if (a.tagName === 'INPUT' && a.type === 'number' && a.mwPrev !== undefined && a.value !== a.mwPrev) {
          a.value = a.mwPrev;
          a.dispatchEvent(new Event('change'));
        }
        a.blur();
        e.preventDefault();
      } else if (isEnter(code) && a.tagName === 'INPUT' && a.type === 'number') {
        a.blur();               // commits through the 'change' event
        e.preventDefault();
      }
      return;                   // everything else: native typing / stepping
    }

    if (code === 'Escape') {
      e.preventDefault();
      if (e.repeat) return;
      if (sub) closeSub(false);
      else if (game.mode === 'paused') game.resume();
      return;
    }
    if (isEnter(code) && e.repeat) { e.preventDefault(); return; }   // a held Enter must not re-press buttons
    if (game.mode === 'finished' && (isEnter(code) || code === 'Space') && performance.now() - finishedAt < FINISH_GUARD_MS) {
      e.preventDefault();       // still holding / mashing jump from the last run: don't press a finish button
      return;
    }

    var card = activeCard();
    if (code === 'ArrowUp' || code === 'KeyW') { e.preventDefault(); moveFocus(card, -1); return; }
    if (code === 'ArrowDown' || code === 'KeyS') { e.preventDefault(); moveFocus(card, 1); return; }
    if (code === 'Tab' && !debugOpen) { e.preventDefault(); moveFocus(card, e.shiftKey ? -1 : 1); return; }
    if ((code === 'ArrowLeft' || code === 'ArrowRight') && a && a.type === 'range' && focusIn(card)) {
      e.preventDefault();
      nudgeRange(a, code === 'ArrowLeft' ? -1 : 1, e.shiftKey ? 1 : 5);
      return;
    }
    if (isEnter(code) && a && a.type === 'checkbox' && focusIn(card)) { e.preventDefault(); a.click(); return; }
    if ((isEnter(code) || code === 'Space') && card && !focusIn(card)) { e.preventDefault(); focusFirst(card); return; }
    // Otherwise native behaviour: Enter / Space press the focused button, Space toggles a checkbox.
  }

  // ---------------------------------------------------------------- mouse
  // The left button is Clarity during play (src/input.js ignores pointerdowns inside #ui). Two rules here:
  //  - a click on the game (outside the debug panel) takes focus away from a debug control, so the next
  //    keys go to the wizard, not to a number box;
  //  - a menu that has just opened ignores mouse clicks for a moment: a Clarity click mashed while the
  //    level ends (or the pause opens) must not press «Ещё раз» / «Уровень заново».
  function onPointerCapture(e) {
    if (!root || !debugOpen || !focusInDebug()) return;
    if (els.debug.contains(e.target)) return;
    var a = document.activeElement;
    if (a && a.blur) a.blur();
  }

  function onMenuClickCapture(e) {
    if (!game || e.detail === 0) return;               // keyboard / gamepad "clicks" have their own guards
    if (els.debug && els.debug.contains(e.target)) return;
    var guard = game.mode === 'finished' ? FINISH_GUARD_MS : MENU_CLICK_GUARD_MS;
    if (performance.now() - modeAt < guard) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  function nudgeRange(input, dir, n) {
    if (dir > 0) input.stepUp(n); else input.stepDown(n);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ---------------------------------------------------------------- gamepad in menus
  // main.js polls the pad only while playing. In menus: d-pad / stick = move, A = press, B = back,
  // Start = resume / start. Actions that switch to play fire on RELEASE, so the same press is not
  // seen again by the game (A would jump, B would focus, Start would pause again).

  function pollPadMenu(mode) {
    var gp = null;
    try {
      var pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) { gp = pads[i]; break; }
    } catch (err) { gp = null; }
    var cur = {};
    if (gp) {
      var b = function (i) { return !!(gp.buttons[i] && gp.buttons[i].pressed); };
      var ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      cur = {
        up: b(12) || ay < -0.5, down: b(13) || ay > 0.5, left: b(14) || ax < -0.5, right: b(15) || ax > 0.5,
        a: b(0), b: b(1), start: b(9),
      };
    }
    // Buttons held when the mode changes (Start that just paused, A that was jumping into the portal)
    // must not count as menu presses on the new screen.
    if (pad.mode !== mode) { pad.mode = mode; pad.prev = cur; pad.armed = {}; return; }
    if (mode === 'finished' && performance.now() - finishedAt < FINISH_GUARD_MS) { pad.prev = cur; pad.armed = {}; return; }
    var prev = pad.prev;
    pad.prev = cur;
    if (!gp || mode === 'play') { pad.armed = {}; return; }
    var card = activeCard();
    var press = function (k) { return cur[k] && !prev[k]; };
    var release = function (k) { var r = pad.armed[k] && prev[k] && !cur[k]; if (!cur[k]) pad.armed[k] = false; return r; };
    ['a', 'b', 'start'].forEach(function (k) { if (press(k)) pad.armed[k] = true; });

    if (press('up')) moveFocus(card, -1);
    if (press('down')) moveFocus(card, 1);
    var a = document.activeElement;
    if ((press('left') || press('right')) && a && a.type === 'range' && focusIn(card)) nudgeRange(a, press('left') ? -1 : 1, 5);

    if (release('a')) {
      a = document.activeElement;
      if (card && focusIn(card)) {
        if (a.tagName === 'BUTTON' || a.type === 'checkbox') a.click();
      } else if (mode === 'title' && !sub) {
        game.start('main');
      } else {
        focusFirst(card);
      }
    }
    if (release('b')) {
      if (sub) closeSub(false);
      else if (mode === 'paused') game.resume();
    }
    if (release('start')) {
      if (sub) closeSub(false);
      else if (mode === 'paused') game.resume();
      else if (mode === 'title') game.start('main');
    }
  }

  // ---------------------------------------------------------------- screens

  function titleColors() {
    var S = MW.PALETTE && MW.PALETTE.stages;
    if (!S || !S[1] || !S[4]) return TITLE_COLORS;
    // Peach → magenta → violet → cyan → acid → sage: a smooth drift through all four stages.
    return [S[1].accent, S[2].accent, S[2].glow, S[3].accent, S[1].glow, S[3].groundEdge, S[3].glow, S[2].fringe,
      S[3].fringe, S[1].fringe, S[4].accent].filter(Boolean);
  }

  // The title as per-letter spans: each letter has its own colour and a phase-shifted wave (style.css).
  // Screen readers get the plain text through aria-label.
  function trippyTitle(text) {
    var colors = titleColors();
    var el = h('h1', { class: 'mw-title', 'aria-label': text });
    var n = 0;
    text.split(' ').forEach(function (word, wi) {
      if (wi) el.appendChild(h('span', { class: 'mw-title-gap', 'aria-hidden': 'true', text: ' ' }));
      var w = h('span', { class: 'mw-title-word', 'aria-hidden': 'true' });
      for (var k = 0; k < word.length; k++, n++) {
        var ch = h('span', { class: 'mw-title-ch', text: word[k] });
        ch.style.setProperty('--i', String(n));
        ch.style.setProperty('--c', colors[n % colors.length]);
        w.appendChild(ch);
      }
      el.appendChild(w);
    });
    return el;
  }

  // A blinking, wandering eye above the title (decorative, CSS-animated).
  function eye() {
    return h('div', { class: 'mw-eye', 'aria-hidden': 'true' },
      h('div', { class: 'mw-eye-lid' }, h('div', { class: 'mw-eye-iris' }, h('div', { class: 'mw-eye-pupil' }))));
  }

  function buildTitle() {
    els.titleSandbox = btn('Песочница', function () { game.start('sandbox'); });
    els.titleNote = h('div', { class: 'mw-note' });
    els.titleCard = h('div', { class: 'mw-card mw-card-title' }, [
      eye(),
      trippyTitle('Грибной волшебник'),
      h('div', { class: 'mw-subtitle', text: 'прототип' }),
      h('div', { class: 'mw-tagline', text: 'каждый прыжок уводит глубже' }),
      h('div', { class: 'mw-press', text: 'Нажмите любую клавишу' }),
      h('div', { class: 'mw-menu' }, [
        btn('Играть', function () { game.start('main'); }, 'mw-primary'),
        els.titleSandbox,
        btn('Настройки', function (e) { openSub('settings', e.currentTarget); }),
        btn('Управление', function (e) { openSub('controls', e.currentTarget); }),
      ]),
      els.titleNote,
    ]);
    els.title = h('div', { class: 'mw-screen mw-screen-title', hidden: true }, [
      h('div', { class: 'mw-spores', 'aria-hidden': 'true' }),
      els.titleCard,
    ]);
  }

  function fillTitle() {
    var ok = levelAvailable('sandbox');
    els.titleSandbox.disabled = !ok;
    els.titleSandbox.title = ok ? '' : 'Песочница ещё не собрана';
    setText(els.titleNote, storageGet(MW.PARAMS_KEY) ? 'Действуют сохранённые параметры из панели отладки' : '');
  }

  function buildPause() {
    els.pauseHead = h('h2', { class: 'mw-h2', text: 'Пауза' });
    els.pauseInfo = h('div', { class: 'mw-info' });
    els.pauseSwitch = btn('Песочница', function () { game.start(otherLevel()); });
    els.pauseCard = h('div', { class: 'mw-card mw-card-menu' }, [
      els.pauseHead,
      els.pauseInfo,
      h('div', { class: 'mw-menu' }, [
        btn('Продолжить', function () { game.resume(); }, 'mw-primary'),
        btn('С чекпоинта', function () { game.restartCheckpoint(); }),
        btn('Уровень заново', function () { game.restartLevel(); }),
        btn('Настройки', function (e) { openSub('settings', e.currentTarget); }),
        btn('Управление', function (e) { openSub('controls', e.currentTarget); }),
        els.pauseSwitch,
      ]),
    ]);
    els.pause = h('div', { class: 'mw-screen', hidden: true }, els.pauseCard);
  }

  function fillPause() {
    var w = game.world;
    var parts = [];
    var r = w && w.currentRoom ? w.currentRoom() : null;
    if (r && r.def) parts.push(roomLabel(r.def));
    if (w) {
      parts.push('смертей: ' + w.stats.deaths);
      parts.push(fmtTime(w.stats.time));
    }
    setText(els.pauseInfo, parts.join('  ·  '));
    setText(els.pauseHead, game.levelName === 'sandbox' ? 'Пауза · песочница' : 'Пауза');
    els.pauseSwitch.textContent = otherLevelLabel();
    els.pauseSwitch.disabled = !levelAvailable(otherLevel());
  }

  // ---- settings

  function saveSettings() {
    if (MW.saveSettings) MW.saveSettings(); // persists and notifies listeners (refreshSettings is one)
    else refreshSettings();
  }

  function buildSettings() {
    function slider(key, label) {
      var input = h('input', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': label });
      var value = h('span', { class: 'mw-set-val' });
      input.addEventListener('input', function () {
        MW.settings[key] = clamp(+input.value, 0, 100) / 100;
        saveSettings();
      });
      var row = h('label', { class: 'mw-set-row' }, [h('span', { class: 'mw-set-label', text: label }), input, value]);
      settingRows.push({ key: key, kind: 'range', input: input, value: value, row: row });
      return row;
    }
    function check(key, label) {
      var input = h('input', { type: 'checkbox' });
      input.addEventListener('change', function () {
        MW.settings[key] = input.checked;
        saveSettings();
      });
      var row = h('label', { class: 'mw-set-row mw-set-check' }, [input, h('span', { class: 'mw-set-label', text: label })]);
      settingRows.push({ key: key, kind: 'check', input: input, row: row });
      return row;
    }
    els.settingsCard = h('div', { class: 'mw-card mw-card-settings' }, [
      h('h2', { class: 'mw-h2', text: 'Настройки' }),
      h('div', { class: 'mw-sec', text: 'Звук' }),
      slider('master', 'Общая громкость'),
      slider('music', 'Музыка'),
      slider('sfx', 'Эффекты'),
      check('muted', 'Без звука (M)'),
      h('div', { class: 'mw-sec', text: 'Экран' }),
      slider('fx', 'Экранные эффекты'),
      h('div', { class: 'mw-set-note', text: '0 — выкл, 50 — умеренные (по умолчанию), 100 — сильные. Сильные эффекты могут укачивать.' }),
      check('shake', 'Тряска экрана'),
      h('div', { class: 'mw-row mw-row-end' }, btn('Назад', function () { closeSub(false); }, 'mw-primary')),
    ]);
    els.settings = h('div', { class: 'mw-screen mw-screen-sub', hidden: true }, els.settingsCard);
  }

  function refreshSettings() {
    var s = MW.settings || {};
    for (var i = 0; i < settingRows.length; i++) {
      var r = settingRows[i];
      if (r.kind === 'range') {
        var v = Math.round((+s[r.key] || 0) * 100);
        if (+r.input.value !== v) r.input.value = v;
        setText(r.value, v + '%');
      } else {
        r.input.checked = !!s[r.key];
      }
      if (VOLUME_KEYS[r.key]) r.row.classList.toggle('mw-dim', !!s.muted);
    }
  }

  // ---- controls

  // Key spec: tokens separated by spaces; '/' and '+' are plain separators, everything else is a keycap.
  function keys(spec) {
    var out = [];
    spec.split(' ').forEach(function (t) {
      if (t === '/') out.push(h('span', { class: 'mw-sep', text: '/' }));
      else if (t === '+') out.push(h('span', { class: 'mw-sep', text: '+' }));
      else out.push(kbd(t));
    });
    return out;
  }

  function keyTable(rows) {
    return h('div', { class: 'mw-keys' }, rows.map(function (r) {
      return h('div', { class: 'mw-key-row' }, [h('div', { class: 'mw-key-caps' }, keys(r[0])), h('div', { class: 'mw-key-desc', text: r[1] })]);
    }));
  }

  // Compact inline list for secondary keys: [caps] description · [caps] description ...
  function keyStrip(rows) {
    return h('div', { class: 'mw-strip' }, rows.map(function (r) {
      return h('span', { class: 'mw-strip-item' }, keys(r[0]).concat([h('span', { class: 'mw-key-desc', text: r[1] })]));
    }));
  }

  function buildControls() {
    els.ideaList = h('ul', { class: 'mw-idea' });
    var keyboard = keyTable([
      ['← → / A D', 'движение'],
      ['Пробел / Z / J', 'прыжок (+1 стадия; держите — выше)'],
      ['ЛКМ / X / K', 'Ясность (ещё раз — выйти)'],
      ['1', 'Блинк'],
      ['2', 'Взлёт'],
      ['3', 'Пёрышко'],
      ['R', 'назад к чекпоинту'],
      ['Esc', 'пауза'],
    ]);
    var gamepad = keyTable([
      ['Стик / Крестовина', 'движение'],
      ['A', 'прыжок'],
      ['LB / RB / LT / RT', 'Ясность'],
      ['X', 'Блинк'],
      ['Y', 'Взлёт'],
      ['B', 'Пёрышко'],
      ['Back', 'к чекпоинту'],
      ['Start', 'пауза'],
    ]);
    els.controlsCard = h('div', { class: 'mw-card mw-card-controls' }, [
      h('h2', { class: 'mw-h2', text: 'Управление' }),
      els.ideaList,
      h('div', { class: 'mw-cols' }, [
        h('div', { class: 'mw-col' }, [h('div', { class: 'mw-sec', text: 'Клавиатура и мышь' }), keyboard]),
        h('div', { class: 'mw-col' }, [
          h('div', { class: 'mw-sec', text: 'Геймпад' }), gamepad,
          h('div', { class: 'mw-set-note', text: 'В меню: крестовина — выбор, A — нажать, B — назад.' }),
        ]),
      ]),
      h('div', { class: 'mw-sec', text: 'Ещё' }),
      keyStrip([['M', 'звук'], ['`', 'панель отладки'], ['G', 'отладочный оверлей']]),
      h('div', { class: 'mw-sec', text: 'Отладка (после первого `)' }),
      keyStrip([['Shift + 1–4', 'стадия'], ['N / B', 'чекпоинт вперёд / назад'], ['I', 'бессмертие'], ['O', 'бесконечная Ясность']]),
      h('div', { class: 'mw-row mw-row-end' }, btn('Назад', function () { closeSub(false); }, 'mw-primary')),
    ]);
    els.controls = h('div', { class: 'mw-screen mw-screen-sub', hidden: true }, els.controlsCard);
  }

  // The core idea in four lines, using the live tuning values.
  function fillIdea() {
    var P = MW.P || {};
    var n = P.jumpsPerStage || 1;
    var every = n === 1 ? 'Каждый прыжок — новая стадия опьянения (до D4)'
      : 'Каждые ' + n + ' ' + plural(n, 'прыжок', 'прыжка', 'прыжков') + ' — новая стадия опьянения (до D4)';
    var lines = [
      every + ', она наступает при приземлении. Прыжки всё выше и длиннее, но скользко и шатко; на D4 — икота.',
      'ЛКМ — Ясность на ' + ru(P.clarityDur) + ' с' + (P.focusSlowScale < 1 && P.focusSlowDur > 0 ? ' (вход на миг замедляет время)' : '') +
        ': стадия замирает, прыжок низкий, но точный. Потом ' + ru(P.focusCooldown) + ' с перезарядки; кристалл возвращает заряд сразу.',
      (P.castEndsClarity ? 'Заклинание сразу завершает Ясность' : 'Одно заклинание за Ясность') +
        ': 1 — Блинк (сквозь стены и ловушки, но не сквозь рунные стены), 2 — Взлёт, 3 — Пёрышко (планирование продолжается).',
      'Пропасть между платформами — смерть. R — назад к чекпоинту (это не смерть). ' +
        (P.cpSetsStage ? 'Чекпоинт задаёт стадию опьянения.' : 'Чекпоинт поднимает стадию до своей.'),
    ];
    clear(els.ideaList);
    lines.forEach(function (t) { els.ideaList.appendChild(h('li', { text: t })); });
  }

  // ---- finish

  function buildFinish() {
    els.finishTitle = h('h2', { class: 'mw-h2 mw-gold' });
    els.finishTiles = h('div', { class: 'mw-tiles' });
    els.finishTable = h('table', { class: 'mw-table' });
    els.finishStatus = h('div', { class: 'mw-note' });
    els.finishSwitch = btn('Песочница', function () { game.start(otherLevel()); });
    els.finishCard = h('div', { class: 'mw-card mw-card-finish' }, [
      els.finishTitle,
      els.finishTiles,
      h('div', { class: 'mw-table-wrap' }, els.finishTable),
      h('div', { class: 'mw-row' }, [
        btn('Копировать статистику', copyStats, '', 'Скопировать итоги и таблицу (TSV) в буфер обмена'),
        els.finishSwitch,
        btn('Ещё раз', function () { game.restartLevel(); }, 'mw-primary'),
      ]),
      els.finishStatus,
    ]);
    els.finish = h('div', { class: 'mw-screen', hidden: true }, els.finishCard);
  }

  function fillFinish() {
    var w = game.world, s = w.stats;
    setText(els.finishTitle, game.levelName === 'sandbox' ? 'Песочница пройдена' : 'Уровень пройден!');
    setText(els.finishStatus, '');
    els.finishSwitch.textContent = otherLevelLabel();
    els.finishSwitch.disabled = !levelAvailable(otherLevel());

    clear(els.finishTiles);
    [
      ['Время', fmtTime(s.time), true], ['Смерти', s.deaths, true], ['Возвраты (R)', s.restarts],
      ['Фокус', s.focus], ['Заклинания', s.casts], ['Прыжки', s.jumps],
    ].forEach(function (t) {
      els.finishTiles.appendChild(h('div', { class: 'mw-tile' + (t[2] ? ' mw-tile-key' : '') }, [
        h('div', { class: 'mw-tile-v', text: String(t[1]) }),
        h('div', { class: 'mw-tile-l', text: t[0] }),
      ]));
    });

    var rooms = s.perRoom || [];
    var worst = 0;
    rooms.forEach(function (r) { worst = Math.max(worst, r.deaths); });
    var t = els.finishTable;
    clear(t);
    var cols = [['Секция'], ['Название'], ['Смерти', 1], ['Время', 1], ['Фокус', 1], ['Закл.', 1, 'Заклинания'], ['R', 1, 'Возвраты к чекпоинту']];
    t.appendChild(h('thead', null, h('tr', null, cols.map(function (c) {
      return h('th', { class: c[1] ? 'mw-n' : null, title: c[2], text: c[0] });
    }))));
    var body = h('tbody');
    rooms.forEach(function (r) {
      body.appendChild(h('tr', { class: worst > 0 && r.deaths === worst ? 'mw-worst' : null }, [
        h('td', { text: r.section || '' }),
        h('td', { text: r.name || '' }),
        h('td', { class: 'mw-n', text: String(r.deaths) }),
        h('td', { class: 'mw-n', text: fmtTime(r.time) }),
        h('td', { class: 'mw-n', text: String(r.focus) }),
        h('td', { class: 'mw-n', text: String(r.casts) }),
        h('td', { class: 'mw-n', text: String(r.restarts || 0) }),
      ]));
    });
    t.appendChild(body);
    t.appendChild(h('tfoot', null, h('tr', null, [
      h('td', { text: 'Итого', colspan: 2 }),
      h('td', { class: 'mw-n', text: String(s.deaths) }),
      h('td', { class: 'mw-n', text: fmtTime(s.time) }),
      h('td', { class: 'mw-n', text: String(s.focus) }),
      h('td', { class: 'mw-n', text: String(s.casts) }),
      h('td', { class: 'mw-n', text: String(s.restarts) }),
    ])));
  }

  function modifiedParams() {
    var out = {};
    (MW.PARAMS_DEF || []).forEach(function (d) { if (!sameValue(MW.P[d[1]], d[2])) out[d[1]] = MW.P[d[1]]; });
    return out;
  }

  function copyStats() {
    var w = game.world, s = w.stats;
    var lines = [
      'Грибной волшебник — ' + (game.levelName === 'sandbox' ? 'песочница' : 'основной уровень') + ' — ' + new Date().toLocaleString('ru-RU'),
      'Время\t' + fmtTime(s.time),
      'Смерти\t' + s.deaths,
      'Возвраты (R)\t' + s.restarts,
      'Фокус\t' + s.focus,
      'Заклинания\t' + s.casts,
      'Прыжки\t' + s.jumps,
      '',
      ['Секция', 'Название', 'Смерти', 'Время, с', 'Фокус', 'Заклинания', 'Возвраты'].join('\t'),
    ];
    (s.perRoom || []).forEach(function (r) {
      lines.push([r.section || '', r.name || '', r.deaths, ru(num(r.time, 1)), r.focus, r.casts, r.restarts || 0].join('\t'));
    });
    var mod = modifiedParams();
    lines.push('', 'Изменённые параметры: ' + (Object.keys(mod).length ? JSON.stringify(mod) : 'нет'));
    copyText(lines.join('\n'), function (ok) {
      setText(els.finishStatus, ok ? 'Статистика скопирована в буфер обмена' : 'Не удалось скопировать');
    });
  }

  // ---- sub-panels and visibility

  function openSub(name, opener) {
    sub = name;
    subOpener = opener || null;
    if (name === 'settings') refreshSettings();
    if (name === 'controls') fillIdea();
    sync();
    focusFirst(activeCard());
  }

  function closeSub(silent) {
    if (!sub) return;
    var card = activeCard();
    sub = null;
    blurIn(card);
    sync();
    if (!silent && subOpener && subOpener.offsetParent !== null) subOpener.focus();
    else if (!silent) focusFirst(activeCard());
    subOpener = null;
  }

  function sync() {
    var m = game ? game.mode : 'title';
    show(els.title, m === 'title');
    show(els.pause, m === 'paused');
    show(els.finish, m === 'finished');
    show(els.titleCard, !sub);
    show(els.pauseCard, !sub);
    show(els.settings, sub === 'settings');
    show(els.controls, sub === 'controls');
  }

  function setHint(on) { els.hint.classList.toggle('mw-on', !!on); }

  // ---------------------------------------------------------------- debug panel

  function sameValue(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-9) return false;
      return true;
    }
    return Math.abs(a - b) <= 1e-9;
  }

  function status(msg, kind) {
    els.dbgStatus.textContent = msg;
    els.dbgStatus.className = 'mw-status' + (kind ? ' mw-' + kind : '');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { els.dbgStatus.textContent = ''; }, 5000);
  }

  function setParam(key, v) {
    MW.P[key] = v;
    MW.D = MW.derive(MW.P);
    var r = paramByKey[key];
    if (r) r.refresh();
    if (ioMode === 'export') els.ioText.value = JSON.stringify(MW.P);
  }

  function refreshParams() {
    for (var i = 0; i < paramRows.length; i++) paramRows[i].refresh();
  }

  // Shared row frame: label (gold when changed from the default) + a reset button.
  function paramRow(d, ctl, refresh) {
    var reset = btn('↺', function () { setParam(d[1], Array.isArray(d[2]) ? d[2].slice() : d[2]); }, 'mw-p-reset',
      'По умолчанию: ' + (Array.isArray(d[2]) ? d[2].join(' / ') : d[2]));
    var el = h('div', { class: 'mw-p' }, [
      h('div', { class: 'mw-p-top' }, [h('span', { class: 'mw-p-label', text: d[6], title: d[1] }), reset]),
      ctl,
    ]);
    var row = {
      el: el,
      refresh: function () {
        refresh();
        var mod = !sameValue(MW.P[d[1]], d[2]);
        el.classList.toggle('mw-mod', mod);
        reset.style.visibility = mod ? 'visible' : 'hidden';
      },
    };
    paramRows.push(row);
    paramByKey[d[1]] = row;
    return row;
  }

  // Scalar param: slider (live) + number box (commits on Enter / blur, clamped to the declared range).
  function paramScalar(d) {
    var key = d[1], min = d[3], max = d[4], step = d[5];
    var rng = h('input', { type: 'range', min: min, max: max, step: step, 'aria-label': d[6] });
    var box = h('input', { type: 'number', class: 'mw-num', min: min, max: max, step: step, 'aria-label': d[6] });
    var row = paramRow(d, h('div', { class: 'mw-p-ctl' }, [rng, box]), function () {
      rng.value = MW.P[key];
      if (document.activeElement !== box) box.value = fmtP(MW.P[key]);
    });
    rng.addEventListener('input', function () {
      setParam(key, Math.round(+rng.value * 1e6) / 1e6);
    });
    box.addEventListener('change', function () {
      var v = parseFloat(box.value);
      if (isFinite(v)) setParam(key, clamp(v, min, max));
      box.value = fmtP(MW.P[key]);
    });
    return row.el;
  }

  // Per-stage param: five compact number boxes [Clarity, D1..D4].
  function paramArray(d) {
    var key = d[1], min = d[3], max = d[4], step = d[5];
    var boxes = [];
    var cells = h('div', { class: 'mw-cells' }, STAGE_LABELS.map(function (lab, s) {
      var box = h('input', { type: 'number', class: 'mw-num', min: min, max: max, step: step, 'aria-label': d[6] + ' — ' + lab });
      box.addEventListener('change', function () {
        var v = parseFloat(box.value);
        if (isFinite(v)) {
          var arr = MW.P[key].slice();
          arr[s] = clamp(v, min, max);
          setParam(key, arr);
        }
        box.value = fmtP(MW.P[key][s]);
      });
      boxes.push(box);
      return h('label', { class: 'mw-cell' + (s === 0 ? ' mw-cell-clar' : '') }, [h('span', { text: lab }), box]);
    }));
    var row = paramRow(d, cells, function () {
      for (var s = 0; s < boxes.length; s++) {
        if (document.activeElement !== boxes[s]) boxes[s].value = fmtP(MW.P[key][s]);
      }
    });
    return row.el;
  }

  function teleport(i) {
    if (game && game.world && isFinite(i) && i >= 0) game.world.teleportToCheckpoint(i);
  }

  function rebuildCheckpoints(w) {
    var sel = els.cpSelect;
    clear(sel);
    cpWorld = w;
    if (!w || !w.level) return;
    var lvl = w.level;
    lvl.checkpoints.forEach(function (c, i) {
      var r = c.room !== undefined ? lvl.rooms[c.room] : (MW.roomAt ? MW.roomAt(lvl, c.x) : null);
      sel.appendChild(h('option', { value: String(i), text: (i + 1) + '. ' + (r ? roomLabel(r.def) : '') + ' · D' + c.stage }));
    });
    if (!lvl.checkpoints.length) sel.appendChild(h('option', { value: '', text: 'нет чекпоинтов', disabled: true }));
    if (w.cpIndex >= 0) sel.value = String(w.cpIndex);
  }

  function onSave() {
    var ok = MW.saveParams ? MW.saveParams() : false;
    status(ok ? 'Параметры сохранены в браузере' : 'Не удалось сохранить: хранилище недоступно', ok ? 'ok' : 'err');
  }

  function disarmReset() {
    resetArmed = false;
    clearTimeout(resetTimer);
    els.resetBtn.textContent = 'Сброс';
  }

  // Two clicks: the first arms the button for 3 s, so a stray click doesn't wipe a tuning session.
  function onReset() {
    if (!resetArmed) {
      resetArmed = true;
      els.resetBtn.textContent = 'Точно сбросить?';
      clearTimeout(resetTimer);
      resetTimer = setTimeout(disarmReset, 3000);
      return;
    }
    disarmReset();
    MW.resetParams();
    if (MW.clearSavedParams) MW.clearSavedParams();
    refreshParams();
    if (ioMode === 'export') els.ioText.value = JSON.stringify(MW.P);
    status('Параметры сброшены, сохранённые удалены', 'ok');
  }

  function showIO(mode) {
    if (mode && mode === ioMode) mode = null;   // second click on the same button closes the area
    ioMode = mode;
    show(els.io, !!mode);
    if (!mode) { blurIn(els.io); return; }
    var exp = mode === 'export';
    els.ioText.readOnly = exp;
    els.ioText.value = exp ? JSON.stringify(MW.P) : '';
    els.ioText.placeholder = exp ? '' : 'Вставьте JSON параметров и нажмите «Применить»';
    show(els.ioApply, !exp);
    show(els.ioCopy, exp);
    els.ioText.focus();
    if (exp) els.ioText.select();
  }

  function applyImport() {
    var obj;
    try { obj = JSON.parse(els.ioText.value); } catch (err) { status('Ошибка JSON: ' + err.message, 'err'); return; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { status('Нужен объект вида {"jumpH": [...], ...}', 'err'); return; }
    // Keep only well-formed finite numbers: a NaN in MW.P would break the physics until reload.
    var clean = {}, n = 0;
    MW.PARAMS_DEF.forEach(function (d) {
      var v = obj[d[1]];
      var good = Array.isArray(d[2])
        ? Array.isArray(v) && v.length === d[2].length && v.every(function (x) { return typeof x === 'number' && isFinite(x); })
        : typeof v === 'number' && isFinite(v);
      if (good) { clean[d[1]] = v; n++; }
    });
    if (!n) { status('Ни один параметр не подошёл', 'err'); return; }
    MW.applyParams(clean);
    refreshParams();
    status('Применено параметров: ' + n + '. «Сохранить» — чтобы запомнить.', 'ok');
  }

  function buildDebug() {
    els.readout = h('pre', { class: 'mw-readout' });
    els.evlog = h('pre', { class: 'mw-evlog' });

    stageBtns = [1, 2, 3, 4].map(function (n) {
      return btn('D' + n, function () { if (game.world) game.world.setStage(n); }, 'mw-stage-btn', 'Стадия D' + n + ' (Shift+' + n + ')');
    });

    els.cpSelect = h('select', { class: 'mw-select', 'aria-label': 'Чекпоинт' });
    els.cpSelect.addEventListener('change', function () {
      teleport(+els.cpSelect.value);
      els.cpSelect.blur();      // give the arrow keys back to the wizard
    });

    var cheats = [['overlay', 'Оверлей (G)'], ['god', 'Бессмертие (I)'], ['infiniteClarity', 'Бесконечная ясность (O)']].map(function (c) {
      var box = h('input', { type: 'checkbox' });
      box.addEventListener('change', function () { MW.CHEATS[c[0]] = box.checked; box.blur(); });
      cheatBoxes[c[0]] = box;
      return h('label', { class: 'mw-dbg-check' }, [box, c[1]]);
    });

    els.dbgStatus = h('div', { class: 'mw-status' });
    els.resetBtn = btn('Сброс', onReset, 'mw-danger', 'Вернуть все параметры по умолчанию и удалить сохранённые');
    els.ioText = h('textarea', { class: 'mw-io-text', spellcheck: 'false', rows: 5 });
    els.ioApply = btn('Применить', applyImport, 'mw-primary');
    els.ioCopy = btn('Копировать', function () {
      copyText(els.ioText.value, function (ok) {
        status(ok ? 'JSON скопирован' : 'Не удалось скопировать: выделите текст и нажмите Ctrl/Cmd+C', ok ? 'ok' : 'err');
      });
    }, 'mw-primary');
    els.io = h('div', { class: 'mw-io', hidden: true }, [
      els.ioText,
      h('div', { class: 'mw-dbg-row' }, [els.ioApply, els.ioCopy, btn('Закрыть', function () { showIO(null); })]),
    ]);

    // Param editors grouped by PARAMS_DEF group, in declaration order.
    var groups = {}, order = [];
    (MW.PARAMS_DEF || []).forEach(function (d) {
      if (!groups[d[0]]) { groups[d[0]] = []; order.push(d[0]); }
      groups[d[0]].push(d);
    });
    var groupEls = order.map(function (g) {
      return h('details', { class: 'mw-group', open: true }, [h('summary', { text: g })].concat(groups[g].map(function (d) {
        return Array.isArray(d[2]) ? paramArray(d) : paramScalar(d);
      })));
    });

    els.debug = h('div', { class: 'mw-debug', hidden: true }, [
      h('div', { class: 'mw-dbg-head' }, [
        h('span', { class: 'mw-dbg-title', text: 'Отладка' }),
        h('span', { class: 'mw-dbg-tip' }, [kbd('`'), ' скрыть']),
        btn('✕', function () { MW.UI.toggleDebugPanel(); }, 'mw-dbg-x', 'Закрыть панель'),
      ]),
      els.readout,
      els.evlog,
      h('div', { class: 'mw-dbg-row' }, [h('span', { class: 'mw-dbg-label', text: 'Стадия' })].concat(stageBtns)),
      h('div', { class: 'mw-dbg-keys' }, [
        kbd('Shift+1–4'), ' стадия · ', kbd('N'), kbd('B'), ' чекпоинт · ', kbd('I'), ' бессмертие · ', kbd('O'), ' ∞ Ясность · ', kbd('G'), ' оверлей',
      ]),
      h('div', { class: 'mw-dbg-keys' }, 'Клик по панели не включает Ясность; ЛКМ по игре — включает.'),
      h('div', { class: 'mw-dbg-row' }, [
        h('span', { class: 'mw-dbg-label', text: 'Чекпоинт' }),
        els.cpSelect,
        btn('→', function () { teleport(+els.cpSelect.value); }, '', 'Телепорт к выбранному чекпоинту'),
      ]),
      h('div', { class: 'mw-dbg-cheats' }, cheats),
      h('div', { class: 'mw-dbg-sec', text: 'Параметры' }),
      h('div', { class: 'mw-dbg-row mw-wrap' }, [
        btn('Сохранить', onSave, 'mw-primary', 'Запомнить параметры в браузере'),
        els.resetBtn,
        btn('Экспорт JSON', function () { showIO('export'); }),
        btn('Импорт JSON', function () { showIO('import'); }),
      ]),
      els.dbgStatus,
      els.io,
    ].concat(groupEls));

    // After a MOUSE interaction, drop focus so game keys work again immediately. Number boxes, the
    // select (until it changes) and the JSON area keep focus: those are for typing.
    els.debug.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button, summary') : null;
      if (t && e.detail > 0) setTimeout(function () { if (document.activeElement === t) t.blur(); }, 0);
    });
    els.debug.addEventListener('pointerup', function (e) {
      var t = e.target;
      if (t && t.type === 'range') setTimeout(function () { if (document.activeElement === t) t.blur(); }, 0);
    });
    // Remember the value at focus, so Esc can revert an uncommitted edit.
    els.debug.addEventListener('focusin', function (e) {
      if (e.target.tagName === 'INPUT') e.target.mwPrev = e.target.value;
    });
  }

  var EV_LABEL = {
    jump: 'прыжок', bonk: 'удар головой', stageWarn: 'стадия скоро ↑', stageUp: 'стадия ↑', stageDown: 'стадия ↓',
    focusOn: 'Ясность', focusOff: 'Ясность кончилась', focusWarn: 'Ясность: скоро конец', focusReady: 'заряд готов',
    focusDenied: 'нет заряда', cast: 'заклинание', fizzle: 'осечка', featherEnd: 'пёрышко кончилось',
    hiccupWarn: 'скоро ик', hiccup: 'ик!', death: 'смерть', respawn: 'возрождение', restart: 'возврат (R)',
    checkpoint: 'чекпоинт', pickup: 'подобрано', finish: 'финиш', crumble: 'обвал',
  };
  var SPELL_LABEL = { blink: 'Блинк', levitate: 'Взлёт', feather: 'Пёрышко' };
  var CAUSE_LABEL = { spikes: 'шипы', saw: 'пила', pit: 'пропасть' };
  var PICKUP_LABEL = { mushroom: 'гриб', crystal: 'кристалл' };

  function evText(e) {
    var t = EV_LABEL[e.type] || e.type;
    if (e.type === 'stageUp' || e.type === 'stageDown') t += ' D' + e.stage + (e.debug ? ' (отладка)' : '');
    else if (e.type === 'stageWarn') t += ' D' + e.stage;
    else if (e.type === 'cast') t += ': ' + (SPELL_LABEL[e.spell] || e.spell);
    else if (e.type === 'death') t += ': ' + (CAUSE_LABEL[e.cause] || e.cause);
    else if (e.type === 'pickup') t += ': ' + (PICKUP_LABEL[e.kind] || e.kind);
    else if (e.type === 'checkpoint') t += ' ' + (e.index + 1);
    else if (e.type === 'focusOff' && e.early) t = 'Ясность: выход раньше';
    else if (e.type === 'fizzle') t += e.reason === 'used' ? ': уже было' : ': не в Ясности';
    else if (e.type === 'jump') t += e.clarity ? ' (трезвый)' : ' D' + e.stage;
    return t;
  }

  function renderReadout(w) {
    if (!w || !w.player) return;
    var p = w.player, P = MW.P, lvl = w.level;
    var room = w.currentRoom ? w.currentRoom() : null;
    var ri = w.roomIndexAt ? w.roomIndexAt(p.x + p.w / 2) : 0;
    var L = [];
    var st = 'Стадия   D' + p.stage + '  прыжки ' + p.drunkJumps + '/' + P.jumpsPerStage;
    if (p.pendingStageUp) st += '  ↑ при посадке';
    if (p.stage >= 4 && P.hiccupEnabled && !p.clarity) st += '  ик ' + num(Math.max(0, p.hiccupT), 1);
    L.push(st);
    L.push('Ясность  ' + (p.clarity ? num(p.clarityT) + ' с' : 'нет   ') + '  заряд ' + p.charge + '  откат ' + num(p.cooldownT));
    var sp = p.clarity ? (p.spellUsed ? 'потрачено' : 'готово') : '—';
    if (p.featherT > 0) sp += '  пёрышко ' + num(p.featherT, 1);
    if (p.levitateT > 0) sp += '  взлёт';
    L.push('Заклин.  ' + sp);
    L.push('vx ' + padL(num(p.vx), 6) + '  vy ' + padL(num(p.vy), 6) + '  ' + (p.grounded ? 'на земле' : 'в воздухе'));
    L.push('x  ' + padL(num(p.x, 1), 6) + '  y  ' + padL(num(p.y, 1), 6));
    L.push('Комната  ' + (room ? roomLabel(room.def) : '—') + '  ' + (ri + 1) + '/' + lvl.rooms.length);
    L.push('Чекпоинт ' + (w.cpIndex + 1) + '/' + lvl.checkpoints.length + '  смерти ' + w.stats.deaths + '  ' + fmtTime(w.stats.time));
    var ch = [];
    if (MW.CHEATS.god) ch.push('бессмертие');
    if (MW.CHEATS.infiniteClarity) ch.push('∞ ясность');
    L.push('FPS ' + Math.round(fps) + (ch.length ? '  · ' + ch.join(', ') : ''));
    setText(els.readout, L.join('\n'));

    if (evDirty) {
      evDirty = false;
      var lines = [];
      for (var i = evLog.length - 1; i >= 0; i--) lines.push(padL(num(evLog[i].t, 1), 6) + '  ' + evLog[i].s);
      setText(els.evlog, lines.length ? lines.join('\n') : 'события появятся здесь');
    }

    for (var s = 0; s < stageBtns.length; s++) stageBtns[s].classList.toggle('mw-active', p.stage === s + 1);
    for (var k in cheatBoxes) if (cheatBoxes[k].checked !== !!MW.CHEATS[k]) cheatBoxes[k].checked = !!MW.CHEATS[k];
    var sel = els.cpSelect;
    if (document.activeElement !== sel && w.cpIndex >= 0 && sel.value !== String(w.cpIndex)) sel.value = String(w.cpIndex);
  }

  // ---------------------------------------------------------------- scale with the stage
  // Menus are sized in em relative to #ui, whose font size follows the stage width (960 = 1.0).
  // The debug panel uses fixed px: it is a tool, it should stay compact on big screens.

  function watchScale() {
    var stage = document.getElementById('stage') || root.parentNode;
    function rescale() {
      var w = (stage && stage.clientWidth) || 960;
      root.style.setProperty('--mw-s', clamp(w / 960, 0.6, 2.4).toFixed(3));
    }
    if (window.ResizeObserver && stage) new ResizeObserver(rescale).observe(stage);
    else window.addEventListener('resize', function () { requestAnimationFrame(rescale); });
    rescale();
  }

  // ---------------------------------------------------------------- public API

  return {
    init: function (g) {
      game = g;
      root = document.getElementById('ui');
      if (!root) {
        root = h('div', { id: 'ui' });
        (document.getElementById('stage') || document.body).appendChild(root);
      }
      buildTitle();
      buildPause();
      buildFinish();
      buildSettings();
      buildControls();
      buildDebug();
      // Non-interactive (pointer-events: none in style.css): a left click on it must reach the game as Clarity.
      els.hint = h('div', { class: 'mw-hint', 'aria-hidden': 'true' }, [
        kbd('ЛКМ'), ' — Ясность · ', kbd('1'), '/', kbd('2'), '/', kbd('3'), ' — заклинания · ',
        kbd('Esc'), ' — пауза · ', kbd('`'), ' — отладка',
      ]);
      // DOM order = stacking order: sub-panels above their screens, the debug panel above everything.
      append(root, [els.title, els.pause, els.finish, els.settings, els.controls, els.hint, els.debug]);

      refreshSettings();
      refreshParams();
      if (MW.onSettingsChanged) MW.onSettingsChanged(refreshSettings);
      window.addEventListener('keydown', onKeyCapture, true);
      window.addEventListener('pointerdown', onPointerCapture, true);
      root.addEventListener('click', onMenuClickCapture, true);
      watchScale();
      lastWorld = g.world;
      fillTitle();
      sync();
    },

    onMode: function (mode, g) {
      if (g) game = g;
      if (!root) return;
      modeAt = performance.now();
      closeSub(true);           // sub-panels belong to the screen that is going away
      var menus = [els.title, els.pause, els.finish];
      for (var i = 0; i < menus.length; i++) blurIn(menus[i]);
      if (mode === 'title') fillTitle();
      else if (mode === 'paused') fillPause();
      else if (mode === 'finished') { fillFinish(); finishedAt = performance.now(); }
      sync();

      if (mode === 'play') {
        if (game.world !== hintWorld) { hintWorld = game.world; hintT = HINT_SECONDS; }
        setHint(hintT > 0);
      } else {
        setHint(false);
      }
      if (!focusInDebug()) focusFirst(activeCard());
    },

    handle: function (e, world) {
      if (!e || e.type === 'land') return;     // landings are too frequent to be useful in the log
      evLog.push({ t: world && world.stats ? world.stats.time : 0, s: evText(e) });
      if (evLog.length > EVLOG_SIZE) evLog.shift();
      evDirty = true;
    },

    update: function (world, dt, mode) {
      if (!root) return;
      if (dt > 0) fps += (1 / dt - fps) * 0.05;
      if (world !== lastWorld) {
        lastWorld = world;
        evLog.length = 0;
        evDirty = true;
        if (debugOpen) rebuildCheckpoints(world);
      }
      if (mode === 'play' && hintT > 0) {
        hintT -= dt;
        if (hintT <= 0) setHint(false);
      }
      pollPadMenu(mode);
      if (debugOpen) {
        readoutT -= dt;
        if (readoutT <= 0) {
          readoutT = READOUT_PERIOD;
          renderReadout(world);
        }
      }
    },

    toggleDebugPanel: function () {
      if (!root) return;
      debugOpen = !debugOpen;
      show(els.debug, debugOpen);
      if (debugOpen) {
        refreshParams();
        if (game && game.world && cpWorld !== game.world) rebuildCheckpoints(game.world);
        readoutT = 0;
        evDirty = true;
        if (game && game.world) renderReadout(game.world);
      } else {
        blurIn(els.debug);
        disarmReset();
      }
    },

    capturesKeys: function (e) { return ownsKey(e); },
  };
})();
