# CineHall — Database

The relational database behind CineHall, transcribed from
[`../DB_DESIGN/DB Design.pdf`](../DB_DESIGN/DB%20Design.pdf) section 3.3.

| File | Purpose |
|---|---|
| `schema.sql` | All 10 tables, constraints, indexes, plus the `seat_map` view |
| `seed.sql` | Idempotent demo data (2 theatres, 2 screens, 160 seats, 6 movies, 16 showtimes, 2 staff logins) |
| `verify.sql` | 12 tests that prove the constraints and business rules actually fire |
| `reset.sh` | Drop, recreate, reseed |

---

## Setup

The database runs in Docker so nothing needs to be installed or run with
sudo.

```bash
docker run -d --name cinehall-db \
  -e POSTGRES_PASSWORD=cinehall -e POSTGRES_USER=cinehall -e POSTGRES_DB=cinehall \
  -p 55432:5432 postgres:16-alpine
```

> **Port 55432, not 5432.** This machine already has a system PostgreSQL
> bound to `127.0.0.1:5432`, so publishing on 5432 silently fails to bind
> and `psql` ends up talking to the *host* server instead of the container.
> If the container is already running you can just `docker start cinehall-db`.

Connection string (already in the project `.env`):

```
postgresql://cinehall:cinehall@127.0.0.1:55432/cinehall
```

## Commands

```bash
npm run db:reset     # drop + recreate + seed (prompts before destroying)
npm run db:schema    # apply schema.sql only
npm run db:seed      # apply seed.sql only
npm run db:verify    # run the constraint test suite
```

`db:reset` is destructive. It asks for confirmation first.

## Demo logins

| Email | Password | Role |
|---|---|---|
| `admin@cinehall.com` | `Admin@123` | `system_admin` |
| `manager@cinehall.com` | `Manager@123` | `theater_admin` |

Passwords are stored as bcrypt hashes (cost 10). These are throwaway
credentials for a local project — change them before deploying anywhere
real, and never commit a real `.env`.

---

## Schema

10 relations, in dependency order:

```
customer ──┐
           ├── booking ──┬── booking_seat ── seat ── screen ── theatre
theatre ───┴── screen ───┘        │
                                  └── payment
                                  └── cancellation

movie ── showtime ── screen
```

`showtime` also joins to `screen`, and `booking_seat` carries a
denormalised `showtime_id` (see deviation 2 below).

### Seat layout

8 rows (`A`–`H`) × 10 seats = 80 seats per screen. There is a centre aisle
after seat 5, so every row reads 5 seats | gap | 5 seats.

The aisle is **presentation only** and is not stored. The front end derives
it from `seat_number > 5` and inserts a spacer element there.

Tier layout — the back rows are premium, the front rows are not:

| Rows | Tier |
|---|---|
| `G`, `H` | `premium` |
| `C`, `D`, `E` | `gold` |
| `A`, `B`, `F` | `silver` |

---

## The two rating columns

`movie` has two similarly named columns that are **not** interchangeable.
The old localStorage front end had these swapped, which is a trap during
migration:

| Column | Type | Meaning | Old JS field |
|---|---|---|---|
| `certificate` | `VARCHAR(10)` | Censor rating: `U`, `UA`, `A` | `movie.rating` |
| `rating` | `DECIMAL(3,1)` | Numeric average score, 0–10 | `movie.score` |

---

## Deviations from the PDF

Both are deliberate and both were flagged before implementation.

### 1. `customer.role` added

The PDF's entity list (3.1) defines `User` with
`Role (Customer, Theater Admin, System Admin)`, but its `CUSTOMER` table
(3.3.1) has no role column. Since `CUSTOMER` is the only identity table,
the role lives here. This makes the relational schema agree with the
project's own entity list rather than contradict it.

```sql
role VARCHAR(20) NOT NULL DEFAULT 'customer'
  CHECK (role IN ('customer','theater_admin','system_admin'))
```

### 2. `booking_seat.showtime_id` added

The PDF defines `BOOKING_SEAT(booking_seat_id, booking_id, seat_id)`. That
shape cannot state "this seat is taken for that showtime", because the
showtime is two joins away. Business Rule 3 (double-booking prevention)
would then only be enforceable in application code, where two concurrent
requests can still both pass a `SELECT` and both insert.

Denormalising `showtime_id` lets the database enforce it:

```sql
CREATE UNIQUE INDEX uniq_seat_per_showtime
  ON booking_seat(showtime_id, seat_id);
```

