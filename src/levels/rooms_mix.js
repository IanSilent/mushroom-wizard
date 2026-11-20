// Final room M «Развилка» — mixes everything taught in S0–S6, plus two small introductions:
// the mushroom 'M' (+1 stage without a jump -> D4, where the hiccup starts) and the crystal '*'
// (restores the Clarity charge, even mid-air).
// Rules this room is built on (DESIGN.md §1–2): every voluntary jump = +1 stage (applied on landing),
// checkpoints SET the stage, pits are lethal (abyss '~' two rows below the platforms, or open to the
// room's bottom edge). Geometry is derived from `node tools/metrics.js`; solutions are replayed by
// `node tools/check.js m_fork` (use --trace <name> for an ASCII path).
//
// Stage flow: the room opens at D1 and the first two jumps plus the mushroom ramp it up to D4 within
// ~6 s (each jump visibly bigger and wider: pit 4 at D1, pit 6 at D2). Everything after the mushroom
// is the D4 peak: every later checkpoint is '4', so a respawn always restores the stage the gate needs.
//
// Beats (columns; cp = checkpoint index inside this room; stage at the beat = cp stage + jumps since):
//  (0) cols 0-34, cp0 D1. «Каждый прыжок пьянее» — a teaching beat, nearly free. Two jumps over
//      abyss pits ('~' two rows below the floor):
//      j1 at D1 over pit A (cols 7-10, 4 wide; D1 max 9 -> margin 5) onto plat A (cols 11-19),
//      j2 at D2 over pit B (cols 20-25, 6 wide; D2 max 11 -> margin 5) onto the approach floor.
//      You land at D3. The approach floor is 9 wide, so even a max D2 jump lands before the corridor.
//      (Measured: with a held jump any take-off within ~3 tiles of the edge clears both pits.)
//  (1) cols 34-43, cp1 D3 (at the corridor mouth: every path walks through it). Mushroom + hiccup.
//      The mushroom sits inside a corridor whose ceiling is spikes 2 free rows above the floor, so it
//      cannot be skipped (and any jump in there kills). At D4 a forced 1.5-tile hiccup comes after 4 s
//      on the ground (0.8 s warning) and kills under these spikes. The corridor ends in a 2-thick
//      wall: LMB + 1 (Blink, taught in S4). Walking in and casting takes ~1 s, so only dawdling 3+ s
//      at the wall is deadly, and Focus resets the hiccup timer. 0 jumps.
//  (2) cols 44-49, cp2 D4. Fork pad. The Blink ended Clarity (castEndsClarity), so the player lands
//      here drunk and cp2 refills the charge at once (open sky: a hiccup here is harmless).
//      Upper route («пьяный путь»), cols 50-71, cp4:
//        (U1) 9-high cliff right behind a 2-wide hole: D4 jump + LMB at the apex + 2 (D4 alone
//             reaches 7, jump+Focus+Levitate 10 -> margin 1 on the ledge, gate +2). Missing it
//             drops you into the lower route (an intended lower floor), not into a death.
//        (U2) 11-wide abyss gap at D4 (max 13 -> margin 2). Needs a DRUNK jump: the Levitate already
//             ended Clarity (cp4 refills the charge). Focusing again here and jumping sober (max 6)
//             dies — Clarity is precise, not far.
//        (U3) jump off the landing pillar onto the merge pad; a hanging wall catches overshoot.
//      Lower route («трезвый путь»), cols 50-80, cp3 / cp5: a tunnel under a spiked ceiling with
//        4 free rows: drunk jumps (D4 min hop 4.07) die, Clarity jumps (rise 3.0) fit, hiccups fit.
//        Every precise hop comes BEFORE the window's Blink, because the cast ends Clarity.
//        (L1) window 1: hop strip A (2), run the 5-wide plat, hop strip B (2), Blink wall W1 (2).
//        (L2) pad P1 (cp5, 5 wide: a drunk landing slide fits, cp5 refills the charge), window 2:
//             hop strip C (2) onto a 2-wide ledge, Blink wall W2 (2) -> drunk again on the floor.
//        (L3) slide (drunk, no jump under the spikes) into the exit shaft, D4 jump up 6 (margin 1).
//  (3) cols 81-108, cp6 D4. Crystal chain (two Clarity windows). Walk into the lip, D4 jump, LMB at
//      the apex, 2 over a 1-wide rune pillar topped with a spike (8.5 effective: D4 alone 7, gate
//      +1.5; Blink is stopped by the runes). The Levitate ends Clarity; the crystal hangs 2 rows
//      above the spike tip, on the drunk arc after the Levitate, so it refills the empty charge on
//      the way over. Then LMB again (window 2), 3: Feather glides across the 16-wide abyss to the
//      2-wide exam pad under the rune wall (Feather reaches the wall with ~4 tiles to spare).
//      Gates: no second Focus -> the Feather fizzles; the natural recharge (2 s) is far too slow
//      (Feather -> recharge -> Levitate cannot clear the pillar); a second Blink or Levitate
//      instead of Feather falls short (best measured reach 107.8 vs the pad edge at 109).
//  (4) cols 109-142, cp7-cp9, D4. Final exam, one spell per Clarity window. Each cast ends Clarity
//      and drops the player drunk onto the next checkpoint pad, which refills the charge:
//      (E1) Blink: wall with a 4-high rune base -> drunk jump, LMB in the air, 1 (S4 lesson at D4).
//      (E2) Levitate: 9-high cliff from the E2 pad (same envelope as U1).
//      (E3) Feather: the cliff top is under a spiked ceiling with 4 free rows that overhangs the
//           chasm by 4, so no drunk jump and no coyote jump. LMB, sober jump (rise 3 fits under the
//           spikes), 3 across 15 tiles down 4 over the abyss (sober jump + Blink reaches ~12.5 ->
//           gate +2.5; sober jump + Feather ~19 -> margin 4). The landing stays on screen.
//      Exit portal 'E' on the floor near the right end.
// Expected deaths for a first run: ~4-8 (pit misses, hiccup or Clarity-jump lessons, crystal timing).
var MW = MW || {};
MW.ROOMS = MW.ROOMS || {};

