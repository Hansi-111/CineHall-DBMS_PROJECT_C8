'use strict';
/* ============================================================
   CineHall — /api/auth
   Registration and sign-in. This is the piece the old front end
   did not have at all: it collected a password and threw it away.
   ============================================================ */

const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, signToken, publicUser, requireAuth } = require('../auth');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 10-15 digits, optionally with a leading +, matching VARCHAR(15).
const PHONE_RE = /^\+?\d{10,15}$/;

/* Returns an array of {field, message} so the client can show every
   problem at once instead of one per round trip. */
function validateRegistration({ name, email, phone, password }) {
  const errors = [];
  if (!name || !name.trim())                    errors.push({ field: 'name', message: 'Name is required' });
  if (!email || !EMAIL_RE.test(email))         errors.push({ field: 'email', message: 'Enter a valid email address' });
  if (!phone || !PHONE_RE.test(phone))         errors.push({ field: 'phone', message: 'Enter a 10-15 digit phone number' });
  if (!password || password.length < 8)         errors.push({ field: 'password', message: 'Password must be at least 8 characters' });
  return errors;
}

router.post('/register', async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  const errors = validateRegistration({ name, email, phone, password });
  if (errors.length) {
    return res.status(400).json({ error: 'Validation failed', errors });
  }

  const normalisedEmail = email.trim().toLowerCase();
  const normalisedPhone = phone.trim();

  // email and phone are both UNIQUE, so check first to turn a
  // constraint violation into a readable message.
  const { rows: clash } = await db.query(
    `SELECT
       EXISTS (SELECT 1 FROM customer WHERE email = $1) AS email_taken,
       EXISTS (SELECT 1 FROM customer WHERE phone = $2) AS phone_taken`,
    [normalisedEmail, normalisedPhone]
  );
  if (clash[0].email_taken) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }
  if (clash[0].phone_taken) {
    return res.status(409).json({ error: 'An account with that phone number already exists' });
  }

  const passwordHash = await hashPassword(password);
  const { rows } = await db.query(
    `INSERT INTO customer (name, email, phone, password, role)
     VALUES ($1, $2, $3, $4, 'customer')
     RETURNING customer_id, name, email, phone, role`,
    [name.trim(), normalisedEmail, normalisedPhone, passwordHash]
  );

  const customer = rows[0];
  return res.status(201).json({ token: signToken(customer), user: publicUser(customer) });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const { rows } = await db.query(
    `SELECT customer_id, name, email, role, password
     FROM customer WHERE email = $1`,
    [String(email).trim().toLowerCase()]
  );
  const customer = rows[0];

  // Compare against a dummy hash when the user is missing, so a
  // wrong email and a wrong password take the same time and cannot
  // be told apart by an attacker.
  const hash = customer ? customer.password : '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu';
  const ok = await verifyPassword(password, hash);

  if (!customer || !ok) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }

  return res.json({ token: signToken(customer), user: publicUser(customer) });
});

/* Lets the front end validate a stored token on page load without
   waiting for a real request to 401. */
router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT customer_id, name, email, role FROM customer WHERE customer_id = $1',
    [req.user.sub]
  );
  if (!rows[0]) {
    // Token is well-formed and unexpired but the account is gone.
    return res.status(401).json({ error: 'Account no longer exists' });
  }
  return res.json({ user: publicUser(rows[0]) });
});

module.exports = router;
