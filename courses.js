const mongoose = require('mongoose');
const express = require('express');
const router = express.Router();

const CourseSchema = new mongoose.Schema({
  name: { type: String, required: true },
  teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  description: { type: String },
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
    const { name, teacherId, description } = req.body;
    if (!name || !teacherId) return res.status(400).json({ ok: false, error: 'name and teacherId required' });
    const course = new Course({ name, teacherId, description });
    await course.save();
    res.json({ ok: true, course });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
