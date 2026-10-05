#!/usr/bin/env node
/* ============================================================
   View-model checks for api.js

   smoke.js covers the server. This covers the seam between the
   server and the pages: that api.js turns API rows into the field
   names the HTML expects, and that its guards fire correctly.

   It loads api.js straight from disk into a sandbox with a fake
   localStorage and a fetch that rewrites relative URLs, because Node
   has no window and does not resolve "/api/..." the way a browser
   does. No jsdom needed: the mappers are pure functions and the
   guards only touch the storage stubs.

   Needs the server running (npm start) and the seeded database.

   Unlike smoke.js, this cleans up after itself. It creates its own
   showtime on a date far enough ahead that the 2-hour cancellation
   rule is satisfied no matter what time of day it runs -- otherwise
   the test would silently start failing once the seeded matinee
   shows pass their cutoff.

   Teardown needs direct database access, because the API cannot do
   it: booking.showtime_id is ON DELETE RESTRICT, so a showtime that
   has ever been booked can never be removed through the API. That is
   the right constraint -- it stops an admin deleting a screen's
   history -- but it means the only way to undo a booking is to
   delete the booking first, and there is no endpoint for that. So
   this test reaches for pg. It is a test; the production code under
   test never does.

   Run: npm run web:test
   ============================================================ */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Pool } = require('pg');

const API_SOURCE = path.join(__dirname, 'api.js');
const ORIGIN = 'http://localhost:3000';


/* --- the sandbox api.js is evaluated inside --- */

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear()
  };
}

/* Stands in for window.location. Assigning to .href is how api.js
   navigates, so the writes are recorded rather than performed. */
const locationStub = { href: `${ORIGIN}/index.html`, pathname: '/index.html' };
const localStorageStub = fakeStorage();
const sessionStorageStub = fakeStorage();
const toastCalls = [];

const globals = {
  localStorage: localStorageStub,
  sessionStorage: sessionStorageStub,
  location: locationStub,
  fetch: (url, opts) => fetch(new URL(url, ORIGIN).href, opts),
  toast: (msg) => toastCalls.push(msg)
};

/* api.js is a plain script, not a module, so it publishes its exports
   as globals. Evaluating it inside a function body collects them
   without needing a module system. Function declarations hoist, so
   the helper below is callable from here. */
const api = (function loadApiJs() {
  const source = fs.readFileSync(API_SOURCE, 'utf8');
  const names = [
    'api', 'ApiError', 'isApiError', 'token', 'user', 'setSession',
    'clearSession', 'isStaff', 'requireAuth', 'requireStaff',
    'toMovie', 'toShow', 'toSeat', 'toBooking', 'toTheatre',
    'toPayment', 'fmtShowTime', 'renderLoading', 'renderError',
    'escapeHtml', 'STAFF_ROLES', 'PAYMENT_METHODS'
  ].join(',');
  const factory = new Function(...Object.keys(globals), `${source}\nreturn { ${names} };`);
  return factory(...Object.values(globals));
})();


/* --- tiny runner --- */

let passed = 0;
let failed = 0;

function group(name) {
  console.log(`\n${name}`);
}

