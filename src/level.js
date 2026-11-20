// Level building: rooms (ASCII grids) are stitched left-to-right into one world grid.
//
// Legend (room ASCII):
//   #  solid ground                 X  rune wall: solid AND blink cannot pass through it
//   %  crumbling tile (breaks after standing on it, restored on respawn)
//   =  one-way platform (solid only from above)
//   ^  floor spikes   v  ceiling spikes   <  spikes pointing left   >  spikes pointing right
//   O  static saw (radius 0.45, centred in the cell)
//   1..4  checkpoint whose authored drunk stage is D1..D4 (put it in the cell right above the floor)
//   P  player start (sandbox only; otherwise the first checkpoint is the start)
//   M  mushroom: +1 drunk stage          *  clarity crystal: restores the focus charge
//   E  exit / finish portal              T  sign (text from room.signs, in reading order)
//   ~  abyss: bottomless void, kills on touch (fill the bottom of every pit with it)
//   .  or space: empty
//
// Room definition:
//   { name, section, rows:[...], entryY, exitY, signs:[...], entities:[...], solutions:[...] }
//   entryY / exitY = row index (inside the room) of the FLOOR tile at the left / right edge.
//   Rooms are aligned so that room[i].exitY floor == room[i+1].entryY floor.
//   entities: [{type:'saw', path:[[x,y],[x,y],...], speed: tiles/s, r: 0.45}]  (room-local tile coords, centres)
var MW = MW || {};

MW.SOLID = { '#': 1, 'X': 1, '%': 1 };
MW.SPIKES = { '^': 1, 'v': 1, '<': 1, '>': 1 };
MW.ABYSS = '~';

MW.buildLevel = function (roomIds, rooms) {
  rooms = rooms || MW.ROOMS;
  var placed = [];
  var ox = 0, prevOy = 0, prevExit = 0;
  roomIds.forEach(function (id, i) {
    var r = rooms[id];
    if (!r) throw new Error('Unknown room: ' + id);
    var h = r.rows.length;
    var w = 0;
    r.rows.forEach(function (row) { w = Math.max(w, row.length); });
    var entryY = r.entryY !== undefined ? r.entryY : h - 1;
    var exitY = r.exitY !== undefined ? r.exitY : h - 1;
    var oy = i === 0 ? 0 : prevOy + prevExit - entryY;
    placed.push({ id: id, def: r, ox: ox, oy: oy, w: w, h: h, entryY: entryY, exitY: exitY });
    ox += w;
    prevOy = oy;
    prevExit = exitY;
  });
  // Normalise vertical offsets so the topmost room starts at row 0.
  var minOy = Infinity, maxBottom = -Infinity;
  placed.forEach(function (p) { minOy = Math.min(minOy, p.oy); });
  placed.forEach(function (p) { p.oy -= minOy; maxBottom = Math.max(maxBottom, p.oy + p.h); });
  var W = ox, H = maxBottom;

  var grid = [];
  for (var y = 0; y < H; y++) {
    var line = [];
    for (var x = 0; x < W; x++) line.push('#');
    grid.push(line);
  }
  var level = {
    w: W, h: H, grid: grid, rooms: placed,
    checkpoints: [], pickups: [], saws: [], signs: [], exits: [], start: null,
    broken: {},     // "x,y" -> true for crumbled tiles
    crumbling: {},  // "x,y" -> seconds since stepped on
    killY: [],      // per column: falling below this y kills
    roomOfCol: [],  // per column: index into rooms
  };

  placed.forEach(function (p, ri) {
    var signIdx = 0;
    for (var ry = 0; ry < p.h; ry++) {
      var row = p.def.rows[ry];
      for (var rx = 0; rx < p.w; rx++) {
        var c = rx < row.length ? row[rx] : ' ';
        var X = p.ox + rx, Y = p.oy + ry;
        var cell = c;
        if (c === ' ') cell = '.';
        if (c >= '1' && c <= '4') {
          level.checkpoints.push({ x: X, y: Y, stage: c.charCodeAt(0) - 48, room: ri });
          cell = '.';
        } else if (c === 'P') {
          level.start = { x: X, y: Y, room: ri };
          cell = '.';
        } else if (c === 'M' || c === '*') {
          level.pickups.push({ type: c === 'M' ? 'mushroom' : 'crystal', x: X + 0.5, y: Y + 0.5, taken: false, t: 0, room: ri });
          cell = '.';
        } else if (c === 'O') {
          level.saws.push({ path: [[X + 0.5, Y + 0.5]], speed: 0, r: 0.45, x: X + 0.5, y: Y + 0.5, room: ri });
          cell = '.';
        } else if (c === 'E') {
          level.exits.push({ x: X, y: Y, room: ri });
          cell = '.';
        } else if (c === 'T') {
          var text = (p.def.signs && p.def.signs[signIdx]) || '';
          signIdx++;
          level.signs.push({ x: X, y: Y, text: text, room: ri });
          cell = '.';
        }
        grid[Y][X] = cell;
      }
    }
    (p.def.entities || []).forEach(function (e) {
      if (e.type === 'saw') {
        var path = e.path.map(function (pt) { return [pt[0] + p.ox, pt[1] + p.oy]; });
        level.saws.push({ path: path, speed: e.speed || 3, r: e.r || 0.45, x: path[0][0], y: path[0][1], room: ri, phase: e.phase || 0 });
      }
    });
    for (var cx = p.ox; cx < p.ox + p.w; cx++) {
      level.killY[cx] = p.oy + p.h + 0.5;
      level.roomOfCol[cx] = ri;
    }
  });

  // Carve 3-tall openings at room seams so neighbouring rooms always connect.
  for (var i = 0; i + 1 < placed.length; i++) {
    var a = placed[i];
    var floorY = a.oy + a.exitY;
    var seamL = a.ox + a.w - 1, seamR = a.ox + a.w;
    for (var k = 1; k <= 3; k++) {
      if (floorY - k >= 0) {
        if (!MW.SPIKES[grid[floorY - k][seamL]]) grid[floorY - k][seamL] = '.';
        if (!MW.SPIKES[grid[floorY - k][seamR]]) grid[floorY - k][seamR] = '.';
      }
    }
    grid[floorY][seamL] = grid[floorY][seamL] === '.' ? '#' : grid[floorY][seamL];
    grid[floorY][seamR] = grid[floorY][seamR] === '.' ? '#' : grid[floorY][seamR];
  }

  level.checkpoints.sort(function (a, b) { return a.x - b.x || b.y - a.y; });
  level.checkpoints.forEach(function (c, i) { c.index = i; });
  if (!level.start && level.checkpoints.length) {
    var c0 = level.checkpoints[0];
    level.start = { x: c0.x, y: c0.y, room: c0.room };
  }
  if (!level.start) level.start = { x: 1, y: 1, room: 0 };
  return level;
};

