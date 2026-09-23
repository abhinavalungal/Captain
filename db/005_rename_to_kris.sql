-- ============================================================================
--  K.R.1.S — migration 005: move an existing database onto the K.R.1.S names
--
--  WHO NEEDS THIS: only a database that was set up by the release before
--  K.R.1.S. A fresh install runs 001–004, which already create everything
--  under the kris_ names; on such a database this file changes nothing.
--
--  WHAT IT DOES, in one transaction:
--    * renames every table, view, sequence and index in `public` whose name
--      starts with the previous prefix (captain_) to the kris_ prefix —
--      the two read views, the vocabulary, query-log and sync-log tables,
--      their id sequences and their indexes (constraint names follow their
--      indexes);
--    * renames the two database roles, if they exist, to kris_reader and
--      kris_writer.
--  Grants, defaults and view definitions follow the objects automatically:
--  Postgres tracks them by OID, not by name. No row is read or changed.
--
--  SAFE TO RE-RUN: an object is renamed only if the old name exists and the
--  new name does not. Anything skipped is reported as a NOTICE.
--
--  ROLE PASSWORDS: roles using SCRAM (the Postgres 14+ and Supabase default)
--  keep their password across a rename. A role still on MD5 has its password
--  cleared by the rename (the MD5 salt is the role name) — set it again with
--  ALTER ROLE kris_reader PASSWORD '...'. Run this while connected as a
--  different role (e.g. postgres), not as the role being renamed.
--
--  AFTER RUNNING: rename the environment variables to the KRIS_ prefix
--  (see README → "Upgrading an existing deployment"), then deploy. This file
--  can be deleted once it has run; nothing reads it.
--
--    psql "$DATABASE_URL" -f db/005_rename_to_kris.sql
-- ============================================================================

BEGIN;

DO $$
DECLARE
  old_prefix constant text := 'captain_';
  new_prefix constant text := 'kris_';
  r record;
  target text;
  kind text;
BEGIN
  -- Tables and views first, then sequences, then indexes, so a dependent
  -- object is never renamed before the thing it hangs off.
  FOR r IN
    SELECT c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'i')
       AND left(c.relname, length(old_prefix)) = old_prefix
     ORDER BY CASE c.relkind WHEN 'r' THEN 1 WHEN 'p' THEN 1 WHEN 'v' THEN 2 WHEN 'm' THEN 2 WHEN 'S' THEN 3 ELSE 4 END, c.relname
  LOOP
    target := new_prefix || substr(r.relname, length(old_prefix) + 1);
    kind := CASE r.relkind
              WHEN 'v' THEN 'VIEW'
              WHEN 'm' THEN 'MATERIALIZED VIEW'
              WHEN 'S' THEN 'SEQUENCE'
              WHEN 'i' THEN 'INDEX'
              ELSE 'TABLE'
            END;
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relname = target) THEN
      RAISE NOTICE 'skipped %: public.% already exists', r.relname, target;
    ELSE
      EXECUTE format('ALTER %s public.%I RENAME TO %I', kind, r.relname, target);
      RAISE NOTICE 'renamed % public.% -> %', lower(kind), r.relname, target;
    END IF;
  END LOOP;

  -- Roles (they exist only if migration 001 was run with them).
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN (old_prefix || 'reader', old_prefix || 'writer') LOOP
    target := new_prefix || substr(r.rolname, length(old_prefix) + 1);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target) THEN
      RAISE NOTICE 'skipped role %: % already exists', r.rolname, target;
    ELSE
      EXECUTE format('ALTER ROLE %I RENAME TO %I', r.rolname, target);
      RAISE NOTICE 'renamed role % -> %', r.rolname, target;
    END IF;
  END LOOP;
END
$$;

COMMIT;

-- What K.R.1.S will read and write from now on:
SELECT c.relname AS object, CASE c.relkind WHEN 'v' THEN 'view' WHEN 'S' THEN 'sequence' WHEN 'i' THEN 'index' ELSE 'table' END AS kind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname LIKE 'kris\_%'
 ORDER BY 2, 1;
