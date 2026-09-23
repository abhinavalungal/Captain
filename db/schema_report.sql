-- K.R.1.S — schema report (READ-ONLY; changes nothing)
--
-- Paste into Supabase > SQL Editor and Run. Then either:
--   * click "Download CSV" and save it as  C:\Projects\K.R.1.S\db\schema_report.csv
--   * or copy the result grid and paste it into the chat.
--
-- One row per column: type, how many rows / non-null / distinct values,
-- min and max, and up to 5 example values for text columns. That is enough
-- for K.R.1.S to map every column to the right metric, unit and date field
-- without guessing. admin_users is deliberately excluded.

with t as (
  select c.table_schema, c.table_name, c.column_name, c.ordinal_position,
         c.data_type, c.is_nullable
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name in (
      'kris_dnv','kris_fueleu_final','dnv','fueleu_final','fueleu_ledger_overrides',
      'fueleu_manual_vessels','fueleu_summary','fueleu_ui_config','historicla_cb',
      'leg_wise','non_dnv','vessels')
)
select
  t.table_name                                   as "table",
  t.ordinal_position                             as pos,
  t.column_name                                  as "column",
  t.data_type                                    as type,
  t.is_nullable                                  as nullable,
  (xpath('/row/n/text()', query_to_xml(format(
     'select count(*) as n from %I.%I', t.table_schema, t.table_name), false, true, '')))[1]::text::bigint   as rows,
  (xpath('/row/n/text()', query_to_xml(format(
     'select count(%I) as n from %I.%I', t.column_name, t.table_schema, t.table_name), false, true, '')))[1]::text::bigint as non_null,
  (xpath('/row/n/text()', query_to_xml(format(
     'select count(distinct %I) as n from %I.%I', t.column_name, t.table_schema, t.table_name), false, true, '')))[1]::text::bigint as distinct_values,
  case when t.data_type in ('json','jsonb','ARRAY','USER-DEFINED','boolean') then null else
  (xpath('/row/v/text()', query_to_xml(format(
     'select min(%I)::text as v from %I.%I', t.column_name, t.table_schema, t.table_name), false, true, '')))[1]::text end as min_value,
  case when t.data_type in ('json','jsonb','ARRAY','USER-DEFINED','boolean') then null else
  (xpath('/row/v/text()', query_to_xml(format(
     'select max(%I)::text as v from %I.%I', t.column_name, t.table_schema, t.table_name), false, true, '')))[1]::text end as max_value,
  case when t.data_type in ('text','character varying','character','boolean','USER-DEFINED') then
  (xpath('/row/v/text()', query_to_xml(format(
     'select string_agg(v, '' | '') as v from (select distinct left(%I::text, 60) as v from %I.%I where %I is not null limit 5) s',
     t.column_name, t.table_schema, t.table_name, t.column_name), false, true, '')))[1]::text end as examples
from t
order by t.table_name, t.ordinal_position;
