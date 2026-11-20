// Player: kinematic controller, drunk stages, Clarity, spells.
// The player only READS the level (solidity). World-side effects (hazards, pickups, checkpoints,
// crumbling) are handled by MW.World after each physics step. This keeps the player cloneable
// for ghost / trajectory previews (debug overlay).
//
// Input per step: { left, right, up, down, jump, focus, cast, restart } (held)
//                 + { jumpPressed, focusPressed, castPressed, restartPressed } (edges)
//                 + spell: 'blink' | 'levitate' | 'feather' | null  (explicit spell key pressed this step;
//                   castPressed instead picks the spell by direction: up = levitate, down = feather, else blink)
var MW = MW || {};

MW.Player = function () {
  this.w = MW.PLAYER_W;
  this.h = MW.PLAYER_H;
  this.reset(0, 0, 1);
};

MW.Player.prototype.reset = function (x, y, stage) {
  this.x = x; this.y = y;
  this.vx = 0; this.vy = 0;
  this.facing = 1;
  this.grounded = false;
  this.coyoteT = 0;
  this.bufferT = 0;
  this.stage = stage || 1;       // drunk stage 1..4 (kept while in Clarity, frozen)
  this.drunkJumps = 0;           // jumps since last stage-up
  this.pendingStageUp = false;
  this.clarity = false;
  this.clarityT = 0;
  this.clarityWarned = false;
  this.charge = 1;
  this.cooldownT = 0;
  this.touchedGroundSinceFocus = true;
  this.spellUsed = false;
  this.featherT = 0;
  this.levitateT = 0;
  this.blinkFloatT = 0;
  this.airT = 0;
  this.takeoffY = y;
  this.swayDir = 1;
  this.swayActive = false;
  this.jumpRising = false;       // currently in the rising part of a voluntary jump
  this.jumpStartY = y;
  this.jumpCut = false;
  this.slipT = 0;
  this.hiccupT = MW.P.hiccupPeriod;
  this.hiccupWarned = false;
  this.hitstopT = 0;
  this.dead = false;
  this.lastCast = null;          // 'blink' | 'levitate' | 'feather'
  this.blinkFrom = null;         // for rendering a blink trail
  this.queuedCast = null;
  this.bankedCharge = false;
};

MW.Player.prototype.clone = function () {
  var c = new MW.Player();
  for (var k in this) if (this.hasOwnProperty(k)) c[k] = this[k];
  return c;
};

// State index into per-stage param arrays.
MW.Player.prototype.si = function () { return this.clarity ? 0 : this.stage; };

MW.Player.prototype.box = function () { return { x: this.x, y: this.y, w: this.w, h: this.h }; };

MW.Player.prototype.canFocus = function () {
  if (this.clarity || this.charge < 1) return false;
  return true;
};

// ---------------------------------------------------------------- collision helpers

MW.overlapsSolid = function (level, x, y, w, h) {
  var x0 = Math.floor(x), x1 = Math.floor(x + w - 1e-6);
  var y0 = Math.floor(y), y1 = Math.floor(y + h - 1e-6);
  for (var ty = y0; ty <= y1; ty++)
    for (var tx = x0; tx <= x1; tx++)
      if (MW.isSolid(level, tx, ty)) return true;
  return false;
};

MW.Player.prototype.moveX = function (level, dx) {
  if (dx === 0) return false;
  var nx = this.x + dx;
  var y0 = Math.floor(this.y), y1 = Math.floor(this.y + this.h - 1e-6);
  if (dx > 0) {
    var tx = Math.floor(nx + this.w - 1e-6);
    for (var ty = y0; ty <= y1; ty++) {
      if (MW.isSolid(level, tx, ty)) { this.x = tx - this.w; return true; }
    }
  } else {
    var tx2 = Math.floor(nx);
    for (var ty2 = y0; ty2 <= y1; ty2++) {
      if (MW.isSolid(level, tx2, ty2)) { this.x = tx2 + 1; return true; }
    }
  }
  this.x = nx;
  return false;
};

