'use strict';

const { EventEmitter } = require('events');
const { loadActiveDataset, getActiveVersionMeta } = require('./db');

/**
 * Single in-process source of truth for "what's currently loaded". Holds the
 * live records array plus status/lifecycle info shown in the top status bar,
 * and emits 'change' whenever a new version becomes active so the WS hub can
 * broadcast dataset_updated, and 'stage' for lifecycle transitions.
 */
class DatasetStore extends EventEmitter {
  constructor() {
    super();
    this.state = {
      status: 'idle', // idle | watching | change_detected | validating | parsing | updating_analysis | updated | error
      records: [],
      auditLog: [],
      manualReview: [],
      meta: null,
      lastError: null,
      lastRefreshAt: null,
      activityLog: [],
    };
  }

  hydrateFromDb() {
    const ds = loadActiveDataset();
    if (ds) {
      this.state.records = ds.records;
      this.state.auditLog = ds.auditLog;
      this.state.manualReview = ds.manualReview;
      this.state.meta = ds.meta;
      this.state.status = 'updated';
      this.state.lastRefreshAt = ds.meta.ingested_at;
      this.pushActivity(`Loaded dataset version ${ds.meta.version} (${ds.meta.record_count} records) from canonical store.`);
    }
  }

  setStage(stage) {
    this.state.status = stage;
    this.emit('stage', stage);
  }

  pushActivity(message) {
    this.state.activityLog.unshift({ at: new Date().toISOString(), message });
    this.state.activityLog = this.state.activityLog.slice(0, 50);
  }

  applyNewVersion({ version }) {
    const ds = require('./db').loadVersion(version);
    this.state.records = ds.records;
    this.state.auditLog = ds.auditLog;
    this.state.manualReview = ds.manualReview;
    this.state.meta = ds.meta;
    this.state.status = 'updated';
    this.state.lastError = null;
    this.state.lastRefreshAt = new Date().toISOString();
    this.pushActivity(`Dataset updated to version ${version}: ${ds.meta.source_filename} (${ds.meta.record_count} records, ${ds.meta.plant_count} plant / ${ds.meta.fungal_count} fungal).`);
    this.emit('change');
  }

  setError(message, details) {
    this.state.status = 'error';
    this.state.lastError = { message, details: details || [] };
    this.pushActivity(`Error: ${message} — last valid dataset preserved.`);
    this.emit('error-state', { message, details });
  }
}

module.exports = new DatasetStore();
