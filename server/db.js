'use strict';
/* ============================================================
   CineHall — database access
   Single shared pg Pool, a query helper, and a transaction
   helper used by the booking flow.
   ============================================================ */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

// A pool-level error (server restart, network drop) would otherwise
// crash the process via an unhandled 'error' event.
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

/* Runs fn inside a transaction, passing it a dedicated client.
   Commits if fn resolves, rolls back if it throws. The client is
   always released, including on failure. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The connection is already broken; the original error matters more.
      console.error('[db] rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

async function healthcheck() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0].ok === 1;
}

module.exports = { pool, query, withTransaction, healthcheck };