function check(name, fn) {
  try {
    const result = fn();
    /* A promise here means the check silently never asserts anything.
       Reject it loudly rather than counting it as a pass. */
    if (result && typeof result.then === 'function') {
      throw new Error('check() returned a promise -- make it async and await it');
    }
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${String(err.message).split('\n').join('\n        ')}`);
  }
}

const note = (msg) => console.log(`        ${msg}`);


/* --- fixtures --- */

/* Far enough ahead that the 2-hour cancellation window has certainly
   not opened. Seven days: outside the seeded week, and far enough
   that a test run at 23:55 still has a legal cancel. */
function futureDate() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
}

/* Awkward on purpose: non-round, and tier-ascending, so a total
   computed from the wrong tier or the wrong row cannot pass by
   coincidence. */
const TEST_PRICES = { silver_price: 137, gold_price: 211, premium_price: 349 };

/* Marks this test's rows so teardown can find them without touching
   anything else in the database. */
const TEST_TIME = '14:30';
const TEST_EMAIL_PREFIX = 'vmc.';

/* Showtimes this run created, by id. Matching on date and time
   instead would risk catching a seeded row on an unlucky day. */
const fixtureShowtimes = new Set();

/* DATABASE_URL lives in .env, same as the server reads it. Reusing it
   means the test cannot be pointed at a different database than the
   one under test by accident. */
let pool = null;
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
} catch (err) {
  /* Reported by the teardown check rather than crashing here. */
}

/* Removes everything this test creates, including rows left by an
   earlier run that failed partway.

   The order is forced by the schema: booking.showtime_id is RESTRICT,
   so the bookings have to go before the showtimes, and a booking has
   to go before its customer. Everything hanging off a booking
   (booking_seat, payment, cancellation) cascades.

   Deliberately keyed on the vmc.* customer prefix as well as on the
   showtimes this run created. Keying only on the in-memory set would
   mean a single interrupted run left rows that made every later run
   fail, first on a unique-index collision and then on the foreign key.
   This test is meant to be re-runnable at any time. */
async function destroyTestRows() {
  if (!pool) return false;

  /* Collect the showtimes to remove before deleting the bookings that
     are the only thing linking them to a test customer. */
  const { rows } = await pool.query(
    `SELECT DISTINCT showtime_id
       FROM booking
      WHERE customer_id IN (SELECT customer_id FROM customer WHERE email LIKE $1)`,
    [`${TEST_EMAIL_PREFIX}%`]
  );
  const showtimeIds = [...new Set([...fixtureShowtimes, ...rows.map((r) => r.showtime_id)])];

  if (showtimeIds.length) {
    await pool.query('DELETE FROM booking WHERE showtime_id = ANY($1::int[])', [showtimeIds]);
    await pool.query('DELETE FROM showtime WHERE showtime_id = ANY($1::int[])', [showtimeIds]);
  }
  await pool.query(
    `DELETE FROM booking
      WHERE customer_id IN (SELECT customer_id FROM customer WHERE email LIKE $1)`,
    [`${TEST_EMAIL_PREFIX}%`]
  );
  await pool.query(`DELETE FROM customer WHERE email LIKE $1`, [`${TEST_EMAIL_PREFIX}%`]);
  return true;
}

/* The date and time of a show `minutes` from now, as the DATABASE
   would spell them.

   show_date and show_time are naive wall-clock columns read in the
   database's timezone, which is not this process's timezone -- the two
   are 5.5 hours apart on this machine. Building the string from a JS
   Date here is the same mistake the API once made, and it makes the
   show land hours outside the window it was meant to land in. So the
   arithmetic happens in SQL and comes back as strings ready for the
   API, with no conversion on this side at all. */
async function dbNowPlus(minutes) {
  const { rows } = await pool.query(
    `SELECT to_char(LOCALTIMESTAMP + ($1 || ' minutes')::interval, 'YYYY-MM-DD') AS d,
            to_char(LOCALTIMESTAMP + ($1 || ' minutes')::interval, 'HH24:MI')     AS t`,
    [String(minutes)]
  );
  return { date: rows[0].d, time: rows[0].t };
}


/* --- entry point --- */

(async function main() {
  group('preflight');
  try {
    await api.api.health();
    check('server is up', () => {});
  } catch (err) {
    console.log(`\n  Cannot reach the API at ${ORIGIN}.`);
    console.log('  Start it with `npm start` in another shell, then re-run.');
    console.log(`  (${err.message})\n`);
    process.exit(1);
  }

  await checkMovies();
  await checkShowtimes();
  await checkSeatMap();
  await checkAuth();
  await checkBookingRoundTrip();
  await checkGuards();
  await checkHelpers();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();


/* ============================================================
   movies
   ============================================================ */

async function checkMovies() {
  group('movies');

  const movies = await api.api.movies();
  check('list is a non-empty array', () => assert.ok(Array.isArray(movies) && movies.length > 0));
  check('id is the integer movie_id', () => assert.ok(Number.isInteger(movies[0].id)));
  check('lang is populated from language', () => assert.ok(movies[0].lang && movies[0].lang.length));
  check('synopsis is present', () => assert.ok(movies[0].synopsis && movies[0].synopsis.length));
  note(`${movies[0].title}: rating=${movies[0].rating} score=${movies[0].score} lang=${movies[0].lang}`);

  /* The mapping most likely to be got wrong, and the one whose failure
     would be quietest. Swapped, every poster in the grid shows "UA"
     where the star rating belongs, and neither value looks wrong on
     its own. */
  check('rating holds the censor rating, not the score', () =>
    assert.ok(['U', 'UA', 'A'].includes(movies[0].rating), `got "${movies[0].rating}"`));
  check('score holds the numeric average out of 10', () =>
    assert.ok(typeof movies[0].score === 'number' && movies[0].score >= 0 && movies[0].score <= 10,
      `got ${movies[0].score}`));

  const single = await api.api.movie(movies[0].id);
  check('a single movie has the same shape as a list entry', () =>
    assert.strictEqual(single.id, movies[0].id));
  check('a single movie maps identically to its list entry', () =>
    assert.deepStrictEqual(single, movies.find((m) => m.id === single.id)));

  /* The schema allows exactly two statuses. The route used to accept
     only those two and silently ignore anything else, which meant a
     typo returned the whole catalogue wearing a 200. */
  const nowShowing = await api.api.movies('now');
  check('?status=now returns only now-showing movies', () =>
    assert.ok(nowShowing.length > 0 && nowShowing.every((m) => m.status === 'now'),
      `statuses seen: ${[...new Set(nowShowing.map((m) => m.status))]}`));
  const upcoming = await api.api.movies('upcoming');
  check('?status=upcoming returns only upcoming movies', () =>
    assert.ok(upcoming.length > 0 && upcoming.every((m) => m.status === 'upcoming'),
      `statuses seen: ${[...new Set(upcoming.map((m) => m.status))]}`));
  check('the two statuses partition the catalogue', () =>
    assert.strictEqual(nowShowing.length + upcoming.length, movies.length));

  let badStatus = null;
  try { await api.api.movies('released'); } catch (err) { badStatus = err; }
  check('an unknown status is refused rather than ignored', () => {
    assert.ok(api.isApiError(badStatus), `got ${badStatus && badStatus.constructor.name}`);
    assert.strictEqual(badStatus.status, 400, `got ${badStatus.status}`);
    assert.ok(/now, upcoming/.test(badStatus.byField().status), badStatus.byField().status);
  });
}


/* ============================================================
   showtimes
   ============================================================ */

async function checkShowtimes() {
  group('showtimes');

  const shows = await api.api.showtimes();
  check('list is a non-empty array', () => assert.ok(Array.isArray(shows) && shows.length > 0));
  check('id is the integer showtime_id', () => assert.ok(Number.isInteger(shows[0].id)));
  check('cinema holds the theatre name', () => assert.ok(shows[0].cinema && shows[0].cinema.length));
  check('screen holds the screen number', () => assert.ok(shows[0].screen));
  check('movieTitle is carried through for the admin table', () => assert.ok(shows[0].movieTitle));
  check('date is YYYY-MM-DD', () =>
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(shows[0].date), `got "${shows[0].date}"`));
  check('price is flattened to silver/gold/premium', () => {
    for (const tier of ['silver', 'gold', 'premium']) {
      assert.strictEqual(typeof shows[0].price[tier], 'number', `${tier} is ${typeof shows[0].price[tier]}`);
    }
  });
  check('time renders as "h:mm AM/PM"', () =>
    assert.ok(/^\d{1,2}:\d{2} (AM|PM)$/.test(shows[0].time), `got "${shows[0].time}"`));
  check('seatsBooked is a whole number', () => assert.ok(Number.isInteger(shows[0].seatsBooked)));
  note(`${shows[0].cinema} screen ${shows[0].screen} "${shows[0].date} ${shows[0].time}" booked=${shows[0].seatsBooked}`);

  /* show_time is a TIME column and meridiem is derived from it, so
     folding them into one display string is presentation only. The
     edge cases are what matter here: 00:30 is not "0:30 AM", and
     12:00 PM is not "12:00 AM". */
  check('12-hour folding handles midnight, noon and the tail', () => {
    const cases = [
      ['00:30', 'AM', '12:30 AM'],
      ['12:00', 'PM', '12:00 PM'],
      ['12:00', 'AM', '12:00 AM'],
      ['19:15', 'PM', '7:15 PM'],
      ['09:05', 'AM', '9:05 AM'],
      ['23:59', 'PM', '11:59 PM'],
      ['00:00', 'AM', '12:00 AM']
    ];
    for (const [clock, meridiem, want] of cases) {
      const got = api.fmtShowTime({ show_time: clock, meridiem });
      assert.strictEqual(got, want, `${clock} ${meridiem} -> "${got}", wanted "${want}"`);
    }
  });
  check('fmtShowTime survives a missing row', () => assert.strictEqual(api.fmtShowTime(undefined), ''));

  const byMovie = await api.api.showtimesForMovie(shows[0].movieId);
  check('shows for a movie all belong to that movie', () =>
    assert.ok(byMovie.length > 0 && byMovie.every((s) => s.movieId === shows[0].movieId)));

  /* The server filters past shows; re-deriving "is this past?" here
     would just re-test this machine's offset from the database's,
     which is the bug fixed in the previous commit. Asserting the
     server's own answer is the only honest version of this check. */
  const defaultList = await api.api.showtimes();
  const withPast = await api.api.showtimes({ includePast: true });
  check('include_past=1 returns at least as many showtimes as the default', () =>
    assert.ok(withPast.length >= defaultList.length,
      `default ${defaultList.length}, withPast ${withPast.length}`));

  /* An unknown id must not surface as a TypeError; a page can handle
     an empty list or an ApiError, but not a crash. */
  let unknown = null;
  try { unknown = await api.api.showtimesForMovie(999999); } catch (err) { unknown = err; }
  check('an unknown movie id yields a list or an ApiError, never a crash', () =>
    assert.ok(Array.isArray(unknown) || api.isApiError(unknown)));
}


/* ============================================================
   seat map
   ============================================================ */

async function checkSeatMap() {
  group('seat map');

  const shows = await api.api.showtimes();
  const { show, seats } = await api.api.seatmap(shows[0].id);

  check('returns every physical seat', () => assert.ok(seats.length > 0, 'no seats'));
  check('id is an integer seat_id, not a label', () => assert.ok(Number.isInteger(seats[0].id)));
  check('label is separate and human readable', () =>
    assert.ok(/^[A-H]\d+$/.test(seats[0].label), `got "${seats[0].label}"`));
  check('booked is a strict boolean', () => assert.strictEqual(typeof seats[0].booked, 'boolean'));
  check('tier is one of the three priced tiers', () =>
    assert.ok(seats.every((s) => ['silver', 'gold', 'premium'].includes(s.tier))));
  check('the mapped show is an ordinary show object', () =>
    assert.ok(Number.isInteger(show.id) && typeof show.time === 'string' && show.price.silver >= 0));

  /* Layout lives in the database, so these check the seed rather than
     the mapping. They matter anyway: the seat grid renders straight
     off these fields, and a silent change would misalign every
     screen in the app. */
  const rowOf = (r) => seats.filter((s) => s.row === r);
  check('the aisle falls after seat 5', () => {
    for (const row of ['A', 'C', 'G']) {
      const r = rowOf(row);
      if (r.length < 6) continue;
      assert.strictEqual(r[4].afterAisle, false, `${row}5 is flagged after the aisle`);
      assert.strictEqual(r[5].afterAisle, true, `${row}6 is not flagged after the aisle`);
    }
  });
  check('tiers follow G/H premium, C/D/E gold, A/B/F silver', () => {
    const expected = {
      A: 'silver', B: 'silver', C: 'gold', D: 'gold',
      E: 'gold', F: 'silver', G: 'premium', H: 'premium'
    };
    for (const [row, tier] of Object.entries(expected)) {
      const r = rowOf(row);
      if (!r.length) continue;
      assert.strictEqual(r[0].tier, tier, `row ${row} is ${r[0].tier}`);
    }
  });
  note(`${seats.length} seats across rows ${[...new Set(seats.map((s) => s.row))].join(' ')}`);
}


/* ============================================================
   session store
   ============================================================ */

async function checkAuth() {
  group('auth');

  const usr = await api.api.login('admin@cinehall.com', 'Admin@123');
  check('login returns the user', () => assert.strictEqual(usr.email, 'admin@cinehall.com'));
  check('token is stored', () => assert.ok(api.token() && api.token().length > 20));
  check('user() reads it back synchronously', () => assert.strictEqual(api.user().role, 'system_admin'));
  check('the stored user carries no password or customer_id', () => {
    const stored = api.user();
    assert.ok(!('password' in stored), 'password was persisted to localStorage');
    assert.ok(!('customer_id' in stored), 'customer_id was persisted to localStorage');
  });

  /* A failed login must not disturb a live session. It matters: the
     staff console and a customer tab are often the same browser, and
     a typo in the staff form should not sign the customer out. */
  let rejected = null;
  try {
    await api.api.login('admin@cinehall.com', 'definitely-not-the-password');
  } catch (err) { rejected = err; }
  check('a wrong password raises ApiError with status 401', () => {
    assert.ok(api.isApiError(rejected), `got ${rejected && rejected.constructor.name}`);
    assert.strictEqual(rejected.status, 401, `got ${rejected.status}`);
  });
  check('a failed login leaves the existing session intact', () => {
    assert.ok(api.token(), 'session was cleared by a failed login');
    assert.strictEqual(api.user().email, 'admin@cinehall.com');
  });

  check('clearSession drops both keys', () => {
    api.setSession('x'.repeat(40), { id: 1, email: 'tmp@example.com', role: 'customer' });
    api.clearSession();
    assert.strictEqual(api.token(), null);
    assert.strictEqual(api.user(), null);
  });

  check('a corrupt user blob reads as signed out rather than throwing', () => {
    localStorageStub.setItem('ch_user', '{not json');
    assert.strictEqual(api.user(), null);
  });
}


/* ============================================================
   booking round trip
   ============================================================ */

async function checkBookingRoundTrip() {
  group('booking round trip');

  /* checkAuth deliberately ends signed out, so sign back in. Creating
     a showtime is a staff action, and without this the round trip
     fails on a 401 that has nothing to do with what it is testing. */
  await api.api.login('admin@cinehall.com', 'Admin@123');

  /* The test owns its showtime. Booking a seeded one would tie the
     test to the seed's dates, and the cancellation below needs a
     show more than two hours out to be legal at any hour of day. */
  const base = (await api.api.showtimes())[0];
  let created = null;

  try {
    await api.api.createShowtime({
      movie_id: base.movieId,
      screen_id: base.screenId,
      show_date: futureDate(),
      show_time: TEST_TIME,
      ...TEST_PRICES
    });
    const all = await api.api.showtimes({ includePast: true });
    created = all.find((s) => s.date === futureDate() && s.time === '2:30 PM');
    assert.ok(created, 'the showtime just created is not in the list');
    fixtureShowtimes.add(created.id);
  } catch (err) {
    console.log(`\n  Could not create a test showtime: ${err.message}`);
    console.log('  Skipping the round-trip checks.\n');
    failed++;
    return;
  }

  const cleanup = async () => {
    try { await api.api.deleteShowtime(created.id); } catch { /* teardown handles it */ }
  };

  check('a created showtime keeps its own prices', () =>
    assert.deepStrictEqual(
      { silver: created.price.silver, gold: created.price.gold, premium: created.price.premium },
      { silver: TEST_PRICES.silver_price, gold: TEST_PRICES.gold_price, premium: TEST_PRICES.premium_price }
    ));

  const { seats } = await api.api.seatmap(created.id);
  const free = seats.filter((s) => !s.booked);
  check('every seat on a fresh showtime is free', () =>
    assert.strictEqual(free.length, seats.length));

  /* One silver, one premium. Two silver seats would total the same
     whichever tier the server wrongly used, so the total check below
     would prove nothing. */
  const chosen = [free.find((s) => s.tier === 'silver'), free.find((s) => s.tier === 'premium')];
  check('found a silver and a premium seat to price differently', () =>
    assert.ok(chosen.every(Boolean), 'a tier was missing from the seat map'));
  if (!chosen.every(Boolean)) { await cleanup(); return; }

  let booking = null;
  try {
    booking = await api.api.createBooking({
      showtimeId: created.id,
      seatIds: chosen.map((s) => s.id),
      paymentMethod: 'upi'
    });
  } catch (err) {
    console.log(`\n  Booking failed: ${err.message}\n`);
    failed++;
    await cleanup();
    return;
  }

  check('booking returns an integer id and a CH- ticket code', () => {
    assert.ok(Number.isInteger(booking.id));
    assert.ok(/^CH-[A-Z0-9]{4}-\d{4}$/.test(booking.code), `got "${booking.code}"`);
  });
  check('seats come back as labels for display', () =>
    assert.ok(booking.seats.length === 2 && booking.seats.every((s) => /^[A-H]\d+$/.test(s))));
  check('the total is what the server priced from each tier', () => {
    const expected = chosen.reduce((sum, s) => sum + created.price[s.tier], 0);
    assert.strictEqual(booking.total, expected, `expected ${expected}, got ${booking.total}`);
  });
  check('status starts as confirmed', () => assert.strictEqual(booking.status, 'confirmed'));
  check('canCancel is a boolean decided by the server', () =>
    assert.strictEqual(typeof booking.canCancel, 'boolean'));
  check('a booking seven days out is cancellable', () =>
    assert.strictEqual(booking.canCancel, true));

  const reread = await api.api.booking(booking.id);
  check('re-reading the booking gives the same total', () =>
    assert.strictEqual(reread.total, booking.total));
  check('re-reading it gives the same code', () =>
    assert.strictEqual(reread.code, booking.code));

  const afterBooking = await api.api.seatmap(created.id);
  check('the seat map reflects the booking immediately', () => {
    const byId = new Map(afterBooking.seats.map((s) => [s.id, s]));
    for (const s of chosen) {
      assert.strictEqual(byId.get(s.id).booked, true, `seat ${s.label} still shows free`);
    }
  });

  const listedAfter = (await api.api.showtimes({ includePast: true })).find((s) => s.id === created.id);
  check('seatsBooked counts the new booking', () =>
    assert.strictEqual(listedAfter.seatsBooked, chosen.length,
      `expected ${chosen.length}, got ${listedAfter.seatsBooked}`));

  const mine = await api.api.bookings();
  check('the list contains the new booking', () =>
    assert.ok(mine.some((b) => b.id === booking.id)));

  const byCode = await api.api.bookings({ q: booking.code });
  check('?q= finds it by ticket code', () => assert.ok(byCode.some((b) => b.code === booking.code)));

  /* % and _ have to stay literal. Unescaped, they are wildcards and a
     lone % would match every booking. */
  const wildcard = await api.api.bookings({ q: '%' });
  check('a bare % matches nothing rather than everything', () =>
    assert.strictEqual(wildcard.length, 0, `${wildcard.length} rows matched`));

  /* The rule the client used to reimplement, badly. */
  const cancelled = await api.api.cancelBooking(booking.id, 'view-model check');
  check('cancel returns the booking as cancelled', () =>
    assert.strictEqual(cancelled.status, 'cancelled'));
  check('a cancelled booking is no longer cancellable', () =>
    assert.strictEqual(cancelled.canCancel, false));

  const freed = await api.api.seatmap(created.id);
  check('cancelling releases the seats', () => {
    const byId = new Map(freed.seats.map((s) => [s.id, s]));
    for (const s of chosen) {
      assert.strictEqual(byId.get(s.id).booked, false, `seat ${s.label} is still booked`);
    }
  });

  const listedFinal = (await api.api.showtimes({ includePast: true })).find((s) => s.id === created.id);
  check('seatsBooked drops back to zero after cancelling', () =>
    assert.strictEqual(listedFinal.seatsBooked, 0, `got ${listedFinal.seatsBooked}`));

  let twice = null;
  try { await api.api.cancelBooking(booking.id, 'again'); } catch (err) { twice = err; }
  check('cancelling twice is refused with 409', () => {
    assert.ok(api.isApiError(twice), `got ${twice && twice.constructor.name}`);
    assert.strictEqual(twice.status, 409, `got ${twice.status}`);
  });

  /* Two ways to try to remove a showtime that has been booked, and
     both should fail: the booking still references it. Worth pinning,
     because the second attempt is how a leak starts. */
  let blocked = null;
  try { await api.api.deleteShowtime(created.id); } catch (err) { blocked = err; }
  check('a showtime with a booking cannot be deleted through the API', () => {
    assert.ok(api.isApiError(blocked), `got ${blocked && blocked.constructor.name}`);
    assert.strictEqual(blocked.status, 409, `got ${blocked.status}`);
  });

  /* Teardown runs last, once every fixture exists. Run earlier, it
     misses whatever the window checks create below -- which is how
     this test came to leave a customer behind on its own first run.
     Its failures are reported rather than thrown: a teardown problem
     is worth a failed check, not a stack trace that hides the 90 that
     already passed. */
  await checkCancelWindow(Boolean(pool), created);

  let teardownError = null;
  try {
    await destroyTestRows();
  } catch (err) {
    teardownError = err;
  }
  check('teardown runs cleanly', () => {
    assert.strictEqual(teardownError, null, teardownError && teardownError.message);
  });

  const afterDelete = await api.api.showtimes({ includePast: true });
  check('the test showtimes are gone once teardown has run', () =>
    assert.ok(!afterDelete.some((s) => fixtureShowtimes.has(s.id)),
      'a fixture showtime survived teardown'));

  if (pool) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM customer WHERE email LIKE $1`,
      [`${TEST_EMAIL_PREFIX}%`]
    );
    check('and no vmc.* customers are left either', () =>
      assert.strictEqual(rows[0].n, 0, `${rows[0].n} left`));
  }

  if (pool) await pool.end();
}


