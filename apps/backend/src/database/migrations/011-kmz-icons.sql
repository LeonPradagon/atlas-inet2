CREATE TABLE IF NOT EXISTS network_kml_icons (
  id text PRIMARY KEY,
  mime_type text NOT NULL,
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
