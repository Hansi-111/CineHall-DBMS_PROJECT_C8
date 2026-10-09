const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
// Only the "public" folder is served, so server.js / package.json / SQL files are never exposed.
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'cinehall_db',
  password: process.env.DB_PASSWORD || 'postgres',   // <-- put YOUR postgres password here (or set DB_PASSWORD)
  port: Number(process.env.DB_PORT) || 5432,
});

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

/* ---------------- helpers ---------------- */
const PAYMENT_METHODS = ['UPI', 'Credit Card', 'Debit Card'];
const statusToDb = s => (s === 'now' ? 'Now Showing' : 'Coming Soon');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// In-memory login tokens (cleared when the server restarts - fine for a project demo)
const tokens = new Map();
function issueToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, { ...user, expires: Date.now() + 8 * 60 * 60 * 1000 });
  return token;
}
function auth(role) {            // role: 'admin' | 'customer' | undefined (any logged-in user)
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const user = tokens.get(token);
    if (!user || user.expires < Date.now()) {
      tokens.delete(token);
      return res.status(401).json({ error: 'Please sign in again' });
    }
    if (role && user.role !== role) return res.status(403).json({ error: 'Not allowed' });
    req.user = user;
    next();
  };
}

/* ---------------- AUTH ---------------- */
app.post('/api/auth/signup', async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || !email || !phone || !password) return res.status(400).json({ error: 'All fields are required' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
  if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Phone must be a 10-digit number' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const r = await pool.query(
      `INSERT INTO Customer (name, email, phone, password) VALUES ($1,$2,$3,$4)
       RETURNING customer_id AS id, name, email, phone`,
      [name.trim(), email.trim().toLowerCase(), phone, hashPassword(password)]
    );
    const user = { ...r.rows[0], role: 'customer' };
    res.json({ token: issueToken(user), user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with this email already exists' });
    console.error(err); res.status(500).json({ error: 'Could not create account' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const r = await pool.query(
    'SELECT customer_id AS id, name, email, phone, password FROM Customer WHERE email = $1',
    [email.trim().toLowerCase()]
  );
  const row = r.rows[0];
  if (!row || !checkPassword(password, row.password)) return res.status(401).json({ error: 'Wrong email or password' });
  const user = { id: row.id, name: row.name, email: row.email, phone: row.phone, role: 'customer' };
  res.json({ token: issueToken(user), user });
});

app.post('/api/auth/admin-login', (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USER || password !== ADMIN_PASS) return res.status(401).json({ error: 'Wrong admin credentials' });
  const user = { name: username, role: 'admin' };
  res.json({ token: issueToken(user), user });
});

/* ---------------- MOVIES ---------------- */
const MOVIE_SELECT = `
  SELECT movie_id AS id, title, genre, language AS lang, duration, certificate AS rating,
         CASE status WHEN 'Now Showing' THEN 'now' ELSE 'upcoming' END AS status,
         COALESCE(synopsis,'') AS synopsis, COALESCE(rating,0)::float AS score
  FROM Movie`;

app.get('/api/movies', async (req, res) => {
  const r = await pool.query(MOVIE_SELECT + ' ORDER BY movie_id');
  res.json(r.rows);
});

function readMovie(b) {
  const m = {
    title: String(b.title || '').trim(), genre: String(b.genre || '').trim(), lang: String(b.lang || '').trim(),
    duration: Number(b.duration), rating: b.rating, status: b.status, synopsis: String(b.synopsis || '').trim(),
    score: Number(b.score),
  };
  if (!m.title || !m.genre || !m.lang || !(m.duration > 0) || !['U', 'UA', 'A'].includes(m.rating)
      || !(m.score >= 0 && m.score <= 10)) return null;
  return m;
}

app.post('/api/movies', auth('admin'), async (req, res) => {
  const m = readMovie(req.body || {});
  if (!m) return res.status(400).json({ error: 'Invalid movie data' });
  const r = await pool.query(
    `INSERT INTO Movie (title, genre, language, duration, certificate, status, synopsis, rating)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING movie_id AS id`,
    [m.title, m.genre, m.lang, m.duration, m.rating, statusToDb(m.status), m.synopsis, m.score]
  );
  res.json(r.rows[0]);
});

app.put('/api/movies/:id', auth('admin'), async (req, res) => {
  const m = readMovie(req.body || {});
  if (!m) return res.status(400).json({ error: 'Invalid movie data' });
  const r = await pool.query(
    `UPDATE Movie SET title=$1, genre=$2, language=$3, duration=$4, certificate=$5, status=$6, synopsis=$7, rating=$8
     WHERE movie_id=$9`,
    [m.title, m.genre, m.lang, m.duration, m.rating, statusToDb(m.status), m.synopsis, m.score, req.params.id]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Movie not found' });
  res.json({ success: true });
});

// NOTE: ON DELETE CASCADE means deleting a movie also removes its showtimes and their bookings.
app.delete('/api/movies/:id', auth('admin'), async (req, res) => {
  await pool.query('DELETE FROM Movie WHERE movie_id = $1', [req.params.id]);
  res.json({ success: true });
});

/* ---------------- SCREENS (for the admin "add showtime" form) ---------------- */
app.get('/api/screens', auth('admin'), async (req, res) => {
  const r = await pool.query(
    `SELECT sc.screen_id AS id, t.name AS cinema, sc.screen_number AS "screenNumber"
     FROM Screen sc JOIN Theatre t ON t.theatre_id = sc.theatre_id ORDER BY t.name, sc.screen_number`
  );
  res.json(r.rows);
});

/* ---------------- SHOWTIMES ---------------- */
const SHOW_SELECT = `
  SELECT st.showtime_id AS id, st.movie_id AS "movieId", st.screen_id AS "screenId",
         t.name AS cinema, sc.screen_number AS "screenNumber",
         to_char(st.show_date, 'YYYY-MM-DD') AS date,
         to_char(st.show_time, 'FMHH12:MI AM') AS time,
         json_build_object('silver', st.silver_price::float, 'gold', st.gold_price::float,
                           'premium', st.premium_price::float) AS price,
         (SELECT COUNT(*)::int FROM Booking_Seat bs JOIN Booking b ON b.booking_id = bs.booking_id
           WHERE b.showtime_id = st.showtime_id AND b.status = 'Confirmed') AS "bookedCount"
  FROM Showtime st
  JOIN Screen sc ON sc.screen_id = st.screen_id
  JOIN Theatre t ON t.theatre_id = sc.theatre_id`;

app.get('/api/shows', async (req, res) => {
  const where = [], params = [];
  if (req.query.movieId) { params.push(req.query.movieId); where.push(`st.movie_id = $${params.length}`); }
  if (req.query.upcoming) where.push('st.show_date >= CURRENT_DATE');
  const r = await pool.query(
    SHOW_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY st.show_date, st.show_time',
    params
  );
  res.json(r.rows);
});

app.get('/api/shows/:id', async (req, res) => {
  const r = await pool.query(SHOW_SELECT + ' WHERE st.showtime_id = $1', [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Show not found' });
  res.json(r.rows[0]);
});

// every seat on the show's screen, flagged booked / free
app.get('/api/shows/:id/seats', async (req, res) => {
  const r = await pool.query(
    `SELECT s.seat_id AS id, s.seat_row AS "row", s.seat_number AS number, s.seat_type AS type,
            EXISTS (SELECT 1 FROM Booking_Seat bs JOIN Booking b ON b.booking_id = bs.booking_id
                    WHERE b.showtime_id = $1 AND b.status = 'Confirmed' AND bs.seat_id = s.seat_id) AS booked
     FROM Seat s
     WHERE s.screen_id = (SELECT screen_id FROM Showtime WHERE showtime_id = $1)
     ORDER BY s.seat_row, s.seat_number`,
    [req.params.id]
  );
  res.json(r.rows);
});

app.post('/api/shows', auth('admin'), async (req, res) => {
  const { movieId, screenId, date, time, price } = req.body || {};
  const p = price || {};
  if (!movieId || !screenId || !date || !time || !(p.silver > 0) || !(p.gold > 0) || !(p.premium > 0))
    return res.status(400).json({ error: 'Invalid showtime data' });
  try {
    const r = await pool.query(
      `INSERT INTO Showtime (movie_id, screen_id, show_date, show_time, silver_price, gold_price, premium_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING showtime_id AS id`,
      [movieId, screenId, date, time, p.silver, p.gold, p.premium]
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That screen already has a show at this date and time' });
    if (err.code === '23503') return res.status(400).json({ error: 'Unknown movie or screen' });
    throw err;
  }
});

app.delete('/api/shows/:id', auth('admin'), async (req, res) => {
  await pool.query('DELETE FROM Showtime WHERE showtime_id = $1', [req.params.id]);
  res.json({ success: true });
});

/* ---------------- BOOKINGS ---------------- */
const BOOKING_SELECT = `
  SELECT b.booking_id AS id, b.ticket_code AS code, b.showtime_id AS "showId", st.movie_id AS "movieId",
         m.title AS "movieTitle", t.name AS cinema,
         to_char(st.show_date, 'YYYY-MM-DD') AS date, to_char(st.show_time, 'FMHH12:MI AM') AS time,
         COALESCE((SELECT array_agg(s.seat_row || s.seat_number ORDER BY s.seat_row, s.seat_number)
                   FROM Booking_Seat bs JOIN Seat s ON s.seat_id = bs.seat_id
                   WHERE bs.booking_id = b.booking_id), '{}') AS seats,
         b.total_amount::float AS total, c.name, c.email, c.phone,
         LOWER(b.status) AS status, b.booking_time AS "timestamp"
  FROM Booking b
  JOIN Customer c ON c.customer_id = b.customer_id
  JOIN Showtime st ON st.showtime_id = b.showtime_id
  JOIN Movie m ON m.movie_id = st.movie_id
  JOIN Screen sc ON sc.screen_id = st.screen_id
  JOIN Theatre t ON t.theatre_id = sc.theatre_id`;

// customers get their own bookings, admin gets everything
app.get('/api/bookings', auth(), async (req, res) => {
  const r = req.user.role === 'admin'
    ? await pool.query(BOOKING_SELECT + ' ORDER BY b.booking_time DESC')
    : await pool.query(BOOKING_SELECT + ' WHERE b.customer_id = $1 ORDER BY b.booking_time DESC', [req.user.id]);
  res.json(r.rows);
});

app.post('/api/bookings', auth('customer'), async (req, res) => {
  const { showId, seatIds, paymentMethod } = req.body || {};
  const ids = Array.isArray(seatIds) ? [...new Set(seatIds.map(Number))] : [];
  if (!Number(showId) || ids.length < 1 || ids.length > 8 || ids.some(n => !Number.isInteger(n)))
    return res.status(400).json({ error: 'Choose between 1 and 8 seats' });
  if (!PAYMENT_METHODS.includes(paymentMethod)) return res.status(400).json({ error: 'Choose a payment method' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock this show's row so two people can't grab the same seat at the same moment
    const st = (await client.query(
      'SELECT *, show_date >= CURRENT_DATE AS open FROM Showtime WHERE showtime_id = $1 FOR UPDATE', [showId]
    )).rows[0];
    if (!st) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Show not found' }); }
    if (!st.open) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'This show has already passed' }); }

    const seats = (await client.query(
      'SELECT seat_id, seat_type FROM Seat WHERE seat_id = ANY($1::int[]) AND screen_id = $2', [ids, st.screen_id]
    )).rows;
    if (seats.length !== ids.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Invalid seat selection' }); }

    const taken = await client.query(
      `SELECT 1 FROM Booking_Seat bs JOIN Booking b ON b.booking_id = bs.booking_id
       WHERE b.showtime_id = $1 AND b.status = 'Confirmed' AND bs.seat_id = ANY($2::int[]) LIMIT 1`, [showId, ids]
    );
    if (taken.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Sorry, one of those seats was just taken. Please pick again.' }); }

    // price is computed on the server - never trust the total sent by the browser
    const priceOf = { Silver: st.silver_price, Gold: st.gold_price, Premium: st.premium_price };
    const total = seats.reduce((sum, s) => sum + Number(priceOf[s.seat_type]), 0);

    let code;
    do {
      code = 'CH-' + crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
    } while ((await client.query('SELECT 1 FROM Booking WHERE ticket_code = $1', [code])).rowCount);

    const b = (await client.query(
      `INSERT INTO Booking (customer_id, showtime_id, ticket_code, total_amount, status)
       VALUES ($1,$2,$3,$4,'Confirmed') RETURNING booking_id`, [req.user.id, showId, code, total]
    )).rows[0];
    await client.query('INSERT INTO Booking_Seat (booking_id, seat_id) SELECT $1, unnest($2::int[])', [b.booking_id, ids]);
    await client.query(
      `INSERT INTO Payment (booking_id, amount, payment_method, payment_status) VALUES ($1,$2,$3,'Successful')`,
      [b.booking_id, total, paymentMethod]
    );
    await client.query('COMMIT');

    const full = await pool.query(BOOKING_SELECT + ' WHERE b.booking_id = $1', [b.booking_id]);
    res.json(full.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// "Delete" = cancel: keeps the booking row, marks it Cancelled and records it in Cancellation
app.delete('/api/bookings/:id', auth(), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = (await client.query(
      `SELECT b.booking_id, b.customer_id, b.status, st.show_date < CURRENT_DATE AS past
       FROM Booking b JOIN Showtime st ON st.showtime_id = b.showtime_id
       WHERE b.booking_id = $1 FOR UPDATE OF b`, [req.params.id]
    )).rows[0];
    const isAdmin = req.user.role === 'admin';
    if (!b || (!isAdmin && b.customer_id !== req.user.id)) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Booking not found' }); }
    if (b.status === 'Cancelled') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Already cancelled' }); }
    if (!isAdmin && b.past) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'This show has already passed' }); }

    await client.query(`UPDATE Booking SET status = 'Cancelled' WHERE booking_id = $1`, [b.booking_id]);
    await client.query(
      `INSERT INTO Cancellation (booking_id, refund_status, reason) VALUES ($1, 'Pending', $2)`,
      [b.booking_id, isAdmin ? 'Cancelled by admin' : 'Cancelled by customer']
    );
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

/* ---------------- errors ---------------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
