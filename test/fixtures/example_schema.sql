-- ============================================================================
--  TEST FIXTURE ONLY — NOT A MIGRATION, NOT FOR PRODUCTION.
--  Fills Captain's synced tables with formula-generated rows so the suite has
--  something to query. Every number is meaningless as vessel data.
--  Run db/002_veson_geoform.sql first.
-- ============================================================================

TRUNCATE geoform_reports, veson_legs, veson_offhire, vessels RESTART IDENTITY CASCADE;

INSERT INTO vessels (id, imo, name, department) VALUES
  ('9851701', '9851701', 'Aurora Trader',  'Emission'),
  ('9234567', '9234567', 'Northern Pearl', 'Emission'),
  ('9345678', '9345678', 'Kaveri Star',    'Performance');

-- Geoform-style daily reports, 1 Jan 2026 -> 1 Sep 2026.
-- 9234567 has a gap in June so the coverage warnings can be tested.
INSERT INTO geoform_reports (imo, vessel_name, form_type, report_time, report_date, shaft_power_kw, fuel_consumed_mt,
                             me_fuel_mt, ae_fuel_mt, distance_nm, speed_kn, me_rpm, co2_mt)
SELECT
  v.id, v.name, 'noon', d + INTERVAL '12 hours', d::date,
  round((9000 + 500 * sin(extract(doy FROM d) / 12.0) + (abs(hashtext(v.id)) % 700))::numeric, 1),
  round((42 + 6 * cos(extract(doy FROM d) / 9.0) + (abs(hashtext(v.id)) % 5))::numeric, 3),
  round((36 + 5 * cos(extract(doy FROM d) / 9.0))::numeric, 3),
  round((6 + 1 * sin(extract(doy FROM d) / 7.0))::numeric, 3),
  round((320 + 40 * sin(extract(doy FROM d) / 15.0))::numeric, 1),
  round((13.4 + 1.2 * sin(extract(doy FROM d) / 15.0))::numeric, 2),
  round((78 + 4 * sin(extract(doy FROM d) / 11.0))::numeric, 1),
  round((131 + 18 * cos(extract(doy FROM d) / 9.0))::numeric, 3)
FROM vessels v
CROSS JOIN generate_series(TIMESTAMPTZ '2026-01-01 00:00Z', TIMESTAMPTZ '2026-09-01 00:00Z', INTERVAL '1 day') d
WHERE NOT (v.id = '9234567' AND d >= '2026-06-05' AND d <= '2026-06-25');

-- Veson-style legs: one leg every 9 days per vessel.
INSERT INTO veson_legs (imo, vessel_name, voyage_no, leg_no, dep_port, arr_port, dep_time, arr_time, leg_date,
                        distance_nm, fuel_mt, co2_mt, ghg_intensity, eu_scope_pct, compliance_balance)
SELECT v.id, v.name, 'V' || (row_number() OVER (PARTITION BY v.id ORDER BY d))::text, '1', 'PORT A', 'PORT B',
       d, d + INTERVAL '8 days', (d + INTERVAL '8 days')::date,
       round((2400 + 300 * sin(extract(doy FROM d) / 10.0))::numeric, 1),
       round((330 + 40 * cos(extract(doy FROM d) / 8.0))::numeric, 3),
       round((1030 + 120 * cos(extract(doy FROM d) / 8.0))::numeric, 3),
       round((89 + 3 * sin(extract(doy FROM d) / 6.0))::numeric, 2),
       50, round((-12000 + 3000 * sin(extract(doy FROM d) / 5.0))::numeric, 0)
FROM vessels v
CROSS JOIN generate_series(TIMESTAMPTZ '2026-01-01 00:00Z', TIMESTAMPTZ '2026-08-20 00:00Z', INTERVAL '9 days') d;

-- Off-hire: a few events.
INSERT INTO veson_offhire (imo, vessel_name, start_time, end_time, start_date, offhire_hours, offhire_days, reason) VALUES
  ('9851701', 'Aurora Trader', '2026-03-10 06:00Z', '2026-03-12 18:00Z', '2026-03-10', 60, 2.5, 'Drydock'),
  ('9851701', 'Aurora Trader', '2026-07-02 00:00Z', '2026-07-03 12:00Z', '2026-07-02', 36, 1.5, 'Repairs'),
  ('9234567', 'Northern Pearl', '2026-06-05 00:00Z', '2026-06-25 00:00Z', '2026-06-05', 480, 20, 'Drydock');
