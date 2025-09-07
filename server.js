// ======================= Imports ==============================
const path = require('path');
const fs = require('fs');
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
require("dotenv").config();

// ======================= App Setup ============================
const app = express();
app.use(express.json());

// ======================= Multer Setup =========================
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

// ======================= Utility Functions ====================
let _fetch = globalThis.fetch;
try { if (!_fetch) _fetch = require("node-fetch").default; } catch (e) {}
const fsPromises = require("fs").promises;
let pdfParse;
try { pdfParse = require("pdf-parse"); } catch (e) { /* handled below */ }
let Tesseract;
try { Tesseract = require("tesseract.js"); } catch (e) { /* handled below */ }
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
function stripCodeFences(s) {
  if (!s) return s;
  return s.replace(/^```(?:html|HTML|json)?\s*/i, "").replace(/```$/i, "");
}
function looksLikeHtml(s) {
  if (!s) return false;
  const t = s.trim();
  return /^<!DOCTYPE html>/i.test(t) || /<html[\s>]/i.test(t);
}
function wrapIfNotHtml(content) {
  const safe = (content || "").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Worksheet (fallback)</title><style>body{font-family:system-ui;padding:20px;background:#fff}pre{white-space:pre-wrap}</style></head><body><h2>Model output (not valid HTML)</h2><pre>${safe}</pre></body></html>`;
}
async function extractImageText(filePath) {
  if (!Tesseract) throw new Error("tesseract.js is not installed. Run: npm install tesseract.js");
  const normalized = path.resolve(String(filePath).replace(/\\/g, "/"));
  const { data: { text } } = await Tesseract.recognize(normalized, "eng");
  if (!text || !text.trim()) throw new Error("No text extracted from image");
  return text.trim();
}
async function extractPdfText(filePath) {
  if (!pdfParse) throw new Error("pdf-parse is not installed. Run: npm install pdf-parse");
  const normalized = path.resolve(String(filePath).replace(/\\/g,"/"));
  const buf = await fsPromises.readFile(normalized);
  const data = await pdfParse(buf);
  const text = (data.text || "").trim();
  if (!text) throw new Error("No text extracted from PDF");
  return text;
}
async function callOpenAI(messages, opts = {}) {
  if (!_fetch) throw new Error("fetch not available");
    const payload = {
      model: opts.model || "gpt-5",
      messages,
  };
  const res = await _fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI API error (${res.status}): ${txt}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ======================= CORS Setup ===========================
app.use(cors({ origin: true, credentials: true }));

// ======================= Routers ==============================
const quizzesRouter = require('./quizzes');
app.use(quizzesRouter);
const coursesRouter = require('./courses');
app.use(coursesRouter);
const authRouter = require('./auth');
app.use(authRouter);

// ======================= MongoDB Setup ========================
const { Quiz, Attempt, Chat } = require('./models');
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/quizDB';
mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true }).then(()=>{
  console.log('Connected to MongoDB');
}).catch(err=>{
  console.error('MongoDB connection error:', err.message);
});

// ======================= Endpoints ============================
// Parse endpoints
app.post('/api/parse-image', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filePath = req.file.path;
    const imageText = await extractImageText(filePath);
    const systemPrompt = req.body.prompt || 'You are an expert in creating educational quizzes. Convert the following content into a quiz format. Return only valid JSON with the following structure: { title: string, description: string, questions: [{ question: string, options: string[], correctAnswer: number, explanation: string }] }';
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: imageText }
    ];
    const aiResponse = await callOpenAI(messages, { temperature: 0.7, max_tokens: 2000 });
    let quizData;
    try {
      quizData = JSON.parse(aiResponse);
    } catch (e) {
      const match = aiResponse.match(/```json([\s\S]*?)```/i);
      if (match) {
        quizData = JSON.parse(match[1]);
      } else {
        throw new Error('OpenAI did not return valid JSON');
      }
    }
    // Generate hint for each question using OpenAI
    if (quizData && Array.isArray(quizData.questions)) {
      for (const q of quizData.questions) {
        const questionText = q.question || q.prompt;
        if (questionText) {
          const hintMessages = [
            { role: 'system', content: 'You are an expert teacher. Provide a helpful hint for the following quiz question.' },
            { role: 'user', content: questionText }
          ];
          try {
            const hint = await callOpenAI(hintMessages, { temperature: 0.5, max_tokens: 100 });
            q.hint = hint.trim();
          } catch (e) {
            q.hint = '';
          }
        }
      }
    }
    // Remove uploaded file after processing
    if (req.file && req.file.path) {
      fs.unlink(req.file.path, (err) => {
        if (err) console.error('Error deleting uploaded file:', err);
      });
    }
    res.json({ ok: true, quiz: quizData });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/parse-pdf', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filePath = req.file.path;
    const pdfText = await extractPdfText(filePath);
    const systemPrompt = req.body.prompt || 'You are an expert in creating educational quizzes. Convert the following content into a quiz format. Return only valid JSON with the following structure: { title: string, description: string, questions: [{ question: string, options: string[], correctAnswer: number, explanation: string }] }';
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: pdfText }
    ];
    const aiResponse = await callOpenAI(messages, { temperature: 0.7, max_tokens: 2000 });
    let quizData;
    try {
      quizData = JSON.parse(aiResponse);
    } catch (e) {
      const match = aiResponse.match(/```json([\s\S]*?)```/i);
      if (match) {
        quizData = JSON.parse(match[1]);
      } else {
        throw new Error('OpenAI did not return valid JSON');
      }
    }
    // Generate hint for each question using OpenAI
    if (quizData && Array.isArray(quizData.questions)) {
      for (const q of quizData.questions) {
        const questionText = q.question || q.prompt;
        if (questionText) {
          const hintMessages = [
            { role: 'system', content: 'You are an expert teacher. Provide a helpful hint for the following quiz question.' },
            { role: 'user', content: questionText }
          ];
          try {
            const hint = await callOpenAI(hintMessages, { temperature: 0.5, max_tokens: 100 });
            q.hint = hint.trim();
          } catch (e) {
            q.hint = '';
          }
        }
      }
    }
    // Remove uploaded file after processing
    if (req.file && req.file.path) {
      fs.unlink(req.file.path, (err) => {
        if (err) console.error('Error deleting uploaded file:', err);
      });
    }
    res.json({ ok: true, quiz: quizData });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
