// --- Helper Utilities ---
const qs = (sel, parent = document) => parent.querySelector(sel);
const qsa = (sel, parent = document) => [...parent.querySelectorAll(sel)];

// escape text before putting it into innerHTML (names/titles come from the database)
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function getParam(name) {
  return new URLSearchParams(location.search).get(name);
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  // dates arrive as "YYYY-MM-DD"; parse as local time so the day never shifts
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function toast(msg) {
  let t = qs('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function initNavToggle() {
  const toggle = qs('.nav-toggle');
  const links = qs('.nav-links');
  if (toggle && links) toggle.addEventListener('click', () => links.classList.toggle('open'));
}

function initSidebarToggle() {
  const btn = qs('.mobile-menu-btn');
  const sidebar = qs('.admin-sidebar');
  if (btn && sidebar) btn.addEventListener('click', () => sidebar.classList.toggle('open'));
}

function requireAuth() {
  const session = DB.getSession();
  if (!session || session.role !== 'customer') {
    sessionStorage.setItem('ch_redirect_after_login', location.href);
    location.href = 'login.html';
    return false;
  }
  return true;
}

// --- Seat map (used by seats.html) ---
// seats: [{id,row,number,type,booked}] from /api/shows/:id/seats
function buildSeatMap(mapEl, show, seats, { maxSelect = 8, onChange = () => {} } = {}) {
  const selected = new Map();            // seat id -> seat
  const rows = {};
  seats.forEach(s => (rows[s.row] = rows[s.row] || []).push(s));

  mapEl.innerHTML = '';
  Object.keys(rows).sort().forEach(r => {
    const rowEl = document.createElement('div');
    rowEl.className = 'seat-row';
    rowEl.innerHTML = `<span class="row-label">${esc(r)}</span>`;

    rows[r].forEach(s => {
      const label = r + s.number;
      const el = document.createElement('div');
      el.className = 'seat ' + (s.booked ? 'booked' : 'available') + (s.type === 'Premium' ? ' premium' : '');
      el.textContent = s.number;
      el.title = `${label} · ${s.type} · ₹${show.price[s.type.toLowerCase()]}`;
      if (!s.booked) {
        el.addEventListener('click', () => {
          if (selected.has(s.id)) {
            selected.delete(s.id);
            el.classList.remove('selected');
          } else {
            if (selected.size >= maxSelect) return toast(`You can select up to ${maxSelect} seats`);
            selected.set(s.id, { ...s, label });
            el.classList.add('selected');
          }
          onChange(api.getSelected());
        });
      }
      rowEl.appendChild(el);
    });
    mapEl.appendChild(rowEl);
  });

  const api = {
    getSelected: () => [...selected.values()].map(s => s.label),
    getSelectedIds: () => [...selected.keys()],
    totalPrice: () => [...selected.values()].reduce((sum, s) => sum + Number(show.price[s.type.toLowerCase()]), 0),
  };
  return api;
}

// --- DATABASE SERVICE: talks to the Express/PostgreSQL backend ---
async function request(method, url, body) {
  const session = DB.getSession();
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(session && session.token ? { Authorization: 'Bearer ' + session.token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty body */ }

  if (res.status === 401 && session) {          // token expired / server restarted
    const wasAdmin = session.role === 'admin';
    DB.clearSession();
    location.href = wasAdmin ? 'admin-login.html' : 'login.html';
  }
  if (!res.ok) throw new Error((data && data.error) || 'Request failed');
  return data;
}

window.DB = {
  // Session (kept in the browser only; the token proves identity to the server)
  getSession() {
    const s = sessionStorage.getItem('ch_session');
    return s ? JSON.parse(s) : null;
  },
  setSession(user) { sessionStorage.setItem('ch_session', JSON.stringify(user)); },
  clearSession() { sessionStorage.removeItem('ch_session'); },

  // Auth
  async login(email, password) {
    const { token, user } = await request('POST', '/api/auth/login', { email, password });
    this.setSession({ ...user, token });
  },
  async signup(data) {
    const { token, user } = await request('POST', '/api/auth/signup', data);
    this.setSession({ ...user, token });
  },
  async adminLogin(username, password) {
    const { token, user } = await request('POST', '/api/auth/admin-login', { username, password });
    this.setSession({ ...user, token });
  },

  // Movies
  getMovies: () => request('GET', '/api/movies'),
  async getMovie(id) {
    const movies = await this.getMovies();
    return movies.find(m => String(m.id) === String(id)) || null;
  },
  saveMovie: m => m.id ? request('PUT', `/api/movies/${m.id}`, m) : request('POST', '/api/movies', m),
  deleteMovie: id => request('DELETE', `/api/movies/${id}`),

  // Shows
  getShows: () => request('GET', '/api/shows'),
  showsForMovie: movieId => request('GET', `/api/shows?movieId=${encodeURIComponent(movieId)}&upcoming=1`),
  async getShow(id) {
    try { return await request('GET', `/api/shows/${encodeURIComponent(id)}`); } catch (e) { return null; }
  },
  getSeats: showId => request('GET', `/api/shows/${encodeURIComponent(showId)}/seats`),
  getScreens: () => request('GET', '/api/screens'),
  addShow: show => request('POST', '/api/shows', show),
  deleteShow: id => request('DELETE', `/api/shows/${id}`),

  // Bookings
  getBookings: () => request('GET', '/api/bookings'),
  addBooking: data => request('POST', '/api/bookings', data),
  cancelBooking: id => request('DELETE', `/api/bookings/${id}`),
};
