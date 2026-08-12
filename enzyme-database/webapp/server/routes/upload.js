'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const store = require('../store');
const { ingestFile, IngestError } = require('../ingest/pipeline');

const router = express.Router();

const uploadsDir = path.join(__dirname, '..', '..', 'data', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      cb(null, `${stamp}__${file.originalname}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .xlsx and .csv files are accepted.'), ok);
  },
});

router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "file").' });

  try {
    const result = await ingestFile(req.file.path, req.file.originalname, (stage) => store.setStage(stage));
    store.applyNewVersion(result);
    res.json({
      ok: true,
      version: result.version,
      fileHash: result.fileHash,
      recordCount: result.recordCount,
      sourceFilename: result.sourceFilename,
      refreshedAt: store.state.lastRefreshAt,
    });
  } catch (err) {
    if (err instanceof IngestError) {
      store.setError(err.message, err.details);
      return res.status(422).json({ ok: false, error: err.message, details: err.details });
    }
    store.setError(err.message, []);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
