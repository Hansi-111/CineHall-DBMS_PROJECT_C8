# CineHall — Movie Ticket Booking System

A movie ticket booking web app: a static HTML/CSS/JS front end talking to
an Express + PostgreSQL API, all served from one origin.

- **Frontend** — 13 static pages (`index.html`, `movie-details.html`,
  `seats.html`, `checkout.html`, the account pages, and the admin
  console), no build step. `api.js` is the single data layer; `script.js`
  holds UI helpers only.
- **Backend** — Express 5, PostgreSQL 16, JWT auth, bcrypt passwords.
  See [`server/README.md`](server/README.md) for the full API.
- **Database** — schema, seed and constraint tests in
  [`database/`](database/README.md).

## Run it

```bash
# 1. Start the database (Docker, on port 55432)
docker start cinehall-db

# 2. Configure the server
cp .env.example .env        # then adjust if needed

# 3. Install and start
npm install
npm start                   # http://localhost:3000
```

The app is at `http://localhost:3000`; the same server exposes `/api`.

## Test

```bash
npm run db:verify   # 12 DB constraint / business-rule checks
npm run api:test    # 112 end-to-end API checks
npm run web:test    # 94 front-end data-layer checks
```

`api:test` and `web:test` need a running server. `db:verify` does not.
All three leave rows behind; run `npm run db:reset` to restore the clean
seed.

## Demo logins

| Email | Password | Role |
|---|---|---|
| `admin@cinehall.com` | `Admin@123` | system admin |
| `manager@cinehall.com` | `Manager@123` | theater admin |

Customers can register from the sign-in page. These are throwaway local
credentials — never commit a real `.env`, and change the secrets before
deploying anywhere real.

## Layout

```
*.html, styles.css        front end (served statically by the API)
api.js                    fetch client, auth store and view models
script.js                 DOM helpers and the seat-map renderer
view-model-check.js       npm run web:test
server/                   Express app, routes, smoke tests
database/                 schema.sql, seed.sql, verify.sql, reset.sh
```