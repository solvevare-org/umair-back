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
function parseJsonLenient(text){
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch(_) {}
  try {
    const unfenced = stripCodeFences(text);
    return JSON.parse(unfenced);
  } catch(_) {}
  try {
    // Replace smart quotes and stray control chars
    let t = String(text).replace(/[“”]/g,'"').replace(/[‘’]/g, "'").replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
    // Extract largest JSON object block
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      const candidate = t.slice(first, last + 1);
      return JSON.parse(candidate);
    }
  } catch(_) {}
  try {
    const m = text.match(/```json([\s\S]*?)```/i);
    if (m) return JSON.parse(m[1]);
  } catch(_) {}
  return null;
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
      model: opts.model || "gpt-4o-mini",
      messages,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.7,
      max_tokens: typeof opts.max_tokens === 'number' ? opts.max_tokens : 800,
      response_format: (opts && opts.force_json) ? { type: 'json_object' } : undefined,
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
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/quizDB';
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
    let imageText = await extractImageText(filePath);
    if (imageText && imageText.length > 6000) imageText = imageText.slice(0, 6000);
    const baseSystemPrompt = 'You are an expert quiz generator. Output ONLY valid JSON (no markdown, no prose). Schema: {"title": string, "description": string, "questions": [{"id": string, "question": string, "options": string[], "correctAnswer": number, "explanation": string}]}. Rules: 1) Do not include code fences. 2) Do not include comments. 3) Use zero-based index for correctAnswer. 4) Ensure JSON is syntactically valid. 5) Provide 3–6 options where applicable. 6) Keep explanations concise.';
    const teacherPrompt = req.body && req.body.prompt ? String(req.body.prompt) : '';
    const ensureJsonLine = 'Return ONLY valid JSON per the schema above.';
    const needsJsonReinforce = teacherPrompt && !/json/i.test(teacherPrompt);
    const systemContent = teacherPrompt
      ? baseSystemPrompt + '\nTeacher instructions: ' + teacherPrompt + (needsJsonReinforce ? ('\n' + ensureJsonLine) : '')
      : baseSystemPrompt;
    const messages = [
      { role: 'system', content: systemContent },
      { role: 'user', content: imageText }
    ];
    const aiResponse = await callOpenAI(messages, { temperature: 0.2, max_tokens: 1200, model: "gpt-4o-mini", force_json: true });
    const quizData = parseJsonLenient(aiResponse);
    if (!quizData || typeof quizData !== 'object') {
      return res.status(422).json({ ok: false, error: 'OpenAI did not return valid JSON', raw: String(aiResponse).slice(0, 4000) });
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
            const hint = await callOpenAI(hintMessages, { temperature: 0.5, max_tokens: 120, model: "gpt-4o-mini" });
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
    let pdfText = await extractPdfText(filePath);
    if (pdfText && pdfText.length > 6000) pdfText = pdfText.slice(0, 6000);
    const baseSystemPrompt = 'You are an expert quiz generator. Output ONLY valid JSON (no markdown, no prose). Schema: {"title": string, "description": string, "questions": [{"id": string, "question": string, "options": string[], "correctAnswer": number, "explanation": string}]}. Rules: 1) Do not include code fences. 2) Do not include comments. 3) Use zero-based index for correctAnswer. 4) Ensure JSON is syntactically valid. 5) Provide 3–6 options where applicable. 6) Keep explanations concise.';
    const teacherPrompt = req.body && req.body.prompt ? String(req.body.prompt) : '';
    const ensureJsonLine = 'Return ONLY valid JSON per the schema above.';
    const needsJsonReinforce = teacherPrompt && !/json/i.test(teacherPrompt);
    const systemContent = teacherPrompt
      ? baseSystemPrompt + '\nTeacher instructions: ' + teacherPrompt + (needsJsonReinforce ? ('\n' + ensureJsonLine) : '')
      : baseSystemPrompt;
    const messages = [
      { role: 'system', content: systemContent },
      { role: 'user', content: pdfText }
    ];
    const aiResponse = await callOpenAI(messages, { temperature: 0.2, max_tokens: 1200, model: "gpt-4o-mini", force_json: true });
    const quizData = parseJsonLenient(aiResponse);
    if (!quizData || typeof quizData !== 'object') {
      return res.status(422).json({ ok: false, error: 'OpenAI did not return valid JSON', raw: String(aiResponse).slice(0, 4000) });
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
            const hint = await callOpenAI(hintMessages, { temperature: 0.5, max_tokens: 120, model: "gpt-4o-mini" });
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
const frontendProcess = spawn('node', [FRONTEND_PATH], {
  cwd: path.join(__dirname, '../frontend'),
  stdio: 'inherit',
  shell: true
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
    // Return stored quiz as-is to avoid latency from enrichment on GET
    const quizObj = q.toObject();
    res.json({ ok:true, quiz: quizObj, fileUrl });
  }catch(err){ res.status(500).json({ ok:false, error:err.message }); }
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
    console.log('[POST /api/chats] raw body =', req.body);
    // Accept alternative payload shapes
    const resolvedText = (typeof text === 'string' && text)
      || (req.body && typeof req.body.content === 'string' && req.body.content)
      || (req.body && req.body.message && typeof req.body.message.content === 'string' && req.body.message.content)
      || (req.body && req.body.message && typeof req.body.message.text === 'string' && req.body.message.text)
      || '';
    const effectiveRole = (typeof role === 'string' && role)
      || (req.body && req.body.message && typeof req.body.message.role === 'string' && req.body.message.role)
      || 'user';
    const effectiveTeacherId = teacherId || (req.body && req.body.message && req.body.message.teacherId) || (meta && meta.teacherId);
    if (!effectiveTeacherId) return res.status(400).json({ ok:false, error:'teacherId required' });
    if (!resolvedText || (typeof resolvedText === 'string' && resolvedText.trim() === '')) {
      return res.status(400).json({ ok:false, error:'text/content required' });
    }
    const doc = {
      id: id || ('msg_' + Date.now().toString(36)),
      role: effectiveRole,
      text: resolvedText,
      meta,
      teacherId: effectiveTeacherId,
      timestamp: timestamp ? new Date(timestamp) : new Date()
    };
    console.log('[POST /api/chats] resolvedText =', resolvedText, 'role =', effectiveRole, 'teacherId =', effectiveTeacherId);
    // Attach raw payload for debugging when no text provided
    if (!doc.text) {
      doc.meta = Object.assign({}, doc.meta || {}, { raw: req.body });
    }
    const upsert = await Chat.findOneAndUpdate({ id: doc.id }, doc, { upsert: true, new: true, setDefaultsOnInsert: true });
    console.log('[POST /api/chats] saved chat =', upsert && upsert.toObject ? upsert.toObject() : upsert);
    res.json({ ok:true, chat: upsert && upsert.toObject ? upsert.toObject() : upsert });
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

const PORT = process.env.PORT || 3004;
const HOST = process.env.HOST || "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}/`);
});