/* ============================================================
   the 2-hour cancellation rule, against the database's own clock
   ============================================================ */

async function checkCancelWindow(hasPool, template) {
  group('the 2-hour window is real');

  if (!hasPool || !pool) {
    console.log('  skipped: no DATABASE_URL, so the database clock is unreachable');
    return;
  }

  /* Rule 6 is a customer-facing rule: staff may cancel inside the
     window to clean up mistakes. These checks therefore have to be
     made as a customer, or the endpoint will correctly let them
     through and the test will read that as a broken rule. Creating the
     showtime, though, is a staff action -- so the loop switches
     identity at each step rather than assuming one session can do it
     all. */
  const CUSTOMER = {
    name: 'Window Check',
    email: `${TEST_EMAIL_PREFIX}w.${Date.now().toString(36)}@example.com`,
    phone: `+9186${String(Date.now()).slice(-8)}`,
    password: 'Str0ngPassw0rd'
  };
  const asAdmin = () => api.api.login('admin@cinehall.com', 'Admin@123');
  const asManager = () => api.api.login('manager@cinehall.com', 'Manager@123');

  /* Registered once, then logged back into per iteration. Registering
     inside the loop would collide with its own email on the second
     pass. */
  await api.api.register(CUSTOMER);

  /* Two showtimes either side of the 2-hour boundary: one 45 minutes
     out, which is inside it, one 3 hours out, which is not. Both are
     legal to book -- only cancellation is gated -- so this checks the
     flag and the endpoint agree with each other in each direction,
     rather than checking one value twice. */
  const cases = [
    { label: '45 minutes out (inside the window)', minutes: 45, expectCancellable: false },
    { label: '3 hours out (outside the window)', minutes: 180, expectCancellable: true }
  ];

  for (const c of cases) {
    const when = await dbNowPlus(c.minutes);
    let showtime = null;

    try {
      await asAdmin();
      await api.api.createShowtime({
        movie_id: template.movieId,
        screen_id: template.screenId,
        show_date: when.date,
        show_time: when.time,
        ...TEST_PRICES
      });
      const listed = await api.api.showtimes({ includePast: true });
      /* Match on the date and time we asked for. The API renders times
         in 12-hour form, so compare against that, not the 24-hour
         string we sent. */
      const wanted = fmtAsTwelveHour(when.time);
      showtime = listed.find((s) => s.date === when.date && s.time === wanted);
      assert.ok(showtime, `created showtime ${when.date} ${wanted} is not in the list`);
      fixtureShowtimes.add(showtime.id);
    } catch (err) {
      console.log(`  skipped ${c.label}: ${err.message}`);
      continue;
    }

    await api.api.login(CUSTOMER.email, CUSTOMER.password);

    const { seats } = await api.api.seatmap(showtime.id);
    const seat = seats.find((s) => !s.booked);
    const booking = await api.api.createBooking({
      showtimeId: showtime.id,
      seatIds: [seat.id],
      paymentMethod: 'upi'
    });

    check(`a show ${c.label} can still be booked`, () =>
      assert.strictEqual(booking.status, 'confirmed'));
    check(`a show ${c.label} reports canCancel=${c.expectCancellable}`, () =>
      assert.strictEqual(booking.canCancel, c.expectCancellable,
        `expected ${c.expectCancellable}, got ${booking.canCancel}`));

    let refused = null;
    try {
      await api.api.cancelBooking(booking.id, 'window check');
    } catch (err) { refused = err; }

    if (c.expectCancellable) {
      check('and cancelling it succeeds', () => assert.strictEqual(refused, null));
    } else {
      check('and cancelling it is refused with 409', () => {
        assert.ok(api.isApiError(refused), `got ${refused && refused.constructor.name}`);
        assert.strictEqual(refused.status, 409, `got ${refused.status}`);
        assert.ok(/2 hours/.test(refused.message), refused.message);
      });
      const reread = await api.api.booking(booking.id);
      check('the booking survives the refused cancel', () =>
        assert.strictEqual(reread.status, 'confirmed'));

      /* The flag is a customer affordance, not an absolute: staff can
         still cancel inside the window to clean up a mistake. */
      await asManager();
      const overridden = await api.api.cancelBooking(booking.id, 'staff override');
      check('but staff can override the window', () =>
        assert.strictEqual(overridden.status, 'cancelled'));
    }
  }
}

