const assert = require('node:assert/strict')
const { test } = require('node:test')
const { GeocodingService } = require('../src/geospatial/geocoding.service')

function response(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function mockProviders(t, nominatim) {
  const previous = { fetch: global.fetch, geocoder: process.env.GEOCODER_URL, nominatim: process.env.NOMINATIM_URL }
  process.env.GEOCODER_URL = 'http://photon.test/'
  process.env.NOMINATIM_URL = 'https://nominatim.test/search'
  global.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    if (url.hostname === 'photon.test') return response({ features: [] })
    return nominatim(url)
  }
  t.after(() => {
    global.fetch = previous.fetch
    if (previous.geocoder === undefined) delete process.env.GEOCODER_URL
    else process.env.GEOCODER_URL = previous.geocoder
    if (previous.nominatim === undefined) delete process.env.NOMINATIM_URL
    else process.env.NOMINATIM_URL = previous.nominatim
  })
}

const darmo = (city = 'Surabaya') => ({
  lat: '-7.2975725', lon: '112.7391342', name: 'Jalan Raya Darmo',
  display_name: `Jalan Raya Darmo, Wonokromo, ${city}, East Java, Indonesia`,
  address: { road: 'Jalan Raya Darmo', city, country_code: 'id' }, country_code: 'id',
})

test('retries a no-match street with a city-level OSM query', async (t) => {
  const queries = []
  mockProviders(t, async (url) => {
    queries.push(url.searchParams.get('q'))
    return response(queries.length === 1 ? [] : [darmo()])
  })

  const result = await new GeocodingService().geocodeStructured({ street: 'Jalan Raya Darmo', city: 'Kota Surabaya', district: 'Wonokromo', province: 'Jawa Timur' })

  assert.deepEqual(result.coordinates, [112.7391342, -7.2975725])
  assert.equal(result.provider, 'nominatim')
  assert.equal(queries.length, 2)
  assert.match(queries[0], /Wonokromo/)
  assert.match(queries[0], /Jalan Raya Darmo/)
  assert.doesNotMatch(queries[1], /Wonokromo/)
})

test('matches initials with or without punctuation', async (t) => {
  mockProviders(t, async () => response([{
    lat: '-6.904', lon: '107.610', name: 'Jalan L.L.R.E. Martadinata',
    display_name: 'Jalan L.L.R.E. Martadinata, Bandung, Indonesia',
    address: { road: 'Jalan L.L.R.E. Martadinata', city: 'Bandung', country_code: 'id' }, country_code: 'id',
  }]))

  const result = await new GeocodingService().geocodeStructured({ street: 'Jalan LLRE Martadinata', city: 'Kota Bandung', district: 'Bandung Wetan', province: 'Jawa Barat' })

  assert.deepEqual(result.coordinates, [107.61, -6.904])
  assert.equal(result.provider, 'nominatim')
})

test('recovers common Java street-name variants from the city-level result', async (t) => {
  const cases = [
    { street: 'Jalan HR Bunyamin', city: 'Kabupaten Banyumas', district: 'Purwokerto Utara', province: 'Jawa Tengah', road: 'Jalan HR Bunyamin', resultCity: 'Banyumas' },
    { street: 'Jalan Hayam Wuruk', city: 'Kota Pekalongan', district: 'Pekalongan Timur', province: 'Jawa Tengah', road: 'Jalan Hayam Wuruk', resultCity: 'Pekalongan' },
    { street: 'Jalan Pahlawan', city: 'Kota Salatiga', district: 'Sidorejo', province: 'Jawa Tengah', road: 'Jalan Taman Pahlawan', resultCity: 'Salatiga' },
    { street: 'Jalan Basuki Rahmat', city: 'Kota Surabaya', district: 'Tegalsari', province: 'Jawa Timur', road: 'Jalan Jenderal Basuki Rachmat', resultCity: 'Surabaya' },
    { street: 'Jalan Margonda Raya', city: 'Kota Depok', district: 'Beji', province: 'Jawa Barat', road: 'Jalan Raya Margonda', resultCity: 'Depok' },
  ]
  let active
  mockProviders(t, async () => {
    active.calls++
    return response(active.calls === 1 ? [] : [{
      lat: '-7.3', lon: '110.5', name: active.road, display_name: `${active.road}, ${active.resultCity}, Indonesia`,
      address: { road: active.road, city: active.resultCity, country_code: 'id' }, country_code: 'id',
    }])
  })

  for (const item of cases) {
    active = { calls: 0, road: item.road, resultCity: item.resultCity }
    const result = await new GeocodingService().geocodeStructured(item)
    assert.equal(result.provider, 'nominatim', item.street)
    assert.equal(active.calls, 2, item.street)
  }
})

test('does not accept a same-named street from another city', async (t) => {
  mockProviders(t, async () => response([darmo('Bandung')]))

  await assert.rejects(
    new GeocodingService().geocodeStructured({ street: 'Jalan Raya Darmo', city: 'Kota Surabaya', district: 'Wonokromo', province: 'Jawa Timur' }),
    (error) => error.getResponse?.().code === 'GEOCODING_NO_MATCH',
  )
})
