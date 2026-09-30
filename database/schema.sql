-- ============================================================
--  CineHall — Database Schema
--  Transcribed from DB_DESIGN/DB Design.pdf section 3.3
--  Target: PostgreSQL 16+
--
--  Run with:
--    psql "$DATABASE_URL" -f database/schema.sql
--
--  TWO DOCUMENTED DEVIATIONS FROM THE PDF (see database/README.md):
--    1. customer.role added — the PDF's entity list (3.1) defines User.Role
--       but its CUSTOMER table (3.3.1) omits the column.
--    2. booking_seat.showtime_id added — needed to enforce Business Rule 3
--       (double-booking prevention) with a real unique index.
-- ============================================================


-- ============================================================
-- 1. CUSTOMER
--    Login identity for customers and staff. Passwords are bcrypt
--    hashes, never plaintext, per section 3.1 "PasswordHash".
-- ============================================================
CREATE TABLE IF NOT EXISTS customer (
  customer_id  SERIAL         PRIMARY KEY,
  name         VARCHAR(100)   NOT NULL,
  email        VARCHAR(100)   UNIQUE NOT NULL,
  phone        VARCHAR(15)    UNIQUE NOT NULL,
  password     VARCHAR(255)   NOT NULL,
  -- deviation 1: role lives here because CUSTOMER is the only identity table
  role         VARCHAR(20)    NOT NULL DEFAULT 'customer'
                             CHECK (role IN ('customer','theater_admin','system_admin')),
  created_at   TIMESTAMP      NOT NULL DEFAULT now()
);

COMMENT ON TABLE  customer          IS 'Registered users: customers and staff';
COMMENT ON COLUMN customer.password IS 'bcrypt hash, never plaintext';
COMMENT ON COLUMN customer.role     IS 'customer | theater_admin | system_admin';


-- ============================================================
-- 2. THEATRE
--    Parent of every screen.
-- ============================================================
CREATE TABLE IF NOT EXISTS theatre (
  theatre_id     SERIAL        PRIMARY KEY,
  name           VARCHAR(100)  NOT NULL,
  location       VARCHAR(255)  NOT NULL,
  contact_info   VARCHAR(50)   NOT NULL,
  total_screens  INT           NOT NULL CHECK (total_screens > 0)
);

COMMENT ON TABLE theatre IS 'Physical cinema locations';


-- ============================================================
-- 3. SCREEN
--    A single auditorium inside a theatre. UNIQUE(theatre_id,
--    screen_number) stops two screens sharing a number in one theatre.
-- ============================================================
CREATE TABLE IF NOT EXISTS screen (
  screen_id         SERIAL      PRIMARY KEY,
  theatre_id        INT         NOT NULL REFERENCES theatre(theatre_id) ON DELETE CASCADE,
  screen_number     INT         NOT NULL CHECK (screen_number > 0),
  seating_capacity  INT         NOT NULL CHECK (seating_capacity > 0),
  UNIQUE (theatre_id, screen_number)
);

COMMENT ON TABLE screen IS 'Individual auditoriums within a theatre';


-- ============================================================
-- 4. SEAT
--    One physical seat, identified by (screen_id, seat_row, seat_number).
--    seat_type is the pricing tier from section 3.1 rule 4.
--    Layout is 8 rows (A-H) x 10 seats with a centre aisle after seat 5.
--    The aisle is presentation-only, derived from seat_number > 5,
--    and is deliberately not stored.
-- ============================================================
CREATE TABLE IF NOT EXISTS seat (
  seat_id      SERIAL        PRIMARY KEY,
  screen_id    INT           NOT NULL REFERENCES screen(screen_id) ON DELETE CASCADE,
  seat_row     VARCHAR(2)    NOT NULL,
  seat_number  INT           NOT NULL CHECK (seat_number > 0),
  seat_type    VARCHAR(20)   NOT NULL CHECK (seat_type IN ('silver','gold','premium')),
  UNIQUE (screen_id, seat_row, seat_number)
);

COMMENT ON TABLE  seat           IS 'Physical seating units inside a screen';
COMMENT ON COLUMN seat.seat_type IS 'Silver, Gold or Premium tier';


