-- ============================================================
--  CineHall — constraint & business rule verification
--
--  Each check deliberately attempts something invalid and confirms
--  the database rejects it.
--
--  HOW FAILURES ARE CAUGHT
--  A failing statement inside a transaction aborts the whole
--  transaction, so a naive suite either stops at the first failure
--  or needs a SAVEPOINT/ROLLBACK pair per test. Both are awkward:
--  savepoints discard the verdict, and a later test can report
--  "current transaction is aborted" for what is not a rejection.
--
--  Each test here instead runs its bad statement inside a DO block
--  with an EXCEPTION handler. A DO block runs in its own
--  subtransaction, so a constraint violation is caught locally and
--  the verdict is recorded without disturbing the outer transaction
--  or needing a savepoint. Each verdict lands in a TEMP table, and
--  the final count decides the exit status.
--
--  SELF-CONTAINED
--  The suite creates its own customer, seat, two showtimes and a
--  booking, and never reads a pre-existing booking_seat row. It
--  therefore gives the same answer on a freshly seeded database and
--  on one the running application has already written to.
--
--  Run with:
--    psql "$DATABASE_URL" -f database/verify.sql
--
--  Exit status: 0 = every constraint held, 1 = at least one failed.
-- ============================================================

\pset pager off

-- Created outside the transaction: CREATE TEMP TABLE is itself
-- transactional, so a table made inside would vanish on ROLLBACK
-- before the summary could read it.
CREATE TEMP TABLE fx_result (
  seq     INT PRIMARY KEY,
  label   TEXT,
  expect  TEXT,
  verdict TEXT CHECK (verdict IN ('PASS', 'FAIL')),
  detail  TEXT
) ON COMMIT PRESERVE ROWS;

BEGIN;

-- ------------------------------------------------------------
--  Fixture. Everything is created here so no test depends on
--  whatever rows the seed or the app happened to leave behind.
--  Seat row 'Q' does not exist in the seed, and the ticket codes
--  use a CH-FX- prefix, so both are unambiguous.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_cust   INT;
  v_screen INT;
  v_movie  INT;
  v_seat   INT;
  v_book   INT;
BEGIN
  -- 9,000,000,9xx is outside the range seed.sql uses, so this
  -- fixture can never collide with a seeded phone.
  INSERT INTO customer (name, email, phone, password)
  VALUES ('Verify Fixture', 'verify.fixture@cinehall.test', '+919000009900', 'not-a-real-hash')
  RETURNING customer_id INTO v_cust;

  SELECT screen_id INTO v_screen FROM screen ORDER BY screen_id LIMIT 1;

  SELECT min(movie_id) INTO v_movie FROM movie;

  INSERT INTO seat (screen_id, seat_row, seat_number, seat_type)
  VALUES (v_screen, 'Q', 1, 'gold')
  RETURNING seat_id INTO v_seat;

  -- Two showtimes on the same screen, same date, different times.
  -- The second one is what the "same seat on a different showtime"
  -- check needs; without it that check would report a false failure.
  INSERT INTO showtime (movie_id, screen_id, show_date, show_time, silver_price, gold_price, premium_price)
  VALUES (v_movie, v_screen, DATE '2031-03-14', TIME '10:00', 150, 220, 320),
         (v_movie, v_screen, DATE '2031-03-14', TIME '14:00', 150, 220, 320);

  INSERT INTO booking (customer_id, showtime_id, ticket_code, total_amount)
  SELECT v_cust, st.showtime_id, 'CH-FX-0001', 320.00
  FROM showtime st
  WHERE st.screen_id = v_screen AND st.show_date = DATE '2031-03-14' AND st.show_time = TIME '10:00'
  RETURNING booking_id INTO v_book;

  INSERT INTO booking_seat (booking_id, seat_id, showtime_id)
  SELECT v_book, v_seat,
         (SELECT showtime_id FROM showtime
          WHERE screen_id = v_screen AND show_date = DATE '2031-03-14' AND show_time = TIME '10:00');

  RAISE NOTICE 'fixture ready: booking % holds seat % on showtime %', v_book, v_seat,
    (SELECT showtime_id FROM showtime
     WHERE screen_id = v_screen AND show_date = DATE '2031-03-14' AND show_time = TIME '10:00');
END $$;

\echo ''
\echo '=== NEGATIVE TESTS: each MUST be rejected by a constraint ==='

