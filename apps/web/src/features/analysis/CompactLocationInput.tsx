import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { api } from "../../lib/api";
import { AddressPinPicker, type SelectedPoint } from "./AddressPinPicker";

export function CompactLocationInput({
  point,
  onChange,
  initialCenter,
}: {
  point: SelectedPoint | null;
  initialCenter?: { longitude: number; latitude: number } | null;
  onChange: (point: SelectedPoint | null) => void;
}) {
  const id = useId();
  const [mode, setMode] = useState<"address" | "coordinates">("address");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [query]);
  const suggestions = useQuery({
    queryKey: [
      "connection-location-suggestions",
      debounced,
      initialCenter?.longitude,
      initialCenter?.latitude,
    ],
    enabled:
      mode === "address" &&
      !point &&
      debounced.length >= 3 &&
      debounced === query.trim(),
    retry: false,
    queryFn: ({ signal }) =>
      api<{ id: string; label: string; longitude: number; latitude: number }[]>(
        `/analysis/address/suggestions?${new URLSearchParams({ q: debounced, lang: "id", ...(initialCenter ? { lon: String(initialCenter.longitude), lat: String(initialCenter.latitude), zoom: "14" } : {}) })}`,
        { signal }
      ),
  });
  const lat = Number(latitude.trim().replace(",", "."));
  const lon = Number(longitude.trim().replace(",", "."));
  const valid =
    Boolean(latitude.trim() && longitude.trim()) &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180;
  if (point?.confirmed) {
    return (
      <div className="border rounded p-3">
        <div className="d-flex justify-content-between align-items-start gap-3">
          <div className="text-break">
            <strong>Titik tujuan dikonfirmasi</strong>
            <p className="mb-1">{point.label}</p>
            <small>
              {point.latitude.toFixed(6)}, {point.longitude.toFixed(6)}
            </small>
          </div>
          <button
            className="btn btn-sm btn-outline-secondary flex-shrink-0"
            onClick={() => onChange({ ...point, confirmed: false })}
            type="button"
          >
            Edit titik B
          </button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <fieldset>
        <legend className="visually-hidden">Metode input titik B</legend>
        <div className="btn-group mb-3">
          {(["address", "coordinates"] as const).map((value) => (
            <button
              aria-pressed={mode === value}
              className={`btn btn-sm ${mode === value ? "btn-primary" : "btn-outline-primary"}`}
              key={value}
              onClick={() => {
                setMode(value);
                onChange(null);
              }}
              type="button"
            >
              {value === "address" ? "Alamat" : "Koordinat"}
            </button>
          ))}
        </div>
      </fieldset>
      {mode === "address" ? (
        <>
          <label className="form-label" htmlFor={`${id}-address`}>
            Cari alamat tujuan
          </label>
          <input
            autoComplete="off"
            className="form-control"
            id={`${id}-address`}
            onChange={(e) => {
              setQuery(e.target.value);
              onChange(null);
            }}
            placeholder="Nama jalan, tempat, atau kota"
            value={query}
          />
          {!point && debounced === query.trim() && query.trim().length >= 3 && (
            <div aria-live="polite">
              {suggestions.isFetching ? (
                <p className="form-text">Mencari alamat…</p>
              ) : suggestions.error ? (
                <p className="text-danger">
                  Pencarian alamat gagal. Coba lagi atau pilih titik pada peta.
                </p>
              ) : suggestions.data?.length === 0 ? (
                <p className="form-text">
                  Alamat tidak ditemukan. Pilih titik pada peta atau masukkan
                  koordinat.
                </p>
              ) : (
                suggestions.data?.map((item) => (
                  <button
                    className="btn btn-light text-start w-100 border-bottom rounded-0"
                    key={item.id}
                    onClick={() => {
                      setQuery(item.label);
                      onChange({
                        ...item,
                        provider: "photon",
                        matchQuality: "approximate",
                        confirmed: false,
                      });
                    }}
                    type="button"
                  >
                    {item.label}
                  </button>
                ))
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="row g-3">
            <div className="col-sm-6">
              <label className="form-label" htmlFor={`${id}-lat`}>
                Latitude B
              </label>
              <input
                className="form-control"
                id={`${id}-lat`}
                inputMode="decimal"
                onChange={(e) => {
                  setLatitude(e.target.value);
                  onChange(null);
                }}
                placeholder="-6,1754"
                value={latitude}
              />
            </div>
            <div className="col-sm-6">
              <label className="form-label" htmlFor={`${id}-lon`}>
                Longitude B
              </label>
              <input
                className="form-control"
                id={`${id}-lon`}
                inputMode="decimal"
                onChange={(e) => {
                  setLongitude(e.target.value);
                  onChange(null);
                }}
                placeholder="106,8272"
                value={longitude}
              />
            </div>
          </div>
          <p className="form-text">
            Latitude −90 hingga 90; longitude −180 hingga 180. Koma atau titik
            desimal diterima.
          </p>
          <button
            className="btn btn-outline-primary mb-3"
            disabled={!valid}
            onClick={() =>
              onChange({
                longitude: lon,
                latitude: lat,
                label: "Koordinat tujuan",
                provider: "manual",
                confirmed: false,
              })
            }
            type="button"
          >
            Tampilkan titik B
          </button>
        </>
      )}
      <div className="mt-3">
        <AddressPinPicker
          onChange={(pinLongitude, pinLatitude) =>
            onChange({
              longitude: pinLongitude,
              latitude: pinLatitude,
              label: point?.label || query || "Titik tujuan pada peta",
              provider: "manual",
              confirmed: false,
            })
          }
          onViewportChange={() => {
            /* B searches are biased to A rather than map movement. */
          }}
          point={point}
          regionView={initialCenter ? { ...initialCenter, zoom: 14 } : null}
        />
      </div>
      <p className="form-text">
        Klik peta atau geser pin untuk mengoreksi lokasi. Saran alamat bersifat
        perkiraan.
      </p>
      {point && (
        <div className="alert alert-warning mb-0">
          <p className="mb-2">
            Periksa titik B: {point.latitude.toFixed(6)},{" "}
            {point.longitude.toFixed(6)}.
          </p>
          <button
            className="btn btn-sm btn-outline-primary"
            onClick={() => onChange({ ...point, confirmed: true })}
            type="button"
          >
            Konfirmasi titik B
          </button>
        </div>
      )}
    </div>
  );
}
