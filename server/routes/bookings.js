'use strict';
/* ============================================================
   CineHall — /api/bookings
   Create, list and cancel. The POST handler is the load-bearing
   piece of the whole backend.
   ============================================================ */

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { requireInt } = require('../helpers');

const router = express.Router();

/* Business Rule 6: cancellation only up to 2 hours before start. */
const CANCEL_WINDOW_HOURS = 2;

/* Rule 6, stated once. Every path that needs it interpolates this
   rather than retyping it: the read paths derive `is_cancellable`
   from it, and the cancel endpoint checks it to allow staff to
   override. These used to be two hand-written copies under two
   different aliases, which is exactly how they would have drifted. */
const SHOW_FAR_ENOUGH = `
  (st.show_date + st.show_time) > LOCALTIMESTAMP + INTERVAL '${CANCEL_WINDOW_HOURS} hours'
`;

const BOOKING_SELECT = `
  b.booking_id,
  b.ticket_code,
  b.booking_time,
  b.total_amount::float8 AS total_amount,
  b.status,
  b.showtime_id,
  b.customer_id,
  c.name AS customer_name,
  c.email AS customer_email,
  c.phone AS customer_phone,
  m.movie_id,
  m.title AS movie_title,
  m.certificate,
  t.name AS theatre_name,
  sc.screen_number,
  st.show_date::text AS show_date,
  to_char(st.show_time, 'HH24:MI') AS show_time,
  to_char(st.show_time, 'AM')     AS meridiem,
  /* Rule 6, decided in SQL so this flag and the cancel endpoint can
     never disagree. Aliased to the name the API actually publishes,
     which every endpoint returns: this used to be derived separately
     by the list handler only, so a booking created by POST came back
     without it and the page could not tell whether it was cancellable. */
  (b.status = 'confirmed' AND ${SHOW_FAR_ENOUGH}) AS is_cancellable
`;

const SEATS_FOR_BOOKING = `
  SELECT string_agg(bs_seat.seat_row || bs_seat.seat_number, ',' ORDER BY
                   bs_seat.seat_row, bs_seat.seat_number) AS seats
  FROM booking_seat link
  JOIN seat bs_seat ON bs_seat.seat_id = link.seat_id
  WHERE link.booking_id = $1
`;

/* Every endpoint that returns a booking passes its row through here,
   so all four publish the same fields. `is_cancellable` arrives from
   the SQL above; this only attaches the seat labels. */
async function withSeats(client, row) {
  const seats = await client.query(SEATS_FOR_BOOKING, [row.booking_id]);
  return {
    ...row,
    // Cancelled bookings have their booking_seat rows removed to
    // release the seats, so this is empty for them.
    seats: (seats.rows[0].seats || '').split(',').filter(Boolean)
  };
}

async function loadBooking(client, bookingId) {
  const { rows } = await client.query(
    `SELECT ${BOOKING_SELECT}
     FROM booking b
     JOIN customer c ON c.customer_id  = b.customer_id
     JOIN showtime st ON st.showtime_id = b.showtime_id
     JOIN movie m  ON m.movie_id  = st.movie_id
     JOIN screen sc ON sc.screen_id = st.screen_id
     JOIN theatre t ON t.theatre_id = sc.theatre_id
     WHERE b.booking_id = $1`,
    [bookingId]
  );
  if (!rows[0]) return null;
  return withSeats(client, rows[0]);
}

/* A collision on the random part of a ticket code is unlikely but
   possible, and ticket_code is UNIQUE. Retry a few times rather
   than failing a real booking over it. */
async function generateTicketCode(client) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let block = '';
    for (let i = 0; i < 4; i += 1) {
      block += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    const code = `CH-${block}-${Math.floor(1000 + Math.random() * 9000)}`;
    const { rows } = await client.query(
      'SELECT 1 FROM booking WHERE ticket_code = $1',
      [code]
    );
    if (rows.length === 0) return code;
  }
  // Fall back to something guaranteed distinct.
  return `CH-${Date.now().toString(36).toUpperCase()}`;
}

/* Creates the booking. The whole thing runs in one transaction so a
   partial booking can never be committed.

   Double-booking protection has two layers:
     1. The FOR UPDATE lock above plus the re-read, which is what
        actually serialises two concurrent requests: the second one
        blocks on the seat rows, then sees the seat as taken.
     2. uniq_seat_per_showtime, which states the rule declaratively
        and still holds for any future code path that inserts
        booking_seat without taking the lock. Verified: removing the
        index does not make this endpoint double-book. */