-- ============================================================
-- 5. MOVIE
--    The two rating columns are NOT interchangeable:
--      certificate -> censor rating, text: U / UA / A
--      rating      -> numeric average score, 0.0 - 10.0
--    The old localStorage front end had these two swapped.
-- ============================================================
CREATE TABLE IF NOT EXISTS movie (
  movie_id     SERIAL        PRIMARY KEY,
  title        VARCHAR(150)  NOT NULL,
  genre        VARCHAR(50)   NOT NULL,
  language     VARCHAR(50)   NOT NULL,
  duration     INT           NOT NULL CHECK (duration > 0),
  certificate  VARCHAR(10)   NOT NULL CHECK (certificate IN ('U','UA','A')),
  status       VARCHAR(20)   NOT NULL CHECK (status IN ('now','upcoming')),
  synopsis     TEXT,
  rating       DECIMAL(3,1)  CHECK (rating IS NULL OR rating BETWEEN 0.0 AND 10.0)
);

COMMENT ON COLUMN movie.certificate IS 'Censor rating: U, UA, A';
COMMENT ON COLUMN movie.rating      IS 'Numeric average score, 0.0-10.0';


-- ============================================================
-- 6. SHOWTIME
--    A screening on a screen at a time. Prices are per showtime per
--    tier, per section 3.1 rule 4.
-- ============================================================
CREATE TABLE IF NOT EXISTS showtime (
  showtime_id    SERIAL        PRIMARY KEY,
  movie_id       INT           NOT NULL REFERENCES movie(movie_id)   ON DELETE CASCADE,
  screen_id      INT           NOT NULL REFERENCES screen(screen_id) ON DELETE RESTRICT,
  show_date      DATE          NOT NULL,
  show_time      TIME          NOT NULL,
  silver_price   DECIMAL(8,2)  NOT NULL CHECK (silver_price  >= 0),
  gold_price     DECIMAL(8,2)  NOT NULL CHECK (gold_price    >= 0),
  premium_price  DECIMAL(8,2)  NOT NULL CHECK (premium_price >= 0),
  -- A screen cannot host two screenings at the same date and time.
  UNIQUE (screen_id, show_date, show_time)
);

COMMENT ON TABLE  showtime               IS 'A screening of a movie on a screen at a time';
COMMENT ON COLUMN showtime.silver_price  IS 'Price for Silver seats';


-- ============================================================
-- 7. BOOKING
--    A ticket reservation. A booking row is only ever created once
--    payment succeeds, so there is no intermediate pending state.
-- ============================================================
CREATE TABLE IF NOT EXISTS booking (
  booking_id    SERIAL        PRIMARY KEY,
  customer_id   INT           NOT NULL REFERENCES customer(customer_id) ON DELETE RESTRICT,
  showtime_id   INT           NOT NULL REFERENCES showtime(showtime_id) ON DELETE RESTRICT,
  ticket_code   VARCHAR(20)   UNIQUE NOT NULL,
  booking_time  TIMESTAMP     NOT NULL DEFAULT now(),
  total_amount  DECIMAL(8,2)  NOT NULL CHECK (total_amount >= 0),
  status        VARCHAR(20)   NOT NULL DEFAULT 'confirmed'
                              CHECK (status IN ('confirmed','cancelled'))
);

COMMENT ON TABLE booking IS 'Ticket reservation transaction';


-- ============================================================
-- 8. BOOKING_SEAT
--    Resolves the many-to-many between bookings and seats.
--
--    DEVIATION 2: showtime_id is denormalised here on purpose. Without
--    it the showtime sits two joins away from the seat, so the database
--    cannot state "this seat is taken for that showtime" and Business
--    Rule 3 would only be enforceable in application code, where two
--    concurrent requests can still double-book.
--
--    uniq_seat_per_showtime states the rule declaratively. Note that
--    the API also takes a FOR UPDATE lock on the seat rows before
--    inserting, and in practice that lock is what serialises two
--    concurrent requests: the loser blocks, then finds the seat taken
--    on re-read. Dropping this index does NOT make the API double-book
--    (verified: server/smoke.js still passes without it).
--
--    The index is the second layer, and it is the layer that still
--    holds for any code path that inserts booking_seat without taking
--    the lock. database/verify.sql test [1] inserts directly, bypassing
--    the API, and is the check that fails if this index is removed.
-- ============================================================
CREATE TABLE IF NOT EXISTS booking_seat (
  booking_seat_id  SERIAL  PRIMARY KEY,
  booking_id       INT     NOT NULL REFERENCES booking(booking_id)   ON DELETE CASCADE,
  seat_id          INT     NOT NULL REFERENCES seat(seat_id)         ON DELETE RESTRICT,
  showtime_id      INT     NOT NULL REFERENCES showtime(showtime_id) ON DELETE CASCADE
);

