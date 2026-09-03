'use strict';

const { VESSELS } = require('./config');
const sql = require('./sql');

/**
 * Access control.
 *
 * The scope is resolved from the session before any question is parsed, and
 * the resulting vessel id list is passed into every query as a bound
 * parameter. The parser is only ever shown vessels inside the scope, so a
 * vessel the user cannot see cannot be named, cannot be disambiguated
 * against, and cannot be confirmed to exist.
 *
 * Wire resolveSession() to your own auth. Everything below it is generic.
 */

/**
 * Turn a request into a session. Replace the body of this function with your
 * real auth check — a Netlify Identity JWT, a Supabase session, a signed
 * cookie, whatever Geo Monitor already uses.
 *
 * Must return null for an unauthenticated request. Returning a session with
 * an empty scope is treated as "authenticated but sees nothing", which is a
 * different and safer outcome than an error.
 */
async function resolveSession(event, deps = {}) {
  if (deps.resolveSession) return deps.resolveSession(event);

  const header = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return null;

  const verify = deps.verifyToken;
  if (typeof verify !== 'function') {
    throw new Error('Captain: no token verifier configured. Pass deps.verifyToken or deps.resolveSession.');
  }
  return verify(token);
}

/**
 * Expand a session into the concrete vessel ids it may read.
 *
 * Precedence:
 *   1. session.vesselIds  — an explicit allow-list wins outright
 *   2. session.departments — expanded via the vessels table scope column
 *   3. neither            — empty scope, and Captain says so plainly
 */
async function resolveScope(session, db) {
  if (!session) return { authenticated: false, vessels: [], vesselIds: [] };

  const scope = {
    vesselIds: Array.isArray(session.vesselIds) && session.vesselIds.length ? session.vesselIds : null,
    departments: Array.isArray(session.departments) && session.departments.length ? session.departments : null,
  };

  if (!scope.vesselIds && !scope.departments) {
    return { authenticated: true, vessels: [], vesselIds: [], reason: 'no_scope' };
  }

  const { text, values } = sql.buildVesselList(scope);
  const res = await db.query(text, values);

  const altCount = (VESSELS.altNameColumns || []).length;
  const vessels = res.rows.map((r) => {
    const altNames = [];
    for (let i = 0; i < altCount; i++) if (r[`alt_${i}`] != null) altNames.push(String(r[`alt_${i}`]));
    return { id: r.id, name: r.name, altNames };
  });

  return {
    authenticated: true,
    vessels,
    vesselIds: vessels.map((v) => v.id),
    departments: scope.departments || [],
  };
}

/**
 * Final gate before execution. The parser proposes vessel ids; this decides.
 * An id outside the scope is dropped rather than reported, so the response
 * cannot be used to probe which vessels exist.
 */
function authorizeVesselIds(requested, scope) {
  const allowed = new Set(scope.vesselIds.map(String));
  const granted = (requested || []).filter((id) => allowed.has(String(id)));
  return {
    ok: granted.length > 0,
    vesselIds: granted,
    droppedCount: (requested || []).length - granted.length,
  };
}

module.exports = { resolveSession, resolveScope, authorizeVesselIds };
