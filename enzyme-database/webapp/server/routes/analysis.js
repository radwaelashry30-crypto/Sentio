'use strict';

const express = require('express');
const store = require('../store');
const { applyFilters, allBivariate, statisticalAnalysis, biologicalInsights, literature, regioByAcceptorClass } = require('../analysis');
const { searchRecords } = require('../search');

const router = express.Router();

router.post('/search', express.json(), (req, res) => {
  const question = (req.body?.question || '').trim();
  if (!question) return res.status(400).json({ ok: false, error: 'Missing "question" in request body.' });
  if (question.length > 500) return res.status(400).json({ ok: false, error: 'Question is too long (max 500 characters).' });

  const filtered = applyFilters(store.state.records, req.body?.filters || {});
  res.json(searchRecords(question, filtered));
});

router.get('/bivariate', (req, res) => {
  const filtered = applyFilters(store.state.records, req.query);
  res.json(allBivariate(filtered));
});

router.get('/stats', (req, res) => {
  const filtered = applyFilters(store.state.records, req.query);
  res.json(statisticalAnalysis(filtered));
});

router.get('/insights', (req, res) => {
  const filtered = applyFilters(store.state.records, req.query);
  res.json(biologicalInsights(filtered));
});

router.get('/literature', (req, res) => {
  const filtered = applyFilters(store.state.records, req.query);
  res.json(literature(filtered));
});

router.get('/regio', (req, res) => {
  const filtered = applyFilters(store.state.records, req.query);
  res.json(regioByAcceptorClass(filtered));
});

module.exports = router;
