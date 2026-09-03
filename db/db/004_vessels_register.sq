-- Captain - vessel register + housekeeping tables
--
-- WHY: Captain scopes every query to the vessels a user may see (RBAC) and
-- resolves vessel names/IMOs through ONE register table. Your project has no
-- such table, so this creates it and seeds it from the vessels that already
-- appear in fueleu_final and dnv. Nothing about those two tables is changed.
--
-- Safe to re-run: creates only if missing, inserts only new IMOs. Re-run it
-- whenever new vessels appear in your data and they will be picked up.

-- 1. The register ------------------------------------------------------------
--    id          = the IMO as text (this is what every data table is joined on)
--    department  = who may see it. Change per vessel to restrict access:
--                  a user whose session lists ['Emission'] sees only vessels
--                  whose department is 'Emission'.
create table if not exists public.vessels (
  id          text primary key,
  name        text not null,
  imo         bigint,
  department  text not null default 'Emission',
  created_at  timestamptz not null default now()
);

create index if not exists vessels_department_idx on public.vessels (department);
create index if not exists vessels_imo_idx        on public.vessels (imo);

-- 2. Seed from live data ------------------------------------------------------
--    One row per IMO. If the same IMO has slightly different spellings across
--    the two source tables, the first alphabetically wins; edit later if needed.
insert into public.vessels (id, name, imo, department)
select distinct on (v.imo)
       v.imo::text,
       coalesce(nullif(trim(v.name), ''), 'IMO ' || v.imo),
       v.imo,
       'Emission'
from (
  select imo, "VesselName" as name from public.fueleu_final where imo is not null
  union all
  select imo, vessel_name       as name from public.dnv          where imo is not null
) v
order by v.imo, v.name
on conflict (id) do nothing;

-- 3. Learned vocabulary (optional but used by the "teach Captain a word" flow)
create table if not exists public.captain_term_mappings (
  id              bigserial primary key,
  org_id          text not null,
  term            text not null,
  term_normalized text not null,
  metric_key      text not null,
  created_by      text,
  active          boolean not null default true,
  hit_count       integer not null default 0,
  last_used_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, term_normalized)
);

-- 4. Query log (optional; every answer/clarify/unparsed outcome is recorded here
--    so you can see what people ask and what Captain could not answer)
create table if not exists public.captain_query_log (
  id          bigserial primary key,
  org_id      text,
  user_id     text,
  question    text,
  outcome     text,
  detail      text,
  created_at  timestamptz not null default now()
);

create index if not exists captain_query_log_created_idx on public.captain_query_log (created_at desc);

-- 5. See what got registered ---------------------------------------------------
select id, name, imo, department from public.vessels order by name;