/* The API reports show_time in 12-hour form; the database sends 24.
   Used only to find a showtime the test just created in the list. */
function fmtAsTwelveHour(clock) {
  const [h, m] = clock.split(':');
  const hour = Number(h) % 12 || 12;
  return `${hour}:${m} ${Number(h) < 12 ? 'AM' : 'PM'}`;
}


/* ============================================================
   guards and errors
   ============================================================ */

async function checkGuards() {
  group('guards');

  api.setSession('x'.repeat(40), { id: 1, email: 'staff@cinehall.com', role: 'theater_admin' });
  check('requireAuth passes for a signed-in visitor', () => {
    locationStub.href = `${ORIGIN}/seats.html`;
    assert.strictEqual(api.requireAuth(), true);
    assert.strictEqual(locationStub.href, `${ORIGIN}/seats.html`, 'navigated away while signed in');
  });
  check('requireStaff passes for theater_admin', () => {
    locationStub.href = `${ORIGIN}/admin-dashboard.html`;
    assert.strictEqual(api.requireStaff(), true);
    assert.strictEqual(locationStub.href, `${ORIGIN}/admin-dashboard.html`);
  });

  api.setSession('x'.repeat(40), { id: 2, email: 'someone@example.com', role: 'customer' });
  check('isStaff is false for a customer', () => assert.strictEqual(api.isStaff(), false));
  check('requireStaff sends a customer to the staff login, not the customer one', () => {
    locationStub.href = `${ORIGIN}/admin-dashboard.html`;
    assert.strictEqual(api.requireStaff(), false);
    assert.ok(locationStub.href.endsWith('admin-login.html'), `went to ${locationStub.href}`);
  });
  check('requireStaff clears the customer session on the way out', () =>
    assert.strictEqual(api.user(), null));

  toastCalls.length = 0;
  check('requireAuth redirects an anonymous visitor and says why', () => {
    locationStub.href = `${ORIGIN}/checkout.html`;
    assert.strictEqual(api.requireAuth(), false);
    assert.ok(locationStub.href.endsWith('login.html'), `went to ${locationStub.href}`);
    assert.strictEqual(toastCalls.length, 1, 'no message was shown');
  });
  check('it remembers where the visitor was headed', () =>
    assert.strictEqual(sessionStorageStub.getItem('ch_redirect_after_login'), `${ORIGIN}/checkout.html`));

  check('STAFF_ROLES matches the schema check constraint', () =>
    assert.deepStrictEqual(api.STAFF_ROLES, ['theater_admin', 'system_admin']));

  group('errors');

  let notFound = null;
  try { await api.api.movie(999999); } catch (err) { notFound = err; }
  check('404 raises ApiError carrying the server message', () => {
    assert.ok(api.isApiError(notFound), `got ${notFound && notFound.constructor.name}`);
    assert.strictEqual(notFound.status, 404);
    assert.ok(/not found/i.test(notFound.message), notFound.message);
  });

  api.clearSession();
  let anon = null;
  try { await api.api.stats(); } catch (err) { anon = err; }
  check('no token on a staff route is 401', () => {
    assert.ok(api.isApiError(anon), `got ${anon && anon.constructor.name}`);
    assert.strictEqual(anon.status, 401, `got ${anon.status}`);
  });

  /* 401 and 403 are different problems and worth telling apart: one
     means "sign in", the other "signed in, but not as staff". Only a
     customer token can reach 403. */
  await api.api.register({
    name: 'View Model Check',
    email: `vmc.${Date.now().toString(36)}@example.com`,
    phone: `+9188${String(Date.now()).slice(-8)}`,
    password: 'Str0ngPassw0rd'
  });
  let forbidden = null;
  try { await api.api.stats(); } catch (err) { forbidden = err; }
  check('a signed-in customer on a staff route is 403', () => {
    assert.ok(api.isApiError(forbidden), `got ${forbidden && forbidden.constructor.name}`);
    assert.strictEqual(forbidden.status, 403, `got ${forbidden.status}`);
    assert.ok(/theater_admin or system_admin/.test(forbidden.message), forbidden.message);
  });

  check('validation errors come back keyed by field', () => {
    const err = new api.ApiError('Validation failed', 400, [
      { field: 'email', message: 'Enter a valid email address' },
      { field: 'password', message: 'Password must be at least 8 characters' },
      { field: 'email', message: 'duplicate' }
    ]);
    assert.deepStrictEqual(err.byField(), {
      email: 'Enter a valid email address',
      password: 'Password must be at least 8 characters'
    });
  });
}


