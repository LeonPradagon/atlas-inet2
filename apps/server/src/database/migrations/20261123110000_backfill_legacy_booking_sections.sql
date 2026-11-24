-- A legacy booking did not record its range. Reserve the complete known
-- cable, preserving the original booking_cores and network_cores records.
-- Core rows with missing geometry remain guarded by their legacy status.
INSERT INTO booking_core_sections (booking_id, core_id, start_m, end_m, status)
SELECT bc.booking_id, bc.core_id, 0,
       round(ST_Length(asset.geometry::geography)::numeric, 3), booking.status
FROM booking_cores bc
JOIN bookings booking ON booking.id = bc.booking_id
JOIN network_cores core ON core.id = bc.core_id
JOIN network_assets asset ON asset.id = core.asset_id
WHERE booking.status IN ('Booked', 'Used')
  AND core.status = booking.status
  AND GeometryType(asset.geometry) = 'LINESTRING'
  AND round(ST_Length(asset.geometry::geography)::numeric, 3) > 0
  AND NOT EXISTS (
    SELECT 1 FROM booking_core_sections existing
    WHERE existing.booking_id=bc.booking_id AND existing.core_id=bc.core_id
      AND existing.status IN ('Booked', 'Used')
  );
