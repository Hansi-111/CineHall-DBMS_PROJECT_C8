'use strict';
/* ============================================================
   CineHall — authentication & authorization
   bcrypt password hashing, JWT issuing, and the two guards every
   protected route runs through.
   ============================================================ */

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const TOKEN_TTL = '12h';
const BCRYPT_ROUNDS = 10;

const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_ROUNDS);
const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

function signToken(customer) {
  return jwt.sign(
    { sub: customer.customer_id, email: customer.email, role: customer.role, name: customer.name },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

/* Minimal shape returned to the client. Deliberately excludes
   customer_id and password so a token payload can be logged or
   inspected in devtools without leaking anything useful. */
const publicUser = (c) => ({ id: c.customer_id, name: c.name, email: c.email, role: c.role });

function readBearer(req) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;
  return token.trim();
}

/* Requires a valid token. Attaches req.user. */
function requireAuth(req, res, next) {
  const token = readBearer(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      error: expired ? 'Session expired, please sign in again' : 'Invalid token'
    });
  }
}

/* Requires a valid token AND one of the allowed roles.
   Must be mounted after requireAuth. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Requires role: ${roles.join(' or ')}`
      });
    }
    return next();
  };
}

module.exports = { hashPassword, verifyPassword, signToken, publicUser, requireAuth, requireRole };
