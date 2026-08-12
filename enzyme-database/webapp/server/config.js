'use strict';

const path = require('path');

function loadDotEnv() {
  const fs = require('fs');
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

module.exports = {
  port: Number(process.env.PORT) || 5173,
  incomingDir: process.env.INCOMING_DIR
    ? path.resolve(process.env.INCOMING_DIR)
    : path.join(__dirname, '..', 'data', 'incoming'),
  reportsDir: path.join(__dirname, '..', 'data', 'reports'),
  watchStabilityMs: Number(process.env.WATCH_STABILITY_MS) || 3000,
  watchPollMs: Number(process.env.WATCH_POLL_MS) || 300,
};
