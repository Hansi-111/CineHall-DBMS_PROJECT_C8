/* ============================================================
   CINEHALL — API client, auth store and view models

   Replaces the localStorage mock layer that used to live in
   script.js. Three separate concerns, in this order:

     1. ApiError + request()  — one fetch wrapper that knows the
        error shape the server uses.
     2. token/user/setSession  — where the JWT lives, and the
        synchronous guards that pages call before rendering.
     3. the mappers  — API rows reshaped into the field names the
        pages already use, so the markup barely changes.

   Loaded before script.js on every page. Depends on toast() from
   script.js, but only when a guard actually fires, which is always
   after both files have run.
   ============================================================ */

const API_BASE = '/api';

/* Roles the admin console accepts. The API has three roles; the old
   mock had one value, 'admin', which matched nothing in the schema. */
const STAFF_ROLES = ['theater_admin', 'system_admin'];

/* POST /api/bookings accepts exactly these. Anything else is a 400,
   so the checkout form renders its options from this list. */
const PAYMENT_METHODS = [
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'netbanking', label: 'Net banking' },
  { value: 'cash', label: 'Cash at counter' }
];

const TOKEN_KEY = 'ch_token';
const USER_KEY = 'ch_user';


/* ---------- 1. errors and transport ---------- */

/* Carries the server's status and its per-field validation messages,
   so a form can mark every bad input at once instead of one per
   round trip. See the "Validation errors" example in server/README.md. */
class ApiError extends Error {
  constructor(message, status, errors) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errors = errors || [];
  }

  /* { email: 'Enter a valid email address', ... } for rendering.
     First message wins; the server sends one per field. */
  byField() {
    const out = {};
    for (const e of this.errors) {
      if (e && e.field && !(e.field in out)) out[e.field] = e.message;
    }
    return out;
  }
}

/* Any failure worth showing the user. A thrown TypeError from fetch
   ("Failed to fetch") means the server is not running, which is a
   different problem from a 500 and deserves a different message. */
function isApiError(err) {
  return err instanceof ApiError;
}

async function request(path, opts = {}) {
  const { method = 'GET', body, auth = true } = opts;

  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';

  const jwt = token();
  if (auth && jwt) headers.authorization = `Bearer ${jwt}`;

  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new ApiError('Cannot reach the server. Is it running on port 3000?', 0);
  }

  /* 204 and some error paths have no body. Never let that throw: an
     unreadable response is still a response. */
  let data = null;
  try { data = await res.json(); } catch { /* no JSON body */ }

  if (!res.ok) {
    /* A 401 on a request that carried a token means the session died
       mid-visit. Clear it and send the user to sign in again,
       remembering where they were. Calls made with auth:false are
       deliberately exempt, otherwise a wrong password on the login
       form would redirect to the login form. */
    if (res.status === 401 && auth) {
      clearSession();
      sessionStorage.setItem('ch_redirect_after_login', location.href);
      location.href = 'login.html';
    }
    const message = (data && data.error) || `Request failed (${res.status})`;
    throw new ApiError(message, res.status, data && data.errors);
  }

  return data;
}


/* ---------- 2. session store and guards ---------- */

/* Read synchronously on purpose. The pages call requireAuth() while
   they are still deciding what to render, before any await, so a
   promise here would mean rendering first and correcting afterwards.
   The token is already in localStorage, so there is nothing to wait
   for. */

function token() {
  return localStorage.getItem(TOKEN_KEY);
}

function user() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

function setSession(jwt, usr) {
  localStorage.setItem(TOKEN_KEY, jwt);
  localStorage.setItem(USER_KEY, JSON.stringify(usr));
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  /* Also drop the old mock's key, or a stale value could be read by
     anything still looking for it. */
  localStorage.removeItem('ch_session');
}

function isStaff() {
  const u = user();
  return Boolean(u && STAFF_ROLES.includes(u.role));
}

/* True if signed in as a customer. A signed-in member of staff is
   still a valid booker — they have a customer record too — so this
   checks for the absence of a session rather than for the presence of
   a particular role. */
function requireAuth() {
  if (user()) return true;
  sessionStorage.setItem('ch_redirect_after_login', location.href);
  toast('Please sign in to book tickets');
  location.href = 'login.html';
  return false;
}

/* Guards the admin console. Distinct from requireAuth because the
   failure mode is different: a customer who lands here should go to
   the staff login, not the customer one. */
