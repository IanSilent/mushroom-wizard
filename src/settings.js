// Player-facing settings (volume, screen FX), persisted in localStorage. Every access is guarded:
// storage may be unavailable (file:// in some browsers, private mode) and the game must still run.
var MW = MW || {};

MW.SETTINGS_KEY = 'mushroomWizard.settings.v1';
MW.PARAMS_KEY = 'mushroomWizard.params.v1';

MW.settings = {
  master: 0.8,   // 0..1
  music: 0.7,    // 0..1
  sfx: 0.8,      // 0..1
  muted: false,
  fx: 0.5,       // screen-effect intensity 0..1 (0.5 = moderate default)
  shake: true,   // screen shake on/off
};

MW.settingsListeners = [];

MW.loadSettings = function () {
  try {
    var raw = window.localStorage.getItem(MW.SETTINGS_KEY);
    if (raw) {
      var s = JSON.parse(raw);
      for (var k in MW.settings) if (s[k] !== undefined && typeof s[k] === typeof MW.settings[k]) MW.settings[k] = s[k];
    }
  } catch (e) { /* storage unavailable: keep defaults */ }
};

MW.saveSettings = function () {
  try { window.localStorage.setItem(MW.SETTINGS_KEY, JSON.stringify(MW.settings)); } catch (e) { /* ignore */ }
  MW.settingsListeners.forEach(function (fn) { try { fn(MW.settings); } catch (e) { console.error(e); } });
};

MW.onSettingsChanged = function (fn) { MW.settingsListeners.push(fn); };

// Tuned movement params saved from the debug panel (only when the player presses "save").
MW.loadSavedParams = function () {
  try {
    var raw = window.localStorage.getItem(MW.PARAMS_KEY);
    if (raw) MW.applyParams(JSON.parse(raw));
  } catch (e) { /* ignore */ }
};

MW.saveParams = function () {
  try { window.localStorage.setItem(MW.PARAMS_KEY, JSON.stringify(MW.P)); return true; } catch (e) { return false; }
};

MW.clearSavedParams = function () {
  try { window.localStorage.removeItem(MW.PARAMS_KEY); } catch (e) { /* ignore */ }
};
