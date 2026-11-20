// Room order of the main level and the sandbox. Loaded LAST (after all room files).
// Missing rooms are skipped so the game still runs while rooms are being authored.
var MW = MW || {};
MW.ROOMS = MW.ROOMS || {};
MW.LEVEL_MAIN = [
  's0_wake',     // S0 Пробуждение — D1
  's1_hill',     // S1 Похмельный холм — D1→D2
  's2_ceiling',  // S2 Низкий потолок — D2→D3, voluntary escalation
  's3_focus',    // S3 Первый Фокус — D3
  's4_blink',    // S4 Терновая стена — Blink
  's5_chimney',  // S5 Дымоход — Levitate
  's6_well',     // S6 Колодец — Feather fall
  'm_fork',      // M Развилка — mixed, mushroom → D4 + hiccup, exit portal
].filter(function (id) { return MW.ROOMS[id]; });
MW.LEVEL_SANDBOX = ['sandbox'].filter(function (id) { return MW.ROOMS[id]; });