// Define UPLOAD_DIR for static file serving
// --- OpenAI utility functions (moved from frontend/openai.js) ---
// require("dotenv").config();
// let _fetch = globalThis.fetch;
// try { if (!_fetch) _fetch = require("node-fetch").default; } catch (e) {}
// const fsPromises = require("fs").promises;
// let pdfParse;
// try { pdfParse = require("pdf-parse"); } catch (e) { /* handled below */ }
// let Tesseract;
// try { Tesseract = require("tesseract.js"); } catch (e) { /* handled below */ }
// const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// function stripCodeFences(s) {
//   if (!s) return s;
//   return s.replace(/^```(?:html|HTML|json)?\s*/i, "").replace(/```$/i, "");
// }
function looksLikeHtml(s) {
  if (!s) return false;
  const t = s.trim();
  return /^<!DOCTYPE html>/i.test(t) || /<html[\s>]/i.test(t);
}
function wrapIfNotHtml(content) {
  const safe = (content || "").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Worksheet (fallback)</title><style>body{font-family:system-ui;padding:20px;background:#fff}pre{white-space:pre-wrap}</style></head><body><h2>Model output (not valid HTML)</h2><pre>${safe}</pre></body></html>`;
}
async function extractImageText(filePath) {
  if (!Tesseract) throw new Error("tesseract.js is not installed. Run: npm install tesseract.js");
  const normalized = path.resolve(String(filePath).replace(/\\/g, "/"));
  const { data: { text } } = await Tesseract.recognize(normalized, "eng");
  if (!text || !text.trim()) throw new Error("No text extracted from image");
  return text.trim();
}
async function extractPdfText(filePath) {
  if (!pdfParse) throw new Error("pdf-parse is not installed. Run: npm install pdf-parse");
  const normalized = path.resolve(String(filePath).replace(/\\/g,"/"));
  const buf = await fsPromises.readFile(normalized);
  const data = await pdfParse(buf);
  const text = (data.text || "").trim();
  if (!text) throw new Error("No text extracted from PDF");
  return text;
}
async function callOpenAI(messages, opts = {}) {
  if (!_fetch) throw new Error("fetch not available");
    const payload = {
      model: opts.model || "gpt-5",
      messages,
  };
  const res = await _fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI API error (${res.status}): ${txt}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}



// Start the frontend server (openai.js) as a child process
const { spawn } = require('child_process');
const FRONTEND_PATH = path.join(__dirname, '../frontend/openai.js');
// Spawn the frontend helper script without using a shell so paths with spaces
// are passed as a single argument (avoids Node interpreting "D:\Work\Solvevare" as a module)
const frontendProcess = spawn('node', [FRONTEND_PATH], {
  cwd: path.join(__dirname, '../frontend'),
  stdio: 'inherit'
});
frontendProcess.on('error', (err) => {
  console.error('Failed to start frontend server:', err);
});
frontendProcess.on('exit', (code) => {
  console.log('Frontend server exited with code', code);
});


// Teacher chat with AI endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ ok: false, error: 'Message is required.' });
    }
    // Compose OpenAI chat messages
    const messages = [
      { role: 'system', content: 'You are a helpful AI assistant for teachers.' },
      { role: 'user', content: message }
    ];
    const aiResponse = await callOpenAI(messages, { temperature: 0.5, max_tokens: 1000 });
    res.json({ ok: true, response: aiResponse });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/quizzes/:id', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
}, async (req,res)=>{
  try{
    const q = await Quiz.findOne({ id: req.params.id });
    if(!q) return res.status(404).json({ ok:false, error:'not found' });
    // Check allowed students if set
    if (q.allowedStudents && q.allowedStudents.length > 0) {
      const email = req.query.email;
      if (!email || !q.allowedStudents.includes(email)) {
        return res.status(403).json({ ok:false, error:'not allowed' });
      }
    }
    // if filePath present, serve full URL
    const host = req.get('origin') || `${req.protocol}://${req.get('host')}`;
    const fileUrl = q.filePath ? `${host}/server/uploads/${path.basename(q.filePath)}` : null;
    // Add correct/acceptable/explanation fields if missing
    let quizObj = q.toObject();
    res.json({ok:true, quiz:quizObj, fileUrl});
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'server error' });
 } 
});

