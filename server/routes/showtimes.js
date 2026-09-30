'use strict';
/* ============================================================
   CineHall — /api/showtimes
   Public reads (including the seat map), admin writes.

   Times are real TIME values. The old front end stored free text
   like '8:30 PM', which cannot be compared or sorted.
   ============================================================ */

const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { requireInt } = require('../helpers');

const router = express.Router();

/* show_time is a TIME column; to_char(..., 'HH24:MI') gives the API
   a stable "HH:MM" string in 24h form, and to_char(..., 'AM') keeps
   the display format the UI already used. */
const SHOWTIME_SELECT = `
  st.showtime_id,
  st.movie_id,
  st.screen_id,
  sc.theatre_id,
  t.name  AS theatre_name,
  t.location AS theatre_location,
  sc.screen_number,
  st.show_date::text AS show_date,
  to_char(st.show_time, 'HH24:MI') AS show_time,
  to_char(st.show_time, 'AM')     AS meridiem,
  st.silver_price::float8  AS silver_price,
  st.gold_price::float8    AS gold_price,
  st.premium_price::float8 AS premium_price
`;

/* HH:MI + meridiem -> HH:MM:SS for the TIME column. */
function parseTime(input) {
  const m = String(input).trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = (m[3] || '').toLowerCase();

  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

function validateShowtime(body) {
  const errors = [];
  if (!body.movie_id || !Number.isInteger(Number(body.movie_id))) {
    errors.push({ field: 'movie_id', message: 'A movie is required' });
  }
  if (!body.screen_id || !Number.isInteger(Number(body.screen_id))) {
    errors.push({ field: 'screen_id', message: 'A screen is required' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.show_date || ''))) {
    errors.push({ field: 'show_date', message: 'Date must be YYYY-MM-DD' });
  }
  const time = parseTime(body.show_time);
  if (!time) {
    errors.push({ field: 'show_time', message: 'Time must be HH:MM or a value like "7:15 PM"' });
  }
  for (const tier of ['silver_price', 'gold_price', 'premium_price']) {
    const v = Number(body[tier]);
    if (Number.isNaN(v) || v < 0) {
      errors.push({ field: tier, message: 'Price must be zero or more' });
    }
  }
  return { errors, time };
}

router.get('/', async (req, res) => {
  const filters = [];
  const params = [];
  if (req.query.movie_id) { params.push(req.query.movie_id); filters.push(`st.movie_id = $${params.length}`); }
  if (req.query.screen_id) { params.push(req.query.screen_id); filters.push(`st.screen_id = $${params.length}`); }
  if (req.query.date)      { params.push(req.query.date);      filters.push(`st.show_date = $${params.length}`); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const { rows } = await db.query(
    `SELECT ${SHOWTIME_SELECT}, m.title AS movie_title
     FROM showtime st
     JOIN movie m  ON m.movie_id  = st.movie_id
     JOIN screen sc ON sc.screen_id = st.screen_id
     JOIN theatre t ON t.theatre_id = sc.theatre_id
     ${where}
     ORDER BY st.show_date, st.show_time, st.showtime_id`,
    params
  );
  res.json({ showtimes: rows });
});

/* Showtimes for one movie, grouped by day. This is what the old
   movie-details.html built from DB.showsForMovie(). */
router.get('/movie/:id', async (req, res) => {
  if (!requireInt(req, res)) return;
  const { rows } = await db.query(
    `SELECT ${SHOWTIME_SELECT}
     FROM showtime st
     JOIN screen sc  ON sc.screen_id  = st.screen_id
     JOIN theatre t  ON t.theatre_id  = sc.theatre_id
     WHERE st.movie_id = $1
     ORDER BY st.show_date, st.show_time`,
    [req.params.id]
  );
  res.json({ showtimes: rows });
});

router.get('/:id', async (req, res) => {
  if (!requireInt(req, res)) return;
  const { rows } = await db.query(
    `SELECT ${SHOWTIME_SELECT}, m.title AS movie_title
     FROM showtime st
     JOIN movie m  ON m.movie_id  = st.movie_id
     JOIN screen sc ON sc.screen_id = st.screen_id
     JOIN theatre t ON t.theatre_id = sc.theatre_id
     WHERE st.showtime_id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Showtime not found' });
  res.json({ showtime: rows[0] });
});

/* The seat map. Replaces the hardcoded rows/seatsPerRow constants
   and the client-side bookedSeats array.
   `is_booked` comes from the seat_map view, so a seat's status is
   never a field the application has to keep in sync. */
router.get('/:id/seatmap', async (req, res) => {
  if (!requireInt(req, res)) return;
  const { rows: show } = await db.query(
    `SELECT ${SHOWTIME_SELECT}, m.title AS movie_title
     FROM showtime st
     JOIN movie m  ON m.movie_id  = st.movie_id
     JOIN screen sc ON sc.screen_id = st.screen_id
     JOIN theatre t ON t.theatre_id = sc.theatre_id
     WHERE st.showtime_id = $1`,
    [req.params.id]
  );
  if (!show[0]) return res.status(404).json({ error: 'Showtime not found' });

  const { rows: seats } = await db.query(
    `SELECT seat_id, seat_row, seat_number, seat_type, is_booked
     FROM seat_map
     WHERE showtime_id = $1
     ORDER BY seat_row, seat_number`,
    [req.params.id]
  );

  res.json({
    showtime: show[0],
    seats: seats.map((s) => ({
      seat_id: s.seat_id,
      seat: `${s.seat_row}${s.seat_number}`,
      row: s.seat_row,
      number: s.seat_number,
      // True once seat 5 has been passed; the front end renders the
      // centre aisle here. Derived, never stored.
      after_aisle: s.seat_number > 5,
      tier: s.seat_type,
      is_booked: s.is_booked
    }))
  });
});

router.post('/', requireAuth, requireRole('theater_admin', 'system_admin'), async (req, res) => {
  const { errors, time } = validateShowtime(req.body || {});
  if (errors.length) return res.status(400).json({ error: 'Validation failed', errors });

  try {
    const { rows } = await db.query(
      `INSERT INTO showtime
         (movie_id, screen_id, show_date, show_time, silver_price, gold_price, premium_price)
       VALUES ($1, $2, $3, $4::time, $5, $6, $7)
       RETURNING showtime_id`,
      [
        Number(req.body.movie_id), Number(req.body.screen_id), req.body.show_date, time,
        Number(req.body.silver_price), Number(req.body.gold_price), Number(req.body.premium_price)
      ]
    );
    const { rows: full } = await db.query(
      `SELECT ${SHOWTIME_SELECT}
       FROM showtime st
       JOIN screen sc  ON sc.screen_id  = st.screen_id
       JOIN theatre t  ON t.theatre_id  = sc.theatre_id
       WHERE st.showtime_id = $1`,
      [rows[0].showtime_id]
    );
    return res.status(201).json({ showtime: full[0] });
  } catch (err) {
    // Business Rule 2: no two screenings on one screen at the same instant.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That screen already has a showtime at that date and time' });
    }
    if (err.code === '23503') {
      return res.status(400).json({ error: 'Unknown movie or screen' });
    }
    throw err;
  }
});

router.delete('/:id', requireAuth, requireRole('theater_admin', 'system_admin'), async (req, res) => {
  if (!requireInt(req, res)) return;
  const { rows: booked } = await db.query(
    'SELECT count(*)::int AS n FROM booking WHERE showtime_id = $1',
    [req.params.id]
  );
  if (booked[0].n > 0) {
    return res.status(409).json({
      error: `Cannot delete: ${booked[0].n} booking(s) reference this showtime`
    });
  }
  const { rowCount } = await db.query('DELETE FROM showtime WHERE showtime_id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'Showtime not found' });
  res.json({ deleted: true, showtime_id: Number(req.params.id) });
});

module.exports = router;
