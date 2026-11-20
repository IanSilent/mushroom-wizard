// Intro rooms S0–S3: the first four rooms of the main level, played left to right.
//
// Core rule (DESIGN.md §1): EVERY voluntary drunk jump raises the stage by one, applied on landing.
// Clarity jumps and hiccups do not count. Checkpoints SET the stage to their digit (respawn too), so
// the stage at any beat = min(4, checkpoint digit + drunk jumps made since it). Jump counts below are
// always counted from the last checkpoint.
//
//   S0 Пробуждение      D1 -> D4   each jump is bigger than the last: 3 jumps take you from D1 to D4
//   S1 Похмельный холм  D1 -> D4   narrow platforms (overshoot grows with every jump), a cp sobers you,
//                                  then VOLUNTARY escalation (hop in place) to climb a wall
//   S2 Низкий потолок   D1/D2      saw ceilings: only D1/D2 taps fit under them; checkpoints reset the count
//   S3 Первый Фокус     D3         Clarity (left mouse) without spells: sober hops, recharge, early exit
//
// Pits are lethal: every gap between platforms has abyss '~' at its bottom (2 rows below the lower
// platform top), so falling in kills and respawns at the checkpoint. There are no walkable trenches.
//
// Measured envelopes (node tools/metrics.js), tiles:      rise  min hop  max gap  max ledge
//   Clarity 3 / 1.08 / 6 / 3     D1 4 / 1.82 / 9 / 4     D2 5 / 2.43 / 11 / 5
//   D3 6 / 3.15 / 12 / 6         D4 7 / 4.07 / 13 / 7
// Saw ceiling 'O' with 4 free rows above the floor kills when the rise exceeds ~2.75 tiles:
//   D1 and D2 taps pass under it (1.82, 2.43); the D3 minimum hop (3.15) always hits it.
var MW = MW || {};
MW.ROOMS = MW.ROOMS || {};

