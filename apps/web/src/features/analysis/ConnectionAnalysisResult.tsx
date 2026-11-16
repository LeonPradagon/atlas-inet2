import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  LngLatBounds,
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useRef, useState } from "react";
import { DetailTable } from "../../components/DetailTable";
import { api, type NetworkAsset, postJson } from "../../lib/api";
import {
  addAtlasMapIcons,
  addNetworkAssetHitLayers,
  addNetworkAssetLayers,
  assetFeatures,
  createNetworkAssetPopup,
  createNetworkAssetPopupContent,
  findNetworkAssetAtPoint,
  loadNetworkMapIcons,
} from "../map/networkMap";
import { analysisMapStyle, searchRadiusFeature } from "./analysisMapStyle";

export type ConnectionPoint = {
  longitude: number;
  latitude: number;
  label: string;
};

export type ConnectionLeg = {
  kind: "new" | "existing";
  name: string;
  distanceMeters: number;
  geometry: { type: "LineString"; coordinates: [number, number][] };
  confirmation: "recorded" | "survey_required";
};

export type ConnectionGap = {
  name: string;
  gapMeters: number;
  geometry: ConnectionLeg["geometry"];
  confirmation: "survey_required";
  basis?: string;
};

export type ConnectionRoute = {
  id: "A" | "B";
  distanceMeters: number;
  newCableMeters: number;
  existingNetworkMeters: number;
  legs: ConnectionLeg[];
  unverifiedGapMeters?: number;
  terminalLinks?: ConnectionGap[];
  roadSnapGaps?: ConnectionGap[];
};

export type ConnectionResult = {
  mode?: "connection";
  inputMode?: "connection";
  status: string;
  message?: string;
  searchRadiusMeters?: number;
  historyId: string;
  start: ConnectionPoint;
  end: ConnectionPoint;
  routes: ConnectionRoute[];
};

const meters = (value: number) =>
  `${Math.round(value).toLocaleString("id-ID")} m`;