function requireStaff() {
  if (isStaff()) return true;
  clearSession();
  location.href = 'admin-login.html';
  return false;
}


/* ---------- 3. view models ---------- */

/* The API speaks the schema's vocabulary; the pages were written
   against the mock's. These translate, so that a page change is
   usually just adding `await`. */

function toMovie(m) {
  return {
    id: m.movie_id,
    title: m.title,
    genre: m.genre,
    lang: m.language,
    duration: m.duration,
    /* These two are swapped relative to the old mock, and it is the
       single easiest thing to get wrong during this migration:
       `certificate` is the censor rating (U/UA/A) and `rating` is the
       numeric average out of 10. Backwards, every poster would read
       "UA" next to a star rating of 8.4. */
    rating: m.certificate,
    score: m.rating,
    status: m.status,
    synopsis: m.synopsis
  };
}

/* "19:15" plus "PM" becomes "7:15 PM", which is the format the pages
   were already displaying. show_time is a real TIME column and
   meridiem is derived from it, so this is a display concern only. */
function fmtShowTime(s) {
  if (!s) return '';
  const clock = s.show_time || '';
  const meridiem = s.meridiem;
  if (!clock || !meridiem) return clock;
  const [h, min] = clock.split(':');
  let hour = Number(h) % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${min} ${String(meridiem).toUpperCase()}`;
}

function toShow(s) {
  return {
    id: s.showtime_id,
    movieId: s.movie_id,
    screenId: s.screen_id,
    cinema: s.theatre_name,
    screen: s.screen_number,
    date: s.show_date,
    time: fmtShowTime(s),
    price: {
      silver: s.silver_price,
      gold: s.gold_price,
      premium: s.premium_price
    },
    /* Confirmed bookings only, so a cancelled ticket does not keep
       inflating the number. */
    seatsBooked: s.seats_booked ?? 0,
    movieTitle: s.movie_title
  };
}

/* Seats come from the seat_map view as one row per physical seat.
   `id` is the integer the booking endpoint wants; `label` is only for
   showing to people. The mock used to identify a seat by its label,
   which is why these are kept apart. */
function toSeat(s) {
  return {
    id: s.seat_id,
    label: s.seat,
    row: s.row,
    number: s.number,
    afterAisle: s.after_aisle,
    tier: s.tier,
    booked: s.is_booked === true
  };
}

function toBooking(b) {
  return {
    id: b.booking_id,
    code: b.ticket_code,
    total: b.total_amount,
    seats: b.seats || [],
    status: b.status,
    /* Decided by the server against the same 2-hour rule the cancel
       endpoint enforces. The page used to compare dates in the
       browser, which ignored the time of day entirely and so offered
       to cancel shows already inside the window. */
    canCancel: b.is_cancellable === true,
    showId: b.showtime_id,
    movieId: b.movie_id,
    movieTitle: b.movie_title,
    cinema: b.theatre_name,
    screen: b.screen_number,
    date: b.show_date,
    time: fmtShowTime(b),
    name: b.customer_name,
    email: b.customer_email,
    phone: b.customer_phone,
    certificate: b.certificate,
    bookedAt: b.booking_time
  };
}

function toPayment(p) {
  return {
    status: p.payment_status,
    method: p.payment_method,
    amount: p.amount
  };
}

function toTheatre(t) {
  return {
    id: t.theatre_id,
    name: t.name,
    location: t.location,
    contact: t.contact_info,
    screens: (t.screens || []).map((sc) => ({
      id: sc.screen_id,
      number: sc.screen_number,
      capacity: sc.seating_capacity
    }))
  };
}


/* ---------- endpoints ---------- */
/* One method per route, named after what the page is doing rather
   than after the path. Everything returns the server's own envelope
   already mapped, so a caller never touches an API field name. */

const api = {
  // health
  health() { return request('/health', { auth: false }); },

  // auth
  async login(email, password) {
    const d = await request('/auth/login', {
      method: 'POST', auth: false, body: { email, password }
    });
    setSession(d.token, d.user);
    return d.user;
  },
  async register({ name, email, phone, password }) {
    const d = await request('/auth/register', {
      method: 'POST', auth: false, body: { name, email, phone, password }
    });
    setSession(d.token, d.user);
    return d.user;
  },
  me() { return request('/auth/me'); },

  // movies
  async movies(status) {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    const d = await request(`/movies${q}`);
    return d.movies.map(toMovie);
  },
  async movie(id) {
    const d = await request(`/movies/${encodeURIComponent(id)}`);
    return toMovie(d.movie);
  },
  createMovie(body) { return request('/movies', { method: 'POST', body }); },
  updateMovie(id, body) { return request(`/movies/${encodeURIComponent(id)}`, { method: 'PUT', body }); },
  deleteMovie(id) { return request(`/movies/${encodeURIComponent(id)}`, { method: 'DELETE' }); },

  // showtimes
  async showtimes({ movieId, screenId, date, includePast } = {}) {
    const q = new URLSearchParams();
    if (movieId) q.set('movie_id', movieId);
    if (screenId) q.set('screen_id', screenId);
    if (date) q.set('date', date);
    if (includePast) q.set('include_past', '1');
    const qsStr = q.toString();
    const d = await request(`/showtimes${qsStr ? `?${qsStr}` : ''}`);
    return d.showtimes.map(toShow);
  },
  async showtimesForMovie(movieId) {
    const d = await request(`/showtimes/movie/${encodeURIComponent(movieId)}`);
    return d.showtimes.map(toShow);
  },
  async showtime(id) {
    const d = await request(`/showtimes/${encodeURIComponent(id)}`);
    return toShow(d.showtime);
  },
  /* Returns the show plus every physical seat with its live state.
     `is_booked` comes from the seat_map view, so it cannot drift
     from the booking table the way the mock's bookedSeats array did. */
  async seatmap(showtimeId) {
    const d = await request(`/showtimes/${encodeURIComponent(showtimeId)}/seatmap`);
    return { show: toShow(d.showtime), seats: d.seats.map(toSeat) };
  },
  createShowtime(body) { return request('/showtimes', { method: 'POST', body }); },
  deleteShowtime(id) { return request(`/showtimes/${encodeURIComponent(id)}`, { method: 'DELETE' }); },

  // bookings
  /* seatIds must be the integer seat_id values, not the "A1" labels.
     The server prices the booking itself and ignores any total sent
     here, so there is deliberately no total in this call. */
  async createBooking({ showtimeId, seatIds, paymentMethod = 'upi' }) {
    const d = await request('/bookings', {
      method: 'POST',
      body: { showtime_id: showtimeId, seat_ids: seatIds, payment_method: paymentMethod }
    });
    return toBooking(d.booking);
  },
  async bookings({ email, status, q } = {}) {
    const query = new URLSearchParams();
    if (email) query.set('email', email);
    if (status) query.set('status', status);
    if (q) query.set('q', q);
    const qsStr = query.toString();
    const d = await request(`/bookings${qsStr ? `?${qsStr}` : ''}`);
    return d.bookings.map(toBooking);
  },
  async booking(id) {
    const d = await request(`/bookings/${encodeURIComponent(id)}`);
    return toBooking(d.booking);
  },
  async cancelBooking(id, reason) {
    const d = await request(`/bookings/${encodeURIComponent(id)}/cancel`, {
      method: 'POST', body: { reason }
    });
    return toBooking(d.booking);
  },

  // admin
  stats() { return request('/admin/stats'); },
  recentBookings(limit = 8) { return request(`/admin/recent-bookings?limit=${encodeURIComponent(limit)}`); },
  async theatres() {
    const d = await request('/admin/theatres');
    return d.theatres.map(toTheatre);
  }
};


/* ---------- rendering states ---------- */
/* Every page now loads asynchronously, so each one needs somewhere to
   show "working" and somewhere to show "it broke". Both reuse the
   .empty-state block the pages already had for their empty and
   not-found cases, so this needs no new CSS. */

function renderLoading(el, message = 'Loading…') {
  if (el) el.innerHTML = `<div class="empty-state"><p class="muted">${message}</p></div>`;
}

function renderError(el, err) {
  if (!el) return;
  const msg = isApiError(err)
    ? err.message
    : 'Something went wrong.';
  if (el) el.innerHTML = `
    <div class="empty-state">
      <div class="h-display">Something went wrong</div>
      <p>${escapeHtml(msg)}</p>
      <button class="btn btn-outline" onclick="location.reload()">Try again</button>
    </div>`;
}

/* The pages build HTML with template literals from database values,
   which means a synopsis or a customer name could inject markup. The
   mock was safe by accident because it only ever held data the same
   script had written; a real database does not make that guarantee. */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}