router.post('/', requireAuth, async (req, res) => {
  const { showtime_id: rawShowtimeId, seat_ids: rawSeatIds, payment_method = 'upi' } = req.body || {};

  const showtimeId = Number(rawShowtimeId);
  if (!Number.isInteger(showtimeId) || showtimeId <= 0) {
    return res.status(400).json({ error: 'A valid showtime_id is required' });
  }
  if (!Array.isArray(rawSeatIds) || rawSeatIds.length === 0) {
    return res.status(400).json({ error: 'Select at least one seat' });
  }
  const seatIds = [...new Set(rawSeatIds.map(Number))].filter(Number.isInteger);
  if (seatIds.length !== rawSeatIds.length) {
    return res.status(400).json({ error: 'Seat ids must be numbers' });
  }
  if (!['upi', 'card', 'netbanking', 'cash'].includes(payment_method)) {
    return res.status(400).json({ error: 'Unsupported payment method' });
  }

  try {
    const booking = await db.withTransaction(async (client) => {
      const { rows: showRows } = await client.query(
        `SELECT st.showtime_id, st.screen_id,
                st.silver_price::float8  AS silver_price,
                st.gold_price::float8    AS gold_price,
                st.premium_price::float8 AS premium_price,
                st.show_date::text AS show_date,
                to_char(st.show_time,'HH24:MI') AS show_time,
                to_char(st.show_date + st.show_time, 'YYYY-MM-DD"T"HH24:MI') AS starts_at,
                (st.show_date + st.show_time) > LOCALTIMESTAMP AS not_started
         FROM showtime st WHERE st.showtime_id = $1`,
        [showtimeId]
      );
      const show = showRows[0];
      if (!show) {
        const err = new Error('Showtime not found');
        err.status = 404;
        throw err;
      }

      /* Once the film has started there is nothing left to book. This
         has to be checked here rather than in the front end, because
         the seed is written with CURRENT_DATE + offset (seed.sql), so
         yesterday's shows stay in the table forever. Without this a
         customer can buy a seat for a film that ended hours ago.

         The comparison is made by Postgres, not in JavaScript. Every
         other "is this in the past" test in this file is SQL too, and
         they have to agree: show_date and show_time are wall-clock
         values with no timezone, so whichever layer interprets them
         defines the answer. Doing it in JS used to disagree with the
         list endpoint by the offset between the server's timezone and
         the database's, which offered shows that then refused to book. */
      if (!show.not_started) {
        const err = new Error('This show has already started and can no longer be booked');
        err.status = 409;
        throw err;
      }

      // Lock the requested seats for this showtime so two concurrent
      // requests serialise here instead of both reading "available".
      const { rows: seatRows } = await client.query(
        `SELECT se.seat_id, se.seat_row, se.seat_number, se.seat_type
         FROM seat se
         WHERE se.screen_id = $1 AND se.seat_id = ANY($2::int[])
         FOR UPDATE`,
        [show.screen_id, seatIds]
      );

      if (seatRows.length !== seatIds.length) {
        const err = new Error('One or more seats do not exist on this screen');
        err.status = 400;
        throw err;
      }

      const { rows: taken } = await client.query(
        `SELECT bs.seat_id
         FROM booking_seat bs
         WHERE bs.showtime_id = $1 AND bs.seat_id = ANY($2::int[])`,
        [showtimeId, seatIds]
      );
      if (taken.length > 0) {
        const { rows: labels } = await client.query(
          `SELECT seat_row, seat_number FROM seat WHERE seat_id = ANY($1::int[])`,
          [taken.map((t) => t.seat_id)]
        );
        const names = labels.map((l) => `${l.seat_row}${l.seat_number}`).sort();
        const err = new Error(`Seat${names.length > 1 ? 's' : ''} ${names.join(', ')} already booked`);
        err.status = 409;
        err.seatConflict = true;
        throw err;
      }

      // Price is computed here, never taken from the client. The old
      // front end trusted a total that had been summed in the browser
      // and stored in sessionStorage, which anyone could edit.
      const priceFor = { silver: show.silver_price, gold: show.gold_price, premium: show.premium_price };
      const total = seatRows.reduce((sum, s) => sum + priceFor[s.seat_type], 0);

      const ticketCode = await generateTicketCode(client);

      const { rows: bookingRows } = await client.query(
        `INSERT INTO booking (customer_id, showtime_id, ticket_code, total_amount, status)
         VALUES ($1, $2, $3, $4, 'confirmed')
         RETURNING booking_id`,
        [req.user.sub, showtimeId, ticketCode, total]
      );
      const bookingId = bookingRows[0].booking_id;

      for (const seatId of seatIds) {
        await client.query(
          'INSERT INTO booking_seat (booking_id, seat_id, showtime_id) VALUES ($1, $2, $3)',
          [bookingId, seatId, showtimeId]
        );
      }

      // A real gateway call goes here. The row records the attempt so
      // the Payment table reflects the booking.
      await client.query(
        `INSERT INTO payment (booking_id, amount, payment_method, payment_status)
         VALUES ($1, $2, $3, 'success')`,
        [bookingId, total, payment_method]
      );

      return loadBooking(client, bookingId);
    });

    return res.status(201).json({ booking });
  } catch (err) {
    // The unique index fired: a concurrent request took the seat
    // between our SELECT and our INSERT. This is the guarantee doing
    // its job, not an unexpected error.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Those seats were just taken. Please pick again.' });
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }
});