// Returns 'floor' | 'ceil' | null
MW.Player.prototype.moveY = function (level, dy) {
  if (dy === 0) return null;
  var ny = this.y + dy;
  var x0 = Math.floor(this.x), x1 = Math.floor(this.x + this.w - 1e-6);
  if (dy > 0) {
    var oldBottom = this.y + this.h;
    var ty = Math.floor(ny + this.h - 1e-6);
    for (var tx = x0; tx <= x1; tx++) {
      var c = MW.tileAt(level, tx, ty);
      if (MW.isSolid(level, tx, ty) || (c === '=' && oldBottom <= ty + 1e-4)) {
        this.y = ty - this.h; return 'floor';
      }
    }
  } else {
    var ty2 = Math.floor(ny);
    var hit = false;
    for (var tx2 = x0; tx2 <= x1; tx2++) if (MW.isSolid(level, tx2, ty2)) hit = true;
    if (hit) {
      // Corner correction: nudge sideways up to 0.3 tiles if that clears the ceiling.
      for (var n = 0.05; n <= 0.3 + 1e-6; n += 0.05) {
        var dirs = [-1, 1];
        for (var d = 0; d < 2; d++) {
          var tx3 = this.x + dirs[d] * n;
          if (!MW.overlapsSolid(level, tx3, ny, this.w, this.h)) { this.x = tx3; this.y = ny; return null; }
        }
      }
      this.y = ty2 + 1; return 'ceil';
    }
  }
  this.y = ny;
  return null;
};

MW.Player.prototype.onGroundProbe = function (level) {
  var footY = this.y + this.h + 0.02;
  var ty = Math.floor(footY);
  var x0 = Math.floor(this.x), x1 = Math.floor(this.x + this.w - 1e-6);
  for (var tx = x0; tx <= x1; tx++) {
    var c = MW.tileAt(level, tx, ty);
    if (MW.isSolid(level, tx, ty)) return true;
    if (c === '=' && Math.abs(this.y + this.h - ty) < 0.03) return true;
  }
  return false;
};

// Tiles directly under the feet (for crumbling).
MW.Player.prototype.groundTiles = function (level) {
  var ty = Math.floor(this.y + this.h + 0.02);
  var x0 = Math.floor(this.x), x1 = Math.floor(this.x + this.w - 1e-6);
  var out = [];
  for (var tx = x0; tx <= x1; tx++) out.push([tx, ty]);
  return out;
};

// ---------------------------------------------------------------- spells

// Where would a blink land right now? {x, y, ok, lethal, clipped}
MW.Player.prototype.blinkTarget = function (level, hazardTest) {
  var P = MW.P;
  var dir = this.facing;
  var D = P.blinkDist;
  // Rune walls clip the blink: find the first rune column along the path.
  var maxD = D;
  var step = 0.05;
  for (var s = step; s <= D + 1e-6; s += step) {
    var bx = this.x + dir * s;
    if (this.boxHitsRune(level, bx, this.y)) { maxD = Math.max(0, s - step); break; }
  }
  // Landing inside solid: back-track toward the start until free; also allow a small lift.
  var lifts = [0, -0.25, -0.5];
  for (var back = 0; back <= maxD + 1e-6; back += step) {
    var tx = this.x + dir * (maxD - back);
    for (var li = 0; li < lifts.length; li++) {
      var ty = this.y + lifts[li];
      if (!MW.overlapsSolid(level, tx, ty, this.w, this.h)) {
        var lethal = hazardTest ? hazardTest(tx, ty, this.w, this.h) : false;
        return { x: tx, y: ty, ok: true, lethal: lethal, clipped: maxD < D - 1e-6, dist: Math.abs(tx - this.x) };
      }
    }
  }
  return { x: this.x, y: this.y, ok: false, lethal: false, clipped: true, dist: 0 };
};

MW.Player.prototype.boxHitsRune = function (level, x, y) {
  var x0 = Math.floor(x), x1 = Math.floor(x + this.w - 1e-6);
  var y0 = Math.floor(y), y1 = Math.floor(y + this.h - 1e-6);
  for (var ty = y0; ty <= y1; ty++)
    for (var tx = x0; tx <= x1; tx++)
      if (MW.isRune(level, tx, ty)) return true;
  return false;
};

