"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { GeocodingService } = require("../src/geospatial/geocoding.service");

function response(value) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function mockProviders(t, nominatim) {
  const previous = {
    fetch: global.fetch,
    geocoder: process.env.GEOCODER_URL,
    nominatim: process.env.NOMINATIM_URL,
  };
  process.env.GEOCODER_URL = "http://photon.test/";
  process.env.NOMINATIM_URL = "https://nominatim.test/search";
  global.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.hostname === "photon.test") {
      return response({ features: [] });
    }
    return nominatim(url);
  };
  t.after(() => {
    global.fetch = previous.fetch;
    if (previous.geocoder === undefined) {
      delete process.env.GEOCODER_URL;
    } else {
      process.env.GEOCODER_URL = previous.geocoder;
    }
    if (previous.nominatim === undefined) {
      delete process.env.NOMINATIM_URL;
    } else {
      process.env.NOMINATIM_URL = previous.nominatim;
    }
  });
}

const darmo = (city = "Surabaya") => ({
  address: { city, country_code: "id", road: "Jalan Raya Darmo" },
  country_code: "id",
  display_name: `Jalan Raya Darmo, Wonokromo, ${city}, East Java, Indonesia`,
  lat: "-7.2975725",
  lon: "112.7391342",
  name: "Jalan Raya Darmo",
});

test("retries a no-match street with a city-level OSM query", async (t) => {
  const queries = [];
  mockProviders(t, async (url) => {
    queries.push(url.searchParams.get("q"));
    return response(queries.length === 1 ? [] : [darmo()]);
  });

  const result = await new GeocodingService().geocodeStructured({
    city: "Kota Surabaya",
    district: "Wonokromo",
    province: "Jawa Timur",
    street: "Jalan Raya Darmo",
  });

  assert.deepEqual(result.coordinates, [112.739_134_2, -7.297_572_5]);
  assert.equal(result.provider, "nominatim");
  assert.equal(queries.length, 2);
  assert.match(queries[0], /Wonokromo/u);
  assert.match(queries[0], /Jalan Raya Darmo/u);
  assert.doesNotMatch(queries[1], /Wonokromo/u);
});

test("matches initials with or without punctuation", async (t) => {
  mockProviders(t, async () =>
    response([
      {
        address: {
          city: "Bandung",
          country_code: "id",
          road: "Jalan L.L.R.E. Martadinata",
        },
        country_code: "id",
        display_name: "Jalan L.L.R.E. Martadinata, Bandung, Indonesia",
        lat: "-6.904",
        lon: "107.610",
        name: "Jalan L.L.R.E. Martadinata",
      },
    ])
  );

  const result = await new GeocodingService().geocodeStructured({
    city: "Kota Bandung",
    district: "Bandung Wetan",
    province: "Jawa Barat",
    street: "Jalan LLRE Martadinata",
  });

  assert.deepEqual(result.coordinates, [107.61, -6.904]);
  assert.equal(result.provider, "nominatim");
});