The second concurrent booking now raises `23505`, which the API will turn
into HTTP 409. Cancelling deletes the `booking_seat` rows, which releases
the seat for re-booking (test `P2` proves this round-trips).

The alternative was keeping the PDF's exact shape and enforcing the rule
with a PL/pgSQL constraint trigger. Same guarantee, more machinery.

---

## Business rules

| Rule | Enforced by | Test |
|---|---|---|
| 1. Unique email & phone | `UNIQUE` on `customer.email`, `customer.phone` | `[10]` |
| 2. No overlapping showtimes | `UNIQUE (screen_id, show_date, show_time)` | `[3]` |
| 3. No double-booking | `uniq_seat_per_showtime` | `[1]`, `[2]`, `P1` |
| 4. Tier-based pricing | `seat.seat_type` + 3 price columns on `showtime` | — |
| 6. Cancellation & refunds | `cancellation` table + seat release | `P2` |

**Rule 2 is only partially covered.** The unique index stops two screenings
starting at the *same instant* on one screen, but it does not stop a long
film overlapping a later one, because duration lives in `movie` and cannot
participate in a constraint on `showtime`. Closing that gap needs either a
`BEFORE INSERT` trigger that joins `movie.duration`, or a stored
`end_time` column. The seed data is spaced 3 hours apart, which clears the
151-minute longest film plus a 20-minute buffer for any assignment, so the
shipped schedule is genuinely overlap-free — but the database would still
accept a bad one. **This is the one known gap and it is not yet closed.**

Rule 5 (a 10-minute payment hold) is intentionally not implemented. A
booking row is only ever created once payment succeeds, so there is no
intermediate pending state to expire.

---

## Verification

`npm run db:verify` runs 12 checks: 10 that attempt something invalid and
expect a rejection, 2 that attempt something valid and expect success. It
prints a table with a `PASS`/`FAIL` verdict per check, the constraint that
fired, and then:

```
failed | passed
--------+--------
      0 |    12
RESULT: ALL 12 CONSTRAINTS ENFORCED.
```

**Exit status is meaningful: 0 when everything held, 3 when a constraint
is missing.** You can chain it:

```bash
npm run db:verify && echo "database is sound"
```

### The suite is self-contained

It creates its own customer, seat, two showtimes and a booking, and never
reads a pre-existing `booking_seat` row. It therefore gives the same
answer on a freshly seeded database and on one the running application has
already written to, so `db:verify` can be run at any point without
resetting first.

### How a failed statement is caught

A constraint violation inside a transaction aborts the whole transaction,
so a naive suite either stops at the first failure or needs a
`SAVEPOINT`/`ROLLBACK` pair per test. Both are awkward: savepoints discard
the verdict, and a later test can report "current transaction is aborted"
for what is not a rejection.

Each check instead runs its bad statement inside a `DO` block with an
`EXCEPTION` handler. A `DO` block runs in its own subtransaction, so a
violation is caught locally and recorded in a `TEMP` verdict table without
disturbing the outer transaction.

Two failure modes this specifically guards against, both of which bit
earlier versions of this file and both of which reported **success**:

- `ON_ERROR_STOP off` throughout, so `db:verify` exited 0 even while
  printing `TEST FAILED`. A missing constraint looked like a pass, and any
  CI step or `&&` chain would go green.
- Tests that read `FROM booking_seat` globally instead of from the fixture
  they had just created. Once the app had written some bookings, the test
  collided with the wrong showtime and reported a *false* "double-booking
  was allowed".

The suite now also raises `verify.sql is BROKEN: only N of 12 checks
reported a result` if any check fails to reach the end, so a half-run
suite can never be mistaken for a clean one.

### Confirming the harness itself works

The results are only worth something if a missing constraint is actually
detected. To check, drop a guard and re-run:

```bash
psql "$DATABASE_URL" -c "DROP INDEX uniq_seat_per_showtime;"
npm run db:verify; echo "exit=$?"   # check 1 FAILs, exit=3
```

Then restore the schema:

```bash
npm run db:reset
```

The same mutation test applies to the API: removing
`uniq_seat_per_showtime` does **not** make `npm run api:test` fail, because
the booking endpoint takes a `SELECT ... FOR UPDATE` lock on the seat rows
and the loser of the race finds the seat taken on re-read. The index is
the second layer, holding for any code path that inserts `booking_seat`
without taking that lock. `db:verify` inserts directly and bypasses the
API, which is why it is the check that catches the missing index. The two
suites are complementary rather than redundant.

The file finishes by printing the row counts, so you can confirm no test
data leaked.
