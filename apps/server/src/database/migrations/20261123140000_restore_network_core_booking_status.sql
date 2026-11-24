-- Older local databases recorded the earlier migration before it added this view.
CREATE OR REPLACE VIEW network_core_booking_status AS
SELECT core.id, core.asset_id, core.core_number,
  CASE
    WHEN core.status = 'Used' OR EXISTS (
      SELECT 1 FROM booking_core_sections section
      WHERE section.core_id = core.id AND section.status = 'Used'
    ) THEN 'Used'
    WHEN core.status = 'Booked' OR EXISTS (
      SELECT 1 FROM booking_core_sections section
      WHERE section.core_id = core.id AND section.status = 'Booked'
    ) THEN 'Booked'
    ELSE core.status
  END AS status
FROM network_cores core;