/* ============================================================
   display helpers
   ============================================================ */

async function checkHelpers() {
  group('helpers');

  check('escapeHtml neutralises markup from database values', () => {
    assert.strictEqual(api.escapeHtml('<img src=x onerror=alert(1)>'),
      '&lt;img src=x onerror=alert(1)&gt;');
    assert.strictEqual(api.escapeHtml("O'Neil & \"co\""), 'O&#39;Neil &amp; &quot;co&quot;');
    assert.strictEqual(api.escapeHtml(null), '');
    assert.strictEqual(api.escapeHtml(undefined), '');
    assert.strictEqual(api.escapeHtml(0), '0');
  });

  check('PAYMENT_METHODS matches what POST /api/bookings accepts', () =>
    assert.deepStrictEqual(api.PAYMENT_METHODS.map((p) => p.value),
      ['upi', 'card', 'netbanking', 'cash']));

  check('renderLoading fills a target with the empty-state block', () => {
    const el = { innerHTML: '' };
    api.renderLoading(el, 'Loading seats');
    assert.ok(el.innerHTML.includes('Loading seats'));
    assert.ok(el.innerHTML.includes('empty-state'));
  });
  check('renderError escapes the server message before injecting it', () => {
    const el = { innerHTML: '' };
    api.renderError(el, new api.ApiError('<b>boom</b>', 500, []));
    assert.ok(!el.innerHTML.includes('<b>boom</b>'), 'message was injected unescaped');
    assert.ok(el.innerHTML.includes('&lt;b&gt;boom&lt;/b&gt;'));
  });
  check('renderError tolerates a missing target', () =>
    assert.doesNotThrow(() => api.renderError(null, new api.ApiError('x', 500, []))));
  check('renderLoading tolerates a missing target', () =>
    assert.doesNotThrow(() => api.renderLoading(null)));
}