COMMENT ON TABLE booking_seat IS 'Which physical seats a booking reserved';


-- ============================================================
-- 9. PAYMENT
--    Mock gateway record. Nothing is actually charged; this row records
--    that a payment was attempted and its outcome.
-- ============================================================
CREATE TABLE IF NOT EXISTS payment (
  payment_id      SERIAL        PRIMARY KEY,
  booking_id      INT           NOT NULL REFERENCES booking(booking_id) ON DELETE CASCADE,
  amount          DECIMAL(8,2)  NOT NULL CHECK (amount >= 0),
  payment_method  VARCHAR(30)   NOT NULL CHECK (payment_method IN ('upi','card','netbanking','cash')),
  payment_status  VARCHAR(20)   NOT NULL CHECK (payment_status IN ('success','failed','refunded')),
  payment_time    TIMESTAMP     NOT NULL DEFAULT now()
);

COMMENT ON TABLE payment IS 'Payment transaction for a booking';


-- ============================================================
-- 10. CANCELLATION
--     One row per cancellation event, keeping the booking table clean.
-- ============================================================
CREATE TABLE IF NOT EXISTS cancellation (
  cancellation_id  SERIAL       PRIMARY KEY,
  booking_id       INT          NOT NULL REFERENCES booking(booking_id) ON DELETE CASCADE,
  refund_status    VARCHAR(20)  NOT NULL CHECK (refund_status IN ('pending','refunded','rejected')),
  reason           TEXT,
  cancelled_at     TIMESTAMP    NOT NULL DEFAULT now()
);

COMMENT ON TABLE cancellation IS 'Cancellation and refund record for a booking';


-- ============================================================
--  INDEXES
--  Postgres does not index foreign keys automatically, so each one is
--  declared here. Without these, every join and cascade pays a seq scan.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_screen_theatre        ON screen(theatre_id);
CREATE INDEX IF NOT EXISTS idx_seat_screen          ON seat(screen_id);
CREATE INDEX IF NOT EXISTS idx_seat_lookup          ON seat(screen_id, seat_row, seat_number);

CREATE INDEX IF NOT EXISTS idx_showtime_movie        ON showtime(movie_id);
CREATE INDEX IF NOT EXISTS idx_showtime_screen_date ON showtime(screen_id, show_date);
CREATE INDEX IF NOT EXISTS idx_showtime_date        ON showtime(show_date);

CREATE INDEX IF NOT EXISTS idx_booking_customer      ON booking(customer_id);
CREATE INDEX IF NOT EXISTS idx_booking_showtime      ON booking(showtime_id);
CREATE INDEX IF NOT EXISTS idx_booking_status        ON booking(status);

CREATE INDEX IF NOT EXISTS idx_booking_seat_booking  ON booking_seat(booking_id);
CREATE INDEX IF NOT EXISTS idx_booking_seat_seat     ON booking_seat(seat_id);

CREATE INDEX IF NOT EXISTS idx_payment_booking       ON payment(booking_id);
CREATE INDEX IF NOT EXISTS idx_cancellation_booking  ON cancellation(booking_id);

-- Double-booking guard for Business Rule 3. This unique index is the
-- single enforcement point; the API relies on it rather than trusting
-- a prior SELECT to have found a free seat.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_seat_per_showtime
  ON booking_seat(showtime_id, seat_id);

-- A given seat may only appear once within a single booking.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_booking_seat_pair
  ON booking_seat(booking_id, seat_id);


-- ============================================================
--  SUPPORTING VIEW
--  A seat's booked status is implied by the presence of a booking_seat
--  row, so there is no is_booked column to keep in sync. This view
--  projects availability for the seat map the front end renders.
-- ============================================================
CREATE OR REPLACE VIEW seat_map AS
SELECT
  st.showtime_id,
  scr.theatre_id,
  se.screen_id,
  se.seat_id,
  se.seat_row,
  se.seat_number,
  se.seat_type,
  (bs.seat_id IS NOT NULL) AS is_booked
FROM showtime st
JOIN screen scr ON scr.screen_id = st.screen_id
JOIN seat se    ON se.screen_id  = st.screen_id
LEFT JOIN booking_seat bs
       ON bs.seat_id     = se.seat_id
      AND bs.showtime_id = st.showtime_id;

COMMENT ON VIEW seat_map IS 'Seat grid for a showtime, with per-showtime availability';