function ConnectionRouteMap({
  result,
  route,
}: {
  result: ConnectionResult;
  route: ConnectionRoute;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  const gaps = [...(route.terminalLinks ?? []), ...(route.roadSnapGaps ?? [])];
  useEffect(() => {
    if (!container.current) {
      return;
    }
    setError(false);
    setWorkerUrl(workerUrl);
    const request = new AbortController();
    const routeGaps = [
      ...(route.terminalLinks ?? []),
      ...(route.roadSnapGaps ?? []),
    ];
    const searchRadiusMeters = result.searchRadiusMeters ?? 1000;
    const searchRadii = [result.start, result.end].map((point) =>
      searchRadiusFeature(point.longitude, point.latitude, searchRadiusMeters)
    );
    const map = new MapLibreMap({
      container: container.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [result.start.longitude, result.start.latitude],
      zoom: 13,
    });
    map.addControl(new NavigationControl(), "top-right");
    map.on("error", () => setError(true));
    let active = true;
    let stopIcons: (() => void) | undefined;
    const assetsById = new Map<string, NetworkAsset>();
    const assetPopup = createNetworkAssetPopup();
    map.on("load", () => {
      addAtlasMapIcons(map);
      map.addSource("connection-route", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: route.legs
            .filter((leg) => leg.geometry?.coordinates.length >= 2)
            .map((leg) => ({
              type: "Feature",
              properties: { kind: leg.kind },
              geometry: leg.geometry,
            })),
        },
      });
      map.addSource("connection-locations", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [result.start, result.end].map((point, index) => ({
            type: "Feature",
            properties: { label: `Titik lokasi ${index + 1}` },
            geometry: {
              type: "Point",
              coordinates: [point.longitude, point.latitude],
            },
          })),
        },
      });
      map.addSource("connection-search-radii", {
        type: "geojson",
        data: { type: "FeatureCollection", features: searchRadii },
      });
      map.addSource("network-assets", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "connection-search-radius-fill",
        type: "fill",
        source: "connection-search-radii",
        paint: {
          "fill-color": analysisMapStyle.searchRadiusColor,
          "fill-opacity": analysisMapStyle.searchRadiusFillOpacity,
        },
      });
      map.addLayer({
        id: "connection-search-radius-line",
        type: "line",
        source: "connection-search-radii",
        paint: {
          "line-color": analysisMapStyle.searchRadiusColor,
          "line-width": analysisMapStyle.searchRadiusLineWidth,
          "line-dasharray": analysisMapStyle.proposedCableDash,
        },
      });
      const assetLayers = addNetworkAssetLayers(map, "network-assets");
      addNetworkAssetHitLayers(map, "network-assets");
      const assetHitLayers = [
        "asset-point-hit",
        "asset-line-hit",
        assetLayers.areas,
      ];
      map.on("mousemove", (event) => {
        map.getCanvas().style.cursor = findNetworkAssetAtPoint(
          map,
          event.point,
          assetsById,
          assetHitLayers
        )
          ? "pointer"
          : "";
      });
      map.on("click", (event) => {
        const asset = findNetworkAssetAtPoint(
          map,
          event.point,
          assetsById,
          assetHitLayers
        );
        if (!asset) {
          return;
        }
        assetPopup
          .setLngLat(event.lngLat)
          .setDOMContent(createNetworkAssetPopupContent(asset))
          .addTo(map);
      });
      map.addLayer({
        id: "connection-new",
        type: "line",
        source: "connection-route",
        filter: ["==", ["get", "kind"], "new"],
        paint: {
          "line-color": analysisMapStyle.proposedCableColor,
          "line-width": analysisMapStyle.proposedCableLineWidth,
          "line-dasharray": analysisMapStyle.proposedCableDash,
        },
      });
      map.addLayer({
        id: "connection-location-points",
        type: "circle",
        source: "connection-locations",
        paint: {
          "circle-radius": analysisMapStyle.locationRadius,
          "circle-color": analysisMapStyle.locationColor,
          "circle-stroke-color": analysisMapStyle.locationStrokeColor,
          "circle-stroke-width": analysisMapStyle.locationStrokeWidth,
        },
      });
      map.addLayer({
        id: "connection-location-labels",
        type: "symbol",
        source: "connection-locations",
        layout: {
          "text-field": ["get", "label"],
          "text-size": analysisMapStyle.locationLabelSize,
          "text-offset": analysisMapStyle.locationLabelOffset,
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": analysisMapStyle.locationLabelColor,
          "text-halo-color": analysisMapStyle.locationLabelHaloColor,
          "text-halo-width": analysisMapStyle.locationLabelHaloWidth,
        },
      });
      map.addSource("connection-gaps", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: routeGaps
            .filter((gap) => gap.geometry?.coordinates.length >= 2)
            .map((gap) => ({
              type: "Feature",
              properties: {},
              geometry: gap.geometry,
            })),
        },
      });
      map.addLayer({
        id: "connection-gap-lines",
        type: "line",
        source: "connection-gaps",
        paint: {
          "line-color": "#ad5900",
          "line-width": 4,
          "line-dasharray": [1, 1.5],
        },
      });
      const bounds = new LngLatBounds();
      bounds.extend([result.start.longitude, result.start.latitude]);
      bounds.extend([result.end.longitude, result.end.latitude]);
      for (const radiusFeature of searchRadii) {
        for (const point of radiusFeature.geometry.coordinates[0]) {
          bounds.extend([point[0], point[1]]);
        }
      }
      for (const leg of route.legs) {
        for (const coordinate of leg.geometry?.coordinates ?? []) {
          bounds.extend(coordinate);
        }
      }
      for (const gap of routeGaps) {
        for (const coordinate of gap.geometry?.coordinates ?? []) {
          bounds.extend(coordinate);
        }
      }
      map.fitBounds(bounds, { padding: 44, maxZoom: 16, duration: 0 });
      const visibleBounds = map.getBounds();
      const bbox = [
        visibleBounds.getWest(),
        visibleBounds.getSouth(),
        visibleBounds.getEast(),
        visibleBounds.getNorth(),
      ];
      void api<NetworkAsset[]>(`/assets/map?bbox=${bbox.join(",")}&zoom=24`, {
        signal: request.signal,
        timeout: 30_000,
      })
        .then(async (assets) => {
          if (!active) {
            return;
          }
          for (const asset of assets) {
            assetsById.set(asset.id, asset);
          }
          const features = assetFeatures(assets);
          await new Promise<void>((resolve) => {
            stopIcons = loadNetworkMapIcons(map, features, resolve);
          });
          if (!active) {
            return;
          }
          const source = map.getSource(
            "network-assets"
          ) as import("maplibre-gl").GeoJSONSource;
          source.setData({ type: "FeatureCollection", features });
        })
        .catch(() => {
          if (active) {
            setError(true);
          }
        });
    });
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container.current);
    return () => {
      active = false;
      request.abort();
      stopIcons?.();
      observer.disconnect();
      assetPopup.remove();
      map.remove();
    };
  }, [result, route]);
  return (
    <>
      {error && (
        <p className="alert alert-warning" role="status">
          Sebagian peta gagal dimuat. Detail ruas tetap tersedia di bawah.
        </p>
      )}
      <section
        aria-label={`Peta rute ${route.id} antara Titik lokasi 1 dan Titik lokasi 2`}
        className="connection-route-map"
        ref={container}
      />
      <div className="connection-map-legend">
        <span>
          <i className="connection-radius-legend-marker" />
          Radius pencarian
        </span>
        <span>
          <i
            className="connection-line is-new"
            style={{
              borderTopColor: analysisMapStyle.proposedCableColor,
            }}
          />
          Jalur usulan
        </span>
        <span>
          <i className="connection-line is-existing" />
          Kabel existing · warna sesuai peta
        </span>
        {gaps.length > 0 && (
          <span>
            <i className="connection-line is-gap" />
            Celah sambungan perlu survei
          </span>
        )}
      </div>
    </>
  );
}

