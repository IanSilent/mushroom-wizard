// World: level + player + entities + checkpoints + stats. Pure simulation (no DOM), runs in Node too.
// Events (world.events) are appended every step; the browser main loop drains them each frame
// and forwards them to audio / renderer. Event types:
//   jump, land, bonk, stageWarn, stageUp, focusOn, focusOff, focusWarn, focusReady, focusDenied,
//   cast{spell}, fizzle, featherEnd, hiccupWarn, hiccup, death{cause}, respawn, restart,
//   stageDown, checkpoint{index}, crumble{x,y}, pickup{kind}, finish
var MW = MW || {};

MW.World = function (roomIds, opts) {
  opts = opts || {};
  this.roomIds = roomIds;
  this.level = MW.buildLevel(roomIds, opts.rooms);
  this.player = new MW.Player();
  this.time = 0;
  this.events = [];
  this.cpIndex = -1;
  this.deathT = 0;
  this.finished = false;
  this.activeSign = null;
  this.stats = {
    deaths: 0, restarts: 0, time: 0, focus: 0, casts: 0, jumps: 0,
    perRoom: this.level.rooms.map(function (r) {
      return { id: r.id, name: r.def.name, section: r.def.section, deaths: 0, time: 0, focus: 0, casts: 0, restarts: 0 };
    }),
  };
  this.startStage = opts.startStage || (this.level.checkpoints[0] ? this.level.checkpoints[0].stage : 1);
  if (opts.startCheckpoint !== undefined && this.level.checkpoints[opts.startCheckpoint]) {
    this.cpIndex = opts.startCheckpoint;
  } else if (this.level.checkpoints.length && this.level.start &&
             this.level.checkpoints[0].x === this.level.start.x && this.level.checkpoints[0].y === this.level.start.y) {
    this.cpIndex = 0;
  }
  this.respawn(true);
};

MW.World.prototype.spawnPoint = function () {
  var cp = this.level.checkpoints[this.cpIndex];
  var src = cp || this.level.start;
  var stage = cp ? cp.stage : this.startStage;
  return {
    x: src.x + 0.5 - MW.PLAYER_W / 2,
    y: src.y + 1 - MW.PLAYER_H,
    stage: stage,
  };
};

MW.World.prototype.respawn = function (initial) {
  var sp = this.spawnPoint();
  // Rooms flagged freeStage (the sandbox) keep the player's current stage across respawns.
  var cpRoom = this.level.rooms[(this.level.checkpoints[this.cpIndex] || this.level.start).room];
  if (!initial && cpRoom && cpRoom.def.freeStage) sp.stage = this.player.stage;
  this.player.reset(sp.x, sp.y, sp.stage);
  this.player.grounded = this.player.onGroundProbe(this.level);
  this.level.broken = {};
  this.level.crumbling = {};
  this.level.pickups.forEach(function (p) { p.taken = false; p.t = 0; });
  this.deathT = 0;
  if (!initial) this.events.push({ type: 'respawn', x: sp.x, y: sp.y, stage: sp.stage });
};

MW.World.prototype.roomIndexAt = function (x) {
  var cx = Math.max(0, Math.min(this.level.w - 1, Math.floor(x)));
  return this.level.roomOfCol[cx] || 0;
};

MW.World.prototype.currentRoom = function () {
  var p = this.player;
  return this.level.rooms[this.roomIndexAt(p.x + p.w / 2)];
};

// Lethal test for an arbitrary box (spikes + saws + below kill line). Used by blink preview.
MW.World.prototype.hazardTestFn = function () {
  var self = this;
  return function (x, y, w, h) { return !!self.hazardAt(x, y, w, h, true); };
};

