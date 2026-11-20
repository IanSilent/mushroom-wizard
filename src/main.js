// Boot + fixed-step main loop. Owns the game mode (title / play / paused / finished) and wires
// world events to the renderer, background FX, audio and UI.
var MW = MW || {};

MW.Game = {
  mode: 'title',       // 'title' | 'play' | 'paused' | 'finished'
  levelName: 'main',   // 'main' | 'sandbox'
  world: null,
  input: null,
  renderer: null,
  bg: null,
  acc: 0,
  last: 0,
  debugMode: false,
  frameEvents: [],
  timeScale: 1,       // < 1 during the short slow-motion on entering Clarity (read by presentation code)
  slowT: 0,           // real seconds left of the current slow-motion

  boot: function () {
    MW.loadSettings();
    MW.loadSavedParams();
    var gameCanvas = document.getElementById('game');
    var bgCanvas = document.getElementById('bg');
    this.input = new MW.Input();
    this.renderer = MW.Renderer ? new MW.Renderer(gameCanvas) : null;
    this.bg = MW.BgFx ? new MW.BgFx(bgCanvas) : null;
    this.loadLevel('main');
    if (MW.UI && MW.UI.init) MW.UI.init(this);
    if (MW.Audio && MW.Audio.setVolumes) MW.Audio.setVolumes(MW.settings);
    MW.onSettingsChanged(function (s) { if (MW.Audio && MW.Audio.setVolumes) MW.Audio.setVolumes(s); });
    this.bindKeys();
    this.fit();
    window.addEventListener('resize', this.fit.bind(this));
    this.last = performance.now();
    requestAnimationFrame(this.frame.bind(this));
    this.setMode('title');
  },

  loadLevel: function (name, opts) {
    opts = opts || {};
    this.levelName = name;
    var ids = name === 'sandbox' ? MW.LEVEL_SANDBOX : MW.LEVEL_MAIN;
    this.world = new MW.World(ids, opts);
    if (this.renderer && this.renderer.reset) this.renderer.reset(this.world);
    if (this.bg && this.bg.reset) this.bg.reset();
    if (MW.Audio && MW.Audio.reset) MW.Audio.reset();
    this.acc = 0;
  },

  // Called by the UI.
  start: function (name) {
    if (MW.Audio && MW.Audio.init) MW.Audio.init();
    if (name && (name !== this.levelName || this.mode === 'finished' || this.mode === 'title')) this.loadLevel(name);
    this.setMode('play');
  },
  resume: function () { this.setMode('play'); },
  pause: function () { if (this.mode === 'play') this.setMode('paused'); },
  restartCheckpoint: function () { if (this.world) this.world.restart(); this.setMode('play'); },
  restartLevel: function () { this.loadLevel(this.levelName); this.setMode('play'); },

  setMode: function (m) {
    this.mode = m;
    this.input.clear();
    this.input.enabled = m === 'play';
    if (MW.UI && MW.UI.onMode) MW.UI.onMode(m, this);
    if (MW.Audio && MW.Audio.onMode) MW.Audio.onMode(m);
  },

  bindKeys: function () {
    var self = this;
    window.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;   // browser shortcuts, not game keys
      if (MW.UI && MW.UI.capturesKeys && MW.UI.capturesKeys(e)) return;
      if (e.code === 'Escape') {
        if (self.mode === 'play') self.pause();
        else if (self.mode === 'paused') self.resume();
        e.preventDefault();
        return;
      }
      if (e.code === 'KeyM' && !e.repeat) {
        MW.settings.muted = !MW.settings.muted;
        MW.saveSettings();
        return;
      }
      if (e.code === 'Backquote' && !e.repeat) {
        self.debugMode = true;
        if (MW.UI && MW.UI.toggleDebugPanel) MW.UI.toggleDebugPanel();
        e.preventDefault();
        return;
      }
      if (e.code === 'KeyG' && !e.repeat) { MW.CHEATS.overlay = !MW.CHEATS.overlay; return; }
      if (self.mode === 'title' && !e.repeat) {
        self.start('main');
        return;
      }
      if (!self.debugMode || self.mode !== 'play' || e.repeat) return;
      if (e.shiftKey && e.code >= 'Digit1' && e.code <= 'Digit4') self.world.setStage(+e.code.slice(5));
      else if (e.code === 'KeyN') self.world.teleportToCheckpoint(Math.min(self.world.cpIndex + 1, self.world.level.checkpoints.length - 1));
      else if (e.code === 'KeyB') self.world.teleportToCheckpoint(Math.max(self.world.cpIndex - 1, 0));
      else if (e.code === 'KeyI') MW.CHEATS.god = !MW.CHEATS.god;
      else if (e.code === 'KeyO') MW.CHEATS.infiniteClarity = !MW.CHEATS.infiniteClarity;
    });
  },

  fit: function () {
    var wrap = document.getElementById('stage');
    if (!wrap) return;
    var W = 960, H = 540;
    var s = Math.min(window.innerWidth / W, window.innerHeight / H);
    wrap.style.width = Math.floor(W * s) + 'px';
    wrap.style.height = Math.floor(H * s) + 'px';
  },

  frame: function (now) {
    // Schedule first: an exception below (e.g. a param tuned to a bad value) must not freeze the game.
    requestAnimationFrame(this.frame.bind(this));
    var dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    try {
      this.tick(dt);
    } catch (err) {
      if (!this.errLogged) { this.errLogged = true; console.error(err); }
    }
  },

  tick: function (dt) {
    var w = this.world;
    if (this.mode === 'play') {
      this.input.pollGamepad();
      if (this.input.pad.pause && !this.input.padPrev.pause) this.pause();
    }
    if (this.mode === 'play' || this.mode === 'title') {
      // Title = attract mode: the world ticks on the same fixed step with no input.
      var play = this.mode === 'play';
      this.timeScale = play ? this.slowScale(dt) : 1;
      this.acc += dt * this.timeScale;
      var steps = 0;
      while (this.acc >= MW.DT && steps < 12) {
        w.update(play ? this.input.snapshot() : {});
        this.acc -= MW.DT;
        steps++;
      }
      if (steps >= 12) this.acc = 0;
    }
    this.flushEvents();
    // Game layer first: it updates the camera that the background parallax reads.
    if (this.renderer) this.renderer.render(w, dt, this.mode);
    if (this.bg) this.bg.render(this.bgState(dt));
    if (MW.Audio && MW.Audio.update) MW.Audio.update(w, dt, this.mode);
    if (MW.UI && MW.UI.update) MW.UI.update(w, dt, this.mode);
  },

  flushEvents: function () {
    var w = this.world, evs = w.events;
    if (!evs.length) return;
    w.events = [];
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      try {
        if (this.renderer && this.renderer.handle) this.renderer.handle(e, w);
        if (this.bg && this.bg.handle) this.bg.handle(e, w);
        if (MW.Audio && MW.Audio.handle) MW.Audio.handle(e, w);
        if (MW.UI && MW.UI.handle) MW.UI.handle(e, w);
      } catch (err) { console.error(err); }
      if (e.type === 'finish') this.setMode('finished');
      // Entering Clarity briefly slows time (tunable: focusSlowScale / focusSlowDur / focusSlowEase).
      if (e.type === 'focusOn') this.slowT = MW.P.focusSlowDur;
      else if (e.type === 'focusOff' || e.type === 'death' || e.type === 'respawn' || e.type === 'restart') this.endSlow();
    }
  },

  // Real-time slow-motion curve: hold at focusSlowScale, then ease back to 1 over the last
  // focusSlowEase fraction of focusSlowDur.
  slowScale: function (dt) {
    var P = MW.P, dur = P.focusSlowDur;
    if (this.slowT <= 0 || dur <= 0) { this.slowT = 0; return 1; }
    var elapsed = dur - this.slowT;
    this.slowT = Math.max(0, this.slowT - dt);
    var holdEnd = dur * (1 - P.focusSlowEase);
    if (elapsed < holdEnd) return P.focusSlowScale;
    var f = Math.min(1, (elapsed - holdEnd) / Math.max(1e-6, dur - holdEnd));
    f = f * f * (3 - 2 * f);
    return P.focusSlowScale + (1 - P.focusSlowScale) * f;
  },

  // Leave slow-motion quickly (e.g. a spell ended Clarity): jump to the easing part of the curve.
  endSlow: function () {
    var P = MW.P, easeLen = P.focusSlowDur * P.focusSlowEase;
    if (this.slowT > easeLen) this.slowT = easeLen;
    if (!(P.focusSlowEase > 0)) this.slowT = 0;
  },

  bgState: function (dt) {
    var w = this.world, p = w.player, cam = this.renderer && this.renderer.camera;
    return {
      dt: dt,
      time: w.time,
      camX: cam ? cam.x : p.x,
      camY: cam ? cam.y : p.y,
      stage: p.stage,
      clarity: p.clarity,
      clarityT: p.clarityT,
      dead: p.dead,
      fx: MW.settings.fx,
      roomIndex: w.roomIndexAt(p.x),
      mode: this.mode,
    };
  },
};

window.addEventListener('load', function () { MW.Game.boot(); });
