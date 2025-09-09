const mongoose = require('mongoose');

const QuizSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  finalizedJson: { type: Object },
  filePath: { type: String },
  metadata: { type: Object },
  courseId: { type: String },
  teacherId: { type: String },
  allowedStudents: [{ type: String }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const AttemptSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  quizId: String,
  email: String,
  answers: Object,
  progress: Object,
  score: Number,
  totalQuestions: Number,
  submitted: { type: Boolean, default: false },
  submittedAt: Date,
  updatedAt: { type: Date, default: Date.now }
});

const ChatSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  role: String,
  text: String,
  meta: Object,
  teacherId: { type: String, index: true },
  timestamp: { type: Date, default: Date.now }
});

mongoose.model('Quiz', QuizSchema);
mongoose.model('Attempt', AttemptSchema);
mongoose.model('Chat', ChatSchema);

module.exports = {
  Quiz: mongoose.model('Quiz'),
  Attempt: mongoose.model('Attempt'),
  Chat: mongoose.model('Chat')
};
