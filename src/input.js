// Browser input: keyboard + mouse (+ standard gamepad). Produces one snapshot per simulation step.
// Presses are queued on keydown / pointerdown, so taps shorter than one step are never lost.
//
// Default layout: WASD / arrows move, Space / Z jump, LEFT MOUSE BUTTON = Clarity (X also works),
// 1 / 2 / 3 = Blink / Levitate / Feather fall. Shift + 1..4 is reserved for the debug stage keys.
var MW = MW || {};

MW.KEYMAP = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  jump: ['Space', 'KeyZ', 'KeyJ'],
  focus: ['KeyX', 'KeyK'],
  spell1: ['Digit1', 'Numpad1'],
  spell2: ['Digit2', 'Numpad2'],
  spell3: ['Digit3', 'Numpad3'],
  restart: ['KeyR'],
};

MW.SPELL_OF_ACTION = { spell1: 'blink', spell2: 'levitate', spell3: 'feather' };

MW.Input = function () {
  var self = this;
  this.down = {};       // code -> bool
  this.pressedQ = {};   // action -> bool (since last snapshot)
  this.mouseDown = false;
  this.codeToAction = {};
  Object.keys(MW.KEYMAP).forEach(function (a) {
    MW.KEYMAP[a].forEach(function (c) { self.codeToAction[c] = a; });
  });
  this.pad = {};
  this.padPrev = {};
  this.enabled = true;
  window.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;   // Cmd+R / Ctrl+C etc. stay browser shortcuts
    var a = self.codeToAction[e.code];
    if (a && MW.SPELL_OF_ACTION[a] && e.shiftKey) return; // Shift+digits = debug stage keys
    if (a) {
      e.preventDefault();
      if (!e.repeat && self.enabled) self.pressedQ[a] = true;
    }
    self.down[e.code] = true;
  });
  window.addEventListener('keyup', function (e) { self.down[e.code] = false; });
  window.addEventListener('blur', function () { self.down = {}; self.mouseDown = false; });

  // Left mouse button = Focus (Clarity). Clicks on UI panels (debug panel, menus) are ignored.
  window.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || !self.enabled) return;
    var ui = document.getElementById('ui');
    if (ui && e.target !== ui && ui.contains(e.target)) return;
    e.preventDefault();
    self.mouseDown = true;
    self.pressedQ.focus = true;
  });
  window.addEventListener('pointerup', function (e) { if (e.button === 0) self.mouseDown = false; });
  // No context menu over the game (a mis-click on the right button shouldn't pop a menu mid-jump).
  window.addEventListener('contextmenu', function (e) {
    var stage = document.getElementById('stage');
    if (stage && stage.contains(e.target) && self.enabled) e.preventDefault();
  });
};

MW.Input.prototype.held = function (action) {
  var codes = MW.KEYMAP[action];
  for (var i = 0; i < codes.length; i++) if (this.down[codes[i]]) return true;
  if (action === 'focus' && this.mouseDown) return true;
  return !!this.pad[action];
};

MW.Input.prototype.pollGamepad = function () {
  var pads = navigator.getGamepads ? navigator.getGamepads() : [];
  var gp = null;
  for (var i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) { gp = pads[i]; break; }
  this.padPrev = this.pad;
  this.pad = {};
  if (!gp) return;
  var b = function (i) { return gp.buttons[i] && gp.buttons[i].pressed; };
  var ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
  this.pad.left = b(14) || ax < -0.4;
  this.pad.right = b(15) || ax > 0.4;
  this.pad.up = b(12) || ay < -0.5;
  this.pad.down = b(13) || ay > 0.5;
  this.pad.jump = b(0);                  // A
  this.pad.focus = b(4) || b(5) || b(6) || b(7); // LB / RB / LT / RT
  this.pad.spell1 = b(2);                // X = Blink
  this.pad.spell2 = b(3);                // Y = Levitate
  this.pad.spell3 = b(1);                // B = Feather fall
  this.pad.restart = b(8);
  this.pad.pause = b(9);
  for (var k in this.pad) if (this.pad[k] && !this.padPrev[k] && k !== 'pause') this.pressedQ[k] = true;
};

// One snapshot per simulation step.
MW.Input.prototype.snapshot = function () {
  var s = {};
  var actions = Object.keys(MW.KEYMAP);
  for (var i = 0; i < actions.length; i++) {
    var a = actions[i];
    s[a] = this.enabled && (this.held(a) || !!this.pressedQ[a]);
  }
  var q = this.enabled ? this.pressedQ : {};
  s.jumpPressed = !!q.jump;
  s.focusPressed = !!q.focus;
  s.castPressed = false;
  s.spell = q.spell1 ? 'blink' : q.spell2 ? 'levitate' : q.spell3 ? 'feather' : null;
  s.restartPressed = !!q.restart;
  this.pressedQ = {};
  return s;
};

MW.Input.prototype.clear = function () { this.pressedQ = {}; this.mouseDown = false; };
