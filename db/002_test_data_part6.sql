-- K.R.1.S TEST DATA — PART 6 OF 6. Run the parts in order, after part 5 has finished.

BEGIN;
SET LOCAL search_path = kris;

-- ============================================================================
--  15. CURRENT POSITIONS — edit here to move a vessel on the map
--  The map and "where is ..." answers read kris.vessel_positions: each vessel's LATEST report.
--  The values below are where it already is: running this unchanged changes nothing. It can be
--  re-run on its own at any time, once the rest of the data is loaded.
--  Change lat/lon (decimal degrees: north and east positive) and course (0-359, NULL in port).
--  Keep a vessel at sea on water. "at sea / at anchor / alongside", the voyage, distance to go
--  and ETA come from the voyage and port-call rows, not from these coordinates.
-- ============================================================================
UPDATE kris.geoform_reports r
   SET latitude = p.lat, longitude = p.lon, course_deg = p.course
  FROM (VALUES
    ('1000019', -24.08441, -44.7161, 76::smallint),   -- SN Star: at sea, Santos to Rotterdam
    ('1000021', 53.61635, 8.10518, NULL::smallint)    -- SN Sky: at anchor off Wilhelmshaven
  ) AS p(imo, lat, lon, course)
 WHERE r.imo = p.imo
   AND r.report_time = (SELECT max(x.report_time) FROM kris.geoform_reports x WHERE x.imo = p.imo AND x.latitude IS NOT NULL);

COMMIT;

-- ============================================================================
--  CHECKS — what the application will show (run after the script)
-- ============================================================================
-- SELECT vessel_name, situation, latitude, longitude, voyage_no, from_port_name, to_port_name, distance_to_go_nm, eta FROM kris.vessel_positions;
-- SELECT * FROM kris.vessel_particulars;
-- SELECT vessel_name, voyage_no, from_port_name, to_port_name, status, departure_at, arrival_at, distance_nm, fuel_t, co2_t FROM kris.voyage_summary ORDER BY departure_at DESC LIMIT 10;
-- SELECT vessel_name, year, distance_nm, co2_t, aer, attained_cii, required_cii, rating, status FROM kris.cii_annual ORDER BY vessel_name, year;
-- SELECT vessel_name, year, fuel_t, hsfo_t, vlsfo_t, mgo_t, lng_t, co2_t, eu_co2_t FROM kris.annual_operations ORDER BY vessel_name, year;
-- SELECT vessel_name, year, ghg_intensity, target_intensity, compliance_balance_t, final_balance_t, penalty_eur, status FROM kris.fueleu_period WHERE period = 'YEAR';
-- SELECT vessel_name, scheme, year, emissions_in_scope_t, allowances_required, allowances_surrendered, status FROM kris.ets_obligations ORDER BY vessel_name, scheme, year;
-- SELECT vessel_name, fuel_code, rob_t FROM kris.fuel_on_board;
