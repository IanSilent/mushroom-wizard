#!/usr/bin/env node
// Bundles the game into ONE self-contained HTML file (all CSS and scripts inlined), so it can be
// copied to another computer and opened with a double-click.
// Usage: node tools/build.js   ->  dist/mushroom-wizard.html
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT = path.join(OUT_DIR, 'mushroom-wizard.html');

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// Inline stylesheets.
html = html.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>/g, (m, href) => {
  const css = fs.readFileSync(path.join(ROOT, href), 'utf8');
  return '<style>\n' + css.replace(/<\/style/gi, '<\\/style') + '\n</style>';
});

// Inline scripts. A literal "</script" inside JS would end the inline tag early, so escape it.
let count = 0;
html = html.replace(/<script\s+src="([^"]+)"\s*><\/script>/g, (m, src) => {
  const js = fs.readFileSync(path.join(ROOT, src), 'utf8');
  count++;
  return '<script>/* ' + src + ' */\n' + js.replace(/<\/script/gi, '<\\/script') + '\n</script>';
});

const leftovers = html.match(/<(script|link)[^>]+(src|href)=/gi);
if (leftovers) {
  console.error('External references left in the bundle:', leftovers);
  process.exitCode = 1;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`wrote ${path.relative(ROOT, OUT)}: ${count} scripts inlined, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
