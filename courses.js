const mongoose = require('mongoose');
const express = require('express');
const router = express.Router();

const CourseSchema = new mongoose.Schema({
  name: { type: String, required: true },
  teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  description: { type: String },
  status: { type: String, default: 'Active' },
  grade: { type: String },
  students: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now }
});

const Course = mongoose.model('Course', CourseSchema);

// Get all courses for a specific teacher (requires teacherId)
router.get('/api/courses', async (req, res) => {
  try {
    // In production, get teacherId from JWT auth, here from query for simplicity
    const teacherId = req.query.teacherId;
    if (!teacherId) return res.status(400).json({ ok: false, error: 'teacherId required' });
    const courses = await Course.find({ teacherId });
    res.json({ ok: true, courses });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Create a new course (for testing/demo)
router.post('/api/courses', async (req, res) => {
  try {
    const { name, teacherId, description, status, grade, students } = req.body;
    if (!name || !teacherId) return res.status(400).json({ ok: false, error: 'name and teacherId required' });
    const course = new Course({ name, teacherId, description, status, grade, students: Array.isArray(students) ? students : [] });
    await course.save();
    res.json({ ok: true, course });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Get students for a specific course
router.get('/api/courses/:id/students', async (req, res) => {
  try {
    const course = await Course.findOne({ _id: req.params.id });
    if (!course) return res.status(404).json({ ok: false, error: 'course not found' });
    res.json({ ok: true, students: Array.isArray(course.students) ? course.students : [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Get all unique students for a teacher
router.get('/api/students', async (req, res) => {
  try {
    const teacherId = req.query.teacherId;
    if (!teacherId) return res.status(400).json({ ok: false, error: 'teacherId required' });
    const courses = await Course.find({ teacherId }).select('students').lean();
    const set = new Set();
    for (const c of courses) {
      if (Array.isArray(c.students)) {
        c.students.forEach(s => { if (s) set.add(String(s)); });
      }
    }
    const students = Array.from(set).sort((a,b)=> a.localeCompare(b));
    res.json({ ok: true, students });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