-- [1] Rule 3 — one physical seat, one showtime, two bookings.
DO $$
DECLARE v_book INT; v_seat INT; v_show INT;
BEGIN
  SELECT bs.booking_id, bs.seat_id, bs.showtime_id INTO v_book, v_seat, v_show
  FROM booking_seat bs
  JOIN booking b ON b.booking_id = bs.booking_id
  WHERE b.ticket_code = 'CH-FX-0001';

  INSERT INTO booking (customer_id, showtime_id, ticket_code, total_amount)
  SELECT customer_id, v_show, 'CH-FX-0002', 320.00 FROM customer
  WHERE email = 'verify.fixture@cinehall.test'
  RETURNING booking_id INTO STRICT v_book;

  BEGIN
    INSERT INTO booking_seat (booking_id, seat_id, showtime_id) VALUES (v_book, v_seat, v_show);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO fx_result VALUES (1, 'Rule 3: same seat + same showtime in two bookings',
      'must be rejected', 'PASS', SQLERRM);
    RETURN;
  END;
  INSERT INTO fx_result VALUES (1, 'Rule 3: same seat + same showtime in two bookings',
    'must be rejected', 'FAIL', 'the insert succeeded');
END $$;

-- [2] The same seat listed twice within one booking.
DO $$
DECLARE v_book INT; v_seat INT; v_show INT;
BEGIN
  SELECT bs.booking_id, bs.seat_id, bs.showtime_id INTO v_book, v_seat, v_show
  FROM booking_seat bs JOIN booking b ON b.booking_id = bs.booking_id
  WHERE b.ticket_code = 'CH-FX-0001';

  BEGIN
    INSERT INTO booking_seat (booking_id, seat_id, showtime_id) VALUES (v_book, v_seat, v_show);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO fx_result VALUES (2, 'Same seat listed twice in one booking',
      'must be rejected', 'PASS', SQLERRM);
    RETURN;
  END;
  INSERT INTO fx_result VALUES (2, 'Same seat listed twice in one booking',
    'must be rejected', 'FAIL', 'the insert succeeded');
END $$;

-- [3] Rule 2 — a screen cannot host two shows at the same date and time.
DO $$
DECLARE v_movie INT; v_screen INT; v_date DATE; v_time TIME;
BEGIN
  SELECT movie_id, screen_id, show_date, show_time
    INTO v_movie, v_screen, v_date, v_time
  FROM showtime WHERE show_date = DATE '2031-03-14' AND show_time = TIME '10:00' LIMIT 1;

  BEGIN
    INSERT INTO showtime (movie_id, screen_id, show_date, show_time, silver_price, gold_price, premium_price)
    VALUES (v_movie, v_screen, v_date, v_time, 150, 220, 320);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO fx_result VALUES (3, 'Rule 2: two shows on one screen at one date/time',
      'must be rejected', 'PASS', SQLERRM);
    RETURN;
  END;
  INSERT INTO fx_result VALUES (3, 'Rule 2: two shows on one screen at one date/time',
    'must be rejected', 'FAIL', 'the insert succeeded');
END $$;

-- [4] Unknown seat_type.
DO $$
DECLARE v_screen INT;
BEGIN
  SELECT min(screen_id) INTO v_screen FROM screen;
  BEGIN
    INSERT INTO seat (screen_id, seat_row, seat_number, seat_type)
    VALUES (v_screen, 'Q', 9, 'platinum');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO fx_result VALUES (4, 'Unknown seat_type', 'must be rejected', 'PASS', SQLERRM);
    RETURN;
  END;
  INSERT INTO fx_result VALUES (4, 'Unknown seat_type', 'must be rejected', 'FAIL', 'the insert succeeded');
END $$;

-- [5] Duplicate physical seat (same screen, row and number).
DO $$
DECLARE v_screen INT; v_row VARCHAR(2); v_num INT;
BEGIN
  SELECT screen_id, seat_row, seat_number INTO v_screen, v_row, v_num
  FROM seat WHERE seat_row = 'Q' LIMIT 1;

  BEGIN
    INSERT INTO seat (screen_id, seat_row, seat_number, seat_type)
    VALUES (v_screen, v_row, v_num, 'gold');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO fx_result VALUES (5, 'Duplicate (screen, row, number)', 'must be rejected', 'PASS', SQLERRM);
    RETURN;
  END;
  INSERT INTO fx_result VALUES (5, 'Duplicate (screen, row, number)', 'must be rejected', 'FAIL', 'the insert succeeded');
