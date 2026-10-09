
# CineHall - Movie Ticket Booking

A movie ticket booking web app built as a DBMS project. Customers can browse movies, pick showtimes, choose seats, pay (demo) and manage their bookings. Admins can manage movies, showtimes and bookings.

**Tech stack:** HTML / CSS / JavaScript (frontend), Node.js + Express (backend), PostgreSQL (database)


## 👥 Team — Group C8
| Roll No | Name |
|---|---|
| AM.SC.U4CSE25218 | Gorrela Tulasi Lasya |
| AM.SC.U4CSE25220 | Hansika L Chawla |
| AM.SC.U4CSE25234 | Mummadi Manjunadha Reddy |
| AM.SC.U4CSE25236 | Nandana Jayakumar |

## Features

**Customer**
- Browse Now Showing and Coming Soon movies
- Choose date, cinema and showtime
- Interactive seat map (Silver / Gold / Premium pricing)
- Sign up / sign in, booking checkout, ticket code
- View and cancel your own bookings

**Admin**
- Dashboard with tickets sold and revenue
- Add, edit and delete movies
- Add and remove showtimes per screen
- Search and cancel any booking

## Database

10 tables: `Theatre`, `Screen`, `Movie`, `Showtime`, `Seat`, `Customer`, `Booking`, `Booking_Seat`, `Payment`, `Cancellation`.

- `schema.sql` creates the tables
- `seed.sql` adds sample theatres, screens, seats, movies and showtimes

## Project structure

```
cinehall/
├── server.js        # Express API + PostgreSQL queries
├── package.json
├── schema.sql
├── seed.sql
└── public/          # frontend (served by Express)
    ├── index.html, movie-details.html, seats.html,
    │   checkout.html, confirmation.html, my-bookings.html,
    │   login.html, profile.html
    ├── admin-*.html, admin-shell.js
    ├── script.js    # shared helpers + API client
    └── styles.css
```

## Setup

**Requirements:** [Node.js](https://nodejs.org) and [PostgreSQL](https://www.postgresql.org/download/)

1. **Clone the repo**
   ```
   git clone https://github.com/Hansi-111/CineHall-DBMS_PROJECT_C8
   cd cinehall
   ```

2. **Create the database** (pgAdmin Query Tool also works)
   ```
   psql -U postgres -c "CREATE DATABASE cinehall_db"
   psql -U postgres -d cinehall_db -f schema.sql
   psql -U postgres -d cinehall_db -f seed.sql
   ```
   On Windows, if `psql` isn't recognised, use its full path, e.g.
   `& "C:\Program Files\PostgreSQL\16\bin\psql.exe" ...`

3. **Install dependencies**
   ```
   npm install
   ```

4. **Set your database password and start the server**

   Mac / Linux:
   ```
   DB_PASSWORD=yourpassword npm start
   ```
   Windows PowerShell:
   ```
   $env:DB_PASSWORD="yourpassword"; npm start
   ```

5. Open **http://localhost:3000** (don't open the HTML files directly).

## Configuration

Set these environment variables if your setup differs. Defaults are in brackets.

| Variable | Purpose |
|---|---|
| `DB_USER` | Postgres user (`postgres`) |
| `DB_PASSWORD` | Postgres password |
| `DB_HOST` | Database host (`localhost`) |
| `DB_PORT` | Database port (`5432`) |
| `DB_NAME` | Database name (`cinehall_db`) |
| `PORT` | Web server port (`3000`) |
| `ADMIN_USER` / `ADMIN_PASS` | Admin login (`admin` / `admin123`) |

