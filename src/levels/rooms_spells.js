// Spell rooms: S4 Blink, S5 Levitate, S6 Feather fall. Played after s3_focus (Focus learned at D3).
// Rules these rooms are built on (DESIGN.md §1-2):
//   - every voluntary drunk jump = +1 stage (applied on landing); jumps in Clarity don't count;
//   - checkpoints SET the stage (respawn too), so every beat starts at a known stage;
//   - exactly one spell per Clarity window, and the cast ENDS Clarity at once (castEndsClarity = 1):
//     lasting spells keep running, but the wizard is drunk again and the 2 s recharge starts (a
//     checkpoint touched while NOT in Clarity refills the charge at once). Precise sober moves go
//     BEFORE the cast;
//   - pits are lethal: every gap has the abyss '~' two rows below the platforms.
// Geometry is derived from `node tools/metrics.js`; solutions are replayed by `node tools/check.js <id>`.
var MW = MW || {};
MW.ROOMS = MW.ROOMS || {};

(function () {
// Concatenates script fragments (arrays of [seconds, keys] segments).
function cat() {
  var out = [];
  for (var i = 0; i < arguments.length; i++) out = out.concat(arguments[i]);
  return out;
}

// ------------------------------------------------------------------------------------------------
// S4 «Терновая стена» — Blink (teach -> test -> twist -> combo). Floor row 15. Stage arc D1 -> D4.
//   (a) cols 12-13: thin stone wall, floor to ceiling. Teaching beat at D1: walk up, LMB, 1. 0 jumps.
//   (b) cols 28-30: thorn column '<#>' to the ceiling (cp D1). Blink works from 0.0..1.5 tiles in front
//       of the left thorns; from further away the landing preview turns red (inside the right thorns).
//       Hopping to escalate shoves you into the thorns. The blink at (a) ends Clarity, so the checkpoint
//       refills the charge: LMB, creep sober to the thorns, 1 (or creep drunk, stop, LMB, 1). 0 jumps.
//   (c) cols 44-45: wall with a 5-high rune base and stone above (cp D1 right before it). A ground blink
//       or a jump lower than 5 is clipped by the runes. D1 rises 4, D2 5 (never enough), D3 6: hop
//       twice against the wall (D1 -> D2 -> D3: every hop visibly higher), then jump, LMB near the apex,
//       1 through the stone. Focus window ~0.35..0.95 s after take-off. The 2 s recharge after (b) runs
//       out during the hops. 3 jumps, the leap lands at D4.
//   G2 cols 53-56: a 4-wide abyss pit, one D4 hop (the rune blink already ended Clarity); the recharge
//       runs out during it.
//   (d) cols 72-87: abyss pit of 16 at D4 (cp '4': plain D4 max 13, sober jump + blink 11, D4 jump +
//       Focus + blink 18). Run, jump, LMB on the way DOWN (~1.0..1.3 s after take-off), 1.
//   Sequence breaks: every wall is floor-to-ceiling; (c) has runes where a low blink would skip.
// Script fragments shared by the S4 solutions.
// (c) at the rune wall, out of Clarity: tap twice (D1 -> D2 -> D3), then the D3 leap.
var S4_LEAP = [[0.6, 'right jump'], [0.03, 'right jump focus'], [0.03, 'right jump'], [0.03, 'right spell1'], [0.6, '']];
var S4_RUNES = cat([[0.6, 'right'], [0.02, 'right jump'], [1.1, 'right'], [0.02, 'right jump'], [1.2, 'right']], S4_LEAP);
// After the rune blink (drunk again, lands at D4): run, hop G2, rest on the far side by the checkpoint.
var S4_G2 = [[0.3, 'right'], [0.35, 'right jump'], [0.5, 'right'], [1.5, '']];
// (d) from about the checkpoint: D4 run-jump, LMB on the way down, blink.
var S4_PIT = [[1.15, 'right jump'], [0.03, 'right jump focus'], [0.03, 'right jump'], [0.03, 'right jump spell1'], [3.0, 'right']];

MW.ROOMS['s4_blink'] = {
  name: 'Терновая стена',
  section: 'S4',
  entryY: 15,
  exitY: 15,
  rows: [
    '####################################################################################################',
    '####################################################################################################',
    '....####....##....######....<#>..#####......##..........######............................#######...',
    '............##......##......<#>.............##..............................................###.....',
    '............##..............<#>.............##......................................................',
    '............##..............<#>.............##......................................................',
    '............##..............<#>.............##......................................................',
    '............##..............<#>.............##......................................................',
    '............##..............<#>.............##......................................................',
    '............##..............<#>.............##......................................................',
    '............##..............<#>.............XX......................................................',
    '............##..............<#>.............XX......................................................',
    '............##..............<#>.............XX......................................................',
    '............##..............<#>.............XX......................................................',
    '...1..T.....##......1.......<#>.......1.T...XX..................4.T.................................',
    '#####################################################....###############................############',
    '#####################################################....###############................############',
    '#####################################################~~~~###############~~~~~~~~~~~~~~~~############',
    '#####################################################~~~~###############~~~~~~~~~~~~~~~~############',
    '#####################################################~~~~###############~~~~~~~~~~~~~~~~############',
  ],
  signs: [
    'ЛКМ — Ясность. В Ясности 1 — Блинк: 4 клетки сквозь стены и шипы. Заклинание сразу завершает Ясность',
    'Руны держат Блинк. Каждый прыжок пьянее и выше: попрыгай у стены, а над рунами — ЛКМ и 1',
    'Пропасть убивает. Не допрыгнуть? Прыжок, ЛКМ на спуске, затем 1',
  ],
  solutions: [
    { name: 'main', script: cat(
      [[1.3, 'right'],                                           // (a) walk into the thin wall (D1)
       [0.05, 'focus'], [0.05, ''], [0.05, 'spell1'], [0.3, ''], // the cast ends Clarity: drunk again
       [1.0, 'right'], [0.6, ''],                                // (b) drunk past the checkpoint (refills the charge)
       [0.05, 'focus'], [0.05, ''], [0.5, 'right'], [0.1, ''],   // LMB first, then a precise sober creep to the thorns
       [0.05, 'spell1'], [0.3, ''],
       [1.9, 'right']],                                          // drunk to the rune wall; the recharge runs out
      S4_RUNES, S4_G2, [[1.0, 'right']], S4_PIT) },
    // (b) from its checkpoint: a drunk creep (slippery D1), stop, then Focus + blink.
    { name: 'thorns-drunk', startCheckpoint: 1, script: cat(
      [[0.85, 'right'], [0.8, ''], [0.05, 'focus'], [0.05, ''], [0.05, 'spell1'], [0.3, ''], [1.9, 'right']],
      S4_RUNES, S4_G2, [[1.0, 'right']], S4_PIT) },
    // (c) from its checkpoint with full hops instead of taps (the leap is then at D3 too).
    { name: 'runes-full-hops', startCheckpoint: 2, script: cat(
      [[0.8, 'right'], [0.5, 'right jump'], [1.0, 'right'], [0.5, 'right jump'], [1.1, 'right']],
      S4_LEAP, S4_G2, [[1.0, 'right']], S4_PIT) },
    // (c) three hops: the leap is at D4 and the Focus window is wider.
    { name: 'runes-d4', startCheckpoint: 2, script: cat(
      [[0.8, 'right'], [0.02, 'right jump'], [1.1, 'right'], [0.02, 'right jump'], [1.2, 'right'], [0.02, 'right jump'], [1.3, 'right'],
       [0.9, 'right jump'], [0.03, 'right jump focus'], [0.03, 'right jump'], [0.03, 'right spell1'], [0.6, '']],
      S4_G2, [[1.0, 'right']], S4_PIT) },
    // (d) from its checkpoint (D4).
    { name: 'pit', startCheckpoint: 3, script: cat([[1.0, 'right']], S4_PIT) },
    { name: 'pit-late-focus', startCheckpoint: 3, script: [
      [0.95, 'right'], [1.25, 'right jump'], [0.03, 'right jump focus'], [0.03, 'right jump'], [0.03, 'right jump spell1'], [3.0, 'right'],
    ] },
    // ---- gates that must fail
    { name: 'a-jump-over', expect: 'fail', script: [[1.0, 'right'], [1.2, 'right jump'], [2.0, 'right']] },
    { name: 'b-blink-too-far', expect: 'fail', startCheckpoint: 1, script: [
      [0.05, 'focus'], [0.05, ''], [0.6, 'right'], [0.2, ''], [0.05, 'spell1'], [3.0, 'right'],
    ] },
    { name: 'c-ground-blink', expect: 'fail', startCheckpoint: 2, script: [
      [0.8, 'right'], [0.05, 'focus'], [0.05, ''], [0.05, 'right spell1'], [3.0, 'right'],
    ] },
    { name: 'c-sober-jump-blink', expect: 'fail', startCheckpoint: 2, script: [
      [0.8, 'right'], [0.05, 'focus'], [0.05, ''], [0.36, 'right jump'], [0.05, 'right jump spell1'], [3.0, 'right'],
    ] },
    // No hops: the D1 leap (rise 4) stays below the 5-high runes, the blink is clipped.
    { name: 'c-d1-leap', expect: 'fail', startCheckpoint: 2, script: cat([[0.8, 'right']], S4_LEAP, [[3.0, 'right']]) },
    // One hop: the D2 leap (rise 5) only grazes the rune top.
    { name: 'c-d2-leap', expect: 'fail', startCheckpoint: 2, script: cat(
      [[0.8, 'right'], [0.02, 'right jump'], [1.1, 'right']], S4_LEAP, [[3.0, 'right']]) },
    // Pits kill: a plain D4 run-jump falls into the abyss of (d).
    { name: 'd-plain-d4-pit', expect: 'fail', startCheckpoint: 3, script: [[1.0, 'right'], [2.5, 'right jump'], [2.0, 'right']] },
    { name: 'd-sober-jump-blink', expect: 'fail', startCheckpoint: 3, script: [
      [0.05, 'focus'], [0.05, ''], [1.05, 'right'], [0.35, 'right jump'], [0.05, 'right jump spell1'], [3.0, 'right'],
    ] },
  ],
};

// ------------------------------------------------------------------------------------------------
// S5 «Дымоход» — Levitate. A climb from the hearth (bottom left) up a stepped flue to the roof.
// Stage arc: D1 -> D1..D4 (the steps) -> D3.
//   (a) cols 7-18: thorn tunnel (clearance 2: any drunk hop dies, a sober tap 1.08 survives) with a '1'
//       checkpoint, then a crumbling hearth over the abyss under the open flue, and a +5 ledge. D1 jumps
//       only 4 and can't escalate here (thorns; the crumble allows one jump, then drops you into the
//       abyss); sober jump + 2 reaches 6.5 (cast window ~0.4 s), D1 jump + LMB + 2 reaches 7. 0-1 jumps.
//   Steps cols 19-41: the escalation lesson. The ledge checkpoint sets D1, then three steps that grow
//       with you: +3 at D1 (max 4), +4 at D2 (max 5), +5 at D3 (max 6). A short jump just lands back
//       on the same step one stage drunker, so the stairs correct themselves. 3 jumps -> D4.
//   (b) col 42: the +8 step (plain D4 max 7, sober jump + levitate 6). The top step L3 is a wait pad
//       with a '4' checkpoint (refills the charge; the staircase outlasts the 2 s recharge). Drunk jump
//       against the wall, LMB, 2 (D4 combo 10; D3 combo 9 also works). Focus window ~0.3..1.2 s.
//   (c) cols 48-69: thorny overhang (clearance 5) over the take-off and the first 4 cols of a 7-wide
//       abyss pit; roof ledge +4. A full drunk jump hits the thorns; a short hop survives but falls
//       short into the abyss; blink can't climb. Answer: tap the jump at the edge, LMB once past the
//       thorns, 2 (Focus window ~0.4..0.9 s after the hop). Checkpoint D3 (D4 hops would graze the thorns).
//   Checkpoints rise left to right (they activate forward only, sorted by column).
var S5_HEARTH = [   // from the entry: run through the tunnel, Focus, sober jump on the hearth, levitate
  [1.2, 'right'], [0.05, 'focus'], [0.05, ''],
  [0.75, 'right'], [0.01, 'jump'], [0.3, 'jump'], [0.05, 'jump spell2'], [0.2, ''], [1.0, 'right'],
];
var S5_STAIRS = [   // from the ledge checkpoint, out of Clarity: +3 at D1, +4 at D2, +5 at D3
  [0.1, 'right'], [0.5, 'right jump'], [0.9, 'right'], [0.5, 'right jump'], [1.0, 'right'], [0.6, 'right jump'], [1.2, 'right'],
];
var S5_STEP = [     // from about the '4' checkpoint: the +8 step, then rest under the roof for the charge
  [0.4, 'right'], [0.6, 'right jump'], [0.03, 'right jump focus'], [0.03, 'right jump spell2'], [0.2, 'right'], [1.0, 'right'], [4.0, ''],
];
var S5_ROOF = [     // from about the D3 checkpoint: tap at the edge, LMB past the thorns, levitate
  [0.8, 'right'], [0.01, 'right jump'], [0.75, 'right'], [0.03, 'right focus'], [0.04, 'right'], [0.03, 'right spell2'], [0.2, 'right'], [2.0, 'right'],
];
MW.ROOMS['s5_chimney'] = {
  name: 'Дымоход',
  section: 'S5',
  entryY: 35,
  exitY: 6,
  rows: [
    '######################################################################',
    '############################################################..........',
    '############################################################..........',
    '############################################################..........',
    '###################################...............vvvvvvvvvv..........',
    '###################################...................................',
    '###################################............................#######',
    '###################################............................#######',
    '###################################............................#######',
    '###################################...............3.T..........#######',
    '###################################.......##############.......#######',
    '###################################.......##############.......#######',
    '###################################.......##############~~~~~~~#######',
    '##############################............##############~~~~~~~#######',
    '##############################............##############~~~~~~~#######',
    '##############################............##############~~~~~~~#######',
    '##############################............##############~~~~~~~#######',
    '##############################.......4.T..##############~~~~~~~#######',
    '#########################..........#####################~~~~~~~#######',
    '#########################..........#####################~~~~~~~#######',
    '#########################..........#####################~~~~~~~#######',
    '#########################..........#####################~~~~~~~#######',
    '################...................#####################~~~~~~~#######',
    '################..............##########################~~~~~~~#######',
    '################..............##########################~~~~~~~#######',
    '################..............##########################~~~~~~~#######',
    '################..............##########################~~~~~~~#######',
    '################.........###############################~~~~~~~#######',
    '################.........###############################~~~~~~~#######',
    '.......#########.....1.T.###############################~~~~~~~#######',
    '.......#########...#####################################~~~~~~~#######',
    '.......#########...#####################################~~~~~~~#######',
    '.......vvvvvvvvv...#####################################~~~~~~~#######',
    '...................#####################################~~~~~~~#######',
    '...1.....1...T.....#####################################~~~~~~~#######',
    '################%%%#####################################~~~~~~~#######',
    '################...#####################################~~~~~~~#######',
    '################~~~#####################################~~~~~~~#######',
    '################~~~#####################################~~~~~~~#######',
    '################~~~#####################################~~~~~~~#######',
  ],
  signs: [
    'Под шипами — только короткий прыжок: отпусти пробел сразу. Потом ЛКМ и 2',
    'Высоко? Прыжок, ЛКМ на вершине, 2 — Взлёт',
    'Каждый прыжок пьянее и выше. Ступени растут вместе с тобой',
    'ЛКМ — Ясность: трезвый прыжок низкий, шипы не достанут. Под трубой — прыжок, затем 2 — Взлёт',
  ],
  solutions: [
    { name: 'main', script: cat(S5_HEARTH, [[1.0, '']], S5_STAIRS, S5_STEP, S5_ROOF) },
    // (a) the D1 drunk jump plus Focus at its apex and levitate also works (still a spell).
    { name: 'a-d1-combo', startCheckpoint: 1, script: cat(
      [[0.95, 'right'], [0.45, 'jump'], [0.03, 'jump focus'], [0.03, 'jump spell2'], [0.2, ''], [1.0, 'right'], [1.6, '']],
      S5_STAIRS, S5_STEP, S5_ROOF) },
    // (a) from the tunnel checkpoint with Focus first and a running jump.
    { name: 'a-sober', startCheckpoint: 1, script: cat(
      [[0.05, 'focus'], [0.05, ''], [1.15, 'right'], [0.35, 'jump'], [0.03, 'jump spell2'], [0.2, ''], [1.0, 'right'], [1.0, '']],
      S5_STAIRS, S5_STEP, S5_ROOF) },
    { name: 'stairs', startCheckpoint: 2, script: cat(S5_STAIRS, S5_STEP, S5_ROOF) },
    // (b) Focus late, on the way down from the D4 apex.
    { name: 'step-late-focus', startCheckpoint: 3, script: cat(
      [[0.4, 'right'], [1.0, 'right jump'], [0.03, 'right jump focus'], [0.03, 'right jump spell2'], [0.2, 'right'], [1.0, 'right'], [4.0, '']],
      S5_ROOF) },
    { name: 'roof', startCheckpoint: 4, script: S5_ROOF },
    // (c) a slightly longer run-up and an earlier cast.
    { name: 'roof-early', startCheckpoint: 4, script: [
      [0.9, 'right'], [0.01, 'right jump'], [0.5, 'right'], [0.03, 'right focus'], [0.04, 'right'], [0.03, 'right spell2'], [0.2, 'right'], [2.0, 'right'],
    ] },
    // ---- gates that must fail
    // Pits kill: the D1 jump falls short, the hearth crumbles and drops the wizard into the abyss.
    { name: 'a-d1-jump-pit', expect: 'fail', startCheckpoint: 1, script: [[0.85, 'right'], [0.8, 'right jump'], [2.0, 'right']] },
    { name: 'a-levitate-from-ground', expect: 'fail', startCheckpoint: 1, script: [
      [0.05, 'focus'], [0.05, ''], [1.15, 'right'], [0.03, 'spell2'], [0.2, ''], [2.0, 'right'],
    ] },
    { name: 'a-hop-in-tunnel', expect: 'fail', startCheckpoint: 1, script: [[0.3, 'right'], [0.02, 'jump'], [1.0, ''], [3.0, 'right']] },
    { name: 'b-plain-d4', expect: 'fail', startCheckpoint: 3, script: [
      [0.4, 'right'], [1.0, 'right jump'], [1.0, 'right'], [0.5, 'right jump'], [2.0, 'right'],
    ] },
    { name: 'b-sober-levitate', expect: 'fail', startCheckpoint: 3, script: [
      [0.05, 'focus'], [0.05, ''], [0.6, 'right'], [0.36, 'right jump'], [0.03, 'right jump spell2'], [0.2, 'right'], [3.0, 'right'],
    ] },
    { name: 'c-full-jump', expect: 'fail', startCheckpoint: 4, script: [[0.8, 'right'], [1.0, 'right jump'], [2.0, 'right']] },
    // Pits kill: a short hop with no spell drops into the abyss under the roof.
    { name: 'c-hop-no-spell-pit', expect: 'fail', startCheckpoint: 4, script: [[0.8, 'right'], [0.01, 'right jump'], [2.5, 'right']] },
    { name: 'c-levitate-under-thorns', expect: 'fail', startCheckpoint: 4, script: [
      [0.8, 'right'], [0.01, 'right jump'], [0.2, 'right'], [0.03, 'right focus'], [0.04, 'right'], [0.03, 'right spell2'], [0.2, 'right'], [2.0, 'right'],
    ] },
  ],
};

// ------------------------------------------------------------------------------------------------
// S6 «Колодец» — Feather fall. A descent from the top left into the well, then a run and a long glide.
// Stage arc: D3 (a, b) -> D1..D4 (c).
//   (a) cols 8-30: low thorn ceiling (clearance 3) over the take-off and 3 cols past the edge, so no
//       drunk jump (D3 min hop 3.15 > 2.2); a 12-wide abyss gap to a landing 5 lower. Free fall reaches
//       ~4, walk-off + blink or levitate ~10: only the feather crosses. Walk off (or cast on the ground
//       near the edge), LMB, 3, hold right. Window ~1 s. Stage D3, 0 jumps.
//   (b) cols 40-64: the well, an abyss at the bottom. Entry again under thorns. Stage 1: glide right
//       over a 14-wide thorny baffle, then let go over the 3-col gap (the feather stops you; it runs out
//       there) and drop onto a safe ledge (wait pad + '3' checkpoint; the cast ended Clarity, so the
//       checkpoint refills the charge). Stage 2:
//       walk off the ledge's left end, fall a little, LMB, 3, then steer back right UNDER the ledge to
//       the exit floor 10 rows down. Free falls end in the abyss; a blink from under the ledge falls
//       ~2 short. The ledge's right wall has no thorns at standing height (a safe anchor). 0 jumps.
//   (c) cols 62-146: the escalation run. The checkpoint sets D1; three stepping stones over the abyss
//       (gaps 3, 4, 5; stones 9 wide) are jumped at D1, D2 and D3, so the launch from the last stone is
//       at D4 (rise 7). Then a 22-wide abyss chasm to a ledge 2 lower: plain D4 reaches ~13, D4 jump +
//       blink ~19.4, + levitate ~18; jump + LMB on the way down + 3 reaches ~27.6 from D4 (~25 from D3,
//       but only ~20.7 from D1: the drunker the jump, the higher the glide starts and the farther it
//       goes). Focus window ~0.6..1.2 s after the launch (apex and later). 4 jumps.
var S6_A = [        // from the entry: walk off under the thorns, LMB, feather
  [1.5, 'right'], [0.03, 'right focus'], [0.05, 'right'], [0.45, 'right'], [0.03, 'right spell3'], [3.0, 'right'],
];
var S6_WELL = [     // from about the landing checkpoint: glide over the baffle onto the ledge, then under it
  [1.65, 'right'], [0.03, 'right focus'], [0.04, 'right'], [0.03, 'right spell3'],
  [2.8, 'right'], [2.15, ''],                     // let go over the gap: the feather stops you, then you drop
  [1.0, 'right'], [1.85, 'left'], [0.25, 'right'],
  [0.03, 'right focus'], [0.04, 'right'], [0.03, 'right spell3'], [3.0, 'right'], [0.6, ''],
];
var S6_RUN = [      // from about the D1 checkpoint: three stones (D1, D2, D3), D4 launch, LMB, feather
  [1.05, 'right'], [0.5, 'right jump'], [1.0, 'right'], [0.5, 'right jump'], [1.0, 'right'], [0.5, 'right jump'], [1.35, 'right'],
  [1.0, 'right jump'], [0.03, 'right jump focus'], [0.04, 'right jump'], [0.03, 'right jump spell3'], [5.0, 'right'],
];
var S6_STONES = S6_RUN.slice(0, 6);   // the three stone jumps; the run-up on the last stone follows
MW.ROOMS['s6_well'] = {
  name: 'Колодец',
  section: 'S6',
  entryY: 6,
  exitY: 34,
  rows: [
    '###################################################################################################################################################',
    '###################################################################################################################################################',
    '########vvvvvvvvvvvvvv#############################################################################################################################',
    '........................................###########################################################################################################',
    '........................................###########################################################################################################',
    '...3..T.................................###########################################################################################################',
    '###################.....................###########################################################################################################',
    '###################.....................vvvvvvvvvv#################################################################################################',
    '###################.............................................<##################################################################################',
    '###################.............................................<##################################################################################',
    '###################..............3..............................<##################################################################################',
    '###################............################.................<##################################################################################',
    '###################............################.................<##################################################################################',
    '###################~~~~~~~~~~~~################.................<##################################################################################',
    '###################~~~~~~~~~~~~################.................<##################################################################################',
    '###################~~~~~~~~~~~~################.................<##################################################################################',
    '###################~~~~~~~~~~~~################.................<##################################################################################',
    '###################~~~~~~~~~~~~################^^^^^^^^^^^^^^...<##################################################################################',
    '###################~~~~~~~~~~~~##############################...<##################################################################################',
    '###################~~~~~~~~~~~~################>.................##################################################################################',
    '###################~~~~~~~~~~~~################>.................##################################################################################',
    '###################~~~~~~~~~~~~################>...........3.....#####.............................................................................',
    '###################~~~~~~~~~~~~################>....##################.............................................................................',
    '###################~~~~~~~~~~~~################>.................#####.............................................................................',
    '###################~~~~~~~~~~~~################>.................#####.............................................................................',
    '###################~~~~~~~~~~~~################>.................#####.............................................................................',
    '###################~~~~~~~~~~~~################>.................#####.............................................................................',
    '###################~~~~~~~~~~~~################>...................................................................................................',
    '###################~~~~~~~~~~~~################>...................................................................................................',
    '###################~~~~~~~~~~~~################>...................................................................................................',
    '###################~~~~~~~~~~~~################>...................................................................................................',
    '###################~~~~~~~~~~~~#################...................1..T............................................................................',
    '###################~~~~~~~~~~~~#################..............##############...#########....#########.....#########................................',
    '###################~~~~~~~~~~~~#################~~~~~~~~~~~~~~##############...#########....#########.....#########................................',
    '###################~~~~~~~~~~~~#################~~~~~~~~~~~~~~##############~~~#########~~~~#########~~~~~#########......................##########',
    '###################~~~~~~~~~~~~#################~~~~~~~~~~~~~~##############~~~#########~~~~#########~~~~~#########......................##########',
    '###################~~~~~~~~~~~~#################~~~~~~~~~~~~~~##############~~~#########~~~~#########~~~~~#########~~~~~~~~~~~~~~~~~~~~~~##########',
    '###################~~~~~~~~~~~~#################~~~~~~~~~~~~~~##############~~~#########~~~~#########~~~~~#########~~~~~~~~~~~~~~~~~~~~~~##########',
    '###################~~~~~~~~~~~~#################~~~~~~~~~~~~~~##############~~~#########~~~~#########~~~~~#########~~~~~~~~~~~~~~~~~~~~~~##########',
    '###################~~~~~~~~~~~~#################~~~~~~~~~~~~~~##############~~~#########~~~~#########~~~~~#########~~~~~~~~~~~~~~~~~~~~~~##########',
    '###################~~~~~~~~~~~~#################~~~~~~~~~~~~~~##############~~~#########~~~~#########~~~~~#########~~~~~~~~~~~~~~~~~~~~~~##########',
    '###################~~~~~~~~~~~~#################~~~~~~~~~~~~~~##############~~~#########~~~~#########~~~~~#########~~~~~~~~~~~~~~~~~~~~~~##########',
  ],
  signs: [
    '3 — Пёрышко (в Ясности): медленное планирование. Сойди с края, ЛКМ, 3',
    'Каждый прыжок пьянее и выше. Чем выше прыжок, тем дальше полёт: прыжок, ЛКМ на спуске, 3',
  ],
  solutions: [
    { name: 'main', script: cat(S6_A, S6_WELL, S6_RUN) },
    // (a) the natural way: walk off drunk, then LMB and 3 in the air.
    { name: 'a-air-cast', script: cat(
      [[2.1, 'right'], [0.03, 'right focus'], [0.04, 'right'], [0.03, 'right spell3'], [2.3, 'right'], [0.8, ''],
       // (b) the same in the air: walk off, LMB, 3, let go over the gap
       [2.1, 'right'], [0.03, 'right focus'], [0.04, 'right'], [0.03, 'right spell3'], [2.45, 'right'], [2.25, ''],
       [1.0, 'right'], [1.85, 'left'], [0.25, 'right'],
       [0.03, 'right focus'], [0.04, 'right'], [0.03, 'right spell3'], [3.0, 'right'], [0.6, '']],
      S6_RUN) },
    // (b) from the landing above the well.
    { name: 'well', startCheckpoint: 1, script: cat(
      [[1.75, 'right'], [0.03, 'right focus'], [0.04, 'right'], [0.03, 'right spell3'], [2.8, 'right'], [2.1, ''],
       [1.0, 'right'], [1.85, 'left'], [0.25, 'right'],
       [0.03, 'right focus'], [0.04, 'right'], [0.03, 'right spell3'], [3.0, 'right'], [0.6, '']],
      S6_RUN) },
    // (b) second glide from the ledge checkpoint: no counter-steer, LMB + 3 a bit later.
    { name: 'well-ledge', startCheckpoint: 2, script: cat(
      [[1.1, 'left'], [0.25, ''], [0.03, 'right focus'], [0.04, 'right'], [0.03, 'right spell3'], [3.0, 'right'], [0.6, '']],
      S6_RUN) },
    { name: 'run', startCheckpoint: 3, script: S6_RUN },
    // (c) a later take-off, Focus near the apex or well past it.
    { name: 'run-apex-focus', startCheckpoint: 3, script: cat(S6_STONES, [
      [1.45, 'right'], [0.6, 'right jump'], [0.03, 'right jump focus'], [0.04, 'right jump'], [0.03, 'right jump spell3'], [5.0, 'right'],
    ]) },
    { name: 'run-late-focus', startCheckpoint: 3, script: cat(S6_STONES, [
      [1.45, 'right'], [1.2, 'right jump'], [0.03, 'right jump focus'], [0.04, 'right jump'], [0.03, 'right jump spell3'], [5.0, 'right'],
    ]) },
    // ---- gates that must fail
    // Pits kill: walking off the entry ledge drops the wizard into the abyss.
    { name: 'a-walk-off-pit', expect: 'fail', script: [[4.0, 'right']] },
    { name: 'a-jump-under-thorns', expect: 'fail', script: [[1.6, 'right'], [0.6, 'right jump'], [3.0, 'right']] },
    { name: 'a-blink', expect: 'fail', script: [[2.1, 'right'], [0.03, 'right focus'], [0.04, 'right'], [0.03, 'right spell1'], [3.0, 'right']] },
    { name: 'a-levitate', expect: 'fail', script: [[2.35, 'right'], [0.03, 'right focus'], [0.04, 'right'], [0.03, 'right spell2'], [0.2, 'right'], [3.0, 'right']] },
    { name: 'b-free-fall', expect: 'fail', startCheckpoint: 1, script: [[4.0, 'right']] },
    { name: 'b-blink-over-baffle', expect: 'fail', startCheckpoint: 1, script: [
      [1.75, 'right'], [0.1, 'right'], [0.03, 'right focus'], [0.04, 'right'], [0.03, 'right spell1'], [3.0, 'right'],
    ] },
    { name: 'b-ledge-free-fall', expect: 'fail', startCheckpoint: 2, script: [[1.1, 'left'], [0.25, ''], [3.0, 'right']] },
    { name: 'b-ledge-blink', expect: 'fail', startCheckpoint: 2, script: [
      [1.1, 'left'], [0.35, ''], [0.03, 'right focus'], [0.04, 'right'], [0.03, 'right spell1'], [3.0, 'right'],
    ] },
    // Pits kill: the plain D4 launch falls into the chasm.
    { name: 'c-plain-d4-pit', expect: 'fail', startCheckpoint: 3, script: cat(S6_STONES, [[1.35, 'right'], [2.0, 'right jump'], [3.0, 'right']]) },
    { name: 'c-d4-blink', expect: 'fail', startCheckpoint: 3, script: cat(S6_STONES, [
      [1.35, 'right'], [1.1, 'right jump'], [0.03, 'right jump focus'], [0.04, 'right jump'], [0.03, 'right jump spell1'], [3.0, 'right'],
    ]) },
    { name: 'c-d4-levitate', expect: 'fail', startCheckpoint: 3, script: cat(S6_STONES, [
      [1.35, 'right'], [0.6, 'right jump'], [0.03, 'right jump focus'], [0.04, 'right jump'], [0.03, 'right jump spell2'], [0.2, 'right'], [3.0, 'right'],
    ]) },
  ],
};

})();