END $$;

-- [6] movie.rating above its DECIMAL(3,1) / range limit.
DO $$
BEGIN
  BEGIN
    INSERT INTO movie (title, genre, language, duration, certificate, status, rating)
    VALUES ('Verify Bad Score', 'Drama', 'English', 90, 'U', 'now', 42.0);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO fx_result VALUES (6, 'movie.rating = 42.0 out of range', 'must be rejected', 'PASS', SQLERRM);
    RETURN;
  END;
  INSERT INTO fx_result VALUES (6, 'movie.rating = 42.0 out of range', 'must be rejected', 'FAIL', 'the insert succeeded');
END $$;

-- [7] Invalid censor certificate.
DO $$
BEGIN
  BEGIN
    INSERT INTO movie (title, genre, language, duration, certificate, status)
    VALUES ('Verify Bad Cert', 'Drama', 'English', 90, 'X', 'now');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO fx_result VALUES (7, 'Invalid censor certificate', 'must be rejected', 'PASS', SQLERRM);
    RETURN;
  END;
  INSERT INTO fx_result VALUES (7, 'Invalid censor certificate', 'must be rejected', 'FAIL', 'the insert succeeded');
END $$;

-- [8] Negative ticket price.
DO $$
DECLARE v_movie INT; v_screen INT;
BEGIN
  SELECT min(movie_id) INTO v_movie FROM movie;
  SELECT min(screen_id) INTO v_screen FROM screen;
  BEGIN
    INSERT INTO showtime (movie_id, screen_id, show_date, show_time, silver_price, gold_price, premium_price)
    VALUES (v_movie, v_screen, DATE '2031-06-01', TIME '23:00', -50.00, 220.00, 320.00);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO fx_result VALUES (8, 'Negative ticket price', 'must be rejected', 'PASS', SQLERRM);
    RETURN;
  END;
  INSERT INTO fx_result VALUES (8, 'Negative ticket price', 'must be rejected', 'FAIL', 'the insert succeeded');
END $$;

-- [9] Orphan booking pointing at a showtime that does not exist.
DO $$
DECLARE v_cust INT;
BEGIN
  SELECT customer_id INTO v_cust FROM customer WHERE email = 'verify.fixture@cinehall.test';
  BEGIN
    INSERT INTO booking (customer_id, showtime_id, ticket_code, total_amount)
    VALUES (v_cust, 999999, 'CH-FX-0009', 100.00);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO fx_result VALUES (9, 'Orphan booking (unknown showtime_id)', 'must be rejected', 'PASS', SQLERRM);
    RETURN;
  END;
  INSERT INTO fx_result VALUES (9, 'Orphan booking (unknown showtime_id)', 'must be rejected', 'FAIL', 'the insert succeeded');
END $$;

-- [10] Duplicate customer email. The phone here is deliberately unique
-- so the row can only be rejected by the email constraint; reusing the
-- fixture's phone would make the test pass for the wrong reason.
DO $$
BEGIN
  BEGIN
    INSERT INTO customer (name, email, phone, password)
    VALUES ('Verify Impostor', 'verify.fixture@cinehall.test', '+919000009901', 'x');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO fx_result VALUES (10, 'Duplicate customer email', 'must be rejected', 'PASS', SQLERRM);
    RETURN;
  END;
  INSERT INTO fx_result VALUES (10, 'Duplicate customer email', 'must be rejected', 'FAIL', 'the insert succeeded');
END $$;

\echo ''
\echo '=== POSITIVE TESTS: each MUST be accepted ==='

-- [P1] The same seat on a different showtime is legitimate.
DO $$
DECLARE v_seat INT; v_show INT; v_cust INT; v_new INT;
BEGIN
  SELECT bs.seat_id INTO v_seat FROM booking_seat bs
  JOIN booking b ON b.booking_id = bs.booking_id WHERE b.ticket_code = 'CH-FX-0001';

  SELECT customer_id INTO v_cust FROM customer WHERE email = 'verify.fixture@cinehall.test';

  SELECT showtime_id INTO v_show FROM showtime
  WHERE screen_id = (SELECT screen_id FROM showtime WHERE show_date = DATE '2031-03-14' AND show_time = TIME '10:00')
    AND show_time = TIME '14:00' LIMIT 1;

  BEGIN
    INSERT INTO booking (customer_id, showtime_id, ticket_code, total_amount)
    VALUES (v_cust, v_show, 'CH-FX-0101', 320.00) RETURNING booking_id INTO v_new;
    INSERT INTO booking_seat (booking_id, seat_id, showtime_id) VALUES (v_new, v_seat, v_show);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO fx_result VALUES (11, 'Same seat on a DIFFERENT showtime', 'must be accepted', 'FAIL', SQLERRM);
    RETURN;
  END;
  INSERT INTO fx_result VALUES (11, 'Same seat on a DIFFERENT showtime', 'must be accepted', 'PASS',
    format('seat %s reused for showtime %s', v_seat, v_show));