MW.Player.prototype.castSpell = function (level, input, ev, world) {
  var P = MW.P;
  var spell = input.spell || (input.up ? 'levitate' : (input.down ? 'feather' : 'blink'));
  this.spellUsed = true;
  this.lastCast = spell;
  if (spell === 'blink') {
    var t = this.blinkTarget(level, world ? world.hazardTestFn() : null);
    this.blinkFrom = { x: this.x, y: this.y };
    var fromX = this.x, fromY = this.y;
    this.x = t.x; this.y = t.y;
    this.vy = 0;
    this.vx = this.facing * Math.max(Math.abs(this.vx), P.runSpeed[0] * 0.6);
    this.blinkFloatT = P.blinkFloat;
    this.levitateT = 0;
    this.featherT = 0;
    this.jumpRising = false;
    ev.push({ type: 'cast', spell: 'blink', fromX: fromX, fromY: fromY, x: t.x, y: t.y, clipped: t.clipped });
  } else if (spell === 'levitate') {
    this.levitateT = P.levitateT;
    this.featherT = 0;
    this.jumpRising = false;
    this.grounded = false;
    ev.push({ type: 'cast', spell: 'levitate', x: this.x, y: this.y });
  } else {
    this.featherT = P.featherMax;
    this.levitateT = 0;
    if (this.vy < -2) this.vy = -2;
    this.jumpRising = false;
    ev.push({ type: 'cast', spell: 'feather', x: this.x, y: this.y });
  }
  if (P.castEndsClarity && this.clarity) this.endClarity(ev, true, 'cast');
};

// ---------------------------------------------------------------- main step

