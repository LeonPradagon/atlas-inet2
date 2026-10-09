CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS "user" (
  id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false, image text,
  role text NOT NULL DEFAULT 'PRESALES' CHECK (role IN ('ADMIN','PRESALES')),
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS session (
  id text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text, "userAgent" text, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS session_user_idx ON session("userId");
CREATE TABLE IF NOT EXISTS account (
  id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, "accessToken" text,
  "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz, scope text, password text,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_user_idx ON account("userId");
CREATE TABLE IF NOT EXISTS verification (
  id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS network_assets (
  id text PRIMARY KEY, name text NOT NULL, asset_type text NOT NULL DEFAULT 'segment',
  source text NOT NULL DEFAULT 'managed' CHECK (source IN ('managed','kml','xlsx')),
  area text NOT NULL DEFAULT '', cable_type text NOT NULL DEFAULT 'Fiber Optic',
  total_cores integer NOT NULL DEFAULT 0 CHECK (total_cores >= 0),
  installation text NOT NULL DEFAULT 'Aerial' CHECK (installation IN ('Aerial','Burial')),
  road_side text NOT NULL DEFAULT 'Kiri' CHECK (road_side IN ('Kiri','Kanan')),
  pole text NOT NULL DEFAULT '', pole_height text CHECK (pole_height IN ('7 m','9 m')), odc text NOT NULL DEFAULT '', odp text NOT NULL DEFAULT '',
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  geometry geometry(Geometry,4326), source_geometry jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE network_assets ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'managed';
ALTER TABLE network_assets ADD COLUMN IF NOT EXISTS pole_height text;
ALTER TABLE network_assets DROP CONSTRAINT IF EXISTS network_assets_source_check;
ALTER TABLE network_assets ADD CONSTRAINT network_assets_source_check CHECK (source IN ('managed','kml','xlsx'));
ALTER TABLE network_assets DROP CONSTRAINT IF EXISTS network_assets_pole_height_check;
ALTER TABLE network_assets ADD CONSTRAINT network_assets_pole_height_check CHECK (pole_height IS NULL OR pole_height IN ('7 m','9 m'));
UPDATE network_assets SET source='kml', asset_type='segment' WHERE asset_type='import';
CREATE INDEX IF NOT EXISTS network_assets_geom_idx ON network_assets USING gist(geometry);
CREATE INDEX IF NOT EXISTS network_assets_name_idx ON network_assets USING gin(to_tsvector('simple', name));

CREATE TABLE IF NOT EXISTS network_cores (
  id bigserial PRIMARY KEY, asset_id text NOT NULL REFERENCES network_assets(id) ON DELETE CASCADE,
  core_number integer NOT NULL, status text NOT NULL DEFAULT 'Available' CHECK (status IN ('Available','Booked','Used')),
  UNIQUE(asset_id, core_number)
);
CREATE INDEX IF NOT EXISTS network_cores_available_idx ON network_cores(asset_id, core_number) WHERE status='Available';
CREATE TABLE IF NOT EXISTS bookings (
  id text PRIMARY KEY, customer text NOT NULL, pic_customer text NOT NULL,
  pic_presales text NOT NULL, segment_id text NOT NULL REFERENCES network_assets(id),
  cores integer NOT NULL CHECK (cores > 0), status text NOT NULL CHECK (status IN ('Booked','Waiting List','Released','Expired')),
  requested_by text REFERENCES "user"(id), requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz, released_at timestamptz
);
CREATE INDEX IF NOT EXISTS bookings_waiting_idx ON bookings(segment_id, requested_at) WHERE status='Waiting List';
CREATE TABLE IF NOT EXISTS booking_cores (
  booking_id text NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  core_id bigint NOT NULL REFERENCES network_cores(id), PRIMARY KEY(booking_id, core_id)
);
CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY, value jsonb NOT NULL
);
INSERT INTO app_settings(key,value) VALUES ('booking_duration_days','30'::jsonb) ON CONFLICT DO NOTHING;
INSERT INTO app_settings(key,value) VALUES ('cable_name_pattern','"^AT-[A-Z]{3}-[A-Z]{3}-FO-[0-9]{3}$"'::jsonb) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS notifications (
  id bigserial PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title text NOT NULL, message text NOT NULL, read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;
CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  actor_id text REFERENCES "user"(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC, id DESC);
