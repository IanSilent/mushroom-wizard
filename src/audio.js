// Procedural audio: WebAudio only, no asset files.
//   - Music: a generative, woozy loop at 88 bpm, played by a lookahead scheduler. Every drunk stage
//     sounds clearly different, and a stage change crossfades in ~0.3 s (stage-gated layers):
//       base   (always): pad + bass;
//       dream  (D1, fades as you get drunker): glassy quarter-note arp, bells, noise swells, heartbeat kick;
//       groove (D2+): 8th arp, kick / brush / hats;
//       neon   (D3+): off-16th square plucks, octave sub pulse, ghost hats, clap;
//       peak   (D4): detuned saw stabs through a tremolo, kaleidoscope ripples, a wobbling "eye" drone,
//              reverse swells, kick fills.
//     On top, per stage: pitch wobble depth / rate, swing, pad detune, filter cutoff / resonance and a
//     slow filter sweep. D1 is sparse and dreamy, D4 dense, wobbly and detuned. Clarity puts the music
//     "underwater" (lowpass + duck) and adds a crisp tick layer that doubles its rate in the last second.
//   - SFX: one short synthesized sound per world event. Voice stealing keeps bursts from piling up.
//     stageUp (every jump now) is a soft three-note motif that rises one scale step per stage; D4 is a
//     shimmering chord. A pit death is a falling whoosh and a dull thud far below.
//
// Signal graph:
//   pad / bass -> musicIn -----------------------------+
//   layer dry  -> musicIn   (peak dry -> tremolo ->)   |
//   layer wet  -> musicSend -> musicIn                 |
//                          \-> music echo ---------> musicFilter -> musicDuck -> musicBus --+
//                                       (stage/Clarity, sweep LFO) (mode)       (volume)    |
//   sfx voice -> voice gain -> sfxIn ------------------------------------------> sfxBus ----+-> comp -> makeup ->
//   (crunchy voices -> crunch shaper -> sfxIn; chimes also -> sfx echo -> sfxIn)       limiter -> master -> soft clip -> out
//                                                                                                (volume, mute)
//   Clarity ticks -> tickGate -> sfxIn   (the ticks are a gameplay timer, so they follow the SFX volume)
//
// Volumes: settings.master / music / sfx are 0..1 and go through a perceptual curve (gain = v * v),
// smoothed with setTargetAtTime. settings.muted silences the master. The compressor and the limiter sit
// before the master volume, so they always see the same levels whatever the volume is.
//
// Every public method is a safe no-op before init() or without WebAudio, and never throws.
var MW = MW || {};

