'use strict';

const express = require('express');
const store = require('../store');
const { kpis, applyFilters, filterOptions, highlights } = require('../analysis');

const router = express.Router();

router.get('/status', (req, res) => {
  const s = store.state;
  res.json({
    status: s.status,
    meta: s.meta,
    lastRefreshAt: s.lastRefreshAt,
    lastError: s.lastError,
    activityLog: s.activityLog.slice(0, 10),
  });
});

router.get('/summary', (req, res) => {
  const filtered = applyFilters(store.state.records, req.query);
  res.json({
    kpis: kpis(filtered),
    kpisUnfiltered: kpis(store.state.records),
    highlights: highlights(filtered),
    meta: store.state.meta,
    manualReviewCount: store.state.manualReview.length,
  });
});

router.get('/filter-options', (req, res) => {
  const filtered = applyFilters(store.state.records, req.query);
  res.json(filterOptions(filtered.length ? filtered : store.state.records));
});

router.get('/manual-review', (req, res) => {
  res.json(store.state.manualReview);
});

router.get('/audit-log', (req, res) => {
  res.json(store.state.auditLog);
});

module.exports = router;