(function () {
  // ------------------------------------------------------------------ S0
  // Пробуждение (D1 -> D4), ~9 s. The escalation tutorial: four jumps, each one visibly bigger.
  //   - Entry cp '1' (col 3), sign 1: keys.
  //   - j1 (D1): 3-wide pit (cols 13-15), flat. Lands on P1 -> D2. Sign 2 on P1: every jump is
  //     drunker, watch the meter.
  //   - j2 (D2): 3-high step (P2, cols 29-37). A D2 tap (min hop 2.43) is too low: hold the jump.
  //     A failed tap just lands back on P1 one stage higher, which makes the step easier. -> D3.
  //   - cp '3' on P2 (col 31) so a death at the next beat is cheap.
  //   - j3 (D3): 3-wide pit + 5-high ledge (P3, cols 41-48): D3 ledge max 6, so 1 tile of margin;
  //     impossible at D1 (max 4). -> D4 on landing. Sign 3 on P3: D4 = peak, standing makes you hiccup.
  //   - j4 (D4): 9-wide gap dropping 4 (D4 max gap 13) to the exit floor.
  MW.ROOMS['s0_wake'] = {
    name: 'Пробуждение',
    section: 'S0',
    entryY: 16,
    exitY: 12,
    rows: [
      '............................................................................', //  0
      '............................................................................', //  1
      '............................................................................', //  2
      '............................................................................', //  3
      '............................................................................', //  4
      '............................................................................', //  5
      '............................................................................', //  6
      '.............................................T..............................', //  7
      '.........................................########...........................', //  8
      '.........................................########...........................', //  9
      '.........................................########...........................', // 10
      '.........................................########...........................', // 11
      '...............................3.........########.........##################', // 12
      '.............................#########...########.........##################', // 13
      '.............................#########...########~~~~~~~~~##################', // 14
      '...1...T.............T.......#########~~~########~~~~~~~~~##################', // 15
      '#############...######################~~~########~~~~~~~~~##################', // 16
      '#############...######################~~~########~~~~~~~~~##################', // 17
      '#############~~~######################~~~########~~~~~~~~~##################', // 18
      '#############~~~######################~~~########~~~~~~~~~##################', // 19
    ],
    signs: [                 // reading order: row 7 (P3) comes before row 15 (entry, P1)
      'D4 — пик. Стоишь на месте — икаешь',
      '← → — идти. Пробел — прыжок (держи — выше)',
      'Каждый прыжок пьянее предыдущего. Смотри на шкалу вверху',
    ],
    solutions: [
      { name: 'main', script: [
        [1.05, 'right'],
        [0.25, 'right jump'],    // j1 (D1): pit 1 -> D2 on landing
        [1.40, 'right'],
        [0.45, 'right jump'],    // j2 (D2): held jump up the 3-high step -> D3 (cp 3)
        [1.10, 'right'],
        [0.50, 'right jump'],    // j3 (D3): pit + 5-high ledge -> D4
        [1.00, 'right'],
        [0.40, 'right jump'],    // j4 (D4): the big gap down to the exit floor
        [4.00, 'right'],
      ] },
      // Pits kill: walking straight on drops into the abyss of pit 1.
      { name: 'walk-into-pit', expect: 'fail', script: [
        [3.00, 'right'],
      ] },
    ],
  };

  // ------------------------------------------------------------------ S1
  // Похмельный холм (D1 -> D4), ~23 s.
  //   - Entry cp '1' (the player arrives at D4 from S0 and is sobered to D1), sign 1: the cp digit is
  //     your stage; platforms are narrow, brake in the air.
  //   - Ascent over 3-wide pits: A (5 wide, flat), B (5 wide, +1), C (5 wide, +1), then the hop
  //     platform H (8 wide, +1). Jumps are made at D1, D2, D3, D4, so the same hop flies further and
  //     the landing slides longer each time (D1 slide ~1.0 tile, D4 ~2.0): stop, hop, brake.
  //   - H: cp '1' on its first column (any landing on H touches it) -> D1 again. Sign 2.
  //     The summit wall is 5 high behind a 2-wide pit: impossible at D1 (ledge max 4; 0 of ~1800
  //     brute-force inputs) and practically impossible at D2 from H (6 of ~1800, frame-perfect);
  //     D3 has 1 tile of margin. Hop in place twice (D1 -> D2 -> D3), then jump. Hops barely drift
  //     (stagger 0.8-1.2 t/s, mostly braked by air drag).
  //   - Summit landing -> D4. Descent at D4 over pits 5/4/4 wide, platforms 6 wide, each 3 lower:
  //     the biggest, floatiest, slipperiest jumps of the intro, plus the D4 hiccup if you linger.
  MW.ROOMS['s1_hill'] = {
    name: 'Похмельный холм',
    section: 'S1',
    entryY: 18,
    exitY: 18,
    rows: [
      '..........................................................................................', //  0
      '..........................................................................................', //  1
      '..........................................................................................', //  2
      '..........................................................................................', //  3
      '..........................................................................................', //  4
      '..........................................................................................', //  5
      '..........................................................................................', //  6
      '..........................................................................................', //  7
      '..........................................................................................', //  8
      '..........................................................................................', //  9
      '...............................................##########.................................', // 10
      '...............................................##########.................................', // 11
      '...............................................##########.................................', // 12
      '...............................................##########.....######......................', // 13
      '.....................................1...T.....##########.....######......................', // 14
      '.....................................########..##########~~~~~######......................', // 15
      '.............................#####...########..##########~~~~~######....######............', // 16
      '...1..T..............#####...#####...########~~##########~~~~~######....######............', // 17
      '##########...#####...#####...#####~~~########~~##########~~~~~######~~~~######....########', // 18
      '##########...#####...#####~~~#####~~~########~~##########~~~~~######~~~~######....########', // 19
      '##########~~~#####~~~#####~~~#####~~~########~~##########~~~~~######~~~~######~~~~########', // 20
      '##########~~~#####~~~#####~~~#####~~~########~~##########~~~~~######~~~~######~~~~########', // 21
    ],
    signs: [                 // reading order: row 14 (hop platform) comes before row 17 (entry)
      'Высоко? Прыгай на месте: каждый прыжок пьянее и выше',
      'Цифра на чекпоинте — твоя стадия. Площадки узкие: в прыжке тормози назад',
    ],
    solutions: [
      { name: 'main', script: [
        [0.69, 'right'],
        [0.40, ''],              // slide to a stop near the edge
        [0.28, 'right jump'],    // j1 (D1) -> A
        [0.30, 'right'],
        [1.20, ''],
        [0.08, 'right'],
        [0.40, ''],
        [0.33, 'right jump'],    // j2 (D2) -> B
        [0.30, 'right'],
        [1.20, ''],
        [0.06, 'right'],
        [0.40, ''],
        [0.33, 'right jump'],    // j3 (D3) -> C
        [0.30, 'right'],
        [1.20, ''],
        [0.10, 'right'],
        [0.40, ''],
        [0.12, 'right jump'],    // j4 (D4) -> H, cp 1 sets D1
        [0.30, 'right'],
        [1.20, ''],
        [0.05, 'jump'],          // voluntary escalation: hop in place (D1 -> D2)
        [0.90, ''],
        [0.05, 'jump'],          // hop 2 (D2 -> D3)
        [1.00, ''],
        [0.40, 'right'],
        [0.55, 'right jump'],    // D3 jump up the 5-high summit -> D4
        [0.40, 'right'],
        [0.80, ''],
        [0.54, 'right'],
        [0.40, ''],
        [0.20, 'right jump'],    // descent 1 (D4)
        [0.30, 'right'],
        [1.40, ''],
        [0.14, 'right'],
        [0.40, ''],
        [0.17, 'right jump'],    // descent 2 (D4)
        [0.30, 'right'],
        [1.40, ''],
        [0.38, 'right'],
        [0.40, ''],
        [0.30, 'right jump'],    // descent 3 to the exit floor
        [2.50, 'right'],
      ] },
      // Without escalation the D1 jump cannot reach the 5-high summit: it falls into the 2-wide pit.
      { name: 'no-escalation', expect: 'fail', startCheckpoint: 1, script: [
        [0.40, 'right'],
        [0.55, 'right jump'],
        [2.00, 'right'],
      ] },
      // One hop is not enough: the D2 jump from H still falls short of the summit.
      { name: 'one-hop', expect: 'fail', startCheckpoint: 1, script: [
        [0.05, 'jump'],
        [0.90, ''],
        [0.40, 'right'],
        [0.55, 'right jump'],
        [2.00, 'right'],
      ] },
      // Pits kill: running straight on drops into the abyss of the first pit.
      { name: 'walk-into-pit', expect: 'fail', script: [
        [3.00, 'right'],
      ] },
    ],
  };

  // ------------------------------------------------------------------ S2
  // Низкий потолок (D1/D2 under saws), ~12 s. Saw ceilings with 4 free rows: D1 and D2 taps pass,
  // a D3 hop always hits the saws, a held jump hits them at any stage. Count jumps from the checkpoint.
  //   - Entry cp '1', sign 1. Corridor A (cols 9-34): 2-wide pit (cols 13-14), then 2-wide spikes
  //     (cols 24-25). j1 D1 tap, j2 D2 tap -> D3 after the corridor. One extra hop before it and the
  //     second hazard needs a D3 hop -> saws.
  //   - Open gap (no ceiling) with cp '2' (sets D3 -> D2) and sign 2: the digit is your stage.
  //   - Corridor B (cols 44-56): 3-wide pit (cols 48-50). From cp '2' only ONE hop fits: j1 D2 -> D3.
  //   - Notch (cols 57-61, open to the sky) with cp '1': the checkpoint resets the count mid-corridor.
  //   - Corridor B' (cols 62-81): 2-wide spikes (cols 67-68), 3-wide pit (cols 75-77). j1 D1, j2 D2 -> D3.
  //   - The threat becomes a tool: a 5-high ledge (cols 87-96) right after the saws needs the D3
  //     jump you now have (D3 ledge max 6). Landing -> D4; S3 starts with cp '3'.
  MW.ROOMS['s2_ceiling'] = {
    name: 'Низкий потолок',
    section: 'S2',
    entryY: 14,
    exitY: 9,
    rows: [
      '.........##########################.........#############.....####################...............', //  0
      '.........##########################.........#############.....####################...............', //  1
      '.........##########################.........#############.....####################...............', //  2
      '.........##########################.........#############.....####################...............', //  3
      '.........##########################.........#############.....####################...............', //  4
      '.........##########################.........#############.....####################...............', //  5
      '.........##########################.........#############.....####################...............', //  6
      '.........##########################.........#############.....####################...............', //  7
      '.........##########################.........#############.....####################...............', //  8
      '.........OOOOOOOOOOOOOOOOOOOOOOOOOO.........OOOOOOOOOOOOO.....OOOOOOOOOOOOOOOOOOOO.....##########', //  9
      '.......................................................................................##########', // 10
      '.......................................................................................##########', // 11
      '.......................................................................................##########', // 12
      '...1..T.................^^...........2..T..................1.......^^..................##########', // 13
      '#############..#################################...########################...###################', // 14
      '#############..#################################...########################...###################', // 15
      '#############~~#################################~~~########################~~~###################', // 16
      '#############~~#################################~~~########################~~~###################', // 17
    ],
    signs: [
      'Пилы низко: под ними только короткий тап Пробела. На D3 не пролезть — считай прыжки',
      'Чекпоинт ставит стадию по своей цифре. Перепрыгал — жми R',
    ],
    solutions: [
      { name: 'main', script: [
        [1.04, 'right'],
        [0.05, 'right jump'],    // j1 (D1 tap): pit A
        [1.28, 'right'],
        [0.05, 'right jump'],    // j2 (D2 tap): spikes A -> D3 after the corridor
        [3.05, 'right'],         // cp 2 sets D2
        [0.05, 'right jump'],    // j1 (D2 tap): pit B1 -> D3
        [2.27, 'right'],         // notch cp 1 sets D1
        [0.05, 'right jump'],    // j1 (D1 tap): spikes B2
        [0.95, 'right'],
        [0.05, 'right jump'],    // j2 (D2 tap): pit B3 -> D3
        [1.20, 'right'],         // out of the saws, against the ledge
        [0.55, 'right jump'],    // D3 jump up the 5-high ledge -> D4
        [1.60, 'right'],
      ] },
      // One needless hop at the entry: the second corridor hop is a D3 hop and hits the saws.
      { name: 'extra-hop', expect: 'fail', script: [
        [0.05, 'jump'],
        [1.00, ''],
        [1.04, 'right'],
        [0.05, 'right jump'],
        [1.28, 'right'],
        [0.05, 'right jump'],
        [1.50, 'right'],
      ] },
      // A held jump under the saws is fatal even at D1.
      { name: 'held-jump', expect: 'fail', script: [
        [1.04, 'right'],
        [0.40, 'right jump'],
        [1.50, 'right'],
      ] },
      // Pits kill: running on without jumping drops into the abyss of pit A.
      { name: 'walk-into-pit', expect: 'fail', script: [
        [3.00, 'right'],
      ] },
    ],
  };

  // ------------------------------------------------------------------ S3
  // Первый Фокус (D3), ~16 s. Clarity (left mouse) without spells; every Clarity stretch is <= 12 tiles.
  // Clarity jumps do not raise the stage, so the whole room is played at D3 until the last jump.
  //   - Entry cp '3' (the player arrives at D4 from S2), sign 1 (Clarity rules).
  //   - Gate 1: saw corridor (4 free rows) with two 2-wide spike pits. Drunk: walking falls in,
  //     any D3 hop hits the saws. Sober: a hop held up to 0.25 s clears the pits.
  //   - Pad (8 wide, open sky) with cp '3', normally touched while still in Clarity, so it does
  //     not refill the charge: the player waits out the 2 s recharge here.
  //   - Gate 2: spiked corridor with only 3 free rows and two 1-wide spike pits: only a sober tap
  //     (hold <= 0.15 s) fits.
  //   - Rest area with cp '3' and sign 2 (early exit). Pillar 1 (1 wide) rises 2 above the rest
  //     floor, so the player can stop against it and hop up sober.
  //   - Pillars over the abyss: 1-wide pillar 1, 3-wide gap, 1-wide pillar 2, 3-wide gap (abyss '~'
  //     from row 13, 3 rows below the pillar tops). A sober hop sticks; a drunk landing keeps its
  //     speed and slides off, and every drunk hop raises the stage. A drunk jump from the rest area
  //     cannot skip the pillars.
  //   - Early exit: the 3-wide ledge after pillar 2 is crumbling and is followed by an 8-wide
  //     abyss gap (sober max 6, D3 run ~10.8). The player lands with ~0.6 s of Clarity left, so
  //     waiting breaks the ledge: click again to leave Clarity and take a drunk jump. [one D3 jump -> D4]
  var S3_TO_PILLARS = [
    [0.658, 'right'],
    [0.050, 'right focus'],  // Clarity before the saw corridor
    [0.358, 'right'],
    [0.183, 'right jump'],   // sober hop over spike pit 1 (a short hold is safe under the saws)
    [0.350, 'right'],
    [0.183, 'right'],
    [0.183, 'right jump'],   // spike pit 2
    [0.350, 'right'],
    [0.267, 'right'],
    [0.083, ''],             // stop on the pad while still sober
    [2.867, ''],             // Clarity ends, 2 s recharge
    [0.750, 'right'],
    [0.050, 'right focus'],  // Clarity before the spiked corridor
    [0.567, 'right'],
    [0.050, 'right jump'],   // sober tap (rise 1.1 < 2.2)
    [0.350, 'right'],
    [0.167, 'right'],
    [0.050, 'right jump'],
    [0.350, 'right'],
    [1.600, 'right'],        // run into pillar 1 (it doubles as a wall)
    [1.692, ''],             // recharge
    [0.050, 'focus'],
    [0.100, ''],
    [0.200, 'right jump'],   // sober hop up onto the 1-wide pillar
    [0.150, 'right'],
    [0.150, ''],
    [0.200, 'right jump'],   // pillar 2 (a sober landing sticks)
    [0.350, 'right'],
    [0.120, ''],
  ];
  MW.ROOMS['s3_focus'] = {
    name: 'Первый Фокус',
    section: 'S3',
    entryY: 12,
    exitY: 10,
    rows: [
      '..........##########........##########.......................................', //  0
      '..........##########........##########.......................................', //  1
      '..........##########........##########.......................................', //  2
      '..........##########........##########.......................................', //  3
      '..........##########........##########.......................................', //  4
      '..........##########........##########.......................................', //  5
      '..........##########........##########.......................................', //  6
      '..........OOOOOOOOOO........##########.......................................', //  7
      '............................vvvvvvvvvv.......................................', //  8
      '.............................................................................', //  9
      '................................................#...#...%%%........##########', // 10
      '...3..T...............3................3..T.....#...#..............##########', // 11
      '###########^^###^^#############^###^#############...#..............##########', // 12
      '#################################################~~~#~~~~~~~~~~~~~~##########', // 13
      '#################################################~~~#~~~~~~~~~~~~~~##########', // 14
      '#################################################~~~#~~~~~~~~~~~~~~##########', // 15
      '#################################################~~~#~~~~~~~~~~~~~~##########', // 16
    ],
    signs: [
      'ЛКМ — Ясность на 2.5 с: прыжок ниже, но точный и не пьянит. Потом 2 с перезарядки',
      'ЛКМ ещё раз — выйти из Ясности досрочно',
    ],
    solutions: [
      { name: 'main', script: S3_TO_PILLARS.concat([
        [0.250, 'right jump'],   // towards the crumbling ledge
        [0.150, 'right'],
        [0.050, ''],
        [0.050, 'focus'],        // leave Clarity early (just before landing on the ledge)
        [0.150, 'right'],
        [0.600, 'right jump'],   // drunk D3 jump over the 8-wide gap
        [2.400, 'right'],
      ]) },
      // Drunk D3 hop in the saw corridor: even the minimum hop hits the saws.
      { name: 'no-focus', expect: 'fail', script: [
        [0.950, 'right'],
        [0.050, 'right jump'],
        [2.000, 'right'],
      ] },
      // Staying sober on the crumbling ledge: the sober jump (max 6) cannot clear the 8-wide gap and
      // falls into the abyss (a pit death).
      { name: 'no-early-exit', expect: 'fail', script: S3_TO_PILLARS.concat([
        [0.250, 'right jump'],
        [0.150, 'right'],
        [0.100, ''],
        [0.150, 'right'],
        [0.400, 'right jump'],   // still in Clarity
        [2.400, 'right'],
      ]) },
    ],
  };
})();