function ConnectionSurvey({
  historyId,
  routeId,
}: {
  historyId: string;
  routeId: "A" | "B";
}) {
  const client = useQueryClient();
  const submit = useMutation({
    mutationFn: () => api("/surveys", postJson({ historyId, routeId })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["surveys"] });
    },
  });
  return (
    <div className="mt-3">
      <button
        className="btn btn-outline-primary"
        disabled={submit.isPending || submit.isSuccess}
        onClick={() => submit.mutate()}
        type="button"
      >
        {submit.isSuccess
          ? "Survei sudah diajukan"
          : submit.isPending
            ? "Mengajukan survei…"
            : `Ajukan survei rute ${routeId}`}
      </button>
      {submit.isSuccess && (
        <p className="text-success mt-2" role="status">
          Rute {routeId} tersimpan untuk Survei & Verifikasi.
        </p>
      )}
      {submit.error && (
        <p className="text-danger mt-2" role="alert">
          {submit.error.message}
        </p>
      )}
    </div>
  );
}

export function ConnectionAnalysisResult({
  result,
}: {
  result: ConnectionResult;
}) {
  const [selectedRouteId, setSelectedRouteId] = useState<"A" | "B">("A");
  const route =
    result.routes?.find((item) => item.id === selectedRouteId) ??
    result.routes?.[0];
  if (!route) {
    return (
      <section aria-label="Hasil koneksi">
        <h3 className="h5">Jalur koneksi belum ditemukan</h3>
        <p className="alert alert-warning" role="status">
          {result.message ||
            "Belum ada jalur jaringan yang dapat menghubungkan A dan B. Kedekatan titik tidak membuktikan koneksi."}
        </p>
        <p>
          Periksa lokasi kedua titik atau perluas pencarian, lalu analisis
          kembali.
        </p>
      </section>
    );
  }
  const gaps = [...(route.terminalLinks ?? []), ...(route.roadSnapGaps ?? [])];
  const uncertain =
    (route.unverifiedGapMeters ?? 0) > 0 ||
    route.legs.some(
      (leg) => leg.kind === "existing" && leg.confirmation === "survey_required"
    );
  return (
    <section aria-label="Hasil analisis koneksi A ke B">
      <h3 className="h5">Rencana jalur melalui jaringan</h3>
      <div
        className={`alert ${uncertain ? "alert-warning" : "alert-info"}`}
        role="status"
      >
        {uncertain
          ? "Jalur ini memuat kandidat jaringan berdasarkan geometri. Sambungan fisik dan ketersediaan core belum dikonfirmasi; perlu survei."
          : "Relasi jaringan mengikuti data tercatat. Rencana kabel baru, kondisi fisik, dan ketersediaan core tetap perlu diverifikasi saat survei."}
      </div>
      <DetailTable
        label="Lokasi koneksi"
        rows={[
          {
            label: "A · Titik awal",
            value: (
              <>
                {result.start.label}
                <small className="d-block">
                  {result.start.latitude.toFixed(6)},{" "}
                  {result.start.longitude.toFixed(6)}
                </small>
              </>
            ),
          },
          {
            label: "B · Titik tujuan",
            value: (
              <>
                {result.end.label}
                <small className="d-block">
                  {result.end.latitude.toFixed(6)},{" "}
                  {result.end.longitude.toFixed(6)}
                </small>
              </>
            ),
          },
        ]}
      />
      <fieldset className="mb-3">
        <legend className="h6">Pilih rute</legend>
        <div className="d-flex flex-wrap gap-2">
          {result.routes.map((item) => (
            <button
              aria-pressed={route.id === item.id}
              className={`btn ${route.id === item.id ? "btn-primary" : "btn-outline-primary"}`}
              key={item.id}
              onClick={() => setSelectedRouteId(item.id)}
              type="button"
            >
              Rute {item.id} · {meters(item.distanceMeters)}
            </button>
          ))}
        </div>
      </fieldset>
      <DetailTable
        label={`Jarak rute ${route.id}`}
        rows={[
          { label: "Total jalur", value: meters(route.distanceMeters) },
          { label: "Kabel baru", value: meters(route.newCableMeters) },
          {
            label: "Jaringan eksisting",
            value: meters(route.existingNetworkMeters),
          },
          {
            label: "Celah sambungan perlu survei",
            value: meters(
              route.unverifiedGapMeters ??
                gaps.reduce((sum, gap) => sum + gap.gapMeters, 0)
            ),
          },
        ]}
      />
      <ConnectionRouteMap result={result} route={route} />
      {gaps.some((gap) => gap.gapMeters > 0) && (
        <details className="mt-3">
          <summary>Celah sambungan perlu survei</summary>
          <DetailTable
            label="Celah sambungan"
            rows={gaps
              .filter((gap) => gap.gapMeters > 0)
              .map((gap) => ({
                label: gap.name,
                value: `${meters(gap.gapMeters)} · Perlu survei`,
              }))}
          />
        </details>
      )}
      <h4 className="h6 mt-4">Rincian ruas · Rute {route.id}</h4>
      <div className="table-responsive">
        <table className="table atlas-detail-table">
          <caption className="visually-hidden">Ruas rute {route.id}</caption>
          <thead>
            <tr>
              <th scope="col">Ruas</th>
              <th scope="col">Jenis</th>
              <th scope="col">Jarak</th>
              <th scope="col">Kepastian</th>
            </tr>
          </thead>
          <tbody>
            {route.legs.map((leg, index) => (
              <tr
                key={`${leg.kind}-${leg.name}-${JSON.stringify(leg.geometry.coordinates)}`}
              >
                <th scope="row">{leg.name || `Ruas ${index + 1}`}</th>
                <td>
                  {leg.kind === "new" ? "Kabel baru" : "Jaringan eksisting"}
                </td>
                <td className="text-nowrap">{meters(leg.distanceMeters)}</td>
                <td>
                  {leg.confirmation === "survey_required"
                    ? "Perlu survei"
                    : "Relasi tercatat"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.historyId && (
        <ConnectionSurvey
          historyId={result.historyId}
          key={`${result.historyId}-${route.id}`}
          routeId={route.id}
        />
      )}
    </section>
  );
}
