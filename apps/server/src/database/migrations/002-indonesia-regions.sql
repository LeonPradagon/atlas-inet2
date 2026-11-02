CREATE TABLE IF NOT EXISTS indonesia_provinces (
  code text PRIMARY KEY,
  name text NOT NULL
);
CREATE TABLE IF NOT EXISTS indonesia_cities (
  code text PRIMARY KEY,
  province_code text NOT NULL REFERENCES indonesia_provinces(code),
  name text NOT NULL
);
CREATE INDEX IF NOT EXISTS indonesia_cities_province_idx ON indonesia_cities(province_code, name);
CREATE TABLE IF NOT EXISTS indonesia_districts (
  code text PRIMARY KEY,
  city_code text NOT NULL REFERENCES indonesia_cities(code),
  name text NOT NULL
);
CREATE INDEX IF NOT EXISTS indonesia_districts_city_idx ON indonesia_districts(city_code, name);
CREATE TABLE IF NOT EXISTS indonesia_subdistricts (
  code text PRIMARY KEY,
  district_code text NOT NULL REFERENCES indonesia_districts(code),
  name text NOT NULL,
  postal_code text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS indonesia_subdistricts_district_idx ON indonesia_subdistricts(district_code, name);