MW.tileAt = function (level, x, y) {
  if (y < 0) return '.';           // open sky above the world
  if (x < 0 || x >= level.w) return '#';
  if (y >= level.h) return '.';    // below the world = pit
  return level.grid[y][x];
};

// Is tile solid for regular collision? (one-way handled separately)
MW.isSolid = function (level, x, y) {
  var c = MW.tileAt(level, x, y);
  if (c === '%') return !level.broken[x + ',' + y];
  return c === '#' || c === 'X';
};

MW.isRune = function (level, x, y) {
  return MW.tileAt(level, x, y) === 'X';
};

MW.roomAt = function (level, x) {
  var cx = Math.max(0, Math.min(level.w - 1, Math.floor(x)));
  return level.rooms[level.roomOfCol[cx] || 0];
};

// Spike hitbox inside a tile, in tile coords, or null.
MW.spikeBox = function (c, tx, ty) {
  switch (c) {
    case '^': return { x: tx + 0.15, y: ty + 0.5, w: 0.7, h: 0.5 };
    case 'v': return { x: tx + 0.15, y: ty, w: 0.7, h: 0.5 };
    case '<': return { x: tx + 0.5, y: ty + 0.15, w: 0.5, h: 0.7 };
    case '>': return { x: tx, y: ty + 0.15, w: 0.5, h: 0.7 };
  }
  return null;
};

MW.sawPos = function (saw, time) {
  var path = saw.path;
  if (path.length < 2 || !saw.speed) return { x: path[0][0], y: path[0][1] };
  // Ping-pong along the polyline.
  var lens = [], total = 0;
  for (var i = 0; i + 1 < path.length; i++) {
    var dx = path[i + 1][0] - path[i][0], dy = path[i + 1][1] - path[i][1];
    var l = Math.sqrt(dx * dx + dy * dy);
    lens.push(l); total += l;
  }
  if (total <= 0) return { x: path[0][0], y: path[0][1] };
  var s = (time * saw.speed + (saw.phase || 0) * total) % (2 * total);
  if (s > total) s = 2 * total - s;
  for (var j = 0; j < lens.length; j++) {
    if (s <= lens[j] || j === lens.length - 1) {
      var f = lens[j] > 0 ? Math.min(1, s / lens[j]) : 0;
      return {
        x: path[j][0] + (path[j + 1][0] - path[j][0]) * f,
        y: path[j][1] + (path[j + 1][1] - path[j][1]) * f,
      };
    }
    s -= lens[j];
  }
  return { x: path[0][0], y: path[0][1] };
};
