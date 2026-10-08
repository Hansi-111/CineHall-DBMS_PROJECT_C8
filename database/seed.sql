-- ============================================================
--  CineHall — Seed Data
--  Mirrors the data the old localStorage DB.seed() produced, but
--  normalised: cinemas become theatres + screens, the hardcoded
--  seat map becomes real seat rows, and showtimes reference a
--  screen instead of a free-text cinema string.
--
--  Run with:
--    psql "$DATABASE_URL" -f database/seed.sql
--
--  Safe to re-run: every insert is guarded, so the file will not
--  duplicate rows.
-- ============================================================

\set ON_ERROR_STOP on

BEGIN;

-- ------------------------------------------------------------
--  Staff accounts
--  Passwords are bcrypt(cost 10) hashes, never plaintext.
--    admin@cinehall.com   / Admin@123     (system_admin)
--    manager@cinehall.com / Manager@123   (theater_admin)
--  These are demo credentials for a local student project. Change
--  them before this is deployed anywhere real.
-- ------------------------------------------------------------
INSERT INTO customer (name, email, phone, password, role)
VALUES
  ('CineHall Admin',   'admin@cinehall.com',   '+919000000001',
   '$2b$10$V8hOg3ck8yKnGoSmHk2V/OW3wr2NCR0lAKhdXdCoyJ3YbKcfjXLsK', 'system_admin'),
  ('CineHall Manager', 'manager@cinehall.com', '+919000000002',
   '$2b$10$XlGQGKXBQ6FcAT5l2o42uu/9nb5GamrveRxc2ESfqmkuh0rX3Hnh6', 'theater_admin')
ON CONFLICT (email) DO NOTHING;


-- ------------------------------------------------------------
--  Theatres and screens
--  Each theatre gets one screen of 80 seats (8 rows x 10).
--  Guarded on name rather than relying on ON CONFLICT, because
--  theatre has no unique key to conflict against.
-- ------------------------------------------------------------
INSERT INTO theatre (name, location, contact_info, total_screens)
SELECT v.name, v.location, v.contact_info, v.total_screens
FROM (VALUES
  ('CineHall Downtown',  '12 Fort Road, Bengaluru',    '+918040001001', 1),
  ('CineHall Riverside', '88 Riverfront Avenue, Kochi', '+918040001002', 1)
) AS v(name, location, contact_info, total_screens)
WHERE NOT EXISTS (
  SELECT 1 FROM theatre t WHERE t.name = v.name
);

INSERT INTO screen (theatre_id, screen_number, seating_capacity)
SELECT t.theatre_id, 1, 80
FROM theatre t
WHERE t.name IN ('CineHall Downtown', 'CineHall Riverside')
  AND NOT EXISTS (
    SELECT 1 FROM screen s
    WHERE s.theatre_id = t.theatre_id AND s.screen_number = 1
  );


-- ------------------------------------------------------------
--  Seats
--  8 rows (A-H) x 10 seats per screen, with a centre aisle after
--  seat 5. Tier layout matches the front end: the back rows are the
--  premium ones, not the front.
--      G, H  -> premium
--      C, D, E -> gold
--      A, B  -> silver
--
--  The seat_type is per-row here only because every screen uses the
--  same layout. It is stored per seat (as the PDF specifies) so a
--  future screen can have a different arrangement.
-- ------------------------------------------------------------
INSERT INTO seat (screen_id, seat_row, seat_number, seat_type)
SELECT
  sc.screen_id,
  chr(65 + gr.rn - 1) AS seat_row,   -- 1 -> 'A' ... 8 -> 'H'
  gs.sn,
  CASE
    WHEN chr(65 + gr.rn - 1) IN ('G','H')     THEN 'premium'
    WHEN chr(65 + gr.rn - 1) IN ('C','D','E') THEN 'gold'
    ELSE 'silver'
  END
FROM screen sc
CROSS JOIN generate_series(1, 8)  AS gr(rn)
CROSS JOIN generate_series(1, 10) AS gs(sn)
WHERE NOT EXISTS (
  SELECT 1 FROM seat s
  WHERE s.screen_id   = sc.screen_id
    AND s.seat_row    = chr(65 + gr.rn - 1)
    AND s.seat_number = gs.sn
);


