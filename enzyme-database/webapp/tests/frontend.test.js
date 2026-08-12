'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

test('the shipped dashboard HTML does not contain a hard-coded const DATA dataset', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  assert.ok(!/const\s+DATA\s*=/.test(html), 'index.html must not embed const DATA');
  // The old prototype embedded the whole dataset inline; the live version should be small.
  assert.ok(html.length < 60000, 'index.html should be a thin shell, not an embedded dataset');
});

test('app.js fetches data from the backend API rather than embedding it', () => {
  const js = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  assert.ok(!/const\s+DATA\s*=/.test(js));
  assert.ok(js.includes("fetch("), 'app.js must call fetch() against the backend API');
  assert.ok(js.includes('/api/'), 'app.js must reference backend API routes');
  assert.ok(js.includes('WebSocket'), 'app.js must open a WebSocket connection for live updates');
});
