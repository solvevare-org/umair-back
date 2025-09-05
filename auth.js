const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true }
});
const User = mongoose.model('User', UserSchema);

// Register endpoint
router.post('/api/signup', async (req, res) => {
  try {
    const { name ,email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ ok: false, error: 'Email and password required.' });
    }
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ ok: false, error: 'User already exists.' });
    }
    const hash = await bcrypt.hash(password, 10);
    const user = new User({ name, email, password: hash });
    await user.save();
    res.json({ ok: true, user: { email: user.email } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Login endpoint
router.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Email and password required.' });
    }
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ ok: false, error: 'User not found.' });
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ ok: false, error: 'Invalid password.' });
    }
  // Generate JWT token
  const token = jwt.sign({ email: user.email, id: user._id }, process.env.JWT_SECRET || 'secret', { expiresIn: '1d' });
  res.json({ ok: true, token, user: { _id: user._id, email: user.email } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
