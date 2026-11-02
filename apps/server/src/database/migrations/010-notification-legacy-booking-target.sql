UPDATE notifications AS notification
SET booking_id = (
  SELECT booking.id
  FROM bookings AS booking
  WHERE notification.message = booking.customer || ' meminta ' || booking.cores || ' core pada segmen ' || booking.segment_id || '.'
  ORDER BY abs(extract(epoch FROM notification.created_at - booking.requested_at)), booking.id
  LIMIT 1
)
WHERE notification.booking_id IS NULL
  AND notification.title = 'Persetujuan booking core diperlukan'
  AND EXISTS (
    SELECT 1
    FROM bookings AS booking
    WHERE notification.message = booking.customer || ' meminta ' || booking.cores || ' core pada segmen ' || booking.segment_id || '.'
  );
