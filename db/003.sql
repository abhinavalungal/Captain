-- Captain — read views over fueleu_final and dnv
--
-- These exist for one reason: Postgres identifiers with spaces or reserved
-- words ("CB at Start", "Gross CB") cannot be declared as safe SQL
-- identifiers in Captain's config (src/config.js) without weakening the
-- identifier check that makes SQL injection structurally impossible there.
-- A view sidesteps that by exposing plain snake_case names while leaving
-- the underlying tables — and whatever writes into them — untouched.
--
-- Safe to re-run. Nothing here mutates fueleu_final or dnv.

create or replace view public.captain_fueleu_final as
select
  imo,
  "VesselName"          as vessel_name,
  "VesselCode"          as vessel_code,
  "CompanyCode"         as company_code,
  "CompanyName"         as company_name,
  "VoyageNo"            as voyage_no,
  "VoyageReference"     as voyage_reference,
  "VoyageStart"         as voyage_start,
  "VoyageEnd"           as voyage_end,
  "voyage_Gross_Days"   as voyage_gross_days,
  "Offhire_Gross_Days"  as offhire_gross_days,
  "Net_Gross_Days"      as net_gross_days,
  "CB at Start"         as cb_at_start,
  "Gross CB"            as gross_cb,
  "SUDS Member"         as suds_member,
  "Remarks"             as remarks,
  oprtype
from public.fueleu_final;

create or replace view public.captain_dnv as
select
  imo,
  vessel_name,
  fueleu_reallocation_period_type  as reallocation_period_type,
  fueleu_reallocation_period       as reallocation_period,
  fueleu_reallocation_period_start as reallocation_period_start,
  fueleu_reallocation_period_end   as reallocation_period_end,
  fueleu_energy,
  actual_ghg,
  "CB"                              as compliance_balance,
  fueleu_penalty
from public.dnv;

-- Row Level Security note: if fueleu_final / dnv have RLS policies, a plain
-- view runs with the querying role's own permissions by default (it is NOT
-- security-definer), so RLS still applies. Nothing to change unless you
-- specifically want the view to bypass RLS, which you almost certainly don't.