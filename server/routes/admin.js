'use strict';
/* ============================================================
   CineHall — /api/admin
   Dashboard aggregates and the reference data the admin screens
   need (theatres, screens) to populate their dropdowns.
   ============================================================ */

const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

const staffOnly = requireRole('theater_admin', 'system_admin');

router.get('/stats', requireAuth, staffOnly, async (req, res) => {
  const { rows } = await db.query(`
    SELECT
      (SELECT count(*)::int FROM movie WHERE status = 'now')      AS movies_now_showing,
      (SELECT count(*)::int FROM movie WHERE status = 'upcoming') AS movies_coming_soon,
      (SELECT count(*)::int FROM movie)                           AS movies_total,
      (SELECT count(*)::int FROM showtime
        WHERE show_date >= CURRENT_DATE)                          AS showtimes_upcoming,
      (SELECT count(*)::int FROM theatre)                         AS theatres,
      (SELECT count(*)::int FROM screen)                          AS screens,
      (SELECT count(*)::int FROM seat)                            AS seats,
      (SELECT count(*)::int FROM customer WHERE role = 'customer') AS customers,
      (SELECT count(*)::int FROM booking WHERE status = 'confirmed') AS bookings_confirmed,
      (SELECT count(*)::int FROM booking WHERE status = 'cancelled') AS bookings_cancelled,
      (SELECT coalesce(sum(total_amount), 0)::float8
         FROM booking WHERE status = 'confirmed')                 AS revenue_confirmed,
      (SELECT coalesce(sum(total_amount), 0)::float8
         FROM booking WHERE status = 'cancelled')                 AS revenue_cancelled
  `);

  const stats = rows[0];
  stats.seats_sold = (await db.query(
    `SELECT count(*)::int AS n
     FROM booking_seat bs
     JOIN booking b ON b.booking_id = bs.booking_id
     WHERE b.status = 'confirmed'`
  )).rows[0].n;

  res.json({ stats });
});

/* The most recent bookings, for the dashboard's activity table. */
router.get('/recent-bookings', requireAuth, staffOnly, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 8, 100);
  const { rows } = await db.query(
    `SELECT b.booking_id, b.ticket_code, b.booking_time,
            b.total_amount::float8 AS total_amount, b.status,
            c.name AS customer_name, c.email AS customer_email,
            m.title AS movie_title,
            t.name AS theatre_name,
            to_char(st.show_time,'HH24:MI') AS show_time,
            st.show_date::text AS show_date,
            (SELECT count(*)::int FROM booking_seat bs WHERE bs.booking_id = b.booking_id) AS seat_count
     FROM booking b
     JOIN customer c ON c.customer_id  = b.customer_id
     JOIN showtime st ON st.showtime_id = b.showtime_id
     JOIN movie m  ON m.movie_id  = st.movie_id
     JOIN screen sc ON sc.screen_id = st.screen_id
     JOIN theatre t ON t.theatre_id = sc.theatre_id
     ORDER BY b.booking_time DESC, b.booking_id DESC
     LIMIT $1`,
    [limit]
  );
  res.json({ bookings: rows });
});

/* Theatres with their screens. Feeds the screen dropdown that
   replaced the old free-text `cinema` field on the admin showtime
   form, and the cinema name the seat and checkout pages display. */
router.get('/theatres', requireAuth, staffOnly, async (req, res) => {
  const { rows } = await db.query(`
    SELECT t.theatre_id, t.name, t.location, t.contact_info, t.total_screens,
           coalesce(
             json_agg(json_build_object(
               'screen_id', sc.screen_id,
               'screen_number', sc.screen_number,
               'seating_capacity', sc.seating_capacity
             ) ORDER BY sc.screen_number)
             FILTER (WHERE sc.screen_id IS NOT NULL),
             '[]'
           ) AS screens
    FROM theatre t
    LEFT JOIN screen sc ON sc.theatre_id = t.theatre_id
    GROUP BY t.theatre_id
    ORDER BY t.name
  `);
  res.json({ theatres: rows });
});

module.exports = router;