END $$;

-- [P2] Cancelling releases the seat so it can be re-booked.
DO $$
DECLARE v_book INT; v_seat INT; v_show INT; v_cust INT; v_new INT;
BEGIN
  SELECT bs.booking_id, bs.seat_id, bs.showtime_id INTO v_book, v_seat, v_show
  FROM booking_seat bs JOIN booking b ON b.booking_id = bs.booking_id
  WHERE b.ticket_code = 'CH-FX-0001';

  SELECT customer_id INTO v_cust FROM customer WHERE email = 'verify.fixture@cinehall.test';

  BEGIN
    UPDATE booking SET status = 'cancelled' WHERE booking_id = v_book;
    INSERT INTO cancellation (booking_id, refund_status, reason)
    VALUES (v_book, 'refunded', 'verify.sql self-test');
    DELETE FROM booking_seat WHERE booking_id = v_book;

    INSERT INTO booking (customer_id, showtime_id, ticket_code, total_amount)
    VALUES (v_cust, v_show, 'CH-FX-0102', 320.00) RETURNING booking_id INTO v_new;
    INSERT INTO booking_seat (booking_id, seat_id, showtime_id) VALUES (v_new, v_seat, v_show);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO fx_result VALUES (12, 'Cancelling releases the seat for re-booking', 'must be accepted', 'FAIL', SQLERRM);
    RETURN;
  END;
  INSERT INTO fx_result VALUES (12, 'Cancelling releases the seat for re-booking', 'must be accepted', 'PASS',
    format('seat %s re-booked by booking %s', v_seat, v_new));
END $$;

\echo ''
\echo '============================================================'
\echo ' Results'
\echo '============================================================'
SELECT seq AS "#", verdict, expect, label,
       left(regexp_replace(detail, '\s+', ' ', 'g'), 62) AS detail
FROM fx_result ORDER BY seq;

SELECT count(*) FILTER (WHERE verdict = 'FAIL') AS failed,
       count(*) FILTER (WHERE verdict = 'PASS') AS passed
FROM fx_result;

-- A missing or short results table means a test block never reached
-- the end, which is itself a failure. Without this guard an aborted
-- run leaves fx_result empty, every count reads zero, and the suite
-- would happily report success.
--
-- This runs BEFORE the ROLLBACK, while the verdicts still exist, and
-- with ON_ERROR_STOP on so a failure actually reaches the shell as a
-- non-zero exit status. psql 16 has no "\quit <code>", and earlier
-- versions of this file set ON_ERROR_STOP off throughout, which made
-- db:verify report success even while printing "TEST FAILED".
\set ON_ERROR_STOP on
DO $$
DECLARE v_rows INT; v_failed INT;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE verdict = 'FAIL') INTO v_rows, v_failed FROM fx_result;

  IF v_rows < 12 THEN
    RAISE EXCEPTION 'verify.sql is BROKEN: only % of 12 checks reported a result', v_rows;
  END IF;
  IF v_failed > 0 THEN
    RAISE EXCEPTION 'verify.sql FAILED: % of 12 constraints are not enforced', v_failed;
  END IF;
END $$;
\set ON_ERROR_STOP off

\echo ''
\echo 'RESULT: ALL 12 CONSTRAINTS ENFORCED.'

-- Undo every fixture. The temp results table survives because it was
-- created outside this transaction.
ROLLBACK;

\echo ''
\echo '--- row counts (must be unchanged: the suite leaves nothing behind) ---'
SELECT 'customer' AS t, count(*) FROM customer   UNION ALL
SELECT 'seat',       count(*) FROM seat       UNION ALL
SELECT 'showtime',   count(*) FROM showtime   UNION ALL
SELECT 'booking',    count(*) FROM booking    UNION ALL
SELECT 'booking_seat', count(*) FROM booking_seat;
