'use strict';

const path = require('path');
const chokidar = require('chokidar');
const store = require('./store');
const { ingestFile, IngestError } = require('./ingest/pipeline');

/**
 * Watches config.incomingDir for new/changed .xlsx and .csv files. Excel
 * temp lock files (~$name.xlsx) are ignored. chokidar's awaitWriteFinish
 * gives us both the debounce and the file-stability check the spec asks
 * for: it only fires 'add'/'change' once the file size has stopped
 * changing for stabilityThreshold ms.
 */
function startWatcher(incomingDir, { stabilityThresholdMs = 3000, pollIntervalMs = 300 } = {}) {
  store.setStage('watching');
  store.pushActivity(`Watching ${incomingDir} for new or changed .xlsx/.csv files.`);

  const watcher = chokidar.watch(incomingDir, {
    ignored: (filePath) => {
      const base = path.basename(filePath);
      if (base.startsWith('~$')) return true;
      if (base.startsWith('.')) return true;
      if (/\.(xlsx|csv|xls)$/i.test(base)) return false;
      return false; // let directories through; non-matching files handled in handler
    },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: stabilityThresholdMs, pollInterval: pollIntervalMs },
    depth: 0,
  });

  let processing = false;
  let queued = null;

  async function handle(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (!['.xlsx', '.xls', '.csv'].includes(ext)) return;

    if (processing) {
      queued = filePath;
      return;
    }
    processing = true;
    store.setStage('change_detected');
    store.pushActivity(`Change detected: ${path.basename(filePath)}`);

    try {
      const result = await ingestFile(filePath, path.basename(filePath), (stage) => store.setStage(stage));
      store.applyNewVersion(result);
    } catch (err) {
      if (err instanceof IngestError) {
        store.setError(err.message, err.details);
      } else {
        store.setError(err.message, []);
      }
    } finally {
      processing = false;
      if (queued) {
        const next = queued;
        queued = null;
        handle(next);
      }
    }
  }

  watcher.on('add', handle);
  watcher.on('change', handle);

  return watcher;
}

module.exports = { startWatcher };