test("recovers common Java street-name variants from the city-level result", async (t) => {
  const cases = [
    {
      city: "Kabupaten Banyumas",
      district: "Purwokerto Utara",
      province: "Jawa Tengah",
      resultCity: "Banyumas",
      road: "Jalan HR Bunyamin",
      street: "Jalan HR Bunyamin",
    },
    {
      city: "Kota Pekalongan",
      district: "Pekalongan Timur",
      province: "Jawa Tengah",
      resultCity: "Pekalongan",
      road: "Jalan Hayam Wuruk",
      street: "Jalan Hayam Wuruk",
    },
    {
      city: "Kota Salatiga",
      district: "Sidorejo",
      province: "Jawa Tengah",
      resultCity: "Salatiga",
      road: "Jalan Taman Pahlawan",
      street: "Jalan Pahlawan",
    },
    {
      city: "Kota Surabaya",
      district: "Tegalsari",
      province: "Jawa Timur",
      resultCity: "Surabaya",
      road: "Jalan Jenderal Basuki Rachmat",
      street: "Jalan Basuki Rahmat",
    },
    {
      city: "Kota Depok",
      district: "Beji",
      province: "Jawa Barat",
      resultCity: "Depok",
      road: "Jalan Raya Margonda",
      street: "Jalan Margonda Raya",
    },
  ];
  let active;
  mockProviders(t, async () => {
    active.calls++;
    return response(
      active.calls === 1
        ? []
        : [
            {
              address: {
                city: active.resultCity,
                country_code: "id",
                road: active.road,
              },
              country_code: "id",
              display_name: `${active.road}, ${active.resultCity}, Indonesia`,
              lat: "-7.3",
              lon: "110.5",
              name: active.road,
            },
          ]
    );
  });

  for (const item of cases) {
    active = { calls: 0, resultCity: item.resultCity, road: item.road };
    const result = await new GeocodingService().geocodeStructured(item);
    assert.equal(result.provider, "nominatim", item.street);
    assert.equal(active.calls, 2, item.street);
  }
});

test("does not accept a same-named street from another city", async (t) => {
  mockProviders(t, async () => response([darmo("Bandung")]));

  await assert.rejects(
    new GeocodingService().geocodeStructured({
      city: "Kota Surabaya",
      district: "Wonokromo",
      province: "Jawa Timur",
      street: "Jalan Raya Darmo",
    }),
    (error) => error.getResponse?.().code === "GEOCODING_NO_MATCH"
  );
});

test("maps Indonesian autocomplete language to Photon default", async (t) => {
  const previous = { fetch: global.fetch, geocoder: process.env.GEOCODER_URL };
  process.env.GEOCODER_URL = "http://photon.test/";
  const requests = [];
  global.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    requests.push(url);
    return response({
      features: [
        {
          geometry: { coordinates: [112.739_134_2, -7.297_572_5] },
          properties: {
            city: "Surabaya",
            country: "Indonesia",
            countrycode: "ID",
            name: "Jalan Raya Darmo",
            osm_id: 1,
            osm_type: "W",
            street: "Jalan Raya Darmo",
          },
        },
      ],
    });
  };
  t.after(() => {
    global.fetch = previous.fetch;
    if (previous.geocoder === undefined) {
      delete process.env.GEOCODER_URL;
    } else {
      process.env.GEOCODER_URL = previous.geocoder;
    }
  });

  const suggestions = await new GeocodingService().suggestAddress(
    "Jalan Raya Darmo",
    {},
    { lang: "id", latitude: -7.3, longitude: 112.7, zoom: 12.5 }
  );

  assert.equal(suggestions.length, 1);
  assert.equal(requests[0].searchParams.get("lang"), "default");
  assert.equal(requests[0].searchParams.get("zoom"), "13");
});

test("reverse lookup supplements incomplete Photon regions with Nominatim", async (t) => {
  const previous = { fetch: global.fetch, geocoder: process.env.GEOCODER_URL };
  process.env.GEOCODER_URL = "http://photon.test/";
  global.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.hostname === "photon.test") {
      return response({ features: [{ properties: { locality: "Contoh", postcode: "12345" } }] });
    }
    if (url.hostname === "geoservices.big.go.id") {
      return response({ features: [] });
    }
    return response({ address: { city: "Kota Contoh", district: "Contoh", village: "Desa Contoh", state: "Banten", country_code: "id" } });
  };
  t.after(() => {
    global.fetch = previous.fetch;
    if (previous.geocoder === undefined) delete process.env.GEOCODER_URL;
    else process.env.GEOCODER_URL = previous.geocoder;
  });
  const result = await new GeocodingService().reverseAddress(106, -6);
  assert.equal(result.city, "Kota Contoh");
  assert.equal(result.district, "Contoh");
  assert.equal(result.subdistrict, "Desa Contoh");
});
