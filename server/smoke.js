'use strict';
/* ============================================================
   CineHall — API smoke test
   Exercises every endpoint against a running server.

     npm start          # in one terminal
     npm run api:test   # in another

   Exits non-zero if anything fails. Uses a real database, so it
   creates rows; run `npm run db:reset` afterwards to get back to a
   clean seed.
   ============================================================ */

const BASE = process.env.API_BASE || 'http://localhost:3000';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* some responses have no body */ }
  return { status: res.status, data };
}

const uniq = () => Math.random().toString(36).slice(2, 8);

/* Small stable string hash, used to derive a per-run showtime slot. */
const hash = (s) => {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
};

async function main() {
  console.log(`Testing ${BASE}`);

  // ---------------------------------------------------------------
  section('Health');
  {
    const { status, data } = await api('GET', '/api/health');
    check('health returns ok', status === 200 && data.status === 'ok', JSON.stringify(data));
  }

  // ---------------------------------------------------------------
  section('Auth');
  const suffix = uniq();

  /* Baseline the showtime list before the suite writes anything, so the
     "nothing leaked" assertion below compares against this run's own
     starting point instead of a hard-coded 16. A hard-coded count makes
     the suite fail on a second run, because the booking showtime it
     creates has bookings against it and therefore cannot be deleted
     again afterwards. */
  const showsAtStart = (await api('GET', '/api/showtimes')).data.showtimes?.length ?? 0;

  const customer = {
    name: 'Smoke Tester', email: `smoke.${suffix}@example.com`,
    phone: `+9198${String(Date.now()).slice(-8)}`, password: 'Str0ngPassw0rd'
  };

  let customerToken, adminToken, managerToken;
  {
    const { status, data } = await api('POST', '/api/auth/register', { body: customer });
    check('register returns 201 + token', status === 201 && !!data.token, JSON.stringify(data));
    customerToken = data.token;
    check('register never returns a password', data.user && data.user.password === undefined);
    check('registered role is customer', data.user?.role === 'customer', data.user?.role);
  }
  {
    const { status } = await api('POST', '/api/auth/register', { body: customer });
    check('duplicate email rejected with 409', status === 409, `got ${status}`);
  }
  {
    const { status, data } = await api('POST', '/api/auth/register', {
      body: { ...customer, email: `x.${suffix}@example.com`, password: 'short' }
    });
    check('short password rejected with 400', status === 400, `got ${status}`);
    check('validation errors name the field', data.errors?.some((e) => e.field === 'password'));
  }
  {
    const { status } = await api('POST', '/api/auth/login', {
      body: { email: customer.email, password: 'wrong-password' }
    });
    check('wrong password rejected with 401', status === 401, `got ${status}`);
  }
  {
    const { status, data } = await api('POST', '/api/auth/login', {
      body: { email: customer.email.toUpperCase(), password: customer.password }
    });
    check('login is case-insensitive on email', status === 200 && !!data.token, `got ${status}`);
  }
  {
    const { status, data } = await api('POST', '/api/auth/login', {
      body: { email: 'admin@cinehall.com', password: 'Admin@123' }
    });
    check('seeded admin can log in', status === 200 && !!data.token, `got ${status}`);
    adminToken = data.token;
  }
  {
    const { status } = await api('POST', '/api/auth/login', {
      body: { email: 'manager@cinehall.com', password: 'Manager@123' }
    });
    check('seeded manager can log in', status === 200, `got ${status}`);
  }
  {
    const { status } = await api('GET', '/api/auth/me', { token: customerToken });
    check('/me works with a token', status === 200, `got ${status}`);
  }
  {
    const { status } = await api('GET', '/api/auth/me');
    check('/me without a token is 401', status === 401, `got ${status}`);
  }
  {
    const { status } = await api('GET', '/api/auth/me', { token: 'not.a.jwt' });
    check('/me with a bad token is 401', status === 401, `got ${status}`);
  }
  {
    const { status, data } = await api('POST', '/api/auth/login', {
      body: { email: 'manager@cinehall.com', password: 'Manager@123' }
    });
    managerToken = data.token;
  }

  // ---------------------------------------------------------------
  section('Movies (public reads)');
  let movieId;
  {
    const { status, data } = await api('GET', '/api/movies');
    check('list movies returns 200', status === 200, `got ${status}`);
    check('seeded 6 movies present', data.movies?.length === 6, `got ${data.movies?.length}`);
    check('certificate is the censor rating', ['U', 'UA', 'A'].includes(data.movies?.[0]?.certificate), data.movies?.[0]?.certificate);
    check('rating is numeric, not a string', typeof data.movies?.[0]?.rating === 'number', typeof data.movies?.[0]?.rating);
    movieId = data.movies[0].movie_id;
  }
  {
    const { status, data } = await api('GET', '/api/movies?status=now');
    check('filter by now-showing works', data.movies?.every((m) => m.status === 'now'), 'mixed statuses');
    check('4 now-showing movies seeded', data.movies?.length === 4, `got ${data.movies?.length}`);
  }
  {
    const { status, data } = await api('GET', `/api/movies/${movieId}`);
    check('fetch one movie by id', status === 200 && data.movie.movie_id === movieId, `got ${status}`);
  }
  {
    const { status } = await api('GET', '/api/movies/999999');
    check('unknown movie is 404', status === 404, `got ${status}`);
  }
  {
    const { status } = await api('GET', '/api/movies/not-a-number');
    check('non-numeric id is 404, not 500', status === 404, `got ${status}`);
  }

  // ---------------------------------------------------------------
  section('Movies (admin writes + role enforcement)');
  let newMovieId;
  {
    const { status } = await api('POST', '/api/movies', {
      token: customerToken,
      body: { title: 'Nope', genre: 'Drama', language: 'English', duration: 90, certificate: 'U', status: 'now' }
    });
    check('customer cannot create a movie (403)', status === 403, `got ${status}`);
  }
  {
    const { status } = await api('POST', '/api/movies', {
      body: { title: 'No auth', genre: 'Drama', language: 'English', duration: 90, certificate: 'U', status: 'now' }
    });
    check('anonymous cannot create a movie (401)', status === 401, `got ${status}`);
  }
  {
    const { status, data } = await api('POST', '/api/movies', {
      token: adminToken,
      body: {
        title: `Smoke Film ${suffix}`, genre: 'Drama', language: 'English', duration: 100,
        certificate: 'UA', status: 'upcoming', synopsis: 'Created by the smoke test.', rating: 7.2
      }
    });
    check('admin can create a movie (201)', status === 201, JSON.stringify(data));
    check('created movie keeps its rating', data.movie?.rating === 7.2, data.movie?.rating);
    newMovieId = data.movie?.movie_id;
  }
  {
    // The PDF specifies movie.rating as DECIMAL(3,1), so the column
    // holds one decimal place. A two-decimal value is rounded by
    // Postgres rather than rejected. Asserted here so the limit is
    // a known, deliberate behaviour rather than a surprise.
    const { status, data } = await api('POST', '/api/movies', {
      token: adminToken,
      body: { title: `Scale Probe ${suffix}`, genre: 'Drama', language: 'English', duration: 100, certificate: 'U', status: 'now', rating: 7.25 }
    });
    check('movie.rating is stored at DECIMAL(3,1) scale (7.25 -> 7.3)',
      status === 201 && data.movie?.rating === 7.3, `${status} rating=${data.movie?.rating}`);
    if (data.movie?.movie_id) {
      await api('DELETE', `/api/movies/${data.movie.movie_id}`, { token: adminToken });
    }
  }
  {
    const { status, data } = await api('POST', '/api/movies', {
      token: adminToken,
      body: { title: 'Bad', genre: 'Drama', language: 'English', duration: 90, certificate: 'X', status: 'now' }
    });
    check('invalid certificate rejected (400)', status === 400, `got ${status}`);
  }
  {
    const { status, data } = await api('PUT', `/api/movies/${newMovieId}`, {
      token: adminToken, body: { rating: 9.1, synopsis: 'Updated synopsis.' }
    });
    check('admin can partially update a movie', status === 200 && data.movie.rating === 9.1, JSON.stringify(data));
    check('partial update did not blank the title', data.movie?.title === `Smoke Film ${suffix}`, data.movie?.title);
  }
  {
    const { status, data } = await api('PUT', `/api/movies/${newMovieId}`, {
      token: adminToken, body: { rating: 42 }
    });
    check('out-of-range rating rejected (400)', status === 400, `got ${status}`);
  }
  {
    const { status, data } = await api('PUT', `/api/movies/${newMovieId}`, { token: customerToken, body: { rating: 5 } });
    check('customer cannot update a movie (403)', status === 403, `got ${status}`);
  }

  // ---------------------------------------------------------------
  section('Showtimes + seat map');
  let showtimeId, screenId, theatreName;
  {
    const { status, data } = await api('GET', '/api/showtimes');
    check('list showtimes returns 200', status === 200, `got ${status}`);
    check('seeded showtimes are present', showsAtStart >= 16, `${showsAtStart} (a fresh seed has 16)`);
    showtimeId = data.showtimes[0].showtime_id;
    screenId = data.showtimes[0].screen_id;
    theatreName = data.showtimes[0].theatre_name;
  }
  {
    const { status, data } = await api('GET', `/api/showtimes?movie_id=${movieId}`);
    check('showtimes filtered by movie', status === 200 && data.showtimes.length > 0, `got ${status}`);
  }
  {
    const { status, data } = await api('GET', `/api/showtimes/${showtimeId}/seatmap`);
    check('seatmap returns 200', status === 200, `got ${status}`);
    check('seatmap has 80 seats', data.seats?.length === 80, `got ${data.seats?.length}`);
    check('every seat starts free', data.seats?.every((s) => s.is_booked === false));
    check('seat label is row+number', /^A1$/.test(data.seats?.[0]?.seat), data.seats?.[0]?.seat);
    check('aisle flag set after seat 5', data.seats?.[4]?.after_aisle === false && data.seats?.[5]?.after_aisle === true,
      `seat5=${data.seats?.[4]?.after_aisle} seat6=${data.seats?.[5]?.after_aisle}`);
    const rows = {};
    data.seats.forEach((s) => { rows[s.row] = s.tier; });
    check('rows G,H are premium', rows.G === 'premium' && rows.H === 'premium', `G=${rows.G} H=${rows.H}`);
    check('rows C,D,E are gold', rows.C === 'gold' && rows.D === 'gold' && rows.E === 'gold');
    check('rows A,B,F are silver', rows.A === 'silver' && rows.B === 'silver' && rows.F === 'silver');
  }
  {
    const { status, data } = await api('POST', '/api/showtimes', {
      token: customerToken,
      body: { movie_id: movieId, screen_id: screenId, show_date: '2030-01-01', show_time: '10:00', silver_price: 1, gold_price: 1, premium_price: 1 }
    });
    check('customer cannot create a showtime (403)', status === 403, `got ${status}`);
  }
  let clashShowId;
  {
    const { status, data } = await api('GET', `/api/showtimes/${showtimeId}`);
    const s = data.showtime;
    const { status: st, data: d } = await api('POST', '/api/showtimes', {
      token: adminToken,
      body: { movie_id: movieId, screen_id: screenId, show_date: s.show_date, show_time: s.show_time, silver_price: 100, gold_price: 200, premium_price: 300 }
    });
    check('duplicate screen+date+time rejected (409)', st === 409, `got ${st} ${JSON.stringify(d)}`);
  }
  {
    const { status, data } = await api('POST', '/api/showtimes', {
      token: adminToken,
      body: { movie_id: movieId, screen_id: screenId, show_date: '2030-06-15', show_time: '7:15 PM', silver_price: 100, gold_price: 200, premium_price: 300 }
    });
    check('admin can create a showtime (201)', status === 201, JSON.stringify(data));
    check('"7:15 PM" stored as 19:15', data.showtime?.show_time === '19:15', data.showtime?.show_time);
    check('meridiem reported for display', data.showtime?.meridiem === 'PM', data.showtime?.meridiem);
    clashShowId = data.showtime?.showtime_id;
  }

  // ---------------------------------------------------------------
  section('Booking');
  /* The seeded showtimes are today and tomorrow, and today may
     already have started. Business Rule 6 blocks cancelling within
     2 hours of start, so booking and cancellation tests need their
     own showtime comfortably in the future.

     The start time is derived from this run's unique suffix, and the
     date advances a little each day, so repeated runs against the same
     database do not collide on the (screen, date, time) unique index.
     This showtime cannot be cleaned up afterwards, because it has
     bookings against it and the API refuses to delete a showtime in
     use. */
  const futureDate = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  const futureTime = `${String(6 + (hash(suffix) % 13)).padStart(2, '0')}:${String(hash(suffix + 'm') % 60).padStart(2, '0')}`;
  {
    const { status, data } = await api('POST', '/api/showtimes', {
      token: adminToken,
      body: { movie_id: movieId, screen_id: screenId, show_date: futureDate, show_time: futureTime, silver_price: 150, gold_price: 220, premium_price: 320 }
    });
    check('created a future showtime for booking tests', status === 201, `${status} ${JSON.stringify(data)}`);
    showtimeId = data.showtime?.showtime_id;
  }
  // A second customer, used to prove one customer cannot touch
  // another's booking. The manager account will not do: staff are
  // allowed to read any booking, so a 200 there would be correct.
  let otherToken;
  {
    const other = {
      name: 'Other Tester', email: `other.${suffix}@example.com`,
      phone: `+9187${String(Date.now()).slice(-8)}`, password: 'Str0ngPassw0rd'
    };
    const { status, data } = await api('POST', '/api/auth/register', { body: other });
    check('second customer registered', status === 201, `${status} ${JSON.stringify(data)}`);
    otherToken = data.token;
  }

  const { data: mapData } = await api('GET', `/api/showtimes/${showtimeId}/seatmap`);
  const premiumSeats = mapData.seats.filter((s) => s.tier === 'premium' && !s.is_booked).slice(0, 2);
  const silverSeat = mapData.seats.find((s) => s.tier === 'silver' && !s.is_booked);
  let bookingId, bookingTotal;

  {
    const { status, data } = await api('POST', '/api/bookings', {
      body: { showtime_id: showtimeId, seat_ids: [premiumSeats[0].seat_id] }
    });
    check('anonymous cannot book (401)', status === 401, `got ${status}`);
  }
  {
    const { status, data } = await api('POST', '/api/bookings', {
      token: customerToken, body: { showtime_id: showtimeId, seat_ids: [] }
    });
    check('empty seat list rejected (400)', status === 400, `got ${status}`);
  }
  {
    const { status, data } = await api('POST', '/api/bookings', {
      token: customerToken, body: { showtime_id: showtimeId, seat_ids: [99999999] }
    });
    check('nonexistent seat rejected (400)', status === 400, `got ${status} ${JSON.stringify(data)}`);
  }
  {
    const { status, data } = await api('POST', '/api/bookings', {
      token: customerToken,
      body: { showtime_id: showtimeId, seat_ids: premiumSeats.map((s) => s.seat_id), payment_method: 'upi' }
    });
    check('customer can book (201)', status === 201, JSON.stringify(data));
    check('booking has a ticket code', /^CH-/.test(data.booking?.ticket_code || ''), data.booking?.ticket_code);
    check('price computed server-side for 2 premium = 640', data.booking?.total_amount === 640, data.booking?.total_amount);
    check('booking status is confirmed', data.booking?.status === 'confirmed', data.booking?.status);
    check('booking returns seat labels', data.booking?.seats?.length === 2, JSON.stringify(data.booking?.seats));
    bookingId = data.booking?.booking_id;
    bookingTotal = data.booking?.total_amount;
  }
  {
    const { status, data } = await api('POST', '/api/bookings', {
      token: customerToken, body: { showtime_id: showtimeId, seat_ids: [premiumSeats[0].seat_id] }
    });
    check('rebooking a taken seat is 409', status === 409, `got ${status} ${JSON.stringify(data)}`);
  }
  {
    const { status, data } = await api('GET', `/api/showtimes/${showtimeId}/seatmap`);
    const booked = data.seats.filter((s) => s.is_booked);
    check('seatmap reflects the booking', booked.length === 2, `got ${booked.length}`);
  }
  {
    const { status } = await api('POST', '/api/bookings', {
      token: customerToken,
      body: { showtime_id: showtimeId, seat_ids: [silverSeat.seat_id], total_amount: 1 }
    });
    check('client-supplied total is ignored (150, not 1)', status === 201, `got ${status}`);
  }
  {
    // The real test of the unique index: two bookings for one seat
    // fired at the same instant. Exactly one must win.
    const { data: m } = await api('GET', `/api/showtimes/${showtimeId}/seatmap`);
    const contested = m.seats.find((s) => !s.is_booked);
    const attempt = (token) => api('POST', '/api/bookings', {
      token, body: { showtime_id: showtimeId, seat_ids: [contested.seat_id] }
    });
    const [a, b] = await Promise.all([attempt(customerToken), attempt(managerToken)]);
    const codes = [a.status, b.status].sort();
    check('concurrent booking: exactly one 201, one 409',
      codes[0] === 201 && codes[1] === 409, `got ${JSON.stringify(codes)}`);
  }

  // ---------------------------------------------------------------
  section('Booking ownership + listing');
  {
    const { status, data } = await api('GET', '/api/bookings', { token: customerToken });
    check('customer sees only own bookings', data.bookings?.every((b) => b.customer_email === customer.email),
      'foreign booking leaked');
  }
  {
    const { status, data } = await api('GET', '/api/bookings', { token: adminToken });
    check('admin sees all bookings', Array.isArray(data.bookings), `got ${status}`);
  }
  {
    const { status } = await api('GET', '/api/bookings', { token: adminToken, });
    check('anonymous listing is 401', (await api('GET', '/api/bookings')).status === 401);
  }

  // ---------------------------------------------------------------
  section('Cancellation');
  {
    const { status } = await api('GET', `/api/bookings/${bookingId}`, { token: otherToken });
    check("another customer cannot read someone else's booking (404)", status === 404, `got ${status}`);
  }
  {
    const { status } = await api('GET', `/api/bookings/${bookingId}`, { token: managerToken });
    check('staff can read any booking (200)', status === 200, `got ${status}`);
  }
  {
    const { status } = await api('POST', `/api/bookings/${bookingId}/cancel`, { token: otherToken });
    check("another customer cannot cancel someone else's booking (404)", status === 404, `got ${status}`);
  }
  {
    const { status, data } = await api('POST', `/api/bookings/${bookingId}/cancel`, { token: customerToken, body: { reason: 'smoke test' } });
    check('owner can cancel', status === 200, `${status} ${JSON.stringify(data)}`);
    check('booking is now cancelled', data.booking?.status === 'cancelled', data.booking?.status);
  }
  {
    const { status } = await api('POST', `/api/bookings/${bookingId}/cancel`, { token: customerToken });
    check('double cancel is 409', status === 409, `got ${status}`);
  }
  {
    const { data: m } = await api('GET', `/api/showtimes/${showtimeId}/seatmap`);
    const free = m.seats.filter((s) => premiumSeats.some((p) => p.seat_id === s.seat_id) && !s.is_booked);
    check('cancelled seats are released in the seat map', free.length === 2, `got ${free.length}`);
  }
  {
    const { status } = await api('POST', '/api/bookings', {
      token: customerToken, body: { showtime_id: showtimeId, seat_ids: [premiumSeats[0].seat_id] }
    });
    check('a released seat can be booked again (201)', status === 201, `got ${status}`);
  }

  // ---------------------------------------------------------------
  section('Admin dashboard');
  {
    const { status, data } = await api('GET', '/api/admin/stats', { token: adminToken });
    const s = data.stats || {};
    check('stats returns 200', status === 200, `got ${status}`);
    check('stats report revenue as a number', typeof s.revenue_confirmed === 'number', typeof s.revenue_confirmed);
    check('stats report seats sold', typeof s.seats_sold === 'number');
    check('confirmed revenue is non-zero after booking', s.revenue_confirmed > 0, s.revenue_confirmed);
    check('cancelled revenue is reported separately, not merged in',
      typeof s.revenue_cancelled === 'number' && s.revenue_cancelled > 0, s.revenue_cancelled);

    // Cross-check the aggregate against the row the API can list. If
    // the two ever disagree, the dashboard number is the wrong one.
    const { data: all } = await api('GET', '/api/bookings?limit=100', { token: adminToken });
    const sumConfirmed = (all.bookings || [])
      .filter((b) => b.status === 'confirmed')
      .reduce((t, b) => t + Number(b.total_amount), 0);
    check('revenue_confirmed matches the sum of confirmed bookings',
      Math.abs(sumConfirmed - s.revenue_confirmed) < 0.01, `list=${sumConfirmed} stats=${s.revenue_confirmed}`);
  }
  {
    const { status } = await api('GET', '/api/admin/stats', { token: customerToken });
    check('customer cannot read stats (403)', status === 403, `got ${status}`);
  }
  {
    const { status, data } = await api('GET', '/api/admin/theatres', { token: adminToken });
    check('theatres endpoint returns screens', status === 200 && data.theatres?.[0]?.screens?.length > 0, JSON.stringify(data).slice(0, 120));
  }
  {
    const { status, data } = await api('GET', '/api/admin/recent-bookings', { token: adminToken });
    check('recent bookings returns rows', status === 200 && Array.isArray(data.bookings), `got ${status}`);
  }

  // ---------------------------------------------------------------
  section('Cleanup');
  {
    const { status } = await api('DELETE', `/api/movies/${newMovieId}`, { token: adminToken });
    check('admin can delete an unbooked movie', status === 200, `got ${status}`);
  }
  {
    const { status } = await api('DELETE', `/api/showtimes/${showtimeId}`, { token: adminToken });
    check('cannot delete a showtime with bookings (409)', status === 409, `got ${status}`);
  }
  {
    const { status } = await api('DELETE', `/api/showtimes/${clashShowId}`, { token: adminToken });
    check('admin can delete an unbooked showtime', status === 200, `got ${status}`);
  }
  {
    const { status } = await api('DELETE', `/api/movies/${movieId}`, { token: adminToken });
    check('cannot delete a movie with bookings (409)', status === 409, `got ${status}`);
  }
  {
    const { status } = await api('GET', '/api/nope');
    check('unknown endpoint is a JSON 404', status === 404, `got ${status}`);
  }

  // ---------------------------------------------------------------
  console.log(`\n${'='.repeat(58)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`\n  Failing checks:`);
    failures.forEach((f) => console.log(`    - ${f}`));
  }
  console.log('='.repeat(58));
  console.log('\nThis run created real rows. Use `npm run db:reset` to restore the seed.\n');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err);
  process.exit(1);
});
