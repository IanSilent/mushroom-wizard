# Mushroom Wizard — prototype design & code contracts

A local 2D web platformer prototype for **design validation**. You play a wizard on mushrooms who
balances between two states:
- **Drunk** (the default): jumps are high and get higher with every few jumps; movement is slippery and weird.
- **Clarity** (Focus key): lasts a few seconds. Jumps are lower but precise, and you can cast ONE spell.

This is a personal, local prototype. There is no hosting, no accounts and no external assets.
It runs by double-clicking `index.html` (classic `<script>` tags, no modules, no build step).

- UI language: **Russian**.
- Code, comments and docs: **English**.

## 1. Mechanics (as implemented in `src/player.js`, `src/world.js`, params in `src/config.js`)

Units: tiles (1 tile = 32 px) and seconds. Y points down. Simulation runs at a fixed 120 Hz (`MW.DT`).
Player box: 0.7 × 1.4 tiles.

### Drunk stages
- There are four stages, D1–D4. `player.stage` holds 1..4.
- **Every voluntary jump → +1 stage** (`jumpsPerStage` = 1), capped at D4. The change applies on **landing**:
  the `stageWarn` event fires on take-off and `stageUp` fires on landing.
  - So the k-th jump after a checkpoint of stage s is made at stage min(4, s + k − 1).
  - From D1 you hit D4 after 3 jumps.
  - Stage changes must be VERY visible: palette, character, HUD and background all shift on every stage.
- Time never increases intoxication. Only jumps do.
- **Checkpoints** carry an authored stage (`1`..`4` glyph).
  - Touching a checkpoint **sets** the stage to that value (the `cpSetsStage` param; 0 = only raise).
  - Respawn always restores the checkpoint's stage.
  - So each beat starts at a known stage and escalates by jumps inside the beat.
- Voluntary escalation is allowed: hopping in place raises the stage. But every drunk jump shoves the
  wizard forward (**stagger**), so hopping on a narrow ledge needs control.