// Returns cause string or null. Hazard hitboxes are forgiving: player box inset by 0.1.
MW.World.prototype.hazardAt = function (x, y, w, h, includePit) {
  var lvl = this.level;
  var ix = x + 0.1, iy = y + 0.1, iw = w - 0.2, ih = h - 0.15;
  var x0 = Math.floor(ix), x1 = Math.floor(ix + iw), y0 = Math.floor(iy), y1 = Math.floor(iy + ih);
  for (var ty = y0; ty <= y1; ty++) {
    for (var tx = x0; tx <= x1; tx++) {
      var c = MW.tileAt(lvl, tx, ty);
      if (MW.SPIKES[c]) {
        var b = MW.spikeBox(c, tx, ty);
        if (ix < b.x + b.w && ix + iw > b.x && iy < b.y + b.h && iy + ih > b.y) return 'spikes';
      } else if (c === MW.ABYSS && iy + ih > ty + 0.3) {
        return 'pit';
      }
    }
  }
  for (var i = 0; i < lvl.saws.length; i++) {
    var s = lvl.saws[i];
    var px = Math.max(ix, Math.min(s.x, ix + iw)), py = Math.max(iy, Math.min(s.y, iy + ih));
    var dx = s.x - px, dy = s.y - py;
    if (dx * dx + dy * dy < s.r * s.r) return 'saw';
  }
  if (includePit) {
    var col = Math.max(0, Math.min(lvl.w - 1, Math.floor(x + w / 2)));
    if (y > lvl.killY[col]) return 'pit';
  }
  return null;
};

MW.World.prototype.die = function (cause) {
  var p = this.player;
  if (p.dead) return;
  p.dead = true;
  this.deathT = MW.P.respawnDelay;
  this.stats.deaths++;
  this.stats.perRoom[this.roomIndexAt(p.x + p.w / 2)].deaths++;
  this.events.push({ type: 'death', cause: cause, x: p.x, y: p.y });
};

MW.World.prototype.restart = function () {
  var p = this.player;
  this.stats.restarts++;
  this.stats.perRoom[this.roomIndexAt(p.x + p.w / 2)].restarts++;
  this.events.push({ type: 'restart', x: p.x, y: p.y });
  this.respawn(false);
};

MW.World.prototype.setStage = function (s) {
  var p = this.player;
  p.stage = Math.max(1, Math.min(4, s));
  p.drunkJumps = 0;
  p.pendingStageUp = false;
  this.events.push({ type: 'stageUp', stage: p.stage, x: p.x, y: p.y, debug: true });
};

MW.World.prototype.teleportToCheckpoint = function (i) {
  if (!this.level.checkpoints[i]) return;
  this.cpIndex = i;
  this.respawn(false);
};

MW.World.prototype.boxOverlap = function (a, bx, by, bw, bh) {
  return a.x < bx + bw && a.x + a.w > bx && a.y < by + bh && a.y + a.h > by;
};