/* Customers see their own bookings. Staff see everything, and may
   filter by email or ticket code.

   This replaces the old my-bookings.html, which had no auth guard
   and showed every booking in the store when the email box was
   empty. */
router.get('/', requireAuth, async (req, res) => {
  const isStaff = ['theater_admin', 'system_admin'].includes(req.user.role);
  const params = [];
  const filters = [];

  if (isStaff) {
    if (req.query.email) {
      params.push(String(req.query.email).trim().toLowerCase());
      filters.push(`c.email = $${params.length}`);
    }
    if (req.query.status && ['confirmed', 'cancelled'].includes(req.query.status)) {
      params.push(req.query.status);
      filters.push(`b.status = $${params.length}`);
    }
    /* Free-text search across the three things the admin bookings table
       shows: who booked, how to reach them, and the ticket code. Staff
       only, because a customer must never be able to search other
       people's bookings -- their own are already filtered below. */
    if (req.query.q) {
      const needle = String(req.query.q).trim().toLowerCase();
      if (needle) {
        /* Escape the LIKE metacharacters so a search for "50%" or a
           name containing "_" matches literally instead of turning into
           a wildcard. */
        params.push(`%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        filters.push(
          `(c.name ILIKE $${params.length} ESCAPE '\\'
            OR c.email ILIKE $${params.length} ESCAPE '\\'
            OR b.ticket_code ILIKE $${params.length} ESCAPE '\\')`
        );
      }
    }
  } else {
    params.push(req.user.sub);
    filters.push(`b.customer_id = $${params.length}`);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT ${BOOKING_SELECT}
     FROM booking b
     JOIN customer c ON c.customer_id  = b.customer_id
     JOIN showtime st ON st.showtime_id = b.showtime_id
     JOIN movie m  ON m.movie_id  = st.movie_id
     JOIN screen sc ON sc.screen_id = st.screen_id
     JOIN theatre t ON t.theatre_id = sc.theatre_id
     ${where}
     ORDER BY b.booking_time DESC, b.booking_id DESC`,
    params
  );

  const withSeatsList = await Promise.all(
    rows.map((row) => withSeats(db, row))
  );

  res.json({ bookings: withSeatsList });
});

router.get('/:id', requireAuth, async (req, res) => {
  if (!requireInt(req, res)) return;
  const booking = await loadBooking(db.pool, req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const isStaff = ['theater_admin', 'system_admin'].includes(req.user.role);
  if (!isStaff && booking.customer_id !== req.user.sub) {
    // Do not disclose that someone else's booking exists.
    return res.status(404).json({ error: 'Booking not found' });
  }
  res.json({ booking });
});

/* Cancel: flip status, record the refund, release the seats. All in
   one transaction, so a booking can never end up cancelled but still
   holding its seats. */
router.post('/:id/cancel', requireAuth, async (req, res) => {
  const { reason = null } = req.body || {};
  const isStaff = ['theater_admin', 'system_admin'].includes(req.user.role);

  if (!requireInt(req, res, 'booking_id')) return;

  try {
    const booking = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT b.booking_id, b.customer_id, b.status,
                ${SHOW_FAR_ENOUGH} AS within_window
         FROM booking b
         JOIN showtime st ON st.showtime_id = b.showtime_id
         WHERE b.booking_id = $1
         FOR UPDATE`,
        [req.params.id]
      );
      const current = rows[0];
      if (!current) {
        const err = new Error('Booking not found');
        err.status = 404;
        throw err;
      }
      if (!isStaff && current.customer_id !== req.user.sub) {
        const err = new Error('Booking not found');
        err.status = 404;
        throw err;
      }
      if (current.status === 'cancelled') {
        const err = new Error('This booking is already cancelled');
        err.status = 409;
        throw err;
      }

      // Rule 6 is a customer-facing rule; staff can cancel anything
      // so they can clean up mistakes.
      if (!isStaff && !current.within_window) {
        const err = new Error(`Bookings can only be cancelled up to ${CANCEL_WINDOW_HOURS} hours before showtime`);
        err.status = 409;
        throw err;
      }

      await client.query(
        `UPDATE booking SET status = 'cancelled' WHERE booking_id = $1`,
        [req.params.id]
      );
      await client.query(
        `INSERT INTO cancellation (booking_id, refund_status, reason)
         VALUES ($1, 'refunded', $2)`,
        [req.params.id, reason]
      );
      // Releasing the seat is what makes the unique index allow the
      // seat to be booked again.
      await client.query('DELETE FROM booking_seat WHERE booking_id = $1', [req.params.id]);
      await client.query(
        `UPDATE payment SET payment_status = 'refunded' WHERE booking_id = $1`,
        [req.params.id]
      );

      return loadBooking(client, req.params.id);
    });

    return res.json({ booking });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

module.exports = router;