app.post('/api/attempts', async (req,res)=>{
  const { quizId, email, score, totalQuestions,submitted } = req.body;
    try{
    // Collect incoming answers: prefer req.body.answers but also include top-level qN keys
    const incoming = req.body || {};
    const incomingAnswers = {};
    if(incoming.answers && typeof incoming.answers === 'object'){
      Object.keys(incoming.answers).forEach(k=> incomingAnswers[k] = incoming.answers[k]);
    }
    // also pick up keys like q1, q2 directly on the payload
    Object.keys(incoming).forEach(k=>{ if(/^q\d+$/.test(k)) incomingAnswers[k]=incoming[k]; });

    const incomingProgress = (incoming.progress && typeof incoming.progress === 'object') ? incoming.progress : {};

    const id = `${quizId}::${email}`;
    // Merge incoming answers/progress with existing attempt to avoid overwriting previous autosaves
    const existing = await Attempt.findOne({ id }).lean();

    const mergedAnswers = Object.assign({}, existing && existing.answers ? existing.answers : {});
    // apply incoming per-key, skipping empty-string/null to preserve prior values
    Object.keys(incomingAnswers).forEach(k=>{
      const v = incomingAnswers[k];
      if(v === null) return; // skip
      if(typeof v === 'string' && v.trim() === '') return; // skip empty strings
      mergedAnswers[k] = v;
    });
    const mergedProgress = Object.assign({}, existing && existing.progress ? existing.progress : {});
    Object.keys(incomingProgress).forEach(k=>{
      const v = incomingProgress[k];
      if(v === null) return;
      mergedProgress[k] = v;
    });
    const doc = { id, quizId, email, answers: mergedAnswers, progress: mergedProgress, score, totalQuestions,submitted, submittedAt: new Date() };
  const upsert = await Attempt.findOneAndUpdate({ id }, doc, { upsert: true, new: true, setDefaultsOnInsert: true });
  res.json({ ok:true, attempt: upsert });
  }catch(err){ res.status(500).json({ ok:false, error:err.message }); }
});

// Chat endpoints
app.post('/api/chats', async (req,res)=>{
  try{
    const { id, role, text, meta, timestamp, teacherId } = req.body;
    if (!teacherId) return res.status(400).json({ ok:false, error:'teacherId required' });
    const doc = { id: id || ('msg_' + Date.now().toString(36)), role, text, meta, teacherId, timestamp: timestamp ? new Date(timestamp) : new Date() };
    const upsert = await Chat.findOneAndUpdate({ id: doc.id }, doc, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.json({ ok:true, chat: upsert });
  }catch(err){ res.status(500).json({ ok:false, error:err.message }); }
});

app.get('/api/chats', async (req,res)=>{
  try{
    const teacherId = req.query.teacherId;
    if (!teacherId) return res.status(400).json({ ok:false, error:'teacherId required' });
    const chats = await Chat.find({ teacherId }).sort({ timestamp: 1 }).limit(1000).lean();
    res.json({ ok:true, chats });
  }catch(err){ res.status(500).json({ ok:false, error:err.message }); }
});

app.get('/api/test', (req, res) => {
  res.json({ message: 'Chats route working!' });
});
app.get('/api/attempts', async (req,res)=>{
  try{
    const { quizId, email } = req.query;
    const id = `${quizId}::${email}`;
    const a = await Attempt.findOne({ id });
    if(!a) return res.status(404).json({ ok:false, error:'not found' });
    res.json({ ok:true, attempt: a.toObject() });
  }catch(err){ res.status(500).json({ ok:false, error:err.message }); }
});

// static file serving for uploaded files
app.use('/server/uploads', express.static(UPLOAD_DIR));

// Serve frontend static files from project root (one level up)
const FRONTEND_ROOT = path.join(__dirname, '..');
app.use(express.static(FRONTEND_ROOT));

// root route -> index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(FRONTEND_ROOT, 'index.html'));
});

const PORT = 3004;
app.listen(PORT, ()=> console.log('Server running on port', PORT));