-- ------------------------------------------------------------
--  Movies
--  certificate is the censor rating (U/UA/A), rating is the numeric
--  score. The old front end called these 'rating' and 'score'.
--  Guarded on title, since movie has no unique key either.
-- ------------------------------------------------------------
INSERT INTO movie (title, genre, language, duration, certificate, status, synopsis, rating)
SELECT v.title, v.genre, v.language, v.duration, v.certificate, v.status, v.synopsis, v.rating
FROM (VALUES
  ('Neon Horizon',      'Sci-Fi',    'English', 128, 'UA', 'now',
   'A salvage pilot uncovers a signal that predates the colonies she was born into.', 8.4::numeric),
  ('Paper Tigers',      'Drama',     'Hindi',   142, 'U',  'now',
   'Three siblings return to their childhood home to settle a debt none of them can pay alone.', 7.9::numeric),
  ('Iron Monsoon',      'Action',    'Tamil',   151, 'UA', 'now',
   'A dismantled task force reassembles for one last job before the rains cut off the city.', 8.1::numeric),
  ('The Quiet Orbit',   'Thriller',  'English', 118, 'A',  'now',
   'A station engineer realizes the silence on the comms line is not a malfunction.', 7.6::numeric),
  ('Midnight Carousel', 'Fantasy',   'English', 134, 'U',  'upcoming',
   'A travelling fair appears only on the night of a blue moon, and only to those who need it.', 8.7::numeric),
  ('Ashes of Baroda',   'Historical','Hindi',   161, 'UA', 'upcoming',
   'A court painter documents a kingdom bracing for a war it cannot win.', 8.9::numeric)
) AS v(title, genre, language, duration, certificate, status, synopsis, rating)
WHERE NOT EXISTS (
  SELECT 1 FROM movie m WHERE m.title = v.title
);


-- ------------------------------------------------------------
--  Showtimes
--  4 now-showing movies x 2 screens x 2 days = 16 rows.
--  Prices are per showtime and per tier (150 / 220 / 320), matching
--  the old seeded data.
--  Times are stored as real TIME values, not free text like '8:30 PM'.
--
--  The slots are staggered 3 hours apart, one per movie. A single
--  auditorium cannot run two films at once, so giving every movie
--  the same three time slots (as the old front end did) would trip
--  UNIQUE (screen_id, show_date, show_time) and describe a schedule
--  that is physically impossible.
--
--  The 3-hour spacing is chosen to satisfy Business Rule 2 for every
--  possible assignment of movies to slots: the longest film is
--  151 min, and 151 + a 20 min cleaning buffer = 171 min, which is
--  under the 180 min gap. So no ordering of these four films can
--  overlap, even though the slot-to-movie pairing depends on
--  SERIAL id assignment and is not pinned down by this script.
--
--      slot 1  10:00
--      slot 2  13:00
--      slot 3  16:00
--      slot 4  19:00
-- ------------------------------------------------------------
WITH now_showing AS (
  SELECT movie_id,
         row_number() OVER (ORDER BY movie_id) AS slot
  FROM movie
  WHERE status = 'now'
),
slots (slot, start_time) AS (
  VALUES (1, '10:00'), (2, '13:00'), (3, '16:00'), (4, '19:00')
)
INSERT INTO showtime (movie_id, screen_id, show_date, show_time, silver_price, gold_price, premium_price)
SELECT
  m.movie_id,
  sc.screen_id,
  CURRENT_DATE + d.offset_days,
  s.start_time::time,
  150.00, 220.00, 320.00
FROM now_showing m
JOIN slots s ON s.slot = m.slot
CROSS JOIN screen sc
CROSS JOIN (VALUES (0), (1)) AS d(offset_days)
WHERE NOT EXISTS (
  SELECT 1 FROM showtime st
  WHERE st.screen_id  = sc.screen_id
    AND st.movie_id   = m.movie_id
    AND st.show_date  = CURRENT_DATE + d.offset_days
    AND st.show_time  = s.start_time::time
);

COMMIT;


-- ============================================================
--  Quick verification
-- ============================================================
\echo ''
\echo '--- seed row counts ---'
SELECT 'customer'   AS table_name, count(*) FROM customer   UNION ALL
SELECT 'theatre',                    count(*) FROM theatre    UNION ALL
SELECT 'screen',                     count(*) FROM screen     UNION ALL
SELECT 'seat',                       count(*) FROM seat       UNION ALL
SELECT 'movie',                      count(*) FROM movie      UNION ALL
SELECT 'showtime',                   count(*) FROM showtime   UNION ALL
SELECT 'booking',                    count(*) FROM booking    UNION ALL
SELECT 'booking_seat',               count(*) FROM booking_seat UNION ALL
SELECT 'payment',                    count(*) FROM payment    UNION ALL
SELECT 'cancellation',               count(*) FROM cancellation;

\echo ''
\echo '--- seat tier layout (screen 1) ---'
SELECT seat_row,
       min(seat_type) AS tier,
       count(*)        AS seats,
       count(*) FILTER (WHERE seat_number <= 5) AS left_of_aisle,
       count(*) FILTER (WHERE seat_number >  5) AS right_of_aisle
FROM seat
WHERE screen_id = (SELECT min(screen_id) FROM screen)
GROUP BY seat_row
ORDER BY seat_row;
