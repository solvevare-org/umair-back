const path = require('path');
// ======================= Imports & Setup =======================
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const mongoose = require('mongoose');
require('./models');
const { extractImageText, extractPdfText, callOpenAI } = require('./server');

// ======================= Multer Setup ==========================
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const name = Date.now().toString(36) + '-' + file.originalname.replace(/[^a-z0-9.\-_]/gi, '_');
    cb(null, name);
  }
});
const upload = multer({ storage });

// ======================= Models ================================
const Quiz = mongoose.model('Quiz');

// ======================= Endpoints =============================

// Get quizzes by courseId and teacherId
router.get('/api/quizzes', async (req, res) => {
  try {
    const { courseId, teacherId } = req.query;
    if (!courseId || !teacherId) {
      return res.status(400).json({ ok: false, error: 'courseId and teacherId required' });
    }
    const quizzes = await Quiz.find({ courseId, teacherId });
    res.json({ ok: true, quizzes });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Create or update a quiz
router.post('/api/quizzes', upload.single('file'), async (req, res) => {
  try {
    const { id, finalizedJson, metadata, courseId, teacherId } = req.body;
    let parsedJson = null;
    if (finalizedJson) {
      if (typeof finalizedJson === 'string') {
        try { parsedJson = JSON.parse(finalizedJson); } catch(e) { parsedJson = null; }
      } else if (typeof finalizedJson === 'object') {
        parsedJson = finalizedJson;
      }
    }
    const filePath = req.file ? path.relative(__dirname, req.file.path).replace(/\\/g, '/') : null;
    console.log('[API] POST /api/quizzes id=', id, 'courseId=', courseId, 'teacherId=', teacherId, 'hasFile=', !!req.file, 'title=', parsedJson && parsedJson.title);
    const upsert = await Quiz.findOneAndUpdate(
      { id },
      { id, finalizedJson: parsedJson, filePath, metadata, courseId, teacherId, updatedAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true, quiz: upsert });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ======================= Export ================================
module.exports = router;
