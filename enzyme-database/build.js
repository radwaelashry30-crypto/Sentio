#!/usr/bin/env node
'use strict';
// Bundles src/index.html + src/styles.css + vendor/xlsx.full.min.js + src/data.json
// + src/app.js into a single self-contained dist/enzyme-database.html — no external
// requests, works by double-clicking the file (file://) or from any static host.

const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const html = read('src/index.html');
const css = read('src/styles.css');
const appJs = read('src/app.js');
const vendorJs = read('vendor/xlsx.full.min.js');

let dataJson = '[]';
const dataPath = path.join(root, 'src/data.json');
if (fs.existsSync(dataPath)) dataJson = fs.readFileSync(dataPath, 'utf8');
// Defensive: a "</script>" substring inside embedded JSON would prematurely
// close the tag when parsed as HTML.
const safeDataJson = dataJson.replace(/<\/script/gi, '<\\/script');
const safeVendorJs = vendorJs.replace(/<\/script/gi, '<\\/script');
const safeAppJs = appJs.replace(/<\/script/gi, '<\\/script');

// Replacement strings are passed as functions, not raw strings: String.replace
// treats "$&", "$1", etc. inside a *string* replacement specially, and the
// vendor bundle's own minified source legitimately contains "$&" substrings
// (e.g. inside its own regex-replace calls) that would otherwise get mangled.
let out = html
  .replace('<!--STYLES-->', () => `<style>\n${css}\n</style>`)
  .replace('<!--VENDOR-->', () => `<script>\n${safeVendorJs}\n</script>`)
  .replace(
    '<!--APP-->',
    () => `<script type="application/json" id="embedded-dataset">${safeDataJson}</script>\n<script>\n${safeAppJs}\n</script>`
  );

const distDir = path.join(root, 'dist');
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir);
const outPath = path.join(distDir, 'enzyme-database.html');
fs.writeFileSync(outPath, out);
console.log(`Built ${outPath} (${(out.length / 1024 / 1024).toFixed(2)} MB)`);