// ev: array to push events into. world: optional (for hazard test in blink preview / cast).
MW.Player.prototype.step = function (level, input, dt, ev, world) {
  var P = MW.P, D = MW.D;
  if (this.dead) return;

  // Hitstop (focus entry): freeze physics, but keep presses made during it.
  if (this.hitstopT > 0) {
    this.hitstopT -= dt;
    if (input.castPressed || input.spell) this.queuedCast = { up: !!input.up, down: !!input.down, spell: input.spell || null };
    if (input.jumpPressed) this.bufferT = P.jumpBuffer;
    return;
  }
  if (this.queuedCast) {
    var q = this.queuedCast;
    this.queuedCast = null;
    input = MW.extend({}, input);
    input.castPressed = true;
    input.spell = input.spell || q.spell;
    input.up = input.up || q.up;
    input.down = input.down || q.down;
  }

  // ---- input bookkeeping
  if (input.left && !input.right) this.facing = -1;
  else if (input.right && !input.left) this.facing = 1;
  if (input.jumpPressed) this.bufferT = P.jumpBuffer;
  else if (this.bufferT > 0) this.bufferT = Math.max(0, this.bufferT - dt);

  // ---- focus / clarity
  if (!this.clarity && this.charge < 1) {
    if (this.cooldownT > 0) this.cooldownT = Math.max(0, this.cooldownT - dt);
    var groundOk = !P.focusNeedsGround || this.touchedGroundSinceFocus;
    if (this.cooldownT <= 0 && groundOk) { this.charge = 1; ev.push({ type: 'focusReady' }); }
  }
  if (input.focusPressed) {
    if (this.clarity) {
      this.endClarity(ev, true);
    } else if (this.canFocus()) {
      this.clarity = true;
      this.clarityT = P.clarityDur;
      this.clarityWarned = false;
      this.charge = 0;
      this.spellUsed = false;
      this.touchedGroundSinceFocus = this.grounded;
      this.hitstopT = P.focusHitstop;
      if (this.vy > 0) this.vy *= P.focusFallDamp;
      this.swayActive = false;
      ev.push({ type: 'focusOn', x: this.x, y: this.y });
    } else {
      ev.push({ type: 'focusDenied' });
    }
  }
  if (this.clarity) {
    if (!MW.CHEATS.infiniteClarity) this.clarityT -= dt;
    if (!this.clarityWarned && this.clarityT <= P.clarityWarn) {
      this.clarityWarned = true;
      ev.push({ type: 'focusWarn' });
    }
    if (this.clarityT <= 0) this.endClarity(ev, false);
  }

  // ---- cast
  if (input.castPressed || input.spell) {
    if (this.clarity && !this.spellUsed) this.castSpell(level, input, ev, world);
    else ev.push({ type: 'fizzle', reason: this.clarity ? 'used' : 'drunk' });
  }

  var si = this.si();

  // ---- hiccup (drunk, max stage, on the ground)
  if (P.hiccupEnabled && !this.clarity && this.stage >= 4 && this.grounded) {
    this.hiccupT -= dt;
    if (!this.hiccupWarned && this.hiccupT <= P.hiccupWarn) {
      this.hiccupWarned = true;
      ev.push({ type: 'hiccupWarn' });
    }
    if (this.hiccupT <= 0) {
      this.vy = -Math.sqrt(2 * D.g[si] * P.hiccupHeight);
      this.grounded = false;
      this.coyoteT = 0;
      this.jumpRising = false;
      this.takeoffY = this.y;
      this.airT = 0;
      this.hiccupT = P.hiccupPeriod;
      this.hiccupWarned = false;
      ev.push({ type: 'hiccup', x: this.x, y: this.y });
    }
  } else if (this.clarity || this.stage < 4) {
    this.hiccupT = P.hiccupPeriod;
    this.hiccupWarned = false;
  }

  // ---- horizontal
  var dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  var feather = this.featherT > 0;
  var maxRun = feather ? P.featherRun : P.runSpeed[si];
  var target = dir * maxRun;
  var accel;
  if (feather) {
    accel = P.featherAccel;
  } else if (this.grounded) {
    if (dir === 0) accel = P.groundDecel[si];
    else if (this.vx * dir < 0) accel = Math.max(P.groundAccel[si], P.groundDecel[si]);
    else accel = P.groundAccel[si];
    if (this.slipT > 0) accel = Math.min(accel, 3);
  } else {
    accel = dir === 0 ? P.airDecel[si] : P.airAccel[si];
  }
  // Above max speed (e.g. after blink or stagger) bleed speed gently instead of clamping.
  if (Math.abs(this.vx) > maxRun && this.vx * target >= 0 && dir !== 0) {
    accel = this.grounded ? P.groundDecel[si] * 0.5 : P.airDecel[si] + 4;
  }
  this.vx = MW.approach(this.vx, target, accel * dt);

  // ---- jump
  if (this.grounded) this.coyoteT = P.coyote;
  else this.coyoteT = Math.max(0, this.coyoteT - dt);

  if (this.bufferT > 0 && this.coyoteT > 0 && this.levitateT <= 0) {
    this.bufferT = 0;
    this.coyoteT = 0;
    this.vy = -D.v0[si];
    this.grounded = false;
    this.jumpRising = true;
    this.jumpCut = false;
    this.jumpStartY = this.y;
    this.takeoffY = this.y;
    this.airT = 0;
    if (!this.clarity) {
      // Stagger: every drunk jump shoves the wizard forward a little.
      this.vx += this.facing * P.stagger[si];
      this.swayActive = P.swayAmp[si] > 0;
      this.swayDir = this.facing;
      this.drunkJumps++;
      if (this.stage < 4 && this.drunkJumps >= P.jumpsPerStage && !this.pendingStageUp) {
        this.pendingStageUp = true;
        ev.push({ type: 'stageWarn', stage: this.stage + 1 });
      }
    } else {
      this.swayActive = false;
    }
    ev.push({ type: 'jump', clarity: this.clarity, stage: this.stage, x: this.x, y: this.y });
  }

  // Variable jump height: releasing early cuts the rise, but never below minHop.
  if (this.jumpRising && !input.jump && !this.jumpCut && this.vy < 0) {
    this.jumpCut = true;
    var risen = this.jumpStartY - this.y;
    var need = Math.max(P.minHop[si] - risen, 0.05);
    var vCut = Math.sqrt(2 * D.g[si] * need);
    if (-this.vy > vCut) this.vy = -vCut;
  }

  // ---- vertical
  if (this.levitateT > 0) {
    this.levitateT -= dt;
    this.vy = -P.levitateH / P.levitateT;
    if (this.levitateT <= 0) this.vy = -2;
  } else if (this.blinkFloatT > 0) {
    this.blinkFloatT -= dt;
    this.vy = 0;
  } else {
    var g = D.g[si];
    if (this.vy > 0) g *= P.fallGravMul[si];
    if (Math.abs(this.vy) < P.apexBand) g *= P.apexGravMul[si];
    if (feather) g *= 0.5;
    this.vy += g * dt;
    var maxFall = feather ? P.featherFall : P.maxFall[si];
    if (this.vy > maxFall) {
      // Feather fall brakes smoothly rather than snapping.
      this.vy = feather ? MW.approach(this.vy, maxFall, 60 * dt) : maxFall;
    }
  }
  if (this.vy >= 0) this.jumpRising = false;
  if (feather) {
    this.featherT -= dt;
    if (this.featherT <= 0) { this.featherT = 0; ev.push({ type: 'featherEnd' }); }
  }

  // ---- sway (deterministic S-curve displacement from takeoff)
  var swayV = 0;
  if (!this.grounded) {
    this.airT += dt;
    if (this.swayActive && !this.clarity && this.levitateT <= 0 && !feather) {
      var T = P.swayPeriod, A = P.swayAmp[this.stage];
      swayV = this.swayDir * A * (2 * Math.PI / T) * Math.cos(2 * Math.PI * this.airT / T);
    }
  }

  // ---- integrate with collision
  var wasGrounded = this.grounded;
  var hitWall = this.moveX(level, (this.vx + swayV) * dt);
  if (hitWall) this.vx = 0;
  var hitY = this.moveY(level, this.vy * dt);
  if (hitY === 'ceil') {
    if (this.vy < 0) this.vy = 0;
    this.levitateT = 0;
    this.jumpRising = false;
    ev.push({ type: 'bonk' });
  }
  this.grounded = this.vy >= 0 && this.onGroundProbe(level);
  if (this.grounded) {
    if (this.vy > 0) this.vy = 0;
    this.touchedGroundSinceFocus = true;
  }

  if (this.slipT > 0) this.slipT -= dt;

  // ---- landing
  if (this.grounded && !wasGrounded) {
    var drop = this.y - this.takeoffY;
    this.swayActive = false;
    this.featherT = 0;
    this.airT = 0;
    if (!this.clarity && this.stage >= P.slipStage && drop > P.slipDrop) this.slipT = P.slipTime;
    if (this.pendingStageUp) {
      this.pendingStageUp = false;
      this.drunkJumps = 0;
      this.stage = Math.min(4, this.stage + 1);
      ev.push({ type: 'stageUp', stage: this.stage, x: this.x, y: this.y });
    }
    ev.push({ type: 'land', drop: drop, x: this.x, y: this.y, clarity: this.clarity });
  }
  if (!this.grounded && wasGrounded && !this.jumpRising && this.levitateT <= 0) {
    // Walked off a ledge.
    this.takeoffY = this.y;
    this.airT = 0;
  }
};

MW.Player.prototype.endClarity = function (ev, early, reason) {
  this.clarity = false;
  this.clarityT = 0;
  this.touchedGroundSinceFocus = this.grounded;
  ev.push({ type: 'focusOff', early: !!early, reason: reason || (early ? 'early' : 'timeout'), x: this.x, y: this.y });
  if (this.bankedCharge) {
    // A crystal picked up during Clarity: the charge is ready immediately.
    this.bankedCharge = false;
    this.charge = 1;
    this.cooldownT = 0;
    ev.push({ type: 'focusReady' });
  } else {
    this.charge = 0;
    this.cooldownT = MW.P.focusCooldown;
  }
};

MW.Player.prototype.addStage = function (n, ev) {
  var before = this.stage;
  this.stage = Math.max(1, Math.min(4, this.stage + n));
  this.drunkJumps = 0;
  this.pendingStageUp = false;
  if (this.stage !== before) ev.push({ type: 'stageUp', stage: this.stage, x: this.x, y: this.y });
};

MW.extend = function (a, b) { for (var k in b) a[k] = b[k]; return a; };

MW.approach = function (v, target, delta) {
  if (v < target) return Math.min(v + delta, target);
  if (v > target) return Math.max(v - delta, target);
  return v;
};
