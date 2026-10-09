-- CineHall schema (PostgreSQL)
-- Run:  createdb cinehall_db   then   psql -d cinehall_db -f schema.sql -f seed.sql

DROP TABLE IF EXISTS Cancellation, Payment, Booking_Seat, Booking, Customer, Seat, Showtime, Movie, Screen, Theatre CASCADE;

CREATE TABLE Theatre (
    theatre_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    location VARCHAR(255) NOT NULL,
    contact_info VARCHAR(50) NOT NULL,
    total_screens INT NOT NULL
);

CREATE TABLE Screen (
    screen_id SERIAL PRIMARY KEY,
    theatre_id INT NOT NULL REFERENCES Theatre(theatre_id) ON DELETE CASCADE,
    screen_number INT NOT NULL,
    seating_capacity INT NOT NULL,
    UNIQUE (theatre_id, screen_number)
);

CREATE TABLE Movie (
    movie_id SERIAL PRIMARY KEY,
    title VARCHAR(150) NOT NULL,
    genre VARCHAR(50) NOT NULL,
    language VARCHAR(50) NOT NULL,
    duration INT NOT NULL CHECK (duration > 0),
    certificate VARCHAR(10) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('Now Showing','Coming Soon')),
    synopsis TEXT,
    rating DECIMAL(3,1) CHECK (rating BETWEEN 0 AND 10)
);

CREATE TABLE Showtime (
    showtime_id SERIAL PRIMARY KEY,
    movie_id INT NOT NULL REFERENCES Movie(movie_id) ON DELETE CASCADE,
    screen_id INT NOT NULL REFERENCES Screen(screen_id) ON DELETE CASCADE,
    show_date DATE NOT NULL,
    show_time TIME NOT NULL,
    silver_price DECIMAL(8,2) NOT NULL,
    gold_price DECIMAL(8,2) NOT NULL,
    premium_price DECIMAL(8,2) NOT NULL,
    UNIQUE (screen_id, show_date, show_time)          -- a screen can't run two shows at once
);

CREATE TABLE Seat (
    seat_id SERIAL PRIMARY KEY,
    screen_id INT NOT NULL REFERENCES Screen(screen_id) ON DELETE CASCADE,
    seat_row VARCHAR(2) NOT NULL,
    seat_number INT NOT NULL,
    seat_type VARCHAR(20) NOT NULL CHECK (seat_type IN ('Silver','Gold','Premium')),
    UNIQUE (screen_id, seat_row, seat_number)
);

CREATE TABLE Customer (
    customer_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    phone VARCHAR(15) NOT NULL,
    password VARCHAR(255) NOT NULL                    -- stores a salted scrypt hash, never plain text
);

CREATE TABLE Booking (
    booking_id SERIAL PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES Customer(customer_id) ON DELETE CASCADE,
    showtime_id INT NOT NULL REFERENCES Showtime(showtime_id) ON DELETE CASCADE,
    ticket_code VARCHAR(20) UNIQUE NOT NULL,
    booking_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    total_amount DECIMAL(8,2) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('Confirmed','Cancelled'))
);

CREATE TABLE Booking_Seat (
    booking_seat_id SERIAL PRIMARY KEY,
    booking_id INT NOT NULL REFERENCES Booking(booking_id) ON DELETE CASCADE,
    seat_id INT NOT NULL REFERENCES Seat(seat_id) ON DELETE CASCADE,
    UNIQUE (booking_id, seat_id)
);

CREATE TABLE Payment (
    payment_id SERIAL PRIMARY KEY,
    booking_id INT NOT NULL REFERENCES Booking(booking_id) ON DELETE CASCADE,
    amount DECIMAL(8,2) NOT NULL,
    payment_method VARCHAR(30) NOT NULL CHECK (payment_method IN ('UPI','Credit Card','Debit Card')),
    payment_status VARCHAR(20) NOT NULL CHECK (payment_status IN ('Successful','Failed')),
    payment_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE Cancellation (
    cancellation_id SERIAL PRIMARY KEY,
    booking_id INT NOT NULL REFERENCES Booking(booking_id) ON DELETE CASCADE,
    refund_status VARCHAR(20) NOT NULL CHECK (refund_status IN ('Processed','Pending')),
    reason TEXT,
    cancelled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_showtime_movie ON Showtime(movie_id);
CREATE INDEX idx_booking_customer ON Booking(customer_id);
CREATE INDEX idx_booking_showtime ON Booking(showtime_id);
