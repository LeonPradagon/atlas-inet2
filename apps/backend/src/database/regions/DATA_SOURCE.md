# Indonesian administrative region data

- Provinces, regencies/cities, and districts: `provinces.json`, derived from
  `db/wilayah.sql` in <https://github.com/cahyadsn/wilayah>.
- Villages/subdistricts and postal codes: `subdistricts/*.json`, derived from
  `json/wilayah_kodepos.min.json` in <https://github.com/cahyadsn/wilayah_kodepos>.
- Both upstream datasets are MIT licensed. See the adjacent license files.

The backend migration runner imports these files into PostgreSQL; the frontend
loads region options from the backend API.
