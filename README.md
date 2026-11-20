# Mushroom Wizard (Грибной волшебник) — local prototype

**Play in the browser: https://iansilent.github.io/mushroom-wizard/**

A 2D platformer prototype for validating one design idea: a wizard on mushrooms balances between a
**drunk** state (high, growing, weird jumps) and short **Clarity** windows (precise jumps + one spell).

## Share / copy to another computer

```bash
node tools/build.js
```

This writes `dist/mushroom-wizard.html`: one self-contained file with all scripts and styles inlined.
Copy just that file and open it with a double-click. `index.html` alone does NOT work, because it loads `src/` and `style.css`.
Re-run the build after every change.

## Run

Double-click `index.html` (no build step, no internet needed).
If your browser blocks local files, serve the folder locally instead:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

and open http://127.0.0.1:8765.

## Controls

| Action | Keys |
|---|---|
| Move / aim spell | ← → ↑ ↓ or WASD |
| Jump | Z / Space / J |
| Focus (Clarity) | X / Shift / K |
| Cast (one per Clarity) | C / L — C = Blink, C+↑ = Levitate, C+↓ = Feather fall |
| Back to checkpoint | R |
| Pause / settings (volume) | Esc |
| Mute | M |
| Debug panel (live tuning) | ` (backquote) |
| Debug overlay (arcs, hitboxes) | G |
| Debug: set stage / next / prev checkpoint / god / infinite clarity | 1–4 / N / B / I / O (after opening the debug panel once) |

## Tools (Node)

```bash
node tools/metrics.js          # measured movement envelopes per state
node tools/check.js            # replay every room's solution scripts + robustness under timing noise
node tools/check.js s4_blink --trace main
```

See `DESIGN.md` for mechanics, level-design rules and code contracts.
