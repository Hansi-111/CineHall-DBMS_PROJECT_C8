'use strict';
/* ============================================================
   CineHall — request helpers shared by the route modules
   ============================================================ */

/* Path parameters are declared as plain ":id" rather than with a
   regex, because Express 5 uses path-to-regexp v8, which dropped
   the ":id(\d+)" inline-regex syntax. Validating here gives the same
   protection with one consistent message, and a bad id produces a
   clean 404 instead of a Postgres "invalid input syntax for type
   integer" error bubbling up as a 500.

   Returns true when the id is a valid integer. Sends a 404 and
   returns false otherwise, so callers can `if (!requireInt(...)) return`. */
function requireInt(req, res, name) {
  const raw = req.params.id;
  if (!/^\d+$/.test(raw)) {
    res.status(404).json({ error: 'Not found' });
    return false;
  }
  req.params.id = Number(raw);
  return true;
}

module.exports = { requireInt };