(function () {
  // Script segments shared by the full-room solutions (one segment per line).
  // Each one starts on a checkpoint, drunk, with a full Focus charge.
  var JUMPS = [                                  // cp0 (D1) -> the corridor wall
    [0.5, 'right'], [0.6, 'right jump'],         // j1 at D1 over pit A
    [1.1, 'right'],                              // land on plat A (D2), run to its edge
    [0.6, 'right jump'],                         // j2 at D2 over pit B
    [2.4, 'right'],                              // land (D3), cp1, mushroom -> D4, up to the wall
  ];
  var ENTRY = [                                  // at the corridor wall -> fork pad
    [0.05, 'focus'], [0.05, ''], [0.05, 'spell1'], // Blink through the wall (the cast ends Clarity)
    [0.3, ''],
    [0.6, ''],                                   // land drunk on the fork pad: cp2 refills the charge
  ];
  var UPPER = [                                  // cp2 -> merge pad
    [0.45, 'right'],
    [0.55, 'right jump'],                        // D4 jump at the cliff
    [0.05, 'right jump focus'],                  // LMB at the apex
    [0.05, 'right'], [0.05, 'right spell2'],     // 2: Levitate
    [0.3, 'right'],
    [0.3, ''],
    [0.25, ''],                                  // land drunk on the cliff top (the cast ended Clarity)
    [0.6, 'right'], [1.6, 'right jump'],         // 11-wide abyss gap
    [0.3, 'right'], [1.2, 'right jump'],         // off the pillar onto the merge pad
    [1.5, ''],
  ];
  var LOWER = [                                  // cp2 -> merge pad
    [0.6, 'right'], [1.0, ''],                   // drop into the tunnel
    [0.05, 'focus'], [0.05, ''],                 // window 1
    [0.06, 'right'], [0.3, 'right jump'],        // hop strip A
    [0.7, 'right'], [0.3, 'right jump'],         // hop strip B
    [0.6, 'right'], [0.05, 'right spell1'],      // Blink through W1 (the cast ends Clarity)
    [0.3, ''],                                   // land drunk on pad P1: cp5 refills the charge
    [0.05, 'focus'], [0.05, ''],                 // window 2
    [0.2, 'right'], [0.3, 'right jump'],         // hop strip C (before the wall now)
    [0.3, 'right'], [0.05, 'right spell1'],      // Blink through W2: drunk again, slide into the shaft
    [0.6, 'right'],
    [0.8, 'right jump'],                         // D4 jump up 6 onto the merge pad
    [0.6, 'right'], [0.5, ''],
  ];
  var CRYSTAL = [                                // cp6 -> exam pad
    [1.2, 'right'], [0.2, ''],                   // walk into the lip
    [0.65, 'right jump'],                        // D4 jump at the rune pillar
    [0.05, 'right jump focus'],                  // LMB near the apex (window 1)
    [0.05, 'right'], [0.05, 'right spell2'],     // 2: Levitate (the cast ends Clarity) over the spike
    [0.35, 'right'],                             // through the crystal: the empty charge is back at once
    [0.05, 'right focus'],                       // LMB: window 2
    [0.05, 'right'], [0.05, 'right spell3'],     // 3: Feather across the abyss
    [3.0, 'right'], [0.5, ''],
  ];
  var EXAM = [                                   // cp7 -> exit portal
    [0.3, ''],
    [0.4, 'right'], [0.1, ''],                   // to the rune wall
    [0.45, 'right jump'],                        // E1: drunk jump above the runes
    [0.05, 'right jump focus'], [0.05, 'right jump'], [0.05, 'right jump spell1'], // LMB, 1: Blink (ends Clarity)
    [0.6, ''],
    [0.3, ''],                                   // land drunk on the E2 pad: cp8 refills the charge
    [0.6, 'right'], [0.3, ''],                   // to the cliff
    [0.55, 'jump'], [0.05, 'jump focus'],        // E2: D4 jump, LMB at the apex
    [0.05, ''], [0.05, 'spell2'],                // 2: Levitate (ends Clarity)
    [0.3, 'right'], [0.3, ''],
    [0.3, ''],                                   // land drunk under the spikes: cp9 refills the charge
    [0.05, 'focus'], [0.05, ''],                 // E3: window 3
    [0.3, 'right'], [0.3, 'right jump'],         // sober jump off the edge
    [0.05, 'right jump spell3'],                 // 3: Feather across the chasm
    [4.0, 'right'],
  ];
  var cat = function () { return Array.prototype.concat.apply([], arguments); };

  MW.ROOMS['m_fork'] = {
    name: 'Развилка',
    section: 'M',
    entryY: 24,
    exitY: 19,
    rows: [
   //0         1         2         3         4         5         6         7         8         9         0         1         2         3         4
   //0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012
    '...................................#########.......................................##..........................##....#########.................', //  0
    '...................................#########.......................................##..........................##....#########.................', //  1
    '...................................#########.......................................##..........................##....#########.................', //  2
    '...................................#########.......................................##..........................##....#########.................', //  3
    '...................................#########.......................................##..........................##....#########.................', //  4
    '...................................#########.......................................##..........................##....#########.................', //  5
    '...................................#########.......................................##..........................##....#########.................', //  6
    '...................................#########.......................................##..........................##....#########.................', //  7
    '...................................#########.......................................##..........................##....#########.................', //  8
    '...................................#########.......................................##..........................##....#########.................', //  9
    '...................................#########.......................................##..........................##....vvvvvvvvv.................', // 10
    '...................................#########.......................................##..........................##..............................', // 11
    '...................................#########.......................................##..........................##..............................', // 12
    '...................................#########.......................................##.......*..................##..............................', // 13
    '...................................#########.........4.............................##..........................##.....4........................', // 14
    '...................................#########........#####...........####...........##.......^..................##....#####.....................', // 15
    '...................................#########........#####...........####...........##.......X..................##....#####.....................', // 16
    '...................................#########........#####~~~~~~~~~~~####...........##.......X..................##....#####.....................', // 17
    '...................................#########........#####~~~~~~~~~~~####...........##.......X..................##....#####..................E..', // 18
    '...................................#########........#####~~~~~~~~~~~####...........##.......X..................##....#####...............######', // 19
    '...................................#########........#####~~~~~~~~~~~####...........##.......X..................XX....#####...............######', // 20
    '...................................vvvvvvv##........#####~~~~~~~~~~~####...........##.......X..................XX....#####~~~~~~~~~~~~~~~######', // 21
    '..........................................##........#####~~~~~~~~~~~####....................X..................XX....#####~~~~~~~~~~~~~~~######', // 22
    '..1.T..........................T..3.M.....##.4..T...#####~~~~~~~~~~~####..........4...T..#..X................T4XX..4.#####~~~~~~~~~~~~~~~######', // 23
    '#######....#########......########################..###########################..#########..X................#############~~~~~~~~~~~~~~~######', // 24
    '#######....#########......########################..vvvvvvvvvvvv##vvvvvvvvv##vv..#########..X................#############~~~~~~~~~~~~~~~######', // 25
    '#######~~~~#########~~~~~~########################..............##.........##....#########~~X~~~~~~~~~~~~~~~~#############~~~~~~~~~~~~~~~######', // 26
    '#######~~~~#########~~~~~~########################..............##.........##....#########~~X~~~~~~~~~~~~~~~~#############~~~~~~~~~~~~~~~######', // 27
    '#######~~~~#########~~~~~~########################..............##.........##....#########~~X~~~~~~~~~~~~~~~~#############~~~~~~~~~~~~~~~######', // 28
    '#######~~~~#########~~~~~~########################.4.^^.....^^..##.4...^^..##....#########~~X~~~~~~~~~~~~~~~~#############~~~~~~~~~~~~~~~######', // 29
    '#######~~~~#########~~~~~~################################################################~~X~~~~~~~~~~~~~~~~#############~~~~~~~~~~~~~~~######', // 30
    '#######~~~~#########~~~~~~################################################################~~X~~~~~~~~~~~~~~~~#############~~~~~~~~~~~~~~~######', // 31
    '#######~~~~#########~~~~~~################################################################~~X~~~~~~~~~~~~~~~~#############~~~~~~~~~~~~~~~######', // 32
    ],
    signs: [
      'Пробел — прыжок. Каждый прыжок пьянее предыдущего: выше и дальше. Ямы — насмерть',
      'Гриб: +1 к опьянению без прыжка. На D4 — икота! ЛКМ — Ясность, 1 — Блинк',
      'Развилка: верх — пьяный путь (ЛКМ в прыжке, 2 — Взлёт), низ — трезвый (ЛКМ)',
      'Кристалл возвращает заряд Ясности — даже в полёте',
      'Экзамен: 1 — Блинк, 2 — Взлёт, 3 — Пёрышко. По одному за Ясность (ЛКМ)',
    ],
    entities: [],
    solutions: [
      { name: 'upper', until: 'finish', script: cat(JUMPS, ENTRY, UPPER, CRYSTAL, EXAM) },
      { name: 'lower', until: 'finish', script: cat(JUMPS, ENTRY, LOWER, CRYSTAL, EXAM) },
      // From the corridor checkpoint (a respawn after a hiccup death), upper route.
      { name: 'corridor', startCheckpoint: 1, until: 'finish', script: cat([[1.3, 'right']], ENTRY, UPPER, CRYSTAL, EXAM) },
      // U2 variant: hesitate on the cliff top. The Levitate already ended Clarity, so the player
      // stands there drunk at D4 and a hiccup comes — harmless under the open sky.
      { name: 'upper-wait', startCheckpoint: 2, until: 'finish', script: cat([
        [0.45, 'right'],
        [0.55, 'right jump'], [0.05, 'right jump focus'], [0.05, 'right'], [0.05, 'right spell2'],
        [0.3, 'right'],
        [5.0, ''],                                 // the hiccup hops in place here
        [0.6, 'right'], [1.6, 'right jump'],
        [0.3, 'right'], [1.2, 'right jump'],
        [1.5, ''],
      ], CRYSTAL, EXAM) },
      // Crystal beat with an impatient LMB: pressed right after the Levitate (before the crystal)
      // it is denied (the cast emptied the charge); the crystal then refills it for window 2.
      { name: 'crystal-early-lmb', startCheckpoint: 6, until: 'finish', script: cat([
        [1.2, 'right'], [0.2, ''],
        [0.65, 'right jump'], [0.05, 'right jump focus'], [0.05, 'right'], [0.05, 'right spell2'],
        [0.05, 'right'],
        [0.05, 'right focus'],                     // too early: denied, no charge yet
        [0.35, 'right'],                           // over the spike, through the crystal
        [0.05, 'right focus'], [0.05, 'right'], [0.05, 'right spell3'],
        [3.0, 'right'], [0.5, ''],
      ], EXAM) },
      { name: 'exam', startCheckpoint: 7, until: 'finish', script: EXAM },

      // ---- gates that must fail
      // (0) pits kill: walking off the entry floor drops into the abyss of pit A.
      { name: 'pit-a-walk-in', expect: 'fail', script: [[3.0, 'right']] },
      // (0) a short tap from far behind the edge falls into pit A.
      { name: 'pit-a-short-tap', expect: 'fail', script: [
        [0.25, 'right'], [0.05, 'right jump'], [0.4, ''], [2.0, ''],
      ] },
      // (1) no Blink: stuck at the wall, the hiccup throws you into the ceiling spikes.
      { name: 'corridor-no-blink', expect: 'fail', startCheckpoint: 1, script: [[8.0, 'right']] },
      // (1) dawdling 3+ s at the wall: the hiccup comes before the Blink.
      { name: 'corridor-dawdle', expect: 'fail', startCheckpoint: 1, script: [
        [0.9, 'right'], [3.9, ''], [0.05, 'focus'], [0.05, ''], [0.05, 'spell1'], [3.0, 'right'],
      ] },
      // (1) a jump in the corridor hits the ceiling spikes (D3 min hop 3.15 > 2 free rows).
      { name: 'corridor-jump', expect: 'fail', startCheckpoint: 1, script: [
        [0.3, 'right'], [0.3, 'right jump'], [2.0, 'right'],
      ] },
      // (U1) a plain D4 jump cannot climb the cliff: you fall into the tunnel.
      { name: 'upper-no-levitate', expect: 'fail', startCheckpoint: 2, script: [
        [0.6, 'right'], [1.6, 'right jump'], [3.0, 'right'],
      ] },
      // (U2) a Clarity jump over the 11-wide gap falls into the abyss.
      { name: 'upper-sober-gap', expect: 'fail', startCheckpoint: 4, script: [
        [0.05, 'focus'], [0.05, ''], [0.6, 'right'], [1.6, 'right jump'], [2.0, 'right'],
      ] },
      // (L1) a drunk hop in the tunnel hits the ceiling spikes.
      { name: 'tunnel-drunk-hop', expect: 'fail', startCheckpoint: 3, script: [
        [0.1, 'right'], [0.3, 'right jump'], [2.0, 'right'],
      ] },
      // (3) a plain D4 jump cannot clear the pillar.
      { name: 'crystal-plain', expect: 'fail', startCheckpoint: 6, script: [
        [1.2, 'right'], [0.2, ''], [1.6, 'right jump'], [3.0, 'right'],
      ] },
      // (3) Blink is stopped by the rune pillar.
      { name: 'crystal-blink', expect: 'fail', startCheckpoint: 6, script: [
        [1.2, 'right'], [0.2, ''],
        [0.6, 'right jump'], [0.05, 'right jump focus'], [0.05, 'right jump'], [0.05, 'right jump spell1'],
        [3.0, 'right'],
      ] },
      // (3) no second Focus: the Levitate ended Clarity, so the Feather fizzles (drunk).
      { name: 'crystal-one-window', expect: 'fail', startCheckpoint: 6, script: [
        [1.2, 'right'], [0.2, ''],
        [0.65, 'right jump'], [0.05, 'right jump focus'], [0.05, 'right'], [0.05, 'right spell2'],
        [0.35, 'right'], [0.05, 'right'], [0.05, 'right spell3'], [3.0, 'right'],
      ] },
      // (3) without the crystal: Feather first (it ends Clarity), wait for the natural 2 s
      // recharge, then Levitate — too low by then to clear the pillar.
      { name: 'crystal-natural-recharge', expect: 'fail', startCheckpoint: 6, script: [
        [1.2, 'right'], [0.2, ''],
        [0.65, 'right jump'], [0.05, 'right jump focus'], [0.05, 'right'], [0.05, 'right spell3'],
        [0.15, 'right'], [2.1, 'right'],
        [0.05, 'right focus'], [0.05, 'right'], [0.05, 'right spell2'], [3.0, 'right'],
      ] },
      // (3) a second Blink instead of Feather falls short of the exam pad.
      { name: 'crystal-blink-across', expect: 'fail', startCheckpoint: 6, script: [
        [1.2, 'right'], [0.2, ''],
        [0.65, 'right jump'], [0.05, 'right jump focus'], [0.05, 'right'], [0.05, 'right spell2'],
        [0.35, 'right'], [0.05, 'right focus'],    // crystal, window 2
        [0.15, 'right'], [0.05, 'right spell1'], [3.0, 'right'],
      ] },
      // (E1) a ground Blink is clipped by the rune base.
      { name: 'exam-ground-blink', expect: 'fail', startCheckpoint: 7, script: [
        [0.4, 'right'], [0.05, 'focus'], [0.05, ''], [0.05, 'right spell1'], [3.0, 'right'],
      ] },
      // (E1) Levitate cannot go over the wall (it reaches the top of the room).
      { name: 'exam-levitate-over', expect: 'fail', startCheckpoint: 7, script: [
        [0.4, 'right'], [0.1, ''],
        [0.55, 'right jump'], [0.05, 'right jump focus'], [0.05, 'right'], [0.05, 'right spell2'],
        [3.0, 'right'],
      ] },
      // (E2) a plain D4 jump cannot climb the cliff.
      { name: 'exam-cliff-plain', expect: 'fail', startCheckpoint: 8, script: [
        [0.3, 'right'], [1.8, 'right jump'], [2.0, 'right'],
      ] },
      // (E3) a drunk jump under the spiked ceiling, and a coyote jump under the overhang.
      { name: 'exam-drunk-jump', expect: 'fail', startCheckpoint: 9, script: [
        [0.3, 'right'], [1.5, 'right jump'], [3.0, 'right'],
      ] },
      { name: 'exam-coyote-jump', expect: 'fail', startCheckpoint: 9, script: [
        [0.6, 'right'], [1.5, 'right jump'], [3.0, 'right'],
      ] },
      // (E3) sober jump + Blink falls into the abyss.
      { name: 'exam-sober-blink', expect: 'fail', startCheckpoint: 9, script: [
        [0.05, 'focus'], [0.05, ''], [0.3, 'right'], [0.3, 'right jump'], [0.05, 'right jump spell1'],
        [3.0, 'right'],
      ] },
    ],
  };
})();
