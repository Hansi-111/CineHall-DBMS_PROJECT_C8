-- Sample data. Showtimes are created relative to today so they never go stale.
INSERT INTO Theatre (name, location, contact_info, total_screens) VALUES
 ('CineHall Downtown', 'MG Road, Kochi', '0484-1234567', 2),
 ('CineHall Mall',     'Lulu Mall, Edappally', '0484-7654321', 1);

INSERT INTO Screen (theatre_id, screen_number, seating_capacity) VALUES
 (1,1,80),(1,2,80),(2,1,80);

-- 8 rows (A-H) x 10 seats per screen: A-C Silver, D-F Gold, G-H Premium
INSERT INTO Seat (screen_id, seat_row, seat_number, seat_type)
SELECT sc.screen_id, chr(64 + r), n,
       CASE WHEN r <= 3 THEN 'Silver' WHEN r <= 6 THEN 'Gold' ELSE 'Premium' END
FROM Screen sc, generate_series(1,8) r, generate_series(1,10) n;

INSERT INTO Movie (title, genre, language, duration, certificate, status, synopsis, rating) VALUES
 ('Starfall Odyssey','Sci-Fi','English',148,'UA','Now Showing','A crew races to reach a dying star before its light goes out.',8.4),
 ('The Last Monsoon','Drama','Malayalam',132,'U','Now Showing','A family reunites at their ancestral home during one final monsoon.',8.1),
 ('Iron Verdict','Action','Hindi',141,'UA','Now Showing','A disgraced cop has 24 hours to clear his name.',7.6),
 ('Whispers in Glass','Thriller','English',119,'A','Now Showing','A glassblower realises someone is watching every piece she makes.',7.9),
 ('Realm of Embers','Fantasy','English',155,'UA','Coming Soon','Three kingdoms, one dragon egg, and a very short truce.',0),
 ('Crown of Dust','Historical','Hindi',162,'UA','Coming Soon','The rise and fall of a desert empire.',0);

INSERT INTO Showtime (movie_id, screen_id, show_date, show_time, silver_price, gold_price, premium_price)
SELECT m, s, CURRENT_DATE + d, t::time, 150, 220, 320
FROM (VALUES (1,1),(2,2),(3,3),(4,1)) AS mv(m,s),
     generate_series(0,2) d,
     (VALUES ('10:30'),('14:00'),('18:45'),('21:30')) AS tm(t)
WHERE (m + d + EXTRACT(HOUR FROM t::time)::int) % 2 = 0     -- spreads shows so screens never overlap
ON CONFLICT DO NOTHING;
