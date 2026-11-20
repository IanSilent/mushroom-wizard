// Mushroom Wizard — tunable parameters.
// Units: tiles (1 tile = 32 px) and seconds. Y axis points DOWN (screen space).
// Per-stage arrays are indexed by state: [0] = Clarity (sober), [1..4] = drunk stages D1..D4.
var MW = MW || {};

MW.TILE = 32;
MW.DT = 1 / 120; // fixed simulation step
MW.PLAYER_W = 0.7;
MW.PLAYER_H = 1.4;

// [group, key, default, min, max, step, label]
MW.PARAMS_DEF = [
  ['Прыжок', 'jumpH', [3, 4, 5, 6, 7], 1, 12, 0.1, 'Высота прыжка (тайлы)'],
  ['Прыжок', 'jumpT', [0.38, 0.46, 0.52, 0.58, 0.64], 0.2, 1.2, 0.01, 'Время до вершины (с)'],
  ['Прыжок', 'minHop', [1.1, 1.8, 2.4, 3.1, 4.0], 0.3, 8, 0.1, 'Минимальный подскок (тайлы)'],
  ['Прыжок', 'fallGravMul', [1.35, 1.0, 1.0, 1.0, 1.0], 0.5, 3, 0.05, 'Множитель гравитации при падении'],
  ['Прыжок', 'apexGravMul', [0.85, 0.6, 0.55, 0.5, 0.45], 0.2, 1, 0.05, 'Гравитация у вершины («плавание»)'],
  ['Прыжок', 'apexBand', 3.0, 0, 8, 0.1, 'Зона вершины: |скорость| < (т/с)'],
  ['Прыжок', 'maxFall', [20, 17, 17, 17, 17], 5, 40, 0.5, 'Макс. скорость падения (т/с)'],
  ['Прыжок', 'coyote', 0.1, 0, 0.3, 0.01, 'Прыжок после схода с края (с)'],
  ['Прыжок', 'jumpBuffer', 0.1, 0, 0.3, 0.01, 'Буфер нажатия прыжка (с)'],

  ['Бег', 'runSpeed', [7, 8, 8, 8, 8], 2, 16, 0.1, 'Скорость бега (т/с)'],
  ['Бег', 'groundAccel', [70, 40, 38, 36, 34], 5, 200, 1, 'Разгон на земле'],
  ['Бег', 'groundDecel', [90, 32, 24.6, 20, 16], 5, 200, 0.5, 'Торможение на земле (скольжение)'],
  ['Бег', 'airAccel', [50, 24, 22, 20, 18], 2, 150, 1, 'Контроль в воздухе: разгон'],
  ['Бег', 'airDecel', [30, 6, 6, 6, 6], 0, 150, 1, 'Контроль в воздухе: торможение'],

  ['Опьянение', 'jumpsPerStage', 1, 1, 12, 1, 'Прыжков до следующей стадии'],
  ['Опьянение', 'cpSetsStage', 1, 0, 1, 1, 'Чекпоинт задаёт стадию (1) или только повышает (0)'],
  ['Опьянение', 'stagger', [0, 0.8, 1.2, 1.6, 2.0], 0, 6, 0.1, 'Пошатывание: толчок вперёд при прыжке (т/с)'],
  ['Опьянение', 'swayAmp', [0, 0, 0.3, 0.5, 0.6], 0, 2, 0.05, 'Покачивание в прыжке (тайлы)'],
  ['Опьянение', 'swayPeriod', 0.9, 0.3, 3, 0.05, 'Период покачивания (с)'],
  ['Опьянение', 'slipStage', 3, 1, 5, 1, 'Проскальзывание при приземлении: с какой стадии'],
  ['Опьянение', 'slipTime', 0.15, 0, 1, 0.01, 'Проскальзывание: длительность (с)'],
  ['Опьянение', 'slipDrop', 2.0, 0, 10, 0.1, 'Проскальзывание: падение ниже точки прыжка (тайлы)'],
  ['Опьянение', 'hiccupEnabled', 1, 0, 1, 1, 'Икота на D4 (вкл/выкл)'],
  ['Опьянение', 'hiccupPeriod', 4.0, 1, 15, 0.1, 'Икота: период на земле (с)'],
  ['Опьянение', 'hiccupWarn', 0.8, 0.1, 3, 0.05, 'Икота: предупреждение (с)'],
  ['Опьянение', 'hiccupHeight', 1.5, 0.3, 5, 0.1, 'Икота: высота подскока (тайлы)'],

  ['Ясность', 'clarityDur', 2.5, 0.5, 8, 0.1, 'Длительность ясности (с)'],
  ['Ясность', 'clarityWarn', 1.0, 0, 3, 0.1, 'Предупреждение до конца (с)'],
  ['Ясность', 'focusCooldown', 2.0, 0, 10, 0.1, 'Откат фокуса (с)'],
  ['Ясность', 'focusNeedsGround', 0, 0, 1, 1, 'Заряд только после касания земли'],
  ['Ясность', 'castEndsClarity', 1, 0, 1, 1, 'Заклинание сразу завершает Ясность (1) / нет (0)'],
  ['Ясность', 'focusSlowScale', 0.35, 0.05, 1, 0.05, 'Замедление при входе: скорость времени ×'],
  ['Ясность', 'focusSlowDur', 0.4, 0, 2, 0.05, 'Замедление: длительность (с, реальные)'],
  ['Ясность', 'focusSlowEase', 0.5, 0, 1, 0.05, 'Замедление: доля плавного возврата'],
  ['Ясность', 'focusHitstop', 0, 0, 0.3, 0.01, 'Микропауза при входе (с)'],
  ['Ясность', 'focusFallDamp', 0.5, 0, 1, 0.05, 'Скорость падения при входе ×'],

  ['Заклинания', 'blinkDist', 4.0, 1, 10, 0.1, 'Блинк: дистанция (тайлы)'],
  ['Заклинания', 'blinkFloat', 0.08, 0, 0.5, 0.01, 'Блинк: зависание после (с)'],
  ['Заклинания', 'levitateH', 3.5, 0.5, 10, 0.1, 'Взлёт: высота (тайлы)'],
  ['Заклинания', 'levitateT', 0.2, 0.05, 1, 0.01, 'Взлёт: время (с)'],
  ['Заклинания', 'featherFall', 2.0, 0.3, 8, 0.1, 'Пёрышко: скорость падения (т/с)'],
  ['Заклинания', 'featherRun', 5.0, 1, 12, 0.1, 'Пёрышко: скорость вбок (т/с)'],
  ['Заклинания', 'featherAccel', 30, 2, 150, 1, 'Пёрышко: управление вбок'],
  ['Заклинания', 'featherMax', 3.0, 0.5, 10, 0.1, 'Пёрышко: макс. длительность (с)'],

  ['Прочее', 'respawnDelay', 0.35, 0, 2, 0.05, 'Пауза перед возрождением (с)'],
  ['Прочее', 'crumbleDelay', 0.45, 0.05, 3, 0.05, 'Осыпающаяся плитка: задержка (с)'],
  ['Прочее', 'crystalRespawn', 3.0, 0.5, 20, 0.5, 'Кристалл: восстановление (с)'],
];

