// Shared art palette («Грибной трип», see DESIGN.md §5). Used by the game layer (render.js) and the
// background (fx_bg.js) so both shift together on every stage change and on Clarity.
var MW = MW || {};

MW.PALETTE = {
  // Drunk stages 1..4. Each stage must read as a clearly different world.
  stages: {
    1: { // «Рассвет»: dusty lilac, peach, sage — soft, dreamy
      name: 'Рассвет',
      skyTop: '#2b2340', skyMid: '#5a4870', skyLow: '#c99aa6',
      ground: '#3a2f47', groundDeep: '#231b2e', groundEdge: '#9a86ad',
      fringe: '#b9d6ae', accent: '#f4c7a1', glow: '#e9b8d0', ink: '#160f1f',
    },
    2: { // «Тепло»: magenta, tangerine, teal
      name: 'Тепло',
      skyTop: '#2a0f2e', skyMid: '#7a1f5c', skyLow: '#f08a3c',
      ground: '#3b1636', groundDeep: '#200a1e', groundEdge: '#d4568f',
      fringe: '#3fd1c0', accent: '#ffb05a', glow: '#ff6fb5', ink: '#12050f',
    },
    3: { // «Неон»: electric violet, acid green, hot pink
      name: 'Неон',
      skyTop: '#0d0626', skyMid: '#3b0f8a', skyLow: '#ff2fa8',
      ground: '#1d0b3d', groundDeep: '#0c0420', groundEdge: '#9c4dff',
      fringe: '#b6ff3b', accent: '#ff3fd0', glow: '#7dfcff', ink: '#05020d',
    },
    4: { // «Пик»: full spectrum; the renderer / background additionally cycle the hue over time
      name: 'Пик',
      skyTop: '#05020a', skyMid: '#2a0a3a', skyLow: '#ffd23f',
      ground: '#12061c', groundDeep: '#070310', groundEdge: '#ff4fd8',
      fringe: '#45ffb0', accent: '#ffe14a', glow: '#ff5ee0', ink: '#000000',
      cycle: true,
    },
  },
  // Clarity «Чернила»: monochrome ink etching on warm paper. Only cyan (spells) and hazard red-orange stay coloured.
  clarity: {
    paper: '#efe6d2', paperShade: '#d6c7a8', paperDeep: '#b9a682',
    ink: '#1c1712', inkSoft: '#4a4034', hatch: '#2a241c',
  },
  // Reserved meanings — identical in every palette.
  hazard: '#ff5a2a', hazardLight: '#ffb08a', hazardDark: '#4a0f04',
  gold: '#f5c65b',
  cyan: '#4fe3f0', cyanDeep: '#0f8fa0',
  rune: '#8a5cff',
  abyss: '#07020c', abyssRim: '#b05cff',
};

// ---- small colour helpers (hex <-> rgb, mixing), shared by presentation code

MW.hexToRgb = function (hex) {
  var h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  var n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

MW.rgbToCss = function (c, a) {
  var r = Math.round(c[0]), g = Math.round(c[1]), b = Math.round(c[2]);
  return a === undefined ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
};

MW.mixRgb = function (a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
};

// Palette colour `key` for a continuous stage value (1..4, fractional during transitions).
MW.stageColor = function (key, stageF) {
  var s = Math.max(1, Math.min(4, stageF));
  var i = Math.floor(s), f = s - i;
  var a = MW.hexToRgb(MW.PALETTE.stages[i][key]);
  if (f <= 0 || i >= 4) return a;
  return MW.mixRgb(a, MW.hexToRgb(MW.PALETTE.stages[i + 1][key]), f);
};
