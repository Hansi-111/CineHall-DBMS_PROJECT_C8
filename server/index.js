'use strict';
/* ============================================================
   CineHall — server entry point
   Serves the JSON API and the static front end from one port, so
   there is no CORS configuration and no second dev server.
   ============================================================ */

require('dotenv').config();

const path = require('path');
const express = require('express');

const db = require('./db');
const authRoutes = require('./routes/auth');
const movieRoutes = require('./routes/movies');
const showtimeRoutes = require('./routes/showtimes');
const bookingRoutes = require('./routes/bookings');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Refusing to sign tokens with an empty secret.');
  process.exit(1);
}

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

// Small request log. Enough to debug the front end without a
// logging dependency.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api/')) {
      console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`);
    }
  });
  next();
});

app.get('/api/health', async (req, res) => {
  try {
    await db.healthcheck();
    res.json({ status: 'ok', database: 'up' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', database: 'down', error: err.message });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/movies', movieRoutes);
app.use('/api/showtimes', showtimeRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/admin', adminRoutes);

app.use('/api', (req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.originalUrl}` });
});

/* Static front end. The old pages are plain .html files, so
   express.static serves them as-is. The seat pages will fetch from
   /api once Phase 3 lands. */
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// Express 5 forwards rejected promises from async handlers here.
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, err);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message
  });
});

const server = app.listen(PORT, () => {
  console.log(`CineHall running at http://localhost:${PORT}`);
  console.log(`API base:        http://localhost:${PORT}/api`);
  console.log(`Database:        ${process.env.DATABASE_URL.replace(/:[^:@/]+@/, ':****@')}`);
});

async function shutdown(signal) {
  console.log(`\n${signal} received, closing...`);
  server.close(async () => {
    await db.pool.end();
    console.log('Closed cleanly.');
    process.exit(0);
  });
  // Do not hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
