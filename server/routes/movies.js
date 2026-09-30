'use strict';
/* ============================================================
   CineHall — /api/movies
   Public reads, admin writes.

   Naming note: the API speaks the SCHEMA's vocabulary, so it returns
   `certificate` (censor rating) and `rating` (numeric score). The
   old localStorage layer called these `rating` and `score` with the
   meanings reversed, so the front end has to map them.
   ============================================================ */

const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { requireInt } = require('../helpers');

const router = express.Router();

const MOVIE_COLUMNS = `
  movie_id, title, genre, language, duration,
  certificate, status, synopsis, rating::float8 AS rating
`;

/* list all movies, optionally filtered by status */
router.get('/', async (req, res) => {
  const { status } = req.query;
  const params = [];
  let where = '';
  if (status === 'now' || status === 'upcoming') {
    params.push(status);
    where = 'WHERE status = $1';
  }
  const { rows } = await db.query(
    `SELECT ${MOVIE_COLUMNS} FROM movie ${where} ORDER BY movie_id`,
    params
  );
  res.json({ movies: rows });
});

router.get('/:id', async (req, res) => {
  if (!requireInt(req, res)) return;
  const { rows } = await db.query(
    `SELECT ${MOVIE_COLUMNS} FROM movie WHERE movie_id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Movie not found' });
  res.json({ movie: rows[0] });
});

function validateMovie(body, { partial = false } = {}) {
  const errors = [];
  const has = (k) => body[k] !== undefined;

  if (!partial || has('title')) {
    if (!String(body.title || '').trim()) errors.push({ field: 'title', message: 'Title is required' });
  }
  if (!partial || has('genre')) {
    if (!String(body.genre || '').trim()) errors.push({ field: 'genre', message: 'Genre is required' });
  }
  if (!partial || has('language')) {
    if (!String(body.language || '').trim()) errors.push({ field: 'language', message: 'Language is required' });
  }
  if (!partial || has('duration')) {
    const d = Number(body.duration);
    if (!Number.isInteger(d) || d <= 0) errors.push({ field: 'duration', message: 'Duration must be a positive number of minutes' });
  }
  if (!partial || has('certificate')) {
    if (!['U', 'UA', 'A'].includes(body.certificate)) {
      errors.push({ field: 'certificate', message: 'Certificate must be U, UA or A' });
    }
  }
  if (!partial || has('status')) {
    if (!['now', 'upcoming'].includes(body.status)) {
      errors.push({ field: 'status', message: 'Status must be now or upcoming' });
    }
  }
  if (!partial || has('rating')) {
    if (body.rating !== undefined && body.rating !== null && body.rating !== '') {
      const r = Number(body.rating);
      if (Number.isNaN(r) || r < 0 || r > 10) {
        errors.push({ field: 'rating', message: 'Rating must be between 0 and 10' });
      }
    }
  }
  return errors;
}

/* Builds the INSERT/UPDATE column list from whichever fields the
   client actually sent, so a partial update cannot blank a column. */
function buildUpdate(body) {
  const map = {
    title: 'title', genre: 'genre', language: 'language', duration: 'duration',
    certificate: 'certificate', status: 'status', synopsis: 'synopsis', rating: 'rating'
  };
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(map)) {
    if (body[key] === undefined) continue;
    let value = body[key];
    if (key === 'duration') value = Number(value);
    if (key === 'rating') value = (value === null || value === '') ? null : Number(value);
    else if (typeof value === 'string') value = value.trim();
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  return { sets, params };
}

router.post('/', requireAuth, requireRole('theater_admin', 'system_admin'), async (req, res) => {
  const body = req.body || {};
  const errors = validateMovie(body);
  if (errors.length) return res.status(400).json({ error: 'Validation failed', errors });

  const { rows } = await db.query(
    `INSERT INTO movie (title, genre, language, duration, certificate, status, synopsis, rating)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${MOVIE_COLUMNS}`,
    [
      body.title.trim(), body.genre.trim(), body.language.trim(), Number(body.duration),
      body.certificate, body.status, (body.synopsis || '').trim() || null,
      (body.rating === undefined || body.rating === null || body.rating === '') ? null : Number(body.rating)
    ]
  );
  res.status(201).json({ movie: rows[0] });
});

router.put('/:id', requireAuth, requireRole('theater_admin', 'system_admin'), async (req, res) => {
  if (!requireInt(req, res)) return;
  const body = req.body || {};
  const errors = validateMovie(body, { partial: true });
  if (errors.length) return res.status(400).json({ error: 'Validation failed', errors });

  const { sets, params } = buildUpdate(body);
  if (sets.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  params.push(req.params.id);
  const { rows } = await db.query(
    `UPDATE movie SET ${sets.join(', ')}
     WHERE movie_id = $${params.length}
     RETURNING ${MOVIE_COLUMNS}`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: 'Movie not found' });
  res.json({ movie: rows[0] });
});

router.delete('/:id', requireAuth, requireRole('theater_admin', 'system_admin'), async (req, res) => {
  if (!requireInt(req, res)) return;
  // Showtimes cascade with the movie. Any booking attached to those
  // showtimes is protected by ON DELETE RESTRICT, so the delete is
  // refused rather than silently destroying ticket history.
  const { rows: booked } = await db.query(
    `SELECT count(*)::int AS n
     FROM booking b
     JOIN showtime st ON st.showtime_id = b.showtime_id
     WHERE st.movie_id = $1`,
    [req.params.id]
  );
  if (booked[0].n > 0) {
    return res.status(409).json({
      error: `Cannot delete: ${booked[0].n} booking(s) reference this movie`
    });
  }

  const { rowCount } = await db.query('DELETE FROM movie WHERE movie_id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'Movie not found' });
  res.json({ deleted: true, movie_id: Number(req.params.id) });
});

module.exports = router;
