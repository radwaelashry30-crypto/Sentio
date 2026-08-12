'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('./config');
const store = require('./store');
const { attachWebSocketServer } = require('./ws');
const { startWatcher } = require('./watcher');
const { ingestFile } = require('./ingest/pipeline');
const { generateReport } = require('./reportGenerator');
const { getActiveVersionMeta } = require('./db');

const datasetRoutes = require('./routes/dataset');
const recordsRoutes = require('./routes/records');
const analysisRoutes = require('./routes/analysis');
const uploadRoutes = require('./routes/upload');

const app = express();
app.use(express.json());

app.use('/api/dataset', datasetRoutes);
app.use('/api/records', recordsRoutes);
app.use('/api/analysis', analysisRoutes);
app.use('/api/upload', uploadRoutes);

app.get('/api/reports/:file', (req, res) => {
  const allowed = new Set([
    'report.md', 'report_summary.json', 'records_filtered.csv', 'manual_review.csv', 'audit_log.csv',
  ]);
  const file = req.params.file;
  if (!allowed.has(file) && !/^bivariate_(plant|fungal)_\w+\.csv$/.test(file)) {
    return res.status(404).json({ error: 'Unknown report file' });
  }
  const filePath = path.join(config.reportsDir, file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Report not generated yet' });
  res.sendFile(filePath);
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
attachWebSocketServer(server);

// Regenerate the report bundle after every successful dataset change,
// regardless of whether it came from the watcher or the upload endpoint.
store.on('change', () => {
  try {
    generateReport(store.state, { trigger: 'dataset-change' });
    store.pushActivity('Report bundle regenerated (report.md, report_summary.json, CSV exports).');
  } catch (err) {
    store.pushActivity(`Report generation failed: ${err.message}`);
  }
});

async function bootstrap() {
  fs.mkdirSync(config.incomingDir, { recursive: true });

  const existing = getActiveVersionMeta();
  if (existing) {
    store.hydrateFromDb();
  } else {
    const baselinePath = path.join(__dirname, '..', 'data', 'source', 'List of PTs_20260806_plant and fungal.xlsx');
    if (fs.existsSync(baselinePath)) {
      try {
        const result = await ingestFile(baselinePath, path.basename(baselinePath), (stage) => store.setStage(stage));
        store.applyNewVersion(result);
        store.pushActivity('Bootstrapped canonical store from baseline workbook in data/source/.');
      } catch (err) {
        store.setError(`Failed to load baseline workbook: ${err.message}`, err.details || []);
      }
    }
  }

  generateReport(store.state, { trigger: 'startup' });
  startWatcher(config.incomingDir, { stabilityThresholdMs: config.watchStabilityMs, pollIntervalMs: config.watchPollMs });

  server.listen(config.port, () => {
    console.log(`Prenyltransferase Atlas dashboard running at http://localhost:${config.port}`);
    console.log(`Watching for file changes in: ${config.incomingDir}`);
  });
}

bootstrap();

module.exports = { app, server };