- Drunk weirdness, all deterministic:
  - slippery ground (long stopping distance);
  - weak air control;
  - floaty apex;
  - high minimum hop (you can't jump low when drunk);
  - stagger on take-off;
  - an S-curve **sway** in the air from D2 (always the same curve from take-off);
  - a short landing **slip** from D3 after a drop of more than 2 tiles below take-off;
  - **hiccup** at D4: while standing, a forced 1.5-tile hop every 4 s, with a 0.8 s warning (`hiccupWarn` → `hiccup`).

### Clarity (Focus = LEFT MOUSE BUTTON; X / K also work)
- **One charge.** Pressing Focus enters Clarity for 2.5 s. Pressing it again exits early.
- After Clarity ends, a **cooldown of 2 s** runs, then the charge returns (even in the air).
- A **crystal** (`*`) restores the charge instantly. If you take it during Clarity, the charge is ready the moment Clarity ends.
- Entering Clarity:
  - 0.05 s hitstop;
  - fall speed is halved;
  - the stage is frozen;
  - no drunk weirdness.
- The sober jump is LOWER than any drunk jump (3 tiles vs 4–7), but precise. Its min hop is 1.08.
- Events: `focusOn`, `focusWarn` (1 s left), `focusOff{early}`, `focusReady`, `focusDenied`.

### Spells (keys 1 / 2 / 3) — exactly ONE spell per Clarity window
- 1 = Blink, 2 = Levitate, 3 = Feather fall.
- Gamepad: X / Y / B.
- In sim scripts use `spell1` / `spell2` / `spell3`. The legacy `cast` (+ `up` / `down`) still works.
- **Blink** (1)
  - Teleports `blinkDist` (4) tiles in the facing direction.
  - Passes **through walls and traps**. Only `X` rune walls stop it: you land just before the rune wall.
  - If the target is inside solid ground, it backtracks to the nearest free spot. So walls up to ~3 tiles thick are passable and thicker ones are not.
  - Landing inside a hazard kills. The landing preview is `player.blinkTarget(level, world.hazardTestFn())`.
  - After the blink there is a short float (0.08 s, vy = 0).
- **Levitate** (2). Upward dash of 3.5 tiles in 0.2 s. It is stopped by ceilings, and spiked ceilings kill.
- **Feather fall** (3).
  - Fall speed is capped at 2 t/s and sideways speed at 5 t/s, with good air control. Rise is capped.
  - It lasts up to 3 s or until landing, even after Clarity ends.
  - Glide ratio is about 2.9 tiles sideways per tile down.
- Casting while drunk or after the spell is used → `fizzle` event.

### Threats
- Spikes `^ v < >` and saws `O` (static) or saws on paths (room entities).
- **Pits are lethal.**
  - Falling into any gap between platforms kills and respawns you at the checkpoint.
  - Fill the bottom of every pit with abyss `~` (a lethal void), or open it to the room's bottom edge.
  - NO walkable trenches between platforms.
  - A lower floor is only allowed when it is an intended route, clearly part of the path.
- Crumbling tiles `%`: they break 0.45 s after you stand on them and are restored on respawn.
- Death → 0.35 s → respawn at the last checkpoint. **Checkpoints are dense; death is cheap.**
- R restarts from the checkpoint and is not counted as a death.

### Measured movement envelopes (`node tools/metrics.js` — always re-run, these are the truth)

| state | rise | min hop | max gap | max ledge | sober jump + blink gap | sober jump + levitate ledge | drunk jump + Focus at apex + blink gap | drunk jump + Focus + levitate ledge |
|---|---|---|---|---|---|---|---|---|
| Clarity | 3 | 1.08 | 6 | 3 | 11 | 6 | — | — |
| D1 | 4 | 1.82 | 9 | 4 | | | 14 | 7 |
| D2 | 5 | 2.43 | 11 | 5 | | | 15 | 8 |
| D3 | 6 | 3.15 | 12 | 6 | | | 17 | 9 |
| D4 | 7 | 4.07 | 13 | 7 | | | 18 | 10 |

"Max" means frame-perfect timing. Feather: about 15 tiles sideways for about 5 down over 3 s.

## 2. Level design rules (SOFT difficulty — the player is a single designer playtesting alone)

- Target is 15–30 deaths for the whole level. Teaching beats must be almost free.
- Margins:
  - an **intended** move must keep at least 2 tiles of margin on gaps and at least 1 tile on ledges below the max envelope of the stage the player will have there;
  - an **impossible-without-X** gate must exceed the envelope of every cheaper option by at least 1 tile.
- The stage at a beat = min(4, checkpoint stage + jumps already made since it). Count every jump: escalation is fast, so checkpoints (which reset the stage) are the main tool for controlling what stage a challenge is played at.
  - Count the jumps in your solution.
  - Voluntary escalation to D4 is always possible by hopping. So a "needs a spell" gate must beat the **D4** envelope (gap ≥ 14, ledge ≥ 8), unless a low spiked ceiling or similar makes D4 a liability there.
- Escalation must be a **double-edged** tool:
  - higher stage → longer and higher jumps;
  - but a higher min hop (deadly under low spiked ceilings), more overshoot on short platforms, and sway.
- A checkpoint before every challenge:
  - put one right at each room's entrance, on the entry floor, within 8 columns of the left edge;
  - put one every ~10–20 s of play.
- Clarity is 2.5 s at about 7 t/s, so a sober-only stretch is at most about 12 tiles.
  - After it there is a 2 s cooldown: give a safe pad to wait on before the next Clarity gate.
- The view is 30 × 17 tiles. Keep the landing of any intended jump on screen (horizontal distance ≤ 24).
- Hazards must stay readable: don't hide spikes behind decorations, and don't place saws where the player can't see them coming.
- Signs `T` teach with minimal Russian text and key names, for example:
  - «Пробел — прыжок. Каждый прыжок пьянее предыдущего.»
  - «ЛКМ — Ясность.»
  - «1 — Блинк, 2 — Взлёт, 3 — Пёрышко (одно за Ясность).»

## 3. Room format (`src/levels/*.js`)

```js
var MW = MW || {};
MW.ROOMS = MW.ROOMS || {};
MW.ROOMS['s4_blink'] = {
  name: 'Терновая стена',     // shown in HUD
  section: 'S4',
  entryY: 20,                  // row index of the FLOOR tile at the left edge (column 0)
  exitY: 14,                   // row index of the FLOOR tile at the right edge (last column)
  rows: [ /* equal-length strings, legend in src/level.js */ ],
  signs: ['…'],                // texts for T cells, in reading order (row by row, left to right)
  entities: [ { type: 'saw', path: [[x, y], [x, y]], speed: 3, phase: 0 } ],  // room-local tile coords (cell centres = x+0.5)
  freeStage: false,            // true (sandbox only): checkpoints never change the stage; respawn keeps it
  solutions: [                 // replayed by tools/check.js — MUST pass
    { name: 'main', script: [[0.8, 'right'], [0.5, 'right jump'], …] },
    { name: 'no-focus', expect: 'fail', script: [...] },   // proves a gate needs the mechanic
  ],
};
```

Rules:
- The entry needs 3 free rows above `entryY` at column 0, and the exit the same above `exitY` at the last column.
- Rooms are stitched left→right so that the floors line up.
- Outside a room everything is solid. Falling below the room's last row is a pit death.

Legend:

| Glyph | Meaning |
|---|---|
| `#` | solid |
| `X` | rune wall (blocks blink) |
| `%` | crumbling |
| `=` | one-way platform |
| `^ v < >` | spikes |
| `O` | static saw |
| `1-4` | checkpoint with stage |
| `M` | mushroom (+1 stage) |
| `*` | crystal (restores charge) |
| `E` | exit portal |
| `T` | sign |
| `P` | sandbox start |
| `~` | abyss: lethal void at the bottom of pits |
| `.` | empty |

Script keys:
- Space-separated words: `left right up down jump focus spell1 spell2 spell3 cast restart`.
- Each segment is `[seconds, 'keys held']`.
- A key is pressed on the first step it becomes held.

### Tools
```bash
node tools/metrics.js                       # measured envelopes
node tools/check.js <roomId>                # structural checks + replay solutions + jitter robustness
node tools/check.js <roomId> --trace main   # ASCII path of a solution (':' drunk, '+' clarity, 'l' levitate, 'f' feather, '@' death)
node tools/check.js                         # everything
node tools/check.js --level                 # stitched main level summary
```
Robustness: solutions are re-run with random ±2 and ±4 step timing noise (±17/±33 ms).
- Intended solutions should be **≥ 80% robust at ±4**. That's soft difficulty: no frame-perfect tricks.
- Teaching beats should be 100%.

## 4. Code contracts (browser)

Script load order is in `index.html`. Every file starts with `var MW = MW || {};`.
Use ES5-compatible style (no modules); `const` / `let` / arrow functions are fine.

### World state (read-only for presentation code)
- `world.player`:
  - position and motion: `x, y, w, h, vx, vy, facing, grounded`;
  - drunk state: `stage (1..4), drunkJumps, pendingStageUp`;
  - Clarity: `clarity, clarityT, charge (0|1), cooldownT, spellUsed`;
  - spells: `featherT, levitateT, blinkFloatT, lastCast, blinkFrom`;
  - other: `hiccupT, hiccupWarned, dead, airT`.
- `world.level`:
  - size and tiles: `w, h, grid[y][x]` (chars per legend), `broken{"x,y":true}`, `crumbling{"x,y":secs}`;
  - objects: `checkpoints[{x,y,stage,index}]`, `pickups[{type,x,y,taken}]`, `saws[{x,y,r}]`, `signs[{x,y,text}]`, `exits[{x,y}]`;
  - layout: `rooms[{id,def,ox,oy,w,h}]`, `killY[col]`.
- `world`:
  - progress: `cpIndex` (active checkpoint index), `activeSign` (the sign near the player or null);
  - `stats{deaths,restarts,time,focus,casts,jumps,perRoom[{name,section,deaths,time,focus,casts,restarts}]}`;
  - `time`, `finished`, `currentRoom()` → `{def:{name,section}}`;
  - previews: `world.ghost(inputFn, seconds)` gives side-effect-free trajectory points `[{x,y,clarity}]` (`.lethal`); `player.blinkTarget(level, world.hazardTestFn())` → `{x,y,ok,lethal,clipped}`.
- Events are drained once per frame by `src/main.js` and passed to `renderer.handle(e, world)`, `bg.handle(e, world)`, `MW.Audio.handle(e, world)` and `MW.UI.handle(e, world)`.
- Event types:
  - movement: `jump{clarity,stage}`, `land{drop}`, `bonk`;
  - stages: `stageWarn`, `stageUp{stage}`, `stageDown{stage}`;
  - Focus: `focusOn`, `focusOff{early}`, `focusWarn`, `focusReady`, `focusDenied`;
  - spells: `cast{spell:'blink'|'levitate'|'feather', fromX,fromY,x,y}`, `fizzle{reason}`, `featherEnd`;
  - hiccup: `hiccupWarn`, `hiccup`;
  - life cycle: `death{cause:'spikes'|'saw'|'pit'}`, `respawn`, `restart`, `checkpoint{index}`;
  - world: `crumble{x,y}`, `pickup{kind:'mushroom'|'crystal'}`, `finish`.
  - All carry `x, y` where meaningful, in tiles.

### Modules and owners
- `src/render.js` exposes `MW.Renderer`:
  - `new MW.Renderer(canvas)`, `.reset(world)`, `.handle(e, world)`, `.render(world, dt, mode)`, `.camera {x,y}` (top-left, in tiles);
  - draws the game layer (**transparent background**: the bg canvas is behind it), the HUD and the debug overlay when `MW.CHEATS.overlay`.
- `src/fx_bg.js` exposes `MW.BgFx`:
  - `new MW.BgFx(canvas)`, `.reset()`, `.handle(e)`, `.render(state)`;
  - `state = {dt,time,camX,camY,stage,clarity,clarityT,dead,fx,roomIndex,mode}`;
  - a WebGL background (psychedelic when drunk, scaling with stage and `fx`; cold and crisp in Clarity) with a 2D fallback.
- `src/audio.js` exposes `MW.Audio`:
  - `.init()` (first user gesture), `.setVolumes(settings)`, `.handle(e, world)`, `.update(world, dt, mode)`, `.onMode(mode)`, `.reset()`;
  - WebAudio only, procedural.
- `src/ui.js` exposes `MW.UI`:
  - `.init(game)`, `.onMode(mode, game)`, `.handle(e, world)`, `.update(world, dt, mode)`, `.toggleDebugPanel()`, `.capturesKeys(e)`;
  - DOM overlays inside `#ui`: title, pause, settings (volume), finish/stats, debug panel.
- `src/settings.js` exposes `MW.settings {master,music,sfx,muted,fx,shake}`, `MW.saveSettings()` (persists and notifies) and `MW.onSettingsChanged(fn)`.
- `src/main.js` holds `MW.Game`: modes `title | play | paused | finished`.
  - API: `start(name)`, `resume()`, `pause()`, `restartCheckpoint()`, `restartLevel()`, `loadLevel(name)`.
  - Keys: Esc pause, M mute, \` debug panel, G overlay. With debug on: Shift+1–4 stage, N/B next/prev checkpoint, I god mode, O infinite clarity.

Controls:
- WASD / arrows: move.
- Space / Z / J: jump.
- **Left mouse button**: Clarity. X / K also work.
- **1 / 2 / 3**: Blink / Levitate / Feather.
- R: back to the checkpoint.
- Esc: pause.
- Debug (after \` has been opened): Shift+1..4 stage, N/B checkpoints, I god mode, O infinite Clarity, G overlay.
- Gamepad: A jump, LB/RB/LT/RT Clarity, X Blink, Y Levitate, B Feather.

## 5. Art direction — «Грибной трип» (art-house, trippy, NOT pixel)

- **Shapes.** Soft, organic and hand-made. No visible 32-px blocks.
  - Terrain is drawn as smoothed blobby silhouettes traced from the tile grid (marching squares + rounded corners).
  - Outlines are slightly irregular ink lines, with deterministic jitter from the position. Collision edges never move.
  - Texture comes from gradients, stippling/grain, flowing inner patterns, gills and veins.
- **Palette per drunk stage.** Every stage must look clearly different: the stage is the core state.
  - D1 «Рассвет»: dusty lilac, peach, sage. Soft and dreamy.
  - D2 «Тепло»: magenta, tangerine, teal.
  - D3 «Неон»: electric violet, acid green, hot pink. Heavier warp.
  - D4 «Пик»: full spectrum cycling, kaleidoscopic, high contrast. Eyes open everywhere.
  - **Clarity «Чернила»**: monochrome ink etching on warm paper, with cross-hatching and a calm still image. The only colours allowed are cyan (Clarity and spells) and red-orange (hazards). This is the most striking contrast in the game.
- **Hazards.** Red-orange with a dark outline. Crisp, never warped, readable on every palette and on paper.
- **Abyss `~`.** A swirling void: deep black-violet, slowly rotating stars or spirals, and a thin glowing rim on its top edge. It must read instantly as death.
- **Motifs.** Use them in the background and on terrain decoration, never on the gameplay silhouettes:
  - giant eyes that blink, a melting moon, spirals, floating spores;
  - fractal fern curls, tendrils, mushrooms with gills and bioluminescence;
  - film grain and a vignette.
- **Wizard.** A readable, expressive silhouette.
  - The hat curls more with each stage: a D4 spiral tip. Robe patterns and aura colour change per stage.
  - Eyes: droopy at D1, spirals at D2, rainbow spirals at D3, a third eye opens at D4.
  - In Clarity he is a clean ink drawing with cyan eyes.
- **Stage-up event.** It fires on every jump now. Make it strong but short (≤ 0.4 s):
  - a chromatic ripple from the wizard;
  - the palette snaps to the new stage;
  - the HUD stage label pops;
  - a burst of spores.
  - On reaching D4: a bigger kaleidoscope bloom.
  - It must never hide hazards.