MW.Audio = (function () {
  // ---------------------------------------------------------------- constants
  var BPM = 88;
  var STEP = 60 / BPM / 4;     // one 16th note (s)
  var LOOKAHEAD = 0.18;        // music is scheduled this far ahead (s); short, so stage layers enter fast
  var TIMER_MS = 50;           // scheduler period; update() also runs it every frame
  var MAX_VOICES = 14;         // SFX polyphony cap; beyond it the oldest lowest-priority voice is stolen
  var MAX_BURST = 6;           // new SFX voices allowed within one frame (same audio time)
  var MUSIC_TRIM = 0.8;        // bus trims leave headroom for the compressor
  var SFX_TRIM = 1.0;
  var MAKEUP = 1.7;            // +4.6 dB after the glue compressor (the limiter catches the peaks)
  var VOL_TC = 0.04;           // volume smoothing time constant (s)
  var STAGE_TC = 0.1;          // stage crossfade time constant: ~95 % of the way in 0.3 s
  // Per state, same indexing as the MW.P arrays: [0] = Clarity, [1..4] = D1..D4.
  var CUTOFF = [480, 2700, 4200, 5200, 6200];  // music lowpass (Hz): hazy at D1, open at D4, underwater in Clarity
  var RESO = [4, 0.8, 1.0, 1.8, 2.6];          // lowpass resonance: the sweep "talks" more when drunker
  var SWEEP = [0, 350, 700, 1500, 2400];       // slow filter sweep depth (Hz)
  var SWEEP_RATE = [0.1, 0.06, 0.1, 0.18, 0.3];
  var DEPTH = [0, 6, 16, 30, 55];              // music pitch wobble depth (cents)
  var LFO_RATE = [0.2, 0.17, 0.24, 0.33, 0.52]; // wobble speed (Hz)
  // Stage layers and their gains per stage (index 0 unused). See the header for what each one plays.
  var LAYERS = ['dream', 'groove', 'neon', 'peak'];
  var LAYER_MIX = {
    dream: [0, 1, 0.55, 0.35, 0.3],
    groove: [0, 0, 1, 0.9, 0.85],
    neon: [0, 0, 0, 1, 0.9],
    peak: [0, 0, 0, 0, 1],
  };
  var PEAK_STABS = { 0: 1, 3: 1, 6: 1, 8: 1, 11: 1, 14: 1 };   // 16th positions of the D4 saw stabs
  // stageUp motif: D major from D5. Stage s starts on degree s-1 (a scale step per stage).
  var MOTIF = [74, 76, 78, 79, 81, 83, 85, 86, 88, 90, 91, 93];

  // 8-bar progression in D with lydian colours. bass = MIDI root, pad = voicing, arp = 5 tones low→high.
  var CHORDS = [
    { bass: 38, pad: [66, 69, 73], arp: [62, 66, 69, 73, 76] },   // Dmaj7
    { bass: 35, pad: [62, 66, 69], arp: [59, 62, 66, 69, 73] },   // Bm9
    { bass: 43, pad: [66, 71, 73], arp: [55, 59, 62, 66, 73] },   // Gmaj7#11
    { bass: 45, pad: [62, 64, 69], arp: [57, 62, 64, 69, 74] },   // Asus
    { bass: 40, pad: [62, 66, 67], arp: [59, 62, 64, 67, 71] },   // Em9
    { bass: 43, pad: [62, 66, 71], arp: [55, 59, 62, 66, 69] },   // Gmaj9
    { bass: 42, pad: [64, 69, 73], arp: [61, 64, 66, 69, 73] },   // F#m7
    { bass: 45, pad: [62, 67, 71], arp: [57, 62, 67, 71, 74] },   // G/A
  ];
  var MELODY = [69, 71, 74, 76, 78, 81, 83, 86];   // D major pentatonic (A4..D6) for the sparse bells
  // Arp shapes as indices into chord.arp (5+ = an octave up). Regenerated every 2 bars with mutations.
  var ARP = [
    [0, 1, 2, 3, 4, 3, 2, 1],
    [0, 2, 1, 3, 2, 4, 3, 1],
    [4, 3, 2, 1, 0, 1, 2, 3],
    [0, 2, 4, 2, 1, 3, 4, 3],
    [0, 1, 2, 4, 3, 2, 1, 2],
  ];

  // ---------------------------------------------------------------- state
  var ctx = null;          // AudioContext, created lazily by init()
  var ready = false;       // graph built and usable
  var disabled = false;    // no WebAudio, or init failed: everything stays a no-op
  var N = {};              // persistent nodes
  var vol = { master: 0.8, music: 0.7, sfx: 0.8, muted: false };
  var mode = 'title';
  var voices = [];         // active SFX voices, in start order
  var lastStart = {};      // tag -> start time of the latest voice (retrigger gaps)
  var burst = { t: -1, n: 0 };   // voices started at the current audio time (one frame's events)
  var music = { on: false, origin: 0, stepAbs: 0, pattern: ARP[0].slice(), mel: 3 };
  var ms = { stage: 1, clarity: false, warn: false, dead: false };   // world snapshot used by the music
  // Last music targets sent to params (only changes are sent).
  var applied = { c: -1, q: -1, duck: -1, depth: -1, rate: -1, sweep: -1, sweepRate: -1, stage: -1, layers: [-1, -1, -1, -1] };
  var prevClarity = false;
  var tick = { open: false, next: 0 };
  var wind = null;         // feather-fall wind loop
  var crumbleSeen = {};    // crumbling tiles already creaked
  var hiddenSuspended = false;   // suspended by us because the tab is hidden
  var warned = {};
  var seed = 0x2545f491;

  // ---------------------------------------------------------------- small helpers

  // Seeded PRNG (mulberry32): the music is generative but not chaotic.
  function rnd() {
    seed = (seed + 0x6D2B79F5) >>> 0;
    var t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function unit(v, def) { v = +v; return isFinite(v) ? clamp(v, 0, 1) : def; }
  function curve(v) { return v * v; }
  function stageOf(s) { s = Math.round(+s); return isFinite(s) ? clamp(s, 1, 4) : 1; }
  function noop() {}
  function settle(p) { if (p && p.then) p.then(noop, noop); }   // swallow promise rejections

  function setP(param, v, t, tc) {
    try { param.setTargetAtTime(v, t, Math.max(0.001, tc)); } catch (e) { /* ignore */ }
  }

  function musicAudible() { return !vol.muted && vol.master > 0.001 && vol.music > 0.001; }
  function sfxAudible() { return !vol.muted && vol.master > 0.001 && vol.sfx > 0.001; }

  // Attack (linear) → optional hold → exponential release to silence at t + d.
  function envelope(p, t, a, peak, d, hold) {
    peak = Math.max(0.0002, peak || 0.1);
    p.setValueAtTime(0.0001, t);
    p.linearRampToValueAtTime(peak, t + a);
    if (hold && hold > a && hold < d) p.setValueAtTime(peak, t + hold);
    p.exponentialRampToValueAtTime(0.0001, t + d);
  }

  // Chains onended handlers (several owners may need the same source's end).
  function onEnd(src, fn) {
    var prev = src.onended;
    src.onended = prev ? function (e) { prev(e); fn(e); } : fn;
  }

  // node -> (optional stereo panner) -> dest. pan: number, or [from, to, seconds] for a sweep.
  function connectOut(node, pan, dest, t) {
    if (pan !== undefined && pan !== null && ctx.createStereoPanner) {
      var p = ctx.createStereoPanner();
      if (typeof pan === 'number') {
        p.pan.value = clamp(pan, -1, 1);
      } else {
        p.pan.setValueAtTime(clamp(pan[0], -1, 1), t);
        p.pan.linearRampToValueAtTime(clamp(pan[1], -1, 1), t + pan[2]);
      }
      node.connect(p);
      p.connect(dest);
    } else {
      node.connect(dest);
    }
  }

  // ---------------------------------------------------------------- voices (SFX polyphony)

  // A voice is the group of nodes of one SFX event, behind one gain node that stealing can fade out.
  // o: { max: voices per tag (2), gap: min seconds between starts, prio (1), echo: send 0..1, pan, to }
  function voice(tag, dur, o) {
    o = o || {};
    if (!ready || !sfxAudible()) return null;
    var t = ctx.currentTime;
    prune(t);
    if (lastStart[tag] === t) return null;   // the same sound twice in one frame adds nothing
    if (o.gap && lastStart[tag] !== undefined && t - lastStart[tag] < o.gap) return null;
    var prio = o.prio || 1, max = o.max || 2;
    // Burst cap: events of one frame share currentTime; past a handful, only important ones get through.
    if (t !== burst.t) { burst.t = t; burst.n = 0; }
    if (burst.n >= MAX_BURST && prio <= 1) return null;
    burst.n++;
    var same = [];
    for (var i = 0; i < voices.length; i++) if (voices[i].tag === tag) same.push(voices[i]);
    while (same.length >= max) steal(same.shift(), t);   // the oldest of the same kind
    while (voices.length >= MAX_VOICES) {
      var victim = null;   // the oldest voice of the lowest priority (voices are in start order)
      for (var j = 0; j < voices.length; j++) if (!victim || voices[j].prio < victim.prio) victim = voices[j];
      if (victim.prio > prio) return null;   // everything playing matters more than this sound
      steal(victim, t);
    }
    var out = ctx.createGain();
    connectOut(out, o.pan, o.to || N.sfxIn, t);
    if (o.echo) {
      var send = ctx.createGain();
      send.gain.value = o.echo;
      out.connect(send);
      send.connect(N.sfxEcho);
    }
    var v = { isVoice: true, tag: tag, t: t, end: t + dur, out: out, srcs: [], live: 0, prio: prio };
    voices.push(v);
    lastStart[tag] = t;
    return v;
  }

  function track(v, src, end) {
    v.srcs.push(src);
    if (end > v.end) v.end = end;
    v.live++;
    onEnd(src, function () {
      if (--v.live <= 0) { try { v.out.disconnect(); } catch (e) { /* ignore */ } }
    });
  }

  function steal(v, t) {
    var i = voices.indexOf(v);
    if (i >= 0) voices.splice(i, 1);
    try { v.out.gain.setTargetAtTime(0, t, 0.008); } catch (e) { /* ignore */ }
    for (var k = 0; k < v.srcs.length; k++) {
      try { v.srcs[k].stop(t + 0.06); } catch (e) { /* already stopped */ }
    }
  }

  function kill(tag) {
    if (!ready) return;
    var t = ctx.currentTime;
    for (var i = voices.length - 1; i >= 0; i--) if (voices[i].tag === tag) steal(voices[i], t);
  }

  function prune(t) {
    for (var i = voices.length - 1; i >= 0; i--) if (voices[i].end < t) voices.splice(i, 1);
  }

  // ---------------------------------------------------------------- sound primitives

  // One oscillator note. dest: a voice (SFX) or an AudioNode (music).
  // o: { type, f | fs:[[dt, hz], ...] (exponential glides), t, a, d, hold, peak, detune,
  //      lp, q (lowpass in front of the envelope), vib:{rate, cents}, wob (music pitch wobble), pan, to }
  function tone(dest, o) {
    var v = dest.isVoice ? dest : null;
    var t = o.t !== undefined ? o.t : (v ? v.t : ctx.currentTime);
    var a = Math.max(0.001, o.a || 0.005);
    var d = Math.max(o.d || 0.1, a + 0.01);
    var end = t + d + 0.03;
    var osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    if (o.fs) {
      osc.frequency.setValueAtTime(Math.max(1, o.fs[0][1]), t + o.fs[0][0]);
      for (var i = 1; i < o.fs.length; i++) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.fs[i][1]), t + o.fs[i][0]);
      }
    } else {
      osc.frequency.setValueAtTime(Math.max(1, o.f), t);
    }
    if (o.detune) osc.detune.setValueAtTime(o.detune, t);
    if (o.wob && N.detuneBus) {
      // The wobble bus runs forever: disconnect at the end, or it would keep the finished note alive.
      N.detuneBus.connect(osc.detune);
      onEnd(osc, function () { try { N.detuneBus.disconnect(osc.detune); } catch (e) { /* ignore */ } });
    }
    var head = osc;
    if (o.lp) {
      var flt = ctx.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.value = o.lp;
      flt.Q.value = o.q || 0.7;
      osc.connect(flt);
      head = flt;
    }
    var g = ctx.createGain();
    envelope(g.gain, t, a, o.peak, d, o.hold);
    head.connect(g);
    connectOut(g, o.pan, o.to || (v ? v.out : dest), t);
    osc.start(t);
    osc.stop(end);
    if (o.vib) {
      var lfo = ctx.createOscillator(), lg = ctx.createGain();
      lfo.frequency.value = o.vib.rate;
      lg.gain.value = o.vib.cents;
      lfo.connect(lg);
      lg.connect(osc.detune);
      lfo.start(t);
      lfo.stop(end);
      if (v) track(v, lfo, end);
    }
    if (v) track(v, osc, end);
    return osc;
  }

  // Filtered noise burst. o: { t, a, d, hold, peak, type (filter; omit for raw), f, f2, fT, q, pan, to }
  function noise(dest, o) {
    var v = dest.isVoice ? dest : null;
    var t = o.t !== undefined ? o.t : (v ? v.t : ctx.currentTime);
    var a = Math.max(0.001, o.a || 0.002);
    var d = Math.max(o.d || 0.1, a + 0.01);
    var end = t + d + 0.03;
    var src = ctx.createBufferSource();
    src.buffer = N.noise;
    src.loop = true;
    var head = src;
    if (o.type) {
      var flt = ctx.createBiquadFilter();
      flt.type = o.type;
      flt.Q.value = o.q || 0.8;
      flt.frequency.setValueAtTime(o.f, t);
      if (o.f2) flt.frequency.exponentialRampToValueAtTime(o.f2, t + (o.fT || d));
      src.connect(flt);
      head = flt;
    }
    var g = ctx.createGain();
    envelope(g.gain, t, a, o.peak, d, o.hold);
    head.connect(g);
    connectOut(g, o.pan, o.to || (v ? v.out : dest), t);
    src.start(t, rnd() * 1.5);   // random offset: consecutive bursts never sound identical
    src.stop(end);
    if (v) track(v, src, end);
    return src;
  }

  // A voice-local filter (for formants and filter sweeps shared by several oscillators).
  function vfilter(v, type, f, q) {
    var flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.setValueAtTime(f, v.t);
    flt.Q.value = q || 1;
    flt.connect(v.out);
    return flt;
  }

  // Inharmonic bell: [ratio, peak, decay] partials.
  function bell(v, f, t, parts, scale) {
    for (var i = 0; i < parts.length; i++) {
      tone(v, { type: 'sine', f: f * parts[i][0], t: t, a: 0.003, d: parts[i][2], peak: parts[i][1] * (scale || 1) });
    }
  }

  // ---------------------------------------------------------------- music

  // The arp index space: 0..4 = chord.arp, 5+ = an octave up.
  function chordTone(ch, idx) { return idx >= 5 ? ch.arp[idx - 5] + 12 : ch.arp[idx]; }

  // The stage the music plays: the title loop is always the dreamy D1.
  function musicStage() { return mode === 'title' ? 1 : ms.stage; }

  // A layer gets new notes while its target is up or while it is still fading out.
  function layerLive(i) {
    if (applied.layers[i] > 0.001) return true;
    try { return N.layers[LAYERS[i]].dry.gain.value > 0.003; } catch (e) { return false; }
  }

  // ---- base layer (always)

  function padChord(ch, t, stage) {
    var d = STEP * 16 * 1.25;   // overlaps the next bar's attack: a seamless crossfade
    var spread = 5 + 5 * stage; // cents: a soft unison at D1, a seasick chorus at D4
    for (var i = 0; i < ch.pad.length; i++) {
      var f = mtof(ch.pad[i]);
      tone(N.padIn, { type: 'triangle', f: f, t: t, a: stage <= 1 ? 1.0 : 0.6, hold: d - 0.9, d: d, peak: 0.03, wob: true });
      tone(N.padIn, { type: 'sawtooth', f: f, t: t, a: 0.9, hold: d - 0.9, d: d, peak: 0.011, detune: i % 2 ? spread : -spread, wob: true });
      if (stage >= 4) {
        tone(N.padIn, { type: 'sawtooth', f: f, t: t, a: 0.5, hold: d - 0.9, d: d, peak: 0.008, detune: i % 2 ? -spread * 1.7 : spread * 1.7, wob: true });
      }
    }
  }

  // slide: 'in' scoops up from a semitone below, 'down' sags a semitone (drunk stumbles).
  function bassNote(m, t, len, slide) {
    var f = mtof(m);
    var fs = slide === 'in' ? [[0, f * 0.944], [0.09, f]] : (slide === 'down' ? [[0, f], [len, f * 0.944]] : null);
    var fs2 = fs && fs.map(function (p) { return [p[0], p[1] * 2]; });
    tone(N.musicIn, { type: 'sine', f: f, fs: fs, t: t, a: 0.015, hold: len * 0.7, d: len + 0.12, peak: 0.17, wob: true });
    // An octave of harmonics so the bass survives laptop speakers.
    tone(N.musicIn, { type: 'triangle', f: f * 2, fs: fs2, t: t, a: 0.01, hold: len * 0.3, d: len * 0.8 + 0.1, peak: 0.03, lp: 900, wob: true });
  }

  // ---- shared percussion (dest = a layer bus)

  function kick(t, dest, k) {
    tone(dest, { type: 'sine', fs: [[0, 120], [0.12, 42]], t: t, a: 0.003, d: 0.32, peak: 0.2 * (k || 1) });
  }
  function brush(t, dest) { noise(dest, { type: 'bandpass', f: 2200, q: 0.7, t: t, a: 0.004, d: 0.16, peak: 0.07 }); }
  function hat(t, acc, dest) { noise(dest, { type: 'highpass', f: 7000, q: 0.7, t: t, a: 0.001, d: 0.04, peak: 0.028 * acc }); }

  // ---- dream layer (D1)

  function glassNote(m, t, i, dest) {
    tone(dest, { type: 'sine', f: mtof(m), t: t, a: 0.02, d: 1.1, peak: 0.04, wob: true, pan: i % 2 ? 0.4 : -0.4 });
    tone(dest, { type: 'sine', f: mtof(m) * 2.005, t: t, a: 0.01, d: 0.5, peak: 0.01, wob: true });
  }

  function bellNote(m, t, dest) {
    tone(dest, { type: 'sine', f: mtof(m), t: t, a: 0.012, d: 1.6, peak: 0.045, wob: true });
    tone(dest, { type: 'sine', f: mtof(m) * 3.01, t: t, a: 0.005, d: 0.5, peak: 0.008, wob: true });
  }

  function swell(t, dest) {
    noise(dest, { type: 'bandpass', f: 500, f2: 1400, fT: 3.5, q: 1.2, t: t, a: 2.0, hold: 2.4, d: 5.0, peak: 0.035 });
  }

  // Lub-dub: a soft double kick, the only drum of D1.
  function heartbeat(t, dest) {
    tone(dest, { type: 'sine', fs: [[0, 90], [0.1, 40]], t: t, a: 0.004, d: 0.26, peak: 0.12 });
    tone(dest, { type: 'sine', fs: [[0, 80], [0.1, 38]], t: t + STEP * 1.1, a: 0.004, d: 0.22, peak: 0.07 });
  }

  // ---- groove layer (D2+)

  function arpNote(m, t, i, dest) {
    tone(dest, { type: 'triangle', f: mtof(m), t: t, a: 0.006, d: 0.42, peak: 0.05, wob: true, pan: i % 2 ? 0.28 : -0.28 });
    tone(dest, { type: 'sine', f: mtof(m + 12), t: t, a: 0.004, d: 0.22, peak: 0.016, wob: true });
  }

  // ---- neon layer (D3+)

  function pluck(m, t, dest, pan) {
    tone(dest, { type: 'square', f: mtof(m), t: t, a: 0.003, d: 0.13, peak: 0.028, lp: 2400, q: 5, wob: true, pan: pan });
  }
  function subPulse(m, t, dest) {
    tone(dest, { type: 'triangle', f: mtof(m), t: t, a: 0.006, d: STEP * 1.3, peak: 0.06, lp: 700, wob: true });
  }
  function clap(t, dest) {
    noise(dest, { type: 'bandpass', f: 1400, q: 1.1, t: t, a: 0.001, d: 0.05, peak: 0.05 });
    noise(dest, { type: 'bandpass', f: 1300, q: 1.1, t: t + 0.014, a: 0.001, d: 0.14, peak: 0.06 });
  }

  // ---- peak layer (D4)

  // A detuned saw chord stab an octave up (the layer bus adds the tremolo).
  function stab(ch, t, dest) {
    var flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(4200, t);
    flt.frequency.exponentialRampToValueAtTime(1600, t + 0.16);
    flt.Q.value = 2;
    flt.connect(dest);
    for (var i = 0; i < ch.pad.length; i++) {
      var f = mtof(ch.pad[i] + 12);
      tone(dest, { type: 'sawtooth', f: f, t: t, a: 0.004, d: 0.17, peak: 0.011, detune: -22, wob: true, to: flt });
      tone(dest, { type: 'sawtooth', f: f, t: t, a: 0.004, d: 0.17, peak: 0.011, detune: 19, wob: true, to: flt });
    }
  }

  // Kaleidoscope: a fast sweep up through the chord, panned left to right.
  function ripple(ch, t, dest) {
    for (var i = 0; i < ch.arp.length; i++) {
      tone(dest, { type: 'triangle', f: mtof(ch.arp[i] + 12), t: t + i * STEP * 0.25, a: 0.003, d: 0.3, peak: 0.022, wob: true,
                   pan: -0.6 + i * 0.3 });
    }
  }

  // A high, heavily wobbling sine over two bars: the eyes open.
  function eyeDrone(ch, t, dest) {
    var d = STEP * 32;
    tone(dest, { type: 'sine', f: mtof(ch.pad[ch.pad.length - 1] + 12), t: t, a: 1.2, hold: d - 1.5, d: d, peak: 0.012,
                 vib: { rate: 5.5, cents: 45 } });
  }

  // Reverse cymbal: a rising hiss that peaks on the next downbeat and cuts.
  function reverseSwell(t, len, dest) {
    noise(dest, { type: 'highpass', f: 2000, f2: 9000, fT: len, q: 0.8, t: t, a: len, d: len + 0.1, peak: 0.05 });
  }

  // ---- scheduler

  function newPattern() {
    var src = ARP[Math.floor(rnd() * ARP.length)], out = [];
    for (var i = 0; i < 8; i++) {
      var n = src[i], r = rnd();
      if (i > 0 && r < 0.16) n = -1;   // rest
      else if (r > 0.9) n += 5;        // an octave up
      out.push(n);
    }
    music.pattern = out;
  }

  function musicStart() {
    if (!ready || music.on) return;
    music.on = true;
    music.origin = ctx.currentTime + 0.1;
    music.stepAbs = 0;
    newPattern();
  }

  function musicStop() { music.on = false; }

  // Swing grows with the stage: off-beat 8ths (and 16ths, half as much) arrive late. Clarity is straight.
  function swingOffset(s, drunk, stage) {
    if (!drunk) return 0;
    var r = 0.52 + 0.03 * stage;          // 8th-note swing ratio: 0.55 (D1) .. 0.64 (D4)
    var late = (r - 0.5) * 4 * STEP;      // delay of an off-beat 8th
    if (s % 4 === 2) return late;
    if (s % 2 === 1) return late * 0.5;
    return 0;
  }

  function scheduleStep(stepAbs, t0) {
    var s = stepAbs % 16, bar = Math.floor(stepAbs / 16) % CHORDS.length;
    if (s === 0 && bar % 2 === 0) newPattern();
    if (!musicAudible()) return;   // the clock keeps running, no nodes are made
    var drunk = !ms.clarity, stage = musicStage();
    var t = t0 + swingOffset(s, drunk, stage);
    if (drunk) t += (rnd() - 0.5) * 0.004 * stage;   // humanize: up to ±8 ms at D4
    t = Math.max(t, ctx.currentTime + 0.005);
    var ch = CHORDS[bar];
    var title = mode === 'title';
    var drums = mode === 'play' || mode === 'paused';   // the title loop is drumless and calmer
    var L = N.layers;

    // Base: pad and bass at every stage. D1 holds the bass longer and never walks.
    if (s === 0) {
      padChord(ch, t, stage);
      bassNote(ch.bass, t, stage <= 1 ? STEP * 10 : STEP * 6, drunk && stage >= 3 ? 'in' : null);
    } else if (s === 10 && stage >= 2 && rnd() < 0.8) {
      bassNote(ch.bass + (rnd() < 0.3 ? 7 : 0), t, STEP * 2, null);
    } else if (s === 14 && drunk && stage >= 2 && rnd() < 0.15 + 0.1 * stage) {
      bassNote(ch.bass, t, STEP * 2, 'down');
    }

    if (layerLive(0)) {   // dream
      if (s === 0 && bar % 2 === 0) swell(t, L.dream.wet);
      if (s % 4 === 0) {
        var di = music.pattern[s / 2];
        if (di >= 0 && !(title && rnd() < 0.3)) glassNote(chordTone(ch, di) + 12, t, s / 4, L.dream.wet);
      }
      if ((s === 0 || s === 6 || s === 12) && rnd() < (stage <= 1 ? 0.4 : 0.22)) {
        music.mel = clamp(music.mel + Math.floor(rnd() * 5) - 2, 0, MELODY.length - 1);
        bellNote(MELODY[music.mel], t + STEP * 0.5, L.dream.wet);
      }
      if (drums && stage <= 1 && s === 0) heartbeat(t, L.dream.dry);
    }

    if (layerLive(1)) {   // groove
      if (s % 2 === 0) {
        var gi = music.pattern[s / 2];
        if (gi >= 0) arpNote(chordTone(ch, gi), t, s / 2, L.groove.wet);
      }
      if (drums) {
        if (s === 0 || s === 8) kick(t, L.groove.dry);
        if (s === 4 || s === 12) brush(t, L.groove.dry);
        if (s % 2 === 0) hat(t, s % 4 === 0 ? 1 : 0.6, L.groove.dry);
      }
    }

    if (layerLive(2)) {   // neon
      if (s % 2 === 1) {
        var ni = music.pattern[7 - (s - 1) / 2];   // the pattern backwards, on the off-16ths
        if (ni >= 0 && rnd() < 0.8) pluck(chordTone(ch, ni) + 12, t, L.neon.wet, s % 4 === 1 ? 0.35 : -0.35);
      }
      if (s % 4 === 2) subPulse(ch.bass + 12, t, L.neon.dry);
      if (drums) {
        if (s % 2 === 1 && rnd() < 0.7) hat(t, 0.4, L.neon.dry);
        if (s === 12) clap(t, L.neon.dry);
      }
    }

    if (layerLive(3)) {   // peak
      if (PEAK_STABS[s]) stab(ch, t, L.peak.dry);
      if (s === 0) ripple(ch, t, L.peak.wet);
      if (s === 0 && bar % 2 === 0) eyeDrone(ch, t, L.peak.wet);
      if (s === 8 && bar % 2 === 1) reverseSwell(t, STEP * 8, L.peak.dry);
      if (drums) {
        if (s % 2 === 1) hat(t, 0.3, L.peak.dry);
        if ((s === 14 || s === 15) && rnd() < 0.5) kick(t, L.peak.dry, 0.6);
      }
    }
  }

  function scheduler() {
    if (!ready || !music.on) return;
    var now = ctx.currentTime;
    var next = music.origin + music.stepAbs * STEP;
    if (next < now - 0.05) {
      // Fell behind (throttled timer): skip the missed steps but stay on the grid.
      music.stepAbs = Math.ceil((now - music.origin) / STEP);
      next = music.origin + music.stepAbs * STEP;
    }
    for (var guard = 0; next < now + LOOKAHEAD && guard < 64; guard++) {
      scheduleStep(music.stepAbs, next);
      music.stepAbs++;
      next = music.origin + music.stepAbs * STEP;
    }
  }

  function layerGains(stage, k) {
    return LAYERS.map(function (name) { return LAYER_MIX[name][stage] * (k || 1); });
  }

  function musicTargets() {
    var s = ms.stage;
    var base = { stage: s, sweepRate: SWEEP_RATE[s], layers: layerGains(s) };
    function out(o) { for (var k in o) base[k] = o[k]; return base; }
    if (mode === 'finished') return out({ c: 1500, q: 1, duck: 0, depth: 0, rate: LFO_RATE[0], sweep: 0 });
    if (mode === 'paused') return out({ c: 1100, q: 1, duck: 0.32, depth: DEPTH[s] * 0.5, rate: LFO_RATE[s], sweep: 0 });
    if (mode === 'title') {
      return out({ stage: 1, c: 3200, q: 1, duck: 0.5, depth: 10, rate: 0.2, sweep: SWEEP[1], sweepRate: SWEEP_RATE[1], layers: layerGains(1) });
    }
    if (ms.clarity) {
      // Calm and still: the stage is frozen (same layers, the busiest ones halved), underwater, no wobble.
      var lay = layerGains(s);
      lay[2] *= 0.5;
      lay[3] *= 0.5;
      return out({ c: CUTOFF[0], q: RESO[0], duck: 0.5, depth: 0, rate: LFO_RATE[0], sweep: 0, layers: lay });
    }
    if (ms.dead) return out({ c: 800, q: 1, duck: 0.6, depth: DEPTH[s], rate: LFO_RATE[s], sweep: 0 });
    return out({ c: CUTOFF[s], q: RESO[s], duck: 1, depth: DEPTH[s], rate: LFO_RATE[s], sweep: SWEEP[s] });
  }

  // Sends music targets to the params, only when they change (keeps the automation timelines short).
  // A stage change moves everything with STAGE_TC, so the whole mix morphs in ~0.3 s.
  function applyMusic() {
    var t = ctx.currentTime, m = musicTargets();
    var entering = ms.clarity && !prevClarity;
    var leaving = !ms.clarity && prevClarity;
    prevClarity = ms.clarity;
    var staged = m.stage !== applied.stage && applied.stage !== -1;
    applied.stage = m.stage;
    function tcFor(normal) { return entering ? 0.03 : (leaving ? 0.22 : (staged ? STAGE_TC : normal)); }
    if (leaving && mode === 'play') {
      // Bubbly sweep back: a resonance bump while the cutoff glides up out of the water.
      setP(N.musicFilter.Q, 12, t, 0.02);
      setP(N.musicFilter.Q, m.q, t + 0.15, 0.25);
      applied.q = m.q;
    }
    if (m.c !== applied.c) { setP(N.musicFilter.frequency, m.c, t, tcFor(0.15)); applied.c = m.c; }
    if (m.q !== applied.q) { setP(N.musicFilter.Q, m.q, t, staged ? STAGE_TC : 0.05); applied.q = m.q; }
    if (m.sweep !== applied.sweep) { setP(N.sweepDepth.gain, m.sweep, t, entering ? 0.02 : tcFor(0.2)); applied.sweep = m.sweep; }
    if (m.sweepRate !== applied.sweepRate) { setP(N.sweepLfo.frequency, m.sweepRate, t, 0.3); applied.sweepRate = m.sweepRate; }
    if (m.duck !== applied.duck) {
      setP(N.musicDuck.gain, m.duck, t, mode === 'finished' ? 0.3 : (entering ? 0.04 : 0.12));
      applied.duck = m.duck;
    }
    if (m.depth !== applied.depth) {
      // Two summed LFOs swing ±1.5, so the depth gain is cents / 1.5.
      setP(N.lfoDepth.gain, m.depth / 1.5, t, entering ? 0.04 : (staged ? STAGE_TC : 0.6));
      applied.depth = m.depth;
    }
    if (m.rate !== applied.rate) {
      var rtc = staged ? 0.15 : 0.5;
      setP(N.lfo1.frequency, m.rate, t, rtc);
      setP(N.lfo2.frequency, m.rate * 1.618, t, rtc);
      applied.rate = m.rate;
    }
    for (var i = 0; i < LAYERS.length; i++) {
      var g = m.layers[i];
      if (g === applied.layers[i]) continue;
      var L = N.layers[LAYERS[i]], ltc = staged || entering ? STAGE_TC : 0.3;
      setP(L.dry.gain, g, t, ltc);
      setP(L.wet.gain, g, t, ltc);
      applied.layers[i] = g;
    }
  }

  // Music-wide pitch offset (cents) on top of the wobble: a sag on death, a hiccup on stage-up.
  function bend(cents, tc, at) {
    if (N.bend) setP(N.bend.offset, cents, at || ctx.currentTime, tc);
  }

  // Grid time at or after t for an interval, locked to the music clock.
  function gridNext(t, iv) {
    var o = music.origin || 0;
    return o + Math.ceil((t - o) / iv - 1e-6) * iv;
  }

  function tickSound(t, accent, warn) {
    var osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = warn ? (accent ? 5200 : 4400) : (accent ? 4000 : 3300);
    envelope(g.gain, t, 0.001, (accent ? 0.09 : 0.06) * (warn ? 1.2 : 1), 0.03);
    osc.connect(g);
    g.connect(N.tickGate);
    osc.start(t);
    osc.stop(t + 0.05);
  }

  // The Clarity tick layer: 8ths, then 16ths during the last second. Scheduled with a short horizon
  // from update() so it starts and stops with Clarity; the gate cuts anything already queued.
  function updateTicks() {
    var t = ctx.currentTime;
    var on = mode === 'play' && ms.clarity;
    if (on !== tick.open) {
      setP(N.tickGate.gain, on ? 1 : 0, t, on ? 0.004 : 0.01);
      tick.open = on;
      tick.next = 0;
    }
    if (!on || !sfxAudible()) return;
    var iv = ms.warn ? STEP : STEP * 2;
    if (tick.next < t + 0.004) tick.next = gridNext(t + 0.004, iv);
    for (var guard = 0; tick.next < t + 0.07 && guard < 8; guard++) {
      var k = Math.round((tick.next - (music.origin || 0)) / STEP);
      tickSound(tick.next, k % 4 === 0, ms.warn);
      tick.next += iv;
    }
  }

  // ---------------------------------------------------------------- feather wind (a held loop)

  function windStart() {
    if (wind || !ready || !sfxAudible()) return;
    var t = ctx.currentTime;
    var src = ctx.createBufferSource();
    src.buffer = N.noise;
    src.loop = true;
    var f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900;
    f.Q.value = 0.9;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.setTargetAtTime(0.06, t, 0.15);
    src.connect(f);
    f.connect(g);
    g.connect(N.sfxIn);
    src.start(t, rnd() * 1.5);
    wind = { src: src, f: f, g: g, next: 0 };
  }

  function windStop() {
    if (!wind) return;
    var w = wind, t = ctx.currentTime;
    wind = null;
    setP(w.g.gain, 0, t, 0.12);
    try { w.src.stop(t + 0.7); } catch (e) { /* ignore */ }
    onEnd(w.src, function () { try { w.g.disconnect(); } catch (e) { /* ignore */ } });
  }

  function updateWind(p) {
    if (!wind) return;
    if (mode !== 'play' || !p || p.dead || !(p.featherT > 0)) { windStop(); return; }
    var t = ctx.currentTime;
    if (t < wind.next) return;
    wind.next = t + 0.1;   // a few param updates per second is plenty
    var speed = Math.min(8, Math.abs(p.vx || 0) + Math.abs(p.vy || 0));
    setP(wind.f.frequency, 600 + speed * 140, t, 0.12);
  }

  // ---------------------------------------------------------------- SFX, one per event type

  var SFX = {};

  SFX.jump = function (e) {
    var stage = stageOf(e.stage), t, v;
    if (e.clarity) {
      // Clean and precise: a short straight blip.
      v = voice('jump', 0.15);
      if (!v) return;
      tone(v, { type: 'square', fs: [[0, 520], [0.07, 880]], a: 0.003, d: 0.1, peak: 0.045, lp: 2600 });
      tone(v, { type: 'sine', fs: [[0, 520], [0.07, 880]], a: 0.003, d: 0.12, peak: 0.1 });
      return;
    }
    // Drunk: pitch rises with the stage, the glide overshoots and droops, with a growing wobble.
    var base = 230 * Math.pow(2, (stage - 1) * 3 / 12);
    var d = 0.18 + stage * 0.03;
    v = voice('jump', d);
    if (!v) return;
    t = v.t;
    tone(v, { type: 'triangle', fs: [[0, base], [0.06, base * 2.1], [d, base * 1.6]], t: t, a: 0.004, d: d, peak: 0.16,
              vib: { rate: 6 + stage * 1.5, cents: 20 + stage * 22 } });
    tone(v, { type: 'sine', fs: [[0, base * 0.5], [0.08, base]], t: t, a: 0.004, d: 0.12, peak: 0.08 });
  };

  SFX.land = function (e) {
    var drop = +e.drop;
    if (!isFinite(drop)) drop = 0;
    var k = clamp(0.3 + Math.max(0, drop) / 7, 0.3, 1);   // a bigger drop → a heavier thud
    var v = voice('land', 0.3, { max: 1 });
    if (!v) return;
    tone(v, { type: 'sine', fs: [[0, 150 + 40 * k], [0.09 + 0.05 * k, 45]], a: 0.002, d: 0.12 + 0.12 * k, peak: 0.06 + 0.26 * k });
    noise(v, { type: 'lowpass', f: 500 + 900 * k, f2: 200, a: 0.002, d: 0.08 + 0.1 * k, peak: 0.12 * k });
  };

  SFX.bonk = function () {
    var v = voice('bonk', 0.15, { max: 1 });
    if (!v) return;
    tone(v, { type: 'square', fs: [[0, 330], [0.06, 160]], a: 0.002, d: 0.09, peak: 0.07, lp: 1800 });
    tone(v, { type: 'sine', fs: [[0, 180], [0.08, 70]], a: 0.002, d: 0.1, peak: 0.2 });
  };

  // First note of the stageUp motif for a stage (D4: the fifth of the bloom chord).
  function motifRoot(stage) { return stage >= 4 ? 81 : MOTIF[clamp(stage - 1, 0, 2)]; }

  // Take-off (every drunk jump now): a quiet breath that glides up into the note the landing will play.
  SFX.stageWarn = function (e) {
    var v = voice('stageWarn', 0.25, { max: 1, gap: 0.1 });
    if (!v) return;
    var r = motifRoot(stageOf(e.stage));
    tone(v, { type: 'sine', fs: [[0, mtof(r - 5)], [0.14, mtof(r)]], t: v.t + 0.03, a: 0.06, d: 0.18, peak: 0.028,
              vib: { rate: 7, cents: 15 } });
  };

  // Landing on a new stage (fires on every jump until D4): a soft three-note arpeggio that starts one
  // scale step higher per stage (D1 = D F# A, D2 = E G B, D3 = F# A C#) and wobbles more when drunker.
  // Short, soft attacks and one voice (a new stage-up replaces the old), so a hop streak never piles up.
  SFX.stageUp = function (e) {
    var stage = stageOf(e.stage);
    if (stage >= 4) { peakBloom(); return; }
    var v = voice('stageUp', 0.5, { max: 1, echo: 0.18 });
    if (!v) return;
    var r = clamp(stage - 1, 0, 2);
    var notes = [MOTIF[r], MOTIF[r + 2], MOTIF[r + 4]];
    for (var i = 0; i < notes.length; i++) {
      var last = i === notes.length - 1, tt = v.t + i * 0.055;
      tone(v, { type: 'triangle', f: mtof(notes[i]), t: tt, a: 0.012, d: last ? 0.3 : 0.13, peak: last ? 0.07 : 0.05,
                vib: last ? { rate: 4 + stage * 1.5, cents: 6 + stage * 8 } : null, pan: (i - 1) * 0.25 });
      tone(v, { type: 'sine', f: mtof(notes[i] + 12), t: tt, a: 0.008, d: last ? 0.22 : 0.09, peak: 0.016 });
    }
    // A low bubbly scoop under the motif: the drunk "blorp".
    var lo = mtof(notes[0] - 24);
    tone(v, { type: 'sine', fs: [[0, lo * 0.8], [0.08, lo]], t: v.t, a: 0.006, d: 0.16, peak: 0.08 });
  };

  // Reaching D4: a shimmering Dmaj9 bloom (strummed detuned pairs through a fast tremolo), glitter on
  // top and a soft low swell under it. Played once per climb (stage-ups stop at D4).
  function peakBloom() {
    var v = voice('stageUp', 1.3, { max: 1, prio: 2, echo: 0.3 });
    if (!v) return;
    var t = v.t, end = t + 1.3;
    var trem = ctx.createGain();
    trem.gain.value = 0.7;
    trem.connect(v.out);
    var lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = 9.5;
    lg.gain.value = 0.3;
    lfo.connect(lg);
    lg.connect(trem.gain);
    lfo.start(t);
    lfo.stop(end);
    track(v, lfo, end);
    var chord = [62, 69, 76, 78, 85, 90];   // D4 A4 E5 F#5 C#6 F#6
    for (var i = 0; i < chord.length; i++) {
      var f = mtof(chord[i]), tt = t + i * 0.024;
      tone(v, { type: 'triangle', f: f, t: tt, a: 0.03, hold: 0.25, d: 1.0, peak: 0.02, detune: -11, to: trem });
      tone(v, { type: 'sine', f: f, t: tt, a: 0.03, hold: 0.25, d: 1.0, peak: 0.016, detune: 12, to: trem, vib: { rate: 5, cents: 18 } });
    }
    var glitter = [98, 102, 105, 109, 110];
    for (var j = 0; j < glitter.length; j++) {
      tone(v, { type: 'sine', f: mtof(glitter[j]), t: t + 0.12 + j * 0.045, a: 0.004, d: 0.35, peak: 0.014, pan: -0.5 + j * 0.25 });
    }
    noise(v, { type: 'highpass', f: 6500, t: t, a: 0.06, d: 0.55, peak: 0.03 });
    tone(v, { type: 'sine', fs: [[0, 82], [0.5, 55]], t: t, a: 0.01, d: 0.6, peak: 0.1 });
  }

  SFX.stageDown = function () {
    var v = voice('stageDown', 0.7, { max: 1 });
    if (!v) return;
    noise(v, { type: 'bandpass', f: 1100, f2: 500, q: 0.8, a: 0.12, d: 0.55, peak: 0.12 });
    tone(v, { type: 'sine', fs: [[0, 520], [0.5, 330]], a: 0.08, d: 0.5, peak: 0.04 });
  };

  SFX.focusOn = function () {
    var v = voice('focusOn', 1.6, { max: 1, echo: 0.3 });
    if (!v) return;
    var t = v.t;
    // Glassy whoosh up, then a ring of inharmonic partials.
    noise(v, { type: 'bandpass', f: 400, f2: 6000, fT: 0.18, q: 2.5, t: t, a: 0.12, d: 0.3, peak: 0.14 });
    bell(v, 1318.5, t + 0.06, [[1, 0.09, 1.4], [2.32, 0.045, 0.9], [4.25, 0.025, 0.6], [6.63, 0.012, 0.4]]);
  };

  SFX.focusWarn = function () {
    var v = voice('focusWarn', 0.3, { max: 1 });
    if (!v) return;
    for (var i = 0; i < 3; i++) {
      tone(v, { type: 'triangle', f: 3000 + i * 400, t: v.t + i * 0.07, a: 0.001, d: 0.035, peak: 0.14 });
    }
  };

  // "Бульк": a few rising bubbles over a low gulp.
  SFX.focusOff = function (e) {
    var v = voice('focusOff', 0.4, { max: 1 });
    if (!v) return;
    var t = v.t, n = e.early ? 2 : 3;
    tone(v, { type: 'sine', fs: [[0, 180], [0.12, 90]], t: t, a: 0.004, d: 0.14, peak: 0.08 });
    for (var i = 0; i < n; i++) {
      var f0 = 260 + ((i * 7) % 3) * 90;
      tone(v, { type: 'sine', fs: [[0, f0], [0.05, f0 * 3.2]], t: t + i * 0.07, a: 0.003, d: 0.08, peak: 0.16 - i * 0.03 });
    }
  };

  SFX.focusReady = function () {
    var v = voice('focusReady', 0.9, { max: 1, echo: 0.25 });
    if (!v) return;
    tone(v, { type: 'sine', f: mtof(88), a: 0.005, d: 0.6, peak: 0.1 });
    tone(v, { type: 'sine', f: mtof(95), t: v.t + 0.07, a: 0.005, d: 0.7, peak: 0.075 });
  };

  SFX.focusDenied = function () {
    var v = voice('focusDenied', 0.1, { max: 1, gap: 0.05 });
    if (!v) return;
    noise(v, { type: 'lowpass', f: 900, a: 0.001, d: 0.04, peak: 0.18 });
    tone(v, { type: 'square', f: 110, a: 0.001, d: 0.06, peak: 0.06, lp: 600 });
  };

  SFX.cast = function (e) {
    var v, t;
    if (e.spell === 'blink') {
      // Zap: a fast downward sweep panned along the blink, then a pop on arrival.
      var dir = (+e.x || 0) >= (+e.fromX || 0) ? 1 : -1;
      v = voice('cast', 0.3, { max: 1, pan: [-0.4 * dir, 0.4 * dir, 0.12] });
      if (!v) return;
      t = v.t;
      tone(v, { type: 'sawtooth', fs: [[0, 2400], [0.13, 180]], t: t, a: 0.002, d: 0.15, peak: 0.12, lp: 5000 });
      tone(v, { type: 'square', fs: [[0, 1200], [0.1, 90]], t: t, a: 0.002, d: 0.12, peak: 0.06, lp: 3000, detune: 15 });
      noise(v, { type: 'highpass', f: 3000, t: t, a: 0.001, d: 0.08, peak: 0.1 });
      tone(v, { type: 'sine', fs: [[0, 300], [0.04, 900]], t: t + 0.1, a: 0.003, d: 0.08, peak: 0.15 });
    } else if (e.spell === 'levitate') {
      v = voice('cast', 0.4, { max: 1 });
      if (!v) return;
      noise(v, { type: 'bandpass', f: 350, f2: 3500, fT: 0.25, q: 3, a: 0.03, d: 0.35, peak: 0.28 });
      tone(v, { type: 'sine', fs: [[0, 280], [0.22, 1100]], a: 0.01, d: 0.3, peak: 0.13, vib: { rate: 20, cents: 30 } });
      tone(v, { type: 'triangle', fs: [[0, 560], [0.22, 2200]], a: 0.01, d: 0.25, peak: 0.05 });
    } else {
      // Feather: an airy shimmer, then the wind loop for as long as the feather lasts.
      v = voice('cast', 0.8, { max: 1, echo: 0.35 });
      if (!v) return;
      var notes = [86, 90, 93, 98, 93, 97];
      for (var i = 0; i < notes.length; i++) {
        tone(v, { type: 'sine', f: mtof(notes[i]), t: v.t + i * 0.055, a: 0.01, d: 0.45, peak: 0.055 });
      }
      noise(v, { type: 'highpass', f: 5000, a: 0.08, d: 0.6, peak: 0.055 });
      windStart();
    }
  };

  SFX.fizzle = function () {
    var v = voice('fizzle', 0.25, { max: 1, gap: 0.05 });
    if (!v) return;
    noise(v, { type: 'lowpass', f: 1800, f2: 250, a: 0.005, d: 0.22, peak: 0.16 });
    tone(v, { type: 'triangle', fs: [[0, 420], [0.18, 210]], a: 0.005, d: 0.2, peak: 0.05 });
  };

  SFX.hiccupWarn = function () {
    // An inhale that swells over the whole warning and cuts just before the hiccup.
    var wd = clamp(+((MW.P && MW.P.hiccupWarn) || 0.8) || 0.8, 0.1, 3);
    var v = voice('hiccupWarn', wd + 0.1, { max: 1 });
    if (!v) return;
    noise(v, { type: 'bandpass', f: 500, f2: 1800, fT: wd, q: 1.2, a: wd * 0.85, d: wd + 0.05, peak: 0.17 });
    tone(v, { type: 'sine', fs: [[0, 300], [wd, 520]], a: wd * 0.85, d: wd + 0.05, peak: 0.035 });
  };

  // "Ик": a squeaky glide through an "i" formant, ending in a tiny "k" click.
  SFX.hiccup = function () {
    var v = voice('hiccup', 0.2, { max: 1 });
    if (!v) return;
    var t = v.t, flt = vfilter(v, 'bandpass', 2600, 5);
    tone(v, { type: 'sawtooth', fs: [[0, 520], [0.035, 980], [0.1, 760]], t: t, a: 0.003, d: 0.12, peak: 0.35, to: flt });
    tone(v, { type: 'sine', fs: [[0, 1050], [0.04, 1900], [0.1, 1500]], t: t, a: 0.003, d: 0.11, peak: 0.1 });
    noise(v, { type: 'highpass', f: 2500, t: t + 0.09, a: 0.001, d: 0.025, peak: 0.08 });
  };

  // Falling into the abyss: wind rushing past (band-passed noise sweeping down) with a sinking whistle,
  // then a dull, muffled thud far below (no click, no crunch) that echoes once in the void.
  // Timed to land just before the respawn (respawnDelay 0.35 s).
  function pitFall() {
    var v = voice('death', 0.8, { max: 1, prio: 2, echo: 0.22 });
    if (!v) return;
    var t = v.t;
    noise(v, { type: 'bandpass', f: 2400, f2: 260, fT: 0.3, q: 1.4, t: t, a: 0.025, hold: 0.14, d: 0.34, peak: 0.24 });
    noise(v, { type: 'lowpass', f: 900, f2: 200, fT: 0.3, t: t, a: 0.05, d: 0.32, peak: 0.1 });
    tone(v, { type: 'sine', fs: [[0, 1250], [0.28, 170]], t: t, a: 0.012, d: 0.3, peak: 0.06, vib: { rate: 11, cents: 30 } });
    var th = t + 0.29;
    tone(v, { type: 'sine', fs: [[0, 92], [0.16, 36]], t: th, a: 0.006, d: 0.34, peak: 0.34 });
    tone(v, { type: 'triangle', fs: [[0, 140], [0.1, 60]], t: th, a: 0.004, d: 0.14, peak: 0.07, lp: 300 });
    noise(v, { type: 'lowpass', f: 380, f2: 90, t: th, a: 0.004, d: 0.22, peak: 0.2 });
  }

  // Crunchy pop through the shared bit-crunch shaper, plus a hint of the cause. Pits have their own sound.
  SFX.death = function (e) {
    if (e.cause === 'pit') { pitFall(); return; }
    var v = voice('death', 0.6, { max: 1, prio: 2, to: N.crunch });
    if (!v) return;
    var t = v.t;
    noise(v, { type: 'bandpass', f: 1500, f2: 300, q: 0.9, t: t, a: 0.001, d: 0.25, peak: 0.35 });
    tone(v, { type: 'square', fs: [[0, 320], [0.18, 55]], t: t, a: 0.001, d: 0.22, peak: 0.12, lp: 2500 });
    tone(v, { type: 'sine', fs: [[0, 900], [0.04, 120]], t: t, a: 0.001, d: 0.06, peak: 0.25 });
    if (e.cause === 'spikes') {
      tone(v, { type: 'triangle', f: 2600, t: t, a: 0.001, d: 0.09, peak: 0.06 });
    } else if (e.cause === 'saw') {
      tone(v, { type: 'sawtooth', f: 190, t: t, a: 0.002, d: 0.25, peak: 0.07, lp: 2200, vib: { rate: 35, cents: 120 } });
    }
  };

  SFX.respawn = function () {
    var v = voice('respawn', 0.45, { max: 1 });
    if (!v) return;
    var t = v.t;
    noise(v, { type: 'bandpass', f: 2200, f2: 700, q: 1.2, t: t, a: 0.01, d: 0.3, peak: 0.12 });
    tone(v, { type: 'sine', fs: [[0, 400], [0.15, 800]], t: t, a: 0.02, d: 0.25, peak: 0.06 });
    tone(v, { type: 'triangle', f: mtof(86), t: t + 0.08, a: 0.005, d: 0.3, peak: 0.03 });
  };

  SFX.restart = function () {
    var v = voice('restart', 0.2, { max: 1 });
    if (!v) return;
    tone(v, { type: 'square', fs: [[0, 900], [0.05, 300], [0.12, 1300]], a: 0.002, d: 0.14, peak: 0.1, lp: 2800 });
    noise(v, { type: 'bandpass', f: 3000, f2: 800, fT: 0.06, q: 2, a: 0.002, d: 0.08, peak: 0.08 });
  };

  // Ding-dong bell; checkpoints are dense, so it stays soft.
  SFX.checkpoint = function () {
    var v = voice('checkpoint', 1.8, { max: 1, echo: 0.3 });
    if (!v) return;
    var parts = [[0.5, 0.04, 1.2], [1, 0.1, 1.6], [2, 0.05, 1.0], [2.76, 0.04, 0.8], [5.4, 0.02, 0.4]];
    bell(v, mtof(81), v.t, parts, 0.8);
    bell(v, mtof(88), v.t + 0.13, parts, 0.5);
  };

  SFX.crumble = function () {
    var v = voice('crumble', 0.25, { max: 2, gap: 0.03 });   // several tiles in one frame → one crack
    if (!v) return;
    var t = v.t;
    noise(v, { type: 'highpass', f: 1800, t: t, a: 0.001, d: 0.05, peak: 0.18 });
    noise(v, { type: 'bandpass', f: 900, f2: 300, q: 1.5, t: t + 0.02, a: 0.002, d: 0.2, peak: 0.12 });
    tone(v, { type: 'sine', fs: [[0, 120], [0.15, 50]], t: t, a: 0.002, d: 0.18, peak: 0.12 });
  };

  // Not a world event: played by update() when a crumbling tile is first stepped on.
  function creak() {
    var v = voice('creak', 0.25, { max: 1, gap: 0.08 });
    if (!v) return;
    tone(v, { type: 'sawtooth', fs: [[0, 140], [0.18, 110]], a: 0.01, d: 0.2, peak: 0.04, lp: 900, vib: { rate: 30, cents: 60 } });
  }

  SFX.pickup = function (e) {
    var v;
    if (e.kind === 'crystal') {
      v = voice('pickup', 0.45, { max: 2, echo: 0.3 });
      if (!v) return;
      var notes = [96, 100, 103, 108];
      for (var i = 0; i < notes.length; i++) {
        tone(v, { type: 'triangle', f: mtof(notes[i]), t: v.t + i * 0.035, a: 0.002, d: 0.3, peak: 0.08 });
      }
      noise(v, { type: 'highpass', f: 7000, a: 0.01, d: 0.25, peak: 0.06 });
    } else {
      // Mushroom: a two-part gulp (the stageUp blorp follows on its own).
      v = voice('pickup', 0.3, { max: 2 });
      if (!v) return;
      tone(v, { type: 'sine', fs: [[0, 480], [0.09, 170]], a: 0.004, d: 0.11, peak: 0.2 });
      tone(v, { type: 'sine', fs: [[0, 380], [0.09, 140]], t: v.t + 0.1, a: 0.004, d: 0.12, peak: 0.18 });
      noise(v, { type: 'lowpass', f: 600, a: 0.002, d: 0.06, peak: 0.05 });
    }
  };

  // Detuned saw pair through an opening lowpass: a soft synth brass note.
  function brass(v, m, t, len, peak) {
    var flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.Q.value = 1.5;
    flt.frequency.setValueAtTime(500, t);
    flt.frequency.exponentialRampToValueAtTime(3200, t + 0.06);
    flt.frequency.exponentialRampToValueAtTime(1400, t + len + 0.2);
    flt.connect(v.out);
    var f = mtof(m);
    tone(v, { type: 'sawtooth', f: f, t: t, a: 0.03, hold: len, d: len + 0.25, peak: peak, detune: -6, to: flt });
    tone(v, { type: 'sawtooth', f: f, t: t, a: 0.03, hold: len, d: len + 0.25, peak: peak * 0.8, detune: 7, to: flt,
              vib: len > 0.5 ? { rate: 5, cents: 8 } : null });
  }

  SFX.finish = function () {
    var v = voice('finish', 3.5, { max: 1, prio: 3, echo: 0.3 });
    if (!v) return;
    var t = v.t + 0.05;
    brass(v, 74, t, 0.12, 0.07);           // D5
    brass(v, 78, t + 0.14, 0.12, 0.07);    // F#5
    brass(v, 81, t + 0.28, 0.12, 0.07);    // A5
    brass(v, 86, t + 0.44, 1.5, 0.08);     // D6, held
    brass(v, 78, t + 0.44, 1.5, 0.035);    // harmony
    brass(v, 69, t + 0.44, 1.5, 0.035);
    tone(v, { type: 'sine', fs: [[0, 95], [0.3, 62]], t: t, a: 0.003, d: 0.4, peak: 0.2 });          // timpani
    tone(v, { type: 'sine', fs: [[0, 95], [0.5, 60]], t: t + 0.44, a: 0.003, d: 0.9, peak: 0.25 });
    noise(v, { type: 'lowpass', f: 400, t: t + 0.44, a: 0.002, d: 0.3, peak: 0.08 });
    var sparkle = [98, 102, 105, 110];
    for (var i = 0; i < sparkle.length; i++) {
      tone(v, { type: 'triangle', f: mtof(sparkle[i]), t: t + 0.5 + i * 0.05, a: 0.002, d: 0.5, peak: 0.03 });
    }
    var padNotes = [62, 66, 69];            // D major pad under the held note
    for (var j = 0; j < padNotes.length; j++) {
      tone(v, { type: 'sine', f: mtof(padNotes[j]), t: t + 0.44, a: 0.3, hold: 1.4, d: 2.6, peak: 0.04 });
    }
  };

  // ---------------------------------------------------------------- graph

  function gainNode(value, dest) {
    var g = ctx.createGain();
    g.gain.value = value;
    if (dest) g.connect(dest);
    return g;
  }

  function filterNode(type, f, q, dest) {
    var flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = f;
    flt.Q.value = q;
    if (dest) flt.connect(dest);
    return flt;
  }

  function compressorNode(threshold, knee, ratio, attack, release, dest) {
    var c = ctx.createDynamicsCompressor();
    c.threshold.value = threshold;
    c.knee.value = knee;
    c.ratio.value = ratio;
    c.attack.value = attack;
    c.release.value = release;
    c.connect(dest);
    return c;
  }

  // Feedback delay: input -> delay -> (lowpass -> feedback -> delay) and delay -> wet -> dest.
  function echoNode(time, feedback, damp, wet, dest) {
    var input = gainNode(1);
    var dl = ctx.createDelay(2);
    dl.delayTime.value = time;
    var fbF = filterNode('lowpass', damp, 0.5);
    var fb = gainNode(feedback);
    input.connect(dl);
    dl.connect(fbF);
    fbF.connect(fb);
    fb.connect(dl);
    dl.connect(gainNode(wet, dest));
    return input;
  }

  function build() {
    // Master: gentle glue compressor -> makeup gain -> limiter -> master volume / mute -> soft clip.
    // (WebAudio compressors add their own automatic makeup gain, so the limiter alone can overshoot
    // a little; the soft clipper is the hard ceiling and is transparent below -2 dBFS.)
    N.clip = ctx.createWaveShaper();
    var cn = 2048, clipCurve = new Float32Array(cn);
    for (var ci = 0; ci < cn; ci++) {
      var cx = ci / (cn - 1) * 2 - 1, ax = Math.abs(cx);
      clipCurve[ci] = ax < 0.8 ? cx : (cx < 0 ? -1 : 1) * (0.8 + 0.17 * Math.tanh((ax - 0.8) / 0.17));
    }
    N.clip.curve = clipCurve;
    N.clip.oversample = 'none';
    N.clip.connect(ctx.destination);
    N.master = gainNode(0, N.clip);
    N.limiter = compressorNode(-4, 0, 20, 0.002, 0.1, N.master);
    N.comp = compressorNode(-18, 12, 3, 0.005, 0.25, gainNode(MAKEUP, N.limiter));

    // Music chain.
    N.musicBus = gainNode(0, N.comp);
    N.musicDuck = gainNode(0.5, N.musicBus);
    N.musicFilter = filterNode('lowpass', CUTOFF[1], 1, N.musicDuck);
    N.musicIn = gainNode(1, N.musicFilter);
    N.musicSend = gainNode(1, N.musicIn);
    N.musicSend.connect(echoNode(STEP * 3, 0.38, 2200, 0.32, N.musicFilter));   // dotted-8th echo
    N.padIn = filterNode('lowpass', 1800, 0.5, N.musicIn);

    // Slow filter sweep (Hz added to the cutoff), deeper and faster with the stage; 0 in Clarity.
    N.sweepLfo = ctx.createOscillator();
    N.sweepLfo.frequency.value = SWEEP_RATE[1];
    N.sweepDepth = gainNode(0, N.musicFilter.frequency);
    N.sweepLfo.connect(N.sweepDepth);
    N.sweepLfo.start();

    // Stage layers: a dry bus (-> musicIn) and a wet bus (-> musicSend, echoed), moved together.
    // The peak layer's dry bus shimmers through a 16th-note tremolo.
    N.peakTrem = gainNode(0.72, N.musicIn);
    N.tremLfo = ctx.createOscillator();
    N.tremLfo.frequency.value = 1 / STEP;
    N.tremLfo.connect(gainNode(0.28, N.peakTrem.gain));
    N.tremLfo.start();
    N.layers = {};
    for (var li = 0; li < LAYERS.length; li++) {
      var name = LAYERS[li];
      N.layers[name] = { dry: gainNode(0, name === 'peak' ? N.peakTrem : N.musicIn), wet: gainNode(0, N.musicSend) };
    }

    // Pitch wobble: two slow LFOs (plus an optional bend offset) summed into a detune bus that every
    // music oscillator listens to.
    N.detuneBus = gainNode(1);
    N.lfoDepth = gainNode(0, N.detuneBus);
    N.lfo1 = ctx.createOscillator();
    N.lfo1.frequency.value = LFO_RATE[1];
    N.lfo1.connect(N.lfoDepth);
    N.lfo2 = ctx.createOscillator();
    N.lfo2.frequency.value = LFO_RATE[1] * 1.618;
    N.lfo2.connect(gainNode(0.5, N.lfoDepth));
    N.lfo1.start();
    N.lfo2.start();
    if (ctx.createConstantSource) {
      N.bend = ctx.createConstantSource();
      N.bend.offset.value = 0;
      N.bend.connect(N.detuneBus);
      N.bend.start();
    }

    // SFX chain.
    N.sfxBus = gainNode(0, N.comp);
    N.sfxIn = gainNode(1, N.sfxBus);
    N.tickGate = gainNode(0, N.sfxIn);
    N.sfxEcho = echoNode(0.23, 0.28, 3000, 0.45, N.sfxIn);
    N.crunch = ctx.createWaveShaper();
    var n = 512, shape = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = i / (n - 1) * 2 - 1, y = Math.tanh(x * 2.5);
      shape[i] = Math.round(y * 7) / 7 * 0.6 + y * 0.4;   // soft clip with coarse steps: crunchy
    }
    N.crunch.curve = shape;
    N.crunch.oversample = 'none';
    N.crunch.connect(gainNode(0.45, N.sfxIn));

    // Shared noise: 2 s of white noise, looped with random offsets.
    var len = Math.floor(ctx.sampleRate * 2);
    N.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = N.noise.getChannelData(0);
    for (var k = 0; k < len; k++) data[k] = Math.random() * 2 - 1;
  }

  function applyVolumes(immediate) {
    if (!ready) return;
    var t = ctx.currentTime;
    var targets = [
      [N.master.gain, vol.muted ? 0 : curve(vol.master)],
      [N.musicBus.gain, curve(vol.music) * MUSIC_TRIM],
      [N.sfxBus.gain, curve(vol.sfx) * SFX_TRIM],
    ];
    for (var i = 0; i < targets.length; i++) {
      var p = targets[i][0], v = targets[i][1];
      if (immediate) {
        try { p.cancelScheduledValues(t); p.setValueAtTime(v, t); } catch (e) { p.value = v; }
      } else {
        setP(p, v, t, VOL_TC);
      }
    }
  }

  function resume() {
    if (!ctx || hiddenSuspended) return;
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      try { settle(ctx.resume()); } catch (e) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- public API

  function init() {
    if (disabled) return;
    if (ctx) { resume(); return; }
    var AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) { disabled = true; return; }
    try {
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
      build();
      ready = true;
    } catch (err) {
      ready = false;
      disabled = true;
      try { if (ctx && ctx.close) settle(ctx.close()); } catch (e) { /* ignore */ }
      ctx = null;
      throw err;   // reported once by safe()
    }
    resume();
    applyVolumes(true);
    applyMusic();
    if (mode !== 'finished') musicStart();
    scheduler();
    // A timer keeps the music going while frames stall (update() alone would leave gaps).
    if (typeof setInterval !== 'undefined') {
      setInterval(function () { try { scheduler(); } catch (e) { /* ignore */ } }, TIMER_MS);
    }
  }

  function setVolumes(s) {
    s = s || MW.settings || {};
    vol.master = unit(s.master, vol.master);
    vol.music = unit(s.music, vol.music);
    vol.sfx = unit(s.sfx, vol.sfx);
    vol.muted = !!s.muted;
    if (!ready) return;   // stored; init() applies it
    applyVolumes(false);
    if (!sfxAudible()) windStop();
  }

  function handle(e, world) {
    if (!ready || !e || !e.type) return;
    var t = ctx.currentTime;
    switch (e.type) {
      case 'featherEnd': windStop(); break;
      // The music sinks on death; deeper and slower when falling into the abyss.
      case 'death': windStop(); kill('hiccupWarn'); bend(e.cause === 'pit' ? -700 : -300, e.cause === 'pit' ? 0.25 : 0.15); break;
      case 'respawn': case 'restart': kill('hiccupWarn'); bend(0, 0.05); break;
      case 'focusOn': kill('hiccupWarn'); break;
      case 'stageUp': {
        // A short upward lurch of the whole mix; D4 swoops higher and settles slower (seasick).
        var up = stageOf(e.stage);
        if (e.debug && up < ms.stage) break;
        bend(10 + 8 * up, 0.02);
        bend(0, up >= 4 ? 0.3 : 0.12, t + 0.1);
        break;
      }
    }
    var fn = SFX[e.type];
    // Debug stage keys emit stageUp even when lowering the stage (ms.stage is still the old one here).
    if (e.type === 'stageUp' && e.debug && stageOf(e.stage) < ms.stage) fn = SFX.stageDown;
    if (fn && sfxAudible()) fn(e, world);
  }

  function update(world, dt, m) {
    if (!ready) return;
    if (typeof m === 'string' && m !== mode) setMode(m);   // in case onMode() was missed
    var p = world && world.player;
    if (p) {
      ms.stage = stageOf(p.stage);
      ms.dead = !!p.dead;
      ms.clarity = !!p.clarity && !p.dead;
      var warnT = (MW.P && isFinite(+MW.P.clarityWarn)) ? +MW.P.clarityWarn : 1;
      ms.warn = ms.clarity && p.clarityT <= warnT;
    }
    scheduler();
    applyMusic();
    updateTicks();
    updateWind(p);
    // A creak the first time a crumbling tile is stepped on (the crack itself is the crumble event).
    var cr = world && world.level && world.level.crumbling;
    if (cr) {
      var seen = {};
      for (var k in cr) {
        seen[k] = true;
        if (!crumbleSeen[k] && mode === 'play') creak();
      }
      crumbleSeen = seen;
    }
    prune(ctx.currentTime);
  }

  // title: quieter, drumless loop; play: full loop; paused: ducked; finished: loop stops (the
  // fanfare comes from the finish event).
  function setMode(m) {
    mode = m;
    if (!ready) return;
    if (m === 'finished') musicStop();
    else musicStart();
    if (m !== 'play') windStop();
    applyMusic();
  }

  function onMode(m) {
    if (typeof m === 'string') setMode(m);
  }

  function reset() {
    crumbleSeen = {};
    tick.next = 0;
    ms.clarity = false;
    ms.warn = false;
    ms.dead = false;
    if (!ready) return;
    windStop();
    kill('hiccupWarn');
    bend(0, 0.05);
  }

  // Extra (not in the contract): a soft chime for a settings screen to preview the SFX volume.
  function preview() {
    if (!ready || !sfxAudible()) return;
    var v = voice('preview', 0.8, { max: 1, gap: 0.15 });
    if (!v) return;
    tone(v, { type: 'sine', f: mtof(88), a: 0.005, d: 0.6, peak: 0.08 });
    tone(v, { type: 'sine', f: mtof(95), t: v.t + 0.07, a: 0.005, d: 0.7, peak: 0.06 });
  }

  // Wraps a public method: it never throws, and reports its first error once.
  function safe(name, fn) {
    return function () {
      try {
        return fn.apply(null, arguments);
      } catch (err) {
        if (!warned[name]) {
          warned[name] = true;
          try { console.warn('MW.Audio.' + name + ' failed:', err); } catch (e) { /* ignore */ }
        }
      }
    };
  }

  // Any user gesture can unlock audio (so the title music starts on the first click), and audio is
  // suspended while the tab is hidden (the game loop stops then too).
  if (typeof window !== 'undefined' && window.addEventListener) {
    var unlock = safe('init', init);
    ['pointerdown', 'keydown', 'touchend'].forEach(function (name) {
      window.addEventListener(name, unlock, true);
    });
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', safe('visibility', function () {
      if (!ctx) return;
      if (document.hidden) {
        if (ctx.state === 'running') { hiddenSuspended = true; settle(ctx.suspend()); }
      } else if (hiddenSuspended) {
        hiddenSuspended = false;
        resume();
      }
    }));
  }

  return {
    init: safe('init', init),
    setVolumes: safe('setVolumes', setVolumes),
    handle: safe('handle', handle),
    update: safe('update', update),
    onMode: safe('onMode', onMode),
    reset: safe('reset', reset),
    preview: safe('preview', preview),
    isReady: function () { return ready; },
  };
})();
