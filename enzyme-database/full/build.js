#!/usr/bin/env node
'use strict';
// Bundles webapp/public/{index.html,styles.css,app.js,vendor/plotly.min.js}
// + vendor/xlsx.full.min.js + full/{ported-server.js,shim.js} + the baseline
// dataset into one self-contained dist/enzyme-database.html -- full feature
// parity with webapp/ (all analysis tabs), zero server, zero external
// requests, works from file://.
//
// Run `node port-server-modules.js` first if webapp/server/ changed.

const fs = require('fs');
const path = require('path');

const root = __dirname; // enzyme-database/full
const dbRoot = path.join(root, '..'); // enzyme-database/
const read = (p) => fs.readFileSync(p, 'utf8');

let html = read(path.join(dbRoot, 'webapp/public/index.html'));
const css = read(path.join(dbRoot, 'webapp/public/styles.css'));
const plotlyJs = read(path.join(dbRoot, 'webapp/public/vendor/plotly.min.js'));
const xlsxJs = read(path.join(dbRoot, 'vendor/xlsx.full.min.js'));
const portedServerJs = read(path.join(root, 'ported-server.js'));
const shimJs = read(path.join(root, 'shim.js'));
const appJs = read(path.join(dbRoot, 'webapp/public/app.js'));

let dataJson = '[]';
const dataPath = path.join(dbRoot, 'src/data.json');
if (fs.existsSync(dataPath)) dataJson = fs.readFileSync(dataPath, 'utf8');

const noScriptClose = (s) => s.replace(/<\/script/gi, '<\\/script');

// 1) Replace the CDN-free-but-still-separate-file plotly <script src> with
//    the vendored content inlined.
html = html.replace(
  '<script src="vendor/plotly.min.js"></script>',
  () => `<script>\n${noScriptClose(plotlyJs)}\n</script>`
);

// 2) Replace the external stylesheet link with an inline <style>.
html = html.replace(
  '<link rel="stylesheet" href="styles.css">',
  () => `<style>\n${css}\n</style>`
);

// 3) Replace the app.js <script src> with: xlsx vendor, ported server logic,
//    the embedded baseline dataset, the browser shim, then app.js itself
//    (unmodified) -- in that exact order, since app.js's boot() runs
//    immediately and needs fetch/XHR/WebSocket already shimmed and the
//    initial dataset already committed.
html = html.replace(
  '<script src="app.js"></script>',
  () => [
    '<script>', noScriptClose(xlsxJs), '</script>',
    '<script>', noScriptClose(portedServerJs), '</script>',
    `<script type="application/json" id="embedded-dataset">${noScriptClose(dataJson)}</script>`,
    '<script>', noScriptClose(shimJs), '</script>',
    '<script>', noScriptClose(appJs), '</script>',
  ].join('\n')
);

const distDir = path.join(dbRoot, 'dist');
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir);
const outPath = path.join(distDir, 'enzyme-database.html');
fs.writeFileSync(outPath, html);
console.log(`Built ${outPath} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
