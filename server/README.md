# CineHall API

Express + PostgreSQL backend. Serves the API and the existing static
frontend from the same origin, so there is no CORS setup and no proxy in
development.

```bash
npm start          # http://localhost:3000
npm run dev        # same, with nodemon
npm run api:test   # 88 end-to-end checks against a running server
```

The server reads `DATABASE_URL` and `JWT_SECRET` from `.env` at the repo
root. See `database/README.md` for the schema and the Docker database.

---

## Conventions

- All bodies and responses are JSON.
- `Authorization: Bearer <token>` on protected routes. Tokens are HS256
  JWTs signed with `JWT_SECRET`; the payload carries `sub` (customer id)
  and `role`, and a 7 day expiry.
- Passwords are bcrypt, cost 10. They are never returned by any endpoint.
- **Prices and totals are computed on the server.** A client-supplied
  `total_amount` is ignored. `api:test` asserts this.
- `show_date` is always `YYYY-MM-DD`. `show_time` is always `HH:MM:SS` on
  the way out, and accepts `HH:MM` or `H:MM AM/PM` on the way in.
- `movie.rating` is `DECIMAL(3,1)`, so it holds **one** decimal place.
  `7.25` is stored as `7.3`. This is the PDF's schema, not a bug.
- `movie.certificate` is the censor rating (`U`, `UA`, `A`).
  `movie.rating` is the numeric average. These are unrelated.

### Status codes

| Code | Meaning |
|---|---|
| 400 | Validation failed — the body names every bad field |
| 401 | No or invalid token |
| 403 | Authenticated, but the role is not allowed |
| 404 | Not found, **or** not yours. A customer asking for someone else's booking gets 404, not 403, so the API does not confirm that the id exists |
| 409 | Conflicts a constraint: double-booked seat, duplicate email, duplicate showtime, cancelling twice |
| 500 | Unexpected server fault |

Validation errors always look like this:

```json
{ "error": "Validation failed",
  "errors": [ { "field": "show_date", "message": "Date must be YYYY-MM-DD" } ] }
```

### Roles

`customer` · `theater_admin` · `system_admin`

Reads are public. Writes need `theater_admin` or `system_admin`. The one
exception is bookings: any authenticated customer can create and cancel
**their own**, and can only read their own.

---

## Auth

### `POST /api/auth/register`
Body: `name`, `email`, `phone`, `password` (min 8).
Returns `201` with `{ token, user }`. Email is stored lowercased and
uniqueness is enforced by the database, so a duplicate returns `409`.

### `POST /api/auth/login`
Body: `email`, `password`. Email match is case-insensitive.
Returns `{ token, user }`.

### `GET /api/auth/me`
Requires a token. Returns the caller's own record.

## Movies

Public reads, admin writes. `certificate` is the censor rating.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/movies` | — | `?status=now\|upcoming` |
| `GET` | `/api/movies/:id` | — | |
| `POST` | `/api/movies` | admin | |
| `PUT` | `/api/movies/:id` | admin | Partial — omitted fields are untouched |
| `DELETE` | `/api/movies/:id` | admin | `409` if any showtime still references it |

A non-numeric `:id` returns `404`, never `500`.

## Showtimes

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/showtimes` | — | `?movie_id=`, `?screen_id=`, `?date=`, `?include_past=1` |
| `GET` | `/api/showtimes/movie/:id` | — | Scheduled showtimes for one movie |
| `GET` | `/api/showtimes/:id` | — | |
| `GET` | `/api/showtimes/:id/seatmap` | — | Every seat for the screen with its live booked/free state |
| `POST` | `/api/showtimes` | admin | `409` on duplicate screen + date + time |
| `DELETE` | `/api/showtimes/:id` | admin | `409` if any booking references it |

Each showtime carries its own `silver_price`, `gold_price`, `premium_price`,
and `seats_booked`, the number of seats held by confirmed bookings on it.

**Past shows are hidden by default.** The seed is built from
`CURRENT_DATE + offset`, so a showtime stays in the table after it has
played. Both list endpoints exclude anything whose
`show_date + show_time` has passed, so the seat picker never offers a
film that already started. `GET /api/showtimes?include_past=1` opts out,
which is what the admin console uses to show the full schedule;
`GET /api/showtimes/movie/:id` has no opt-out, since nothing in the
customer flow should link to a past show.