MW.World.prototype.update = function (input) {
  var dt = MW.DT, P = MW.P, p = this.player, lvl = this.level, ev = this.events;
  this.time += dt;
  if (this.finished) return;
  this.stats.time += dt;
  var ri = this.roomIndexAt(p.x + p.w / 2);
  this.stats.perRoom[ri].time += dt;

  var i;
  for (i = 0; i < lvl.saws.length; i++) {
    var sp = MW.sawPos(lvl.saws[i], this.time);
    lvl.saws[i].x = sp.x; lvl.saws[i].y = sp.y;
  }
  for (i = 0; i < lvl.pickups.length; i++) {
    var pk = lvl.pickups[i];
    if (pk.taken && pk.type === 'crystal') {
      pk.t += dt;
      if (pk.t >= P.crystalRespawn) { pk.taken = false; pk.t = 0; }
    }
  }

  if (p.dead) {
    this.deathT -= dt;
    if (this.deathT <= 0) this.respawn(false);
    return;
  }
  if (input.restartPressed) { this.restart(); return; }

  var evBefore = ev.length;
  p.step(lvl, input, dt, ev, this);
  for (i = evBefore; i < ev.length; i++) {
    var e = ev[i];
    if (e.type === 'focusOn') { this.stats.focus++; this.stats.perRoom[ri].focus++; }
    else if (e.type === 'cast') { this.stats.casts++; this.stats.perRoom[ri].casts++; }
    else if (e.type === 'jump') { this.stats.jumps++; }
  }

  // Crumbling tiles.
  if (p.grounded) {
    var gt = p.groundTiles(lvl);
    for (i = 0; i < gt.length; i++) {
      var key = gt[i][0] + ',' + gt[i][1];
      if (MW.tileAt(lvl, gt[i][0], gt[i][1]) === '%' && !lvl.broken[key] && lvl.crumbling[key] === undefined) {
        lvl.crumbling[key] = 0;
      }
    }
  }
  for (var k in lvl.crumbling) {
    lvl.crumbling[k] += dt;
    if (lvl.crumbling[k] >= P.crumbleDelay) {
      delete lvl.crumbling[k];
      lvl.broken[k] = true;
      var xy = k.split(',');
      ev.push({ type: 'crumble', x: +xy[0], y: +xy[1] });
    }
  }

  // Hazards and pits.
  var cause = this.hazardAt(p.x, p.y, p.w, p.h, false);
  if (cause && (!MW.CHEATS.god || cause === 'pit')) { this.die(cause); return; }
  var col = Math.max(0, Math.min(lvl.w - 1, Math.floor(p.x + p.w / 2)));
  if (p.y > lvl.killY[col]) { this.die('pit'); return; }

  var pb = p.box();
  // Pickups.
  for (i = 0; i < lvl.pickups.length; i++) {
    var q = lvl.pickups[i];
    if (q.taken) continue;
    if (!this.boxOverlap(pb, q.x - 0.4, q.y - 0.4, 0.8, 0.8)) continue;
    if (q.type === 'mushroom') {
      q.taken = true;
      p.addStage(1, ev);
      ev.push({ type: 'pickup', kind: 'mushroom', x: q.x, y: q.y });
    } else if (q.type === 'crystal') {
      if (p.clarity) {
        if (p.bankedCharge) continue;
        p.bankedCharge = true;
      } else {
        if (p.charge >= 1) continue;
        p.charge = 1; p.cooldownT = 0;
      }
      q.taken = true; q.t = 0;
      ev.push({ type: 'pickup', kind: 'crystal', x: q.x, y: q.y });
    }
  }

  // Checkpoints (forward only). Activation sets the drunk stage to the checkpoint's authored stage
  // (cpSetsStage = 1) or only raises it to that floor (cpSetsStage = 0). Respawn always uses it.
  for (i = this.cpIndex + 1; i < lvl.checkpoints.length; i++) {
    var c = lvl.checkpoints[i];
    if (!this.boxOverlap(pb, c.x - 0.2, c.y - 1, 1.4, 2)) continue;
    this.cpIndex = i;
    var free = lvl.rooms[c.room].def.freeStage;
    if (free) {
      // Sandbox: checkpoints never touch the stage.
    } else if (c.stage > p.stage || (P.cpSetsStage && c.stage !== p.stage)) {
      var up = c.stage > p.stage;
      p.stage = c.stage; p.drunkJumps = 0; p.pendingStageUp = false;
      ev.push({ type: up ? 'stageUp' : 'stageDown', stage: p.stage, x: p.x, y: p.y });
    } else if (P.cpSetsStage) {
      p.drunkJumps = 0; p.pendingStageUp = false;
    }
    if (!p.clarity && p.charge < 1) { p.charge = 1; p.cooldownT = 0; }
    ev.push({ type: 'checkpoint', index: i, x: c.x, y: c.y });
    break;
  }

  // Exit.
  for (i = 0; i < lvl.exits.length; i++) {
    var ex = lvl.exits[i];
    if (this.boxOverlap(pb, ex.x, ex.y - 1, 1, 2)) {
      this.finished = true;
      ev.push({ type: 'finish' });
      return;
    }
  }

  // Nearest sign.
  this.activeSign = null;
  var best = 3.0;
  for (i = 0; i < lvl.signs.length; i++) {
    var sg = lvl.signs[i];
    var d = Math.abs(sg.x + 0.5 - (p.x + p.w / 2)) + Math.abs(sg.y + 0.5 - (p.y + p.h / 2)) * 0.5;
    if (d < best) { best = d; this.activeSign = sg; }
  }
};

// Side-effect-free preview: simulate a clone of the player. inputFn(stepIndex, ghostPlayer) -> input.
// Returns an array of feet-centre points {x, y, clarity}; .lethal = true if the path hits a hazard.
MW.World.prototype.ghost = function (inputFn, seconds) {
  var p = this.player.clone();
  var ev = [];
  var pts = [];
  var n = Math.round(seconds / MW.DT);
  for (var i = 0; i < n; i++) {
    p.step(this.level, inputFn(i, p), MW.DT, ev, null);
    pts.push({ x: p.x + p.w / 2, y: p.y + p.h, clarity: p.clarity });
    if (this.hazardAt(p.x, p.y, p.w, p.h, true)) { pts.lethal = true; break; }
    if (i > 4 && p.grounded) break;
  }
  return pts;
};