MW.defaultParams = function () {
  var p = {};
  MW.PARAMS_DEF.forEach(function (d) {
    p[d[1]] = Array.isArray(d[2]) ? d[2].slice() : d[2];
  });
  return p;
};

MW.P = MW.defaultParams();

// Debug / cheat flags (not physics, not persisted between sessions).
MW.CHEATS = { god: false, infiniteClarity: false, overlay: false };

// Derived physics per state index (0 = clarity, 1..4 = D1..D4). Recomputed whenever params change.
MW.derive = function (P) {
  var d = { g: [], v0: [] };
  for (var s = 0; s < 5; s++) {
    var h = P.jumpH[s], t = P.jumpT[s];
    var g = 2 * h / (t * t);
    // Find the take-off speed whose simulated apex (same integrator as the player, including the
    // reduced apex gravity) equals jumpH exactly.
    var lo = 0, hi = 4 * h / t;
    for (var it = 0; it < 40; it++) {
      var mid = (lo + hi) / 2;
      if (MW.simRise(mid, g, P.apexGravMul[s], P.apexBand) < h) lo = mid; else hi = mid;
    }
    d.g[s] = g;
    d.v0[s] = (lo + hi) / 2;
  }
  return d;
};

MW.simRise = function (v0, g, apexMul, apexBand) {
  var vy = -v0, y = 0, top = 0, dt = MW.DT;
  for (var i = 0; i < 4000 && vy < 0; i++) {
    var gg = g;
    if (Math.abs(vy) < apexBand) gg *= apexMul;
    vy += gg * dt;
    y += vy * dt;
    if (-y > top) top = -y;
  }
  return top;
};

MW.D = MW.derive(MW.P);

MW.applyParams = function (obj) {
  if (!obj) return;
  MW.PARAMS_DEF.forEach(function (d) {
    var k = d[1];
    if (obj[k] === undefined) return;
    if (Array.isArray(d[2])) {
      if (Array.isArray(obj[k]) && obj[k].length === d[2].length) MW.P[k] = obj[k].map(Number);
    } else if (typeof obj[k] === 'number') {
      MW.P[k] = obj[k];
    }
  });
  MW.D = MW.derive(MW.P);
};

MW.resetParams = function () {
  MW.P = MW.defaultParams();
  MW.D = MW.derive(MW.P);
};