The seat map returns one entry per physical seat with `is_booked`. It is
computed by the `seat_map` view, so it cannot drift from `booking_seat`.

## Bookings

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/api/bookings` | any | `{ showtime_id, seat_ids: [], payment_method }` |
| `GET` | `/api/bookings` | any | Customers see their own; staff see all |
| `GET` | `/api/bookings/:id` | owner or staff | `404` for anyone else |
| `POST` | `/api/bookings/:id/cancel` | owner or staff | |

Staff listing accepts `?email=`, `?status=` and `?q=`. The free-text `q`
matches customer name, email or ticket code, with `%` and `_` escaped so
they are literal rather than wildcards. It is staff-only on purpose: a
customer's own bookings are already scoped by their token, so there is
nothing for them to search.

All four booking endpoints return the same object, including the
`is_cancellable` boolean: confirmed, and still more than
`CANCEL_WINDOW_HOURS` from the start. It is computed in SQL, in the same
expression the cancel endpoint checks, so the flag and the endpoint
cannot disagree. It used to be derived separately by the list handler
only, so a booking created by `POST` came back without it and a page
rendering straight from that response would have told the customer
their fresh booking could not be cancelled.

`is_cancellable` reflects what a *customer* may do. Staff can cancel
inside the window, which is how mistakes get cleaned up.

Creating a booking is a single transaction that:
1. locks the requested seat rows with `SELECT ... FOR UPDATE`,
2. re-checks each seat exists on that screen and is not already booked,
3. prices each seat from the showtime's tier price,
4. inserts the `confirmed` booking, its `booking_seat` rows and a
   `payment` row, generating the `CH-XXXXXX` ticket code.

Bookings are only ever created **after** payment succeeds; there is no
10-minute seat-hold state, so an abandoned checkout never strands a seat.
An empty `seat_ids`, or a seat that is not on that screen, returns `400`.
A seat taken between the list rendering and the submit returns `409` and
nothing is written. A show whose start time has already passed returns
`409` — the list endpoints hide those, so this only catches a race or a
stale client.

**Cancellation is limited to 2 hours before the show starts** (Rule 6), so
a same-day show that has already begun cannot be cancelled — `409`. A
cancelled booking gets a `cancellation` row and its `booking_seat` rows
are deleted, which releases the seats.

Two concurrent requests for the same seat produce exactly one `201` and one
`409`; `api:test` fires them in parallel and asserts that.

## Admin

Requires `theater_admin` or `system_admin`; a customer gets `403`.

| Path | Notes |
|---|---|
| `GET /api/admin/stats` | Revenue, seats sold, counts |
| `GET /api/admin/recent-bookings` | Latest bookings across all users |
| `GET /api/admin/theatres` | Theatres with their screens |

`stats` reports `revenue_confirmed` and `revenue_cancelled` as separate
figures rather than one total, so a refunded booking cannot quietly inflate
the revenue number. `seats_sold` likewise counts only confirmed bookings.

---

## Tests

`npm run api:test` runs 88 checks against a running server: auth and
validation, role enforcement, movie and showtime CRUD, seat map state,
the booking transaction, ownership isolation, the cancellation window, and
the admin dashboard.

The suite can be run repeatedly against the same database — it derives a
unique showtime slot per run and baselines the showtime count at the start
rather than hard-coding the seeded 16. It still leaves rows behind: a
customer, bookings, and the showtime those bookings reference, which the
API correctly refuses to delete while it is in use. Run
`npm run db:reset` when you want the clean seed back.

The booking and cancellation checks create their own showtime 7 days out.
The seeded shows are today and tomorrow, and today may already have
started, which would make the 2-hour cancellation rule reject them
correctly but for the wrong reason.

### Known limits

- The suite is happy-path plus the important unhappy paths. There is no
  load test and no long-running transaction test.
- Cancellation is not wired to a real payment provider, so refunds are
  recorded in `cancellation.refund_status` but never actually issued.
