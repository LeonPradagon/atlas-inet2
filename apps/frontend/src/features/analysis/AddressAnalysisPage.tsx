import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Map as MapLibreMap, Marker, NavigationControl, Popup, setWorkerUrl } from "maplibre-gl";
import type { MapMouseEvent } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { distanceMeters, generateFtthDraft, offsetCoordinate, type DesignFeature } from "./ftthDraft";
import { Link } from "@tanstack/react-router";
import { PageHeader } from "../../components/PageHeader";
import { api, postCompressedJson, postJson, type ApiError } from "../../lib/api";

type Result = {
  address: string;
  latitude: number;
  longitude: number;
  historyId: string;
  network: { name: string; area: string; cableType: string } | null;
  distanceMeters: number | null;
  status: string;
  message?: string;
  geocodingProvider?: "photon" | "nominatim" | "manual";
  geocodingMatch?: "approximate";
  matchedStreet?: string;
};
type RegionOption = { code: string; name: string };
type Subdistrict = RegionOption & { postalCode: string };
type AddressFields = { street: string; number: string; postalCode: string; provinceCode: string; cityCode: string; districtCode: string; subdistrictCode: string };
type AddressSuggestion = {
  id: string;
  label: string;
  category?: string;
  location?: string;
  longitude: number;
  latitude: number;
  street?: string;
  number?: string;
  subdistrict?: string;
  subdistrictCandidates?: string[];
  district?: string;
  districtCandidates?: string[];
  city?: string;
  cityCandidates?: string[];
  province?: string;
  postalCode?: string;
  matchQuality: "approximate";
};
type ResolvedRegion = { provinceCode: string; cityCode: string; districtCode: string | null; subdistrictCode: string | null; postalCode?: string | null };

async function resolveRegionParams(params: URLSearchParams) {
  let result = await api<ResolvedRegion | null>(`/regions/resolve?${params}`);
  if (!result && params.has("province")) {
    const withoutProviderProvince = new URLSearchParams(params);
    withoutProviderProvince.delete("province");
    result = await api<ResolvedRegion | null>(`/regions/resolve?${withoutProviderProvince}`);
  }
  return result;
}
function regionParams(fields: Partial<AddressSuggestion>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({
    city: fields.city,
    district: fields.district,
    subdistrict: fields.subdistrict,
    province: fields.province,
    postalCode: fields.postalCode,
    street: fields.street,
  }))
    if (value) params.set(key, value);
  for (const [key, values] of Object.entries({
    cityCandidate: fields.cityCandidates,
    districtCandidate: fields.districtCandidates,
    subdistrictCandidate: fields.subdistrictCandidates,
  }))
    for (const value of values ?? []) params.append(key, value);
  return params;
}
type SelectedPoint = { longitude: number; latitude: number; label: string; provider: "photon" | "manual"; matchQuality?: "approximate"; matchedStreet?: string; confirmed: boolean };
type SearchViewport = { longitude: number; latitude: number; zoom: number };

function AddressPinPicker({ point, regionView, onChange, onViewportChange }: { point: SelectedPoint | null; regionView: SearchViewport | null; onChange: (longitude: number, latitude: number) => void; onViewportChange: (viewport: SearchViewport) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onViewportChangeRef = useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;
  const pointRef = useRef(point);
  pointRef.current = point;

  useEffect(() => {
    if (!container.current) return;
    setWorkerUrl(workerUrl);
    const map = new MapLibreMap({
      container: container.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: point ? [point.longitude, point.latitude] : regionView ? [regionView.longitude, regionView.latitude] : [118, -2],
      zoom: point ? 16 : (regionView?.zoom ?? 4.5),
    });
    map.addControl(new NavigationControl(), "top-right");
    const marker = new Marker({ color: "#3454d1", draggable: true });
    marker.on("dragend", () => {
      const coordinates = marker.getLngLat();
      onChangeRef.current(coordinates.lng, coordinates.lat);
    });
    markerRef.current = marker;
    mapRef.current = map;
    const reportViewport = () => {
      const center = map.getCenter();
      onViewportChangeRef.current({ longitude: center.lng, latitude: center.lat, zoom: map.getZoom() });
    };
    map.on("moveend", reportViewport);
    map.on("load", () => {
      if (pointRef.current) marker.setLngLat([pointRef.current.longitude, pointRef.current.latitude]).addTo(map);
      reportViewport();
    });
    map.on("click", (event) => {
      marker.setLngLat(event.lngLat).addTo(map);
      onChangeRef.current(event.lngLat.lng, event.lngLat.lat);
    });
    return () => {
      marker.remove();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker) return;
    if (!point) {
      marker.remove();
      return;
    }
    marker.setLngLat([point.longitude, point.latitude]).addTo(map);
    map.easeTo({ center: [point.longitude, point.latitude], zoom: Math.max(map.getZoom(), 16) });
  }, [point?.longitude, point?.latitude]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || point || !regionView) return;
    map.easeTo({ center: [regionView.longitude, regionView.latitude], zoom: regionView.zoom, duration: 700 });
  }, [point, regionView?.longitude, regionView?.latitude, regionView?.zoom]);

  return <div ref={container} role="application" aria-label="Pilih atau koreksi titik alamat pada peta" style={{ height: 320, width: "100%", borderRadius: 8, overflow: "hidden" }} />;
}
function AddressResultMap({ latitude, longitude, anchorKind, design }: { latitude: number; longitude: number; anchorKind: string; design: DesignFeature[] }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    setWorkerUrl(workerUrl);
    const map = new MapLibreMap({ container: container.current, style: "https://tiles.openfreemap.org/styles/liberty", center: [longitude, latitude], zoom: 15 });
    map.addControl(new NavigationControl(), "top-right");
    const circle = Array.from({ length: 65 }, (_, index) => {
      const bearing = (index / 64) * 2 * Math.PI;
      const distance = 500 / 6371008.8;
      const lat1 = (latitude * Math.PI) / 180;
      const lon1 = (longitude * Math.PI) / 180;
      const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distance) + Math.cos(lat1) * Math.sin(distance) * Math.cos(bearing));
      const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(lat1), Math.cos(distance) - Math.sin(lat1) * Math.sin(lat2));
      return [(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI];
    });
    map.on("load", async () => {
      const drawAssetIcon = (kind: "OLT" | "ODC" | "ODP" | "POLE", color: string) => {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext("2d")!;
        context.scale(2, 2);
        if (kind === "ODC" || kind === "ODP") {
          context.fillStyle = color;
          context.beginPath();
          context.moveTo(16, 4);
          context.lineTo(28, 27);
          context.lineTo(4, 27);
          context.closePath();
          context.fill();
          context.globalCompositeOperation = "destination-out";
          context.beginPath();
          context.arc(16, 19, 3.5, 0, 2 * Math.PI);
          context.fill();
          context.globalCompositeOperation = "source-over";
        } else if (kind === "OLT") {
          context.fillStyle = "#fff";
          context.strokeStyle = "#d9a400";
          context.lineWidth = 1.5;
          context.beginPath();
          context.roundRect(5, 7, 22, 20, 2);
          context.fill();
          context.stroke();
          for (const y of [12, 18, 24]) {
            context.fillStyle = "#e8b500";
            context.fillRect(8, y - 1, 16, 3);
            context.fillStyle = "#fff";
            context.fillRect(10, y, 2, 1);
          }
        } else {
          context.strokeStyle = color;
          context.fillStyle = color;
          context.lineWidth = 2.5;
          context.beginPath();
          context.moveTo(16, 4);
          context.lineTo(16, 29);
          context.moveTo(8, 10);
          context.lineTo(24, 10);
          context.moveTo(10, 15);
          context.lineTo(22, 15);
          context.moveTo(13, 7);
          context.lineTo(13, 11);
          context.moveTo(19, 7);
          context.lineTo(19, 11);
          context.stroke();
          context.beginPath();
          context.moveTo(11, 29);
          context.lineTo(21, 29);
          context.stroke();
        }
        map.addImage(`ftth-${kind.toLowerCase()}`, context.getImageData(0, 0, 64, 64), { pixelRatio: 2 });
      };
      drawAssetIcon("OLT", "#e8b500");
      drawAssetIcon("ODC", "#ff0000");
      drawAssetIcon("ODP", "#0000ff");
      drawAssetIcon("POLE", "#536177");
      const bounds = circle.reduce(([west, south, east, north], [lng, lat]) => [Math.min(west, lng), Math.min(south, lat), Math.max(east, lng), Math.max(north, lat)], [Infinity, Infinity, -Infinity, -Infinity]);
      map.fitBounds(
        [
          [bounds[0], bounds[1]],
          [bounds[2], bounds[3]],
        ],
        { padding: 36, maxZoom: 15 },
      );
      map.addSource("analysis-location", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [
            { type: "Feature", properties: { kind: "boundary", name: "Radius 500 m" }, geometry: { type: "Polygon", coordinates: [circle] } },
            { type: "Feature", properties: { kind: anchorKind, name: "Titik awal" }, geometry: { type: "Point", coordinates: [longitude, latitude] } },
            ...design
              .filter((feature) => feature.properties.kind === "ODP")
              .map((feature) => {
                const [odpLongitude, odpLatitude] = feature.geometry.coordinates as [number, number];
                const coverage = Array.from({ length: 65 }, (_, index) => offsetCoordinate([odpLongitude, odpLatitude], 150, (index / 64) * 2 * Math.PI));
                return { type: "Feature" as const, properties: { kind: "coverage", name: `Radius layanan ${feature.properties.name} · 150 m` }, geometry: { type: "Polygon" as const, coordinates: [coverage] } };
              }),
            ...design,
          ],
        },
      });
      map.addLayer({ id: "analysis-radius-fill", type: "fill", source: "analysis-location", filter: ["==", "$type", "Polygon"], paint: { "fill-color": "#3454d1", "fill-opacity": 0.16 } });
      map.addLayer({ id: "analysis-radius-line", type: "line", source: "analysis-location", filter: ["==", "$type", "Polygon"], paint: { "line-color": "#3454d1", "line-width": 2 } });
      map.addLayer({ id: "analysis-odp-coverage", type: "fill", source: "analysis-location", filter: ["==", ["get", "kind"], "coverage"], paint: { "fill-color": "#f29b38", "fill-opacity": 0.12 } }, "analysis-radius-line");
      map.addLayer({ id: "analysis-odp-coverage-line", type: "line", source: "analysis-location", filter: ["==", ["get", "kind"], "coverage"], paint: { "line-color": "#f29b38", "line-width": 1, "line-dasharray": [2, 2] } });
      map.addLayer({
        id: "analysis-design-routes",
        type: "line",
        source: "analysis-location",
        filter: ["==", ["get", "kind"], "ROUTE"],
        paint: { "line-color": ["match", ["get", "routeType"], "FEEDER", "#ff0000", "DISTRIBUTION", "#a000ff", "#64748b"], "line-width": ["match", ["get", "routeType"], "FEEDER", 4.5, 3.5] },
      });
      const pointKinds = ["OLT", "HANDHOLE", "JOINT_CLOSURE", "ODC", "ODP", "POLE"];
      map.addLayer({
        id: "analysis-design-points",
        type: "circle",
        source: "analysis-location",
        filter: ["all", ["in", ["get", "kind"], ["literal", pointKinds]], ["!", ["in", ["get", "kind"], ["literal", ["OLT", "ODC", "ODP", "POLE"]]]]],
        paint: {
          "circle-radius": 12,
          "circle-color": ["match", ["get", "kind"], "HANDHOLE", "#536177", "JOINT_CLOSURE", "#7256bf", "#536177"],
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "analysis-design-point-labels",
        type: "symbol",
        source: "analysis-location",
        filter: ["all", ["in", ["get", "kind"], ["literal", pointKinds]], ["!", ["in", ["get", "kind"], ["literal", ["OLT", "ODC", "ODP", "POLE"]]]]],
        layout: {
          "text-field": ["match", ["get", "kind"], "HANDHOLE", "HH", "JOINT_CLOSURE", "JC", ""],
          "text-size": 9,
          "text-font": ["Noto Sans Bold"],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-color": "#fff", "text-halo-color": "rgba(0,0,0,0.2)", "text-halo-width": 0.5 },
      });
      map.addLayer({
        id: "analysis-design-major-icons",
        type: "symbol",
        source: "analysis-location",
        filter: ["in", ["get", "kind"], ["literal", ["OLT", "ODC", "ODP"]]],
        layout: { "icon-image": ["concat", "ftth-", ["downcase", ["get", "kind"]]], "icon-size": 0.8, "icon-allow-overlap": true, "icon-ignore-placement": true },
      });
      map.addLayer({
        id: "analysis-design-pole-icons",
        type: "symbol",
        source: "analysis-location",
        filter: ["==", ["get", "kind"], "POLE"],
        layout: { "icon-image": "ftth-pole", "icon-size": 0.62, "icon-allow-overlap": true, "icon-ignore-placement": true },
      });
      const interactiveLayers = ["analysis-design-major-icons", "analysis-design-pole-icons", "analysis-design-points", "analysis-design-point-labels", "analysis-design-routes"];
      const kindLabels: Record<string, string> = { OLT: "Server OLT (POP)", ODC: "ODC (Cabinet)", ODP: "ODP (Tiang)", HANDHOLE: "Handhole", JOINT_CLOSURE: "Joint Closure", POLE: "Tiang", ROUTE: "Jalur kabel" };
      let activePopup: Popup | undefined;
      let pinnedPopup = false;
      let activeFeatureKey = "";
      const getFeature = (point: MapMouseEvent["point"]) =>
        map.queryRenderedFeatures(point, { layers: interactiveLayers }).find((feature) => feature.geometry.type === "Point") ?? map.queryRenderedFeatures(point, { layers: ["analysis-design-routes"] })[0];
      const popupContent = (feature: ReturnType<typeof getFeature>) => {
        const properties = feature?.properties as { kind?: string; name?: string; routeType?: string; spacingMeters?: number; poleHeight?: string; roadClass?: string } | undefined;
        const kind = properties?.kind ?? "ASSET";
        const routeType = properties?.routeType;
        const title = routeType === "FEEDER" ? "Kabel Feeder" : routeType === "DISTRIBUTION" ? "Kabel Distribusi" : (kindLabels[kind] ?? kind);
        const content = document.createElement("div");
        content.className = "small";
        const heading = document.createElement("strong");
        heading.className = "d-block mb-1";
        heading.textContent = title;
        content.append(heading);
        const name = document.createElement("span");
        name.className = "d-block";
        name.textContent = properties?.name ?? "Titik awal";
        content.append(name);
        if (kind === "POLE" && properties?.spacingMeters) {
          const spacing = document.createElement("span");
          spacing.className = "d-block text-secondary mt-1";
          spacing.textContent = `Tinggi ${properties.poleHeight ?? "—"}${properties.roadClass ? ` · kelas jalan ${properties.roadClass}` : ""} · jarak rencana antartiang ±${properties.spacingMeters} m di sepanjang jalur`;
          content.append(spacing);
        }
        if (feature?.geometry.type === "Point") {
          const [lng, lat] = feature.geometry.coordinates;
          const coordinates = document.createElement("span");
          coordinates.className = "d-block text-secondary mt-1";
          coordinates.textContent = `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
          content.append(coordinates);
        } else if (feature?.geometry.type === "LineString") {
          const coords = feature.geometry.coordinates as [number, number][];
          const length = coords.slice(1).reduce((sum, coordinate, index) => sum + distanceMeters(coords[index], coordinate), 0);
          const distance = document.createElement("span");
          distance.className = "d-block text-secondary mt-1";
          distance.textContent = `Panjang jalur ± ${(length / 1000).toFixed(2)} km`;
          content.append(distance);
        }
        return content;
      };
      const setPopup = (feature: ReturnType<typeof getFeature>, lngLat: { lng: number; lat: number }, pinned: boolean) => {
        if (!feature) return;
        const properties = feature.properties as { kind?: string; name?: string } | undefined;
        const key = `${properties?.kind}:${properties?.name}`;
        if (!pinned && (pinnedPopup || key === activeFeatureKey)) return;
        activeFeatureKey = key;
        pinnedPopup = pinned;
        activePopup?.remove();
        activePopup = new Popup({ closeButton: pinned, closeOnClick: pinned, offset: 12, maxWidth: "260px" }).setLngLat(lngLat).setDOMContent(popupContent(feature)).addTo(map);
        if (pinned)
          activePopup.on("close", () => {
            pinnedPopup = false;
            activePopup = undefined;
            activeFeatureKey = "";
          });
      };
      map.on("mousemove", (event) => {
        const feature = getFeature(event.point);
        map.getCanvas().style.cursor = feature ? "pointer" : "";
        if (feature) setPopup(feature, event.lngLat, false);
        else if (!pinnedPopup) {
          activePopup?.remove();
          activePopup = undefined;
          activeFeatureKey = "";
        }
      });
      map.on("click", (event) => {
        const feature = getFeature(event.point);
        if (feature) setPopup(feature, event.lngLat, true);
        else if (pinnedPopup) {
          activePopup?.remove();
          activePopup = undefined;
          pinnedPopup = false;
          activeFeatureKey = "";
        }
      });
      map.on("mouseout", () => {
        map.getCanvas().style.cursor = "";
        if (!pinnedPopup) {
          activePopup?.remove();
          activePopup = undefined;
          activeFeatureKey = "";
        }
      });
    });
    return () => map.remove();
  }, [latitude, longitude, design]);

  return <div ref={container} role="img" aria-label="Peta lokasi dengan boundary radius 500 meter" style={{ height: 620, width: "100%", borderRadius: 8, overflow: "hidden" }} />;
}

export function AddressAnalysisPage() {
  const [address, setAddress] = useState<AddressFields>({ street: "", number: "", postalCode: "", provinceCode: "", cityCode: "", districtCode: "", subdistrictCode: "" });
  const [selectedPoint, setSelectedPoint] = useState<SelectedPoint | null>(null);
  const [searchViewport, setSearchViewport] = useState<SearchViewport | null>(null);
  const [showPinPicker, setShowPinPicker] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [coordinateCopyStatus, setCoordinateCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [assetKind, setAssetKind] = useState("OLT");
  const [poleHeight, setPoleHeight] = useState("7 m");
  const [assetName, setAssetName] = useState("");
  const [designFeatures, setDesignFeatures] = useState<DesignFeature[]>([]);
  const [designError, setDesignError] = useState("");
  const [designNotice, setDesignNotice] = useState("");
  const [designLoading, setDesignLoading] = useState(false);
  const regionLookupId = useRef(0);
  const queryClient = useQueryClient();
  const addressQuery = [address.street, address.number && `No. ${address.number}`].filter(Boolean).join(" ").trim();
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(addressQuery), 350);
    return () => window.clearTimeout(timer);
  }, [addressQuery]);
  const { data: regions = [] } = useQuery({ queryKey: ["indonesia-provinces"], staleTime: Infinity, queryFn: () => api<RegionOption[]>("/regions/provinces") });
  const { data: cities = [] } = useQuery({
    queryKey: ["indonesia-cities", address.provinceCode],
    enabled: Boolean(address.provinceCode),
    staleTime: Infinity,
    queryFn: () => api<RegionOption[]>(`/regions/cities?provinceCode=${encodeURIComponent(address.provinceCode)}`),
  });
  const { data: districts = [] } = useQuery({
    queryKey: ["indonesia-districts", address.cityCode],
    enabled: Boolean(address.cityCode),
    staleTime: Infinity,
    queryFn: () => api<RegionOption[]>(`/regions/districts?cityCode=${encodeURIComponent(address.cityCode)}`),
  });
  const {
    data: subdistricts = [],
    isLoading: loadingSubdistricts,
    isError: subdistrictLoadError,
  } = useQuery({
    queryKey: ["indonesia-subdistricts", address.districtCode],
    enabled: Boolean(address.districtCode),
    staleTime: Infinity,
    retry: false,
    queryFn: () => api<Subdistrict[]>(`/regions/subdistricts?districtCode=${encodeURIComponent(address.districtCode)}`),
  });
  const province = regions.find((region) => region.code === address.provinceCode);
  const city = cities.find((item) => item.code === address.cityCode);
  const district = districts.find((item) => item.code === address.districtCode);
  const subdistrict = subdistricts.find((item) => item.code === address.subdistrictCode);
  const hasSearchArea = Boolean(province && city && district && subdistrict);
  const postalRegionQuery = useQuery({
    queryKey: ["region-by-postal", address.provinceCode, address.cityCode, address.postalCode],
    // A postal code may conflict with the street (or cover multiple kelurahan).
    // Prefer the street suggestion whenever one is being entered.
    enabled: Boolean(province && city && !address.street.trim() && /^\d{5}$/.test(address.postalCode) && (!district || !subdistrict)),
    staleTime: 60_000,
    retry: false,
    queryFn: () => {
      const params = new URLSearchParams({ city: city!.name, province: province!.name, postalCode: address.postalCode });
      return api<{ provinceCode: string; cityCode: string; districtCode: string | null; subdistrictCode: string | null; postalCode?: string | null } | null>(`/regions/resolve?${params}`);
    },
  });
  useEffect(() => {
    const resolved = postalRegionQuery.data;
    if (!resolved) return;
    setAddress((current) =>
      current.cityCode === resolved.cityCode && current.postalCode === address.postalCode
        ? { ...current, provinceCode: resolved.provinceCode, districtCode: resolved.districtCode ?? "", subdistrictCode: resolved.subdistrictCode ?? "" }
        : current,
    );
  }, [postalRegionQuery.data, address.postalCode]);
  const fullAddress = [
    address.street.trim(),
    address.number.trim() && `No. ${address.number.trim()}`,
    subdistrict?.name,
    district && `Kecamatan ${district.name}`,
    city?.name,
    province && `Provinsi ${province.name}`,
    address.postalCode.trim() && `Kode pos ${address.postalCode.trim()}`,
  ]
    .filter(Boolean)
    .join(", ");
  const selectedRegionName = subdistrict?.name ?? district?.name ?? city?.name ?? province?.name;
  const regionMapQuery = useQuery({
    queryKey: ["address-region-map", address.subdistrictCode, address.districtCode, address.cityCode, address.provinceCode],
    enabled: Boolean(selectedRegionName),
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ q: selectedRegionName! });
      if (subdistrict?.name) params.set("subdistrict", subdistrict.name);
      if (district?.name) params.set("district", district.name);
      if (city?.name) params.set("city", city.name);
      if (province?.name) params.set("province", province.name);
      const candidates = await api<AddressSuggestion[]>(`/analysis/address/suggestions?${params}`, { signal });
      const candidate = candidates[0];
      if (!candidate) return null;
      const zoom = subdistrict ? 13 : district ? 12 : city ? 10 : 7;
      return { longitude: candidate.longitude, latitude: candidate.latitude, zoom };
    },
  });
  const suggestionsQuery = useQuery({
    queryKey: ["address-suggestions", debouncedQuery, address.subdistrictCode, address.districtCode, address.cityCode, address.provinceCode, address.postalCode, searchViewport?.longitude, searchViewport?.latitude, searchViewport?.zoom],
    enabled: debouncedQuery.length >= 3 && debouncedQuery === addressQuery && !selectedPoint,
    staleTime: 60_000,
    retry: false,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ q: debouncedQuery, lang: "id" });
      if (subdistrict?.name) params.set("subdistrict", subdistrict.name);
      if (district?.name) params.set("district", district.name);
      if (city?.name) params.set("city", city.name);
      if (province?.name) params.set("province", province.name);
      if (address.postalCode) params.set("postalCode", address.postalCode);
      const bias = searchViewport ?? regionMapQuery.data ?? { longitude: 118, latitude: -2, zoom: 4.5 };
      params.set("lon", String(bias.longitude));
      params.set("lat", String(bias.latitude));
      params.set("zoom", String(bias.zoom));
      return api<AddressSuggestion[]>(`/analysis/address/suggestions?${params}`, { signal });
    },
  });
  const analyze = useMutation({
    mutationFn: (value: {
      address: string;
      structured: { street: string; number: string; subdistrict: string; district: string; city: string; province: string; postalCode: string };
      coordinates: { longitude: number; latitude: number; provider: "photon" | "manual"; matchQuality?: "approximate"; matchedStreet?: string };
      coordinateConfirmed: true;
    }) => api<Result>("/analysis/address", postJson(value)),
  });
  const saveAsset = useMutation({
    mutationFn: () =>
      api<{ id: string; name: string }>(
        "/assets/point",
        postJson({
          kind: assetKind,
          poleHeight: assetKind === "POLE" ? poleHeight : undefined,
          name: (assetName.trim() || `${assetKind} · ${address.street.trim() || "Titik analisis"}`).slice(0, 150),
          longitude: analyze.data?.longitude,
          latitude: analyze.data?.latitude,
          area: [city?.name, province?.name].filter(Boolean).join(", "),
        }),
      ),
    onSuccess: () => Promise.all([queryClient.invalidateQueries({ queryKey: ["segments"] }), queryClient.invalidateQueries({ queryKey: ["map-assets"] })]),
  });
  const saveDesign = useMutation({
    mutationFn: () =>
      postCompressedJson<{ savedCount: number; historyId: string; designId: string }>("/assets/ftth-design", {
        area: [city?.name, province?.name].filter(Boolean).join(", "),
        sourceAnalysisId: analyze.data!.historyId,
        features: [
          {
            kind: assetKind,
            name: (assetName.trim() || `${assetKind} · ${address.street.trim() || "Titik analisis"}`).slice(0, 150),
            poleHeight: assetKind === "POLE" ? poleHeight : undefined,
            designAnchor: true,
            geometry: { type: "Point", coordinates: [analyze.data!.longitude, analyze.data!.latitude] },
          },
          ...designFeatures.map((feature) => ({ ...feature.properties, geometry: feature.geometry })),
        ],
      }),
    onSuccess: (result) => {
      localStorage.setItem("atlas-map-focus", JSON.stringify([analyze.data!.longitude, analyze.data!.latitude]));
      localStorage.setItem("atlas-map-focus-design", result.designId);
      return Promise.all([queryClient.invalidateQueries({ queryKey: ["segments"] }), queryClient.invalidateQueries({ queryKey: ["map-assets"] }), queryClient.invalidateQueries({ queryKey: ["analysis-history"] })]);
    },
  });
  const error = analyze.error as ApiError | null;
  const updateAddress = (field: keyof AddressFields, value: string) => {
    regionLookupId.current += 1;
    setAddress((current) => ({
      ...current,
      [field]: value,
      ...(field === "street" ? { postalCode: "", provinceCode: "", cityCode: "", districtCode: "", subdistrictCode: "" } : field === "postalCode" ? { districtCode: "", subdistrictCode: "" } : {}),
    }));
    setSelectedPoint(null);
    analyze.reset();
  };
  const resolveSuggestionRegions = async (suggestion: AddressSuggestion) => {
    const resolve = (fields: Partial<AddressSuggestion>) => {
      const params = regionParams({
        ...fields,
        city: fields.city ?? city?.name,
        district: fields.district ?? district?.name,
        subdistrict: fields.subdistrict && !/^(?:rt|rw)\s*\d/i.test(fields.subdistrict) ? fields.subdistrict : subdistrict?.name,
        province: fields.province ?? province?.name,
        postalCode: fields.postalCode ?? address.postalCode,
        street: fields.street ?? address.street,
      });
      if (!params.has("city") && !params.has("cityCandidate")) return Promise.resolve(null);
      return resolveRegionParams(params);
    };
    let direct: ResolvedRegion | null = null;
    try {
      direct = await resolve(suggestion);
    } catch {
      /* Try reverse geocoding if the name resolver is unavailable. */
    }
    if (direct?.provinceCode && direct.cityCode && direct.districtCode && direct.subdistrictCode) return direct;
    const reverseParams = new URLSearchParams({ longitude: String(suggestion.longitude), latitude: String(suggestion.latitude) });
    let reverse: Partial<AddressSuggestion> | null = null;
    try {
      reverse = await api<Partial<AddressSuggestion> | null>(`/analysis/address/reverse?${reverseParams}`);
    } catch {
      return direct;
    }
    if (!reverse) return direct;
    const refined = await resolve({
      ...suggestion,
      ...reverse,
      city: reverse.city ?? suggestion.city,
      district: reverse.district ?? suggestion.district,
      subdistrict: reverse.subdistrict && !/^(?:rt|rw)\s*\d/i.test(reverse.subdistrict) ? reverse.subdistrict : suggestion.subdistrict && !/^(?:rt|rw)\s*\d/i.test(suggestion.subdistrict) ? suggestion.subdistrict : undefined,
      province: reverse.province ?? suggestion.province,
      postalCode: reverse.postalCode ?? suggestion.postalCode,
      cityCandidates: [...(suggestion.cityCandidates ?? []), ...(reverse.cityCandidates ?? [])],
      districtCandidates: [...(suggestion.districtCandidates ?? []), ...(reverse.districtCandidates ?? [])],
      subdistrictCandidates: [...(suggestion.subdistrictCandidates ?? []), ...(reverse.subdistrictCandidates ?? [])],
    });
    return refined ?? direct;
  };
  const resolvePointRegions = async (longitude: number, latitude: number) => {
    const lookupId = ++regionLookupId.current;
    try {
      const reverse = await api<Partial<AddressSuggestion> | null>(
        `/analysis/address/reverse?${new URLSearchParams({ longitude: String(longitude), latitude: String(latitude) })}`,
      );
      if (!reverse?.city && !reverse?.cityCandidates?.length) return;
      const params = regionParams(reverse);
      const resolved = await resolveRegionParams(params);
      if (!resolved || lookupId !== regionLookupId.current) return;
      setAddress((current) => ({
        ...current,
        provinceCode: resolved.provinceCode,
        cityCode: resolved.cityCode,
        districtCode: resolved.districtCode ?? "",
        subdistrictCode: resolved.subdistrictCode ?? "",
        postalCode: resolved.postalCode ?? current.postalCode,
      }));
    } catch {
      // Keep the point usable when reverse geocoding or region lookup is unavailable.
    }
  };
  const selectSuggestion = async (suggestion: AddressSuggestion) => {
    const lookupId = ++regionLookupId.current;
    const selectedLabel = suggestion.label;
    setSelectedPoint({ longitude: suggestion.longitude, latitude: suggestion.latitude, label: selectedLabel, provider: "photon", matchQuality: "approximate", matchedStreet: suggestion.street, confirmed: false });
    analyze.reset();
    let resolved: ResolvedRegion | null = null;
    try {
      resolved = await resolveSuggestionRegions(suggestion);
    } catch {
      /* Keep manual region inputs available if auto-fill is unavailable. */
    }
    if (lookupId !== regionLookupId.current) return;
    setAddress((current) => ({
      ...current,
      street: suggestion.street || suggestion.label,
      number: suggestion.number || current.number,
      postalCode: resolved?.postalCode ?? suggestion.postalCode ?? current.postalCode,
      ...(resolved ? { provinceCode: resolved.provinceCode, cityCode: resolved.cityCode, districtCode: resolved.districtCode ?? "", subdistrictCode: resolved.subdistrictCode ?? "" } : {}),
    }));
  };
  useEffect(() => {
    const normalizeStreet = (value: string) => {
      const romanToArabic: Record<string, string> = {
        i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10",
        xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15", xvi: "16", xvii: "17", xviii: "18", xix: "19", xx: "20",
      };
      return value
        .toLocaleLowerCase("id")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/^\s*(?:jalan|jln|jl)\.?\s*/, "")
        .replace(/\b(?:letjen|letjend)\b/g, "letnan jenderal")
        .replace(/\bmayjen\b/g, "mayor jenderal")
        .replace(/\bbrigjen\b/g, "brigadir jenderal")
        .replace(/^(?:(?:brigadir|letnan|mayor)\s+)?jenderal\s+/, "")
        .replace(/\bkol\.?\b/g, "kolonel")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .split(/\s+/)
        .map((token) => romanToArabic[token] ?? token)
        .join(" ");
    };
    const matchingSuggestions = (suggestionsQuery.data ?? []).filter((candidate) => {
      if (!candidate.street) return false;
      const regionTokens = new Set(normalizeStreet([candidate.city, candidate.province, candidate.postalCode].filter(Boolean).join(" ")).split(" "));
      const requestedStreet = normalizeStreet(address.street).split(" ").filter((token) => token && !regionTokens.has(token));
      const suggestedStreet = normalizeStreet(candidate.street).split(" ").filter((token) => token && !regionTokens.has(token));
      return requestedStreet.length > 0 && requestedStreet.join(" ") === suggestedStreet.join(" ");
    });
    if (!matchingSuggestions.length || selectedPoint) return;
    const lookupId = regionLookupId.current;
    let cancelled = false;
    void Promise.all(matchingSuggestions.map((suggestion) => resolveSuggestionRegions(suggestion).catch(() => null))).then((results) => {
      if (cancelled || lookupId !== regionLookupId.current) return;
      const valid = results.filter(
        (result) => result && (!address.provinceCode || result.provinceCode === address.provinceCode) && (!address.cityCode || result.cityCode === address.cityCode),
      );
      const common = (field: "provinceCode" | "cityCode" | "districtCode" | "subdistrictCode" | "postalCode") => {
        const values = new Set(valid.map((result) => result?.[field]).filter((value): value is string => Boolean(value)));
        return values.size === 1 ? values.values().next().value ?? "" : "";
      };
      const provinceCode = common("provinceCode");
      const cityCode = common("cityCode");
      if (!provinceCode || !cityCode) return;
      setAddress((current) =>
        current.street === address.street && (!current.cityCode || current.cityCode === cityCode)
          ? {
              ...current,
              provinceCode,
              cityCode,
              districtCode: common("districtCode") || current.districtCode,
              subdistrictCode: common("subdistrictCode") || current.subdistrictCode,
              postalCode: common("postalCode") || matchingSuggestions.find((candidate) => candidate.postalCode)?.postalCode || current.postalCode,
            }
          : current,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [suggestionsQuery.data, address.street, address.provinceCode, address.cityCode, selectedPoint]);
  const coordinates = analyze.data ? `${analyze.data.latitude}, ${analyze.data.longitude}` : "";
  const copyCoordinates = async () => {
    try {
      await navigator.clipboard.writeText(coordinates);
      setCoordinateCopyStatus("copied");
      window.setTimeout(() => setCoordinateCopyStatus("idle"), 2000);
    } catch {
      setCoordinateCopyStatus("error");
    }
  };
  const createFtthDraft = async () => {
    if (!analyze.data) return;
    setDesignLoading(true);
    setDesignError("");
    setDesignNotice("");
    setDesignFeatures([]);
    saveDesign.reset();
    try {
      const { features, uncoveredTargets, generatedOlt } = await generateFtthDraft([analyze.data.longitude, analyze.data.latitude], assetKind);
      setDesignFeatures(features);
      setDesignNotice([
        generatedOlt ? "Sistem mengusulkan OLT otomatis di jalan terhubung dengan prioritas akses yang lebih baik dan rute feeder pendek; verifikasi lokasinya saat survei lapangan." : "",
        uncoveredTargets ? `${uncoveredTargets} titik pemerataan tidak dapat dipasangi ODP dengan jalur kabel maksimal 1.500 m pada jaringan GraphHopper. Cakupan mengikuti jalan yang tersedia; sebagian boundary masih belum terlayani.` : "",
      ].filter(Boolean).join(" "));
    } catch (error) {
      setDesignError(error instanceof Error ? error.message : "Draft FTTH tidak dapat dibuat.");
    } finally {
      setDesignLoading(false);
    }
  };

  return (
    <>
      <PageHeader title="Analisis alamat" subtitle="Ubah alamat menjadi koordinat dan temukan jaringan terdekat." />
      <div className="row g-4">
        <div className="col-lg-7">
          <section className="card panel-card">
            <div className="card-header analysis-form-header">
              <div>
                <h3>Lokasi pelanggan</h3>
                <p>Ketik alamat bebas atau lengkapi detail wilayah untuk mempersempit hasil.</p>
              </div>
              <span className="step-tag">ANALISIS TUNGGAL</span>
            </div>
            <div className="card-body">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!selectedPoint?.confirmed) return;
                  analyze.mutate({
                    address: fullAddress || address.street,
                    structured: {
                      street: address.street,
                      number: address.number,
                      subdistrict: subdistrict?.name ?? "",
                      district: district?.name ?? "",
                      city: city?.name ?? "",
                      province: province?.name ?? "",
                      postalCode: address.postalCode,
                    },
                    coordinates: { longitude: selectedPoint.longitude, latitude: selectedPoint.latitude, provider: selectedPoint.provider, matchQuality: selectedPoint.matchQuality, matchedStreet: selectedPoint.matchedStreet },
                    coordinateConfirmed: true,
                  });
                }}
              >
                <div className="row g-3">
                  <div className="col-12 position-relative">
                    <label className="form-label fw-semibold" htmlFor="street">
                      Nama jalan
                    </label>
                    <input
                      id="street"
                      className="form-control"
                      autoComplete="street-address"
                      value={address.street}
                      onChange={(event) => updateAddress("street", event.target.value)}
                      placeholder="Contoh: Jl. Panjang Arteri Klp. Dua Raya"
                      aria-autocomplete="list"
                      aria-controls="address-suggestions"
                      aria-expanded={!selectedPoint && addressQuery.length >= 3 && Boolean(suggestionsQuery.data?.length)}
                    />
                    {!selectedPoint && addressQuery.length >= 3 && (
                      <div id="address-suggestions" className="list-group position-absolute top-100 start-0 end-0 shadow" style={{ zIndex: 20 }} role="listbox" aria-label="Saran alamat">
                        {debouncedQuery !== addressQuery || suggestionsQuery.isFetching ? (
                          <div className="list-group-item text-secondary">
                            <span className="spinner-border spinner-border-sm me-2" />
                            Mencari alamat...
                          </div>
                        ) : suggestionsQuery.isError ? (
                          <div className="list-group-item text-danger">Saran alamat gagal dimuat. Anda tetap bisa memilih titik pada peta.</div>
                        ) : suggestionsQuery.data?.length ? (
                          <>
                            {suggestionsQuery.data.map((suggestion) => (
                              <button type="button" role="option" aria-selected={false} className="list-group-item list-group-item-action text-start" key={suggestion.id} onClick={() => void selectSuggestion(suggestion)}>
                                <b className="d-block">{suggestion.label}</b>
                                <small className="text-secondary">{[suggestion.category, suggestion.location].filter(Boolean).join(", ") || "Kandidat Photon"} · periksa pin pada peta</small>
                              </button>
                            ))}
                            <button type="button" className="list-group-item list-group-item-action text-start text-primary" onClick={() => setShowPinPicker(true)}>
                              <i className="bi bi-geo-alt me-2" />
                              Pilih titik manual di peta
                            </button>
                          </>
                        ) : suggestionsQuery.isSuccess ? (
                          <div className="list-group-item text-secondary">Belum ada saran yang cocok. Pilih titik secara manual pada peta.</div>
                        ) : null}
                      </div>
                    )}
                  </div>
                  <div className="col-12">
                    <div className="fw-semibold">
                      Pilih Wilayah <span className="text-danger">(wajib)</span>
                    </div>
                    <div className="form-text mb-2">Pilih wilayah untuk mempersempit hasil. Jika belum dipilih, Anda juga bisa mencari dengan alamat lengkap.</div>
                    <div className="row g-3">
                      <div className="col-md-6">
                        <label className="form-label fw-semibold" htmlFor="province">
                          Provinsi *
                        </label>
                        <select
                          id="province"
                          className="form-select"
                          required
                          value={address.provinceCode}
                          onChange={(event) => {
                            setAddress((current) => ({ ...current, provinceCode: event.target.value, cityCode: "", districtCode: "", subdistrictCode: "", postalCode: "" }));
                            setSelectedPoint(null);
                            analyze.reset();
                          }}
                        >
                          <option value="">Pilih provinsi</option>
                          {[...regions]
                            .sort((a, b) => a.name.localeCompare(b.name, "id"))
                            .map((item) => (
                              <option value={item.code} key={item.code}>
                                {item.name}
                              </option>
                            ))}
                        </select>
                      </div>
                      <div className="col-md-6">
                        <label className="form-label fw-semibold" htmlFor="city">
                          Kabupaten / kota *
                        </label>
                        <select
                          id="city"
                          className="form-select"
                          required
                          value={address.cityCode}
                          onChange={(event) => {
                            setAddress((current) => ({ ...current, cityCode: event.target.value, districtCode: "", subdistrictCode: "", postalCode: "" }));
                            setSelectedPoint(null);
                            analyze.reset();
                          }}
                          disabled={!province}
                        >
                          <option value="">Pilih kabupaten/kota</option>
                          {cities.map((item) => (
                            <option value={item.code} key={item.code}>
                              {item.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="col-md-6">
                        <label className="form-label fw-semibold" htmlFor="district">
                          Kecamatan *
                        </label>
                        <select
                          id="district"
                          className="form-select"
                          required
                          value={address.districtCode}
                          onChange={(event) => {
                            setAddress((current) => ({ ...current, districtCode: event.target.value, subdistrictCode: "", postalCode: "" }));
                            setSelectedPoint(null);
                            analyze.reset();
                          }}
                          disabled={!city}
                        >
                          <option value="">Pilih kecamatan</option>
                          {districts.map((item) => (
                            <option value={item.code} key={item.code}>
                              {item.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="col-md-6">
                        <label className="form-label fw-semibold" htmlFor="subdistrict">
                          Kelurahan / desa *
                        </label>
                        <select
                          id="subdistrict"
                          className="form-select"
                          required
                          value={address.subdistrictCode}
                          onChange={(event) => {
                            const selected = subdistricts.find((item) => item.code === event.target.value);
                            setAddress((current) => ({ ...current, subdistrictCode: event.target.value, postalCode: selected?.postalCode ?? "" }));
                            setSelectedPoint(null);
                            analyze.reset();
                          }}
                          disabled={!district || loadingSubdistricts || subdistrictLoadError}
                        >
                          <option value="">{loadingSubdistricts ? "Memuat daftar..." : "Pilih kelurahan/desa"}</option>
                          {subdistricts.map(({ code, name }) => (
                            <option value={code} key={code}>
                              {name}
                            </option>
                          ))}
                        </select>
                        {subdistrictLoadError && <div className="form-text text-danger">Daftar kelurahan/desa gagal dimuat. Coba pilih ulang kabupaten/kota.</div>}
                      </div>
                      <div className="col-md-6">
                        <label className="form-label fw-semibold" htmlFor="street-number">
                          Nomor rumah
                        </label>
                        <input id="street-number" className="form-control" value={address.number} onChange={(event) => updateAddress("number", event.target.value)} placeholder="Contoh: 12 atau A-12" />
                      </div>
                      <div className="col-md-6">
                        <label className="form-label fw-semibold" htmlFor="postal-code">
                          Kode pos
                        </label>
                        <input
                          id="postal-code"
                          className="form-control"
                          inputMode="numeric"
                          autoComplete="postal-code"
                          pattern="[0-9]{5}"
                          maxLength={5}
                          value={address.postalCode}
                          onChange={(event) => updateAddress("postalCode", event.target.value)}
                          placeholder="Opsional"
                        />
                        {postalRegionQuery.data && <div className="form-text">Wilayah ditemukan dari kode pos. Pastikan kelurahan sesuai dengan nama jalan.</div>}
                      </div>
                    </div>
                  </div>
                </div>
                {(selectedPoint || selectedRegionName || showPinPicker || (addressQuery.length >= 3 && debouncedQuery === addressQuery && suggestionsQuery.isSuccess && !suggestionsQuery.data?.length) || suggestionsQuery.isError) && (
                  <div className="mt-3">
                    <div className="d-flex align-items-center justify-content-between gap-2 mb-2">
                      <b>Pilih atau periksa titik alamat</b>
                      {selectedPoint && (
                        <small className="text-secondary">
                          {selectedPoint.latitude.toFixed(6)}, {selectedPoint.longitude.toFixed(6)}
                        </small>
                      )}
                    </div>
                    <AddressPinPicker
                      point={selectedPoint}
                      regionView={regionMapQuery.data ?? null}
                      onViewportChange={setSearchViewport}
                      onChange={(longitude, latitude) => {
                        void resolvePointRegions(longitude, latitude);
                        setSelectedPoint((current) => ({
                          longitude,
                          latitude,
                          label: current?.label ?? "Titik dipilih manual",
                          provider: current?.provider ?? "manual",
                          matchQuality: current?.matchQuality,
                          matchedStreet: current?.matchedStreet,
                          confirmed: false,
                        }));
                        analyze.reset();
                      }}
                    />
                    <div className="form-text">
                      {selectedPoint
                        ? "Klik peta atau geser pin untuk mengoreksi posisi."
                        : selectedRegionName
                          ? `Peta diarahkan ke perkiraan area ${subdistrict ? "kelurahan" : district ? "kecamatan" : city ? "kabupaten/kota" : "provinsi"} ${selectedRegionName}. Klik peta untuk menentukan titik alamat yang tepat.`
                          : "Klik peta untuk menentukan titik alamat."}
                    </div>
                    {selectedPoint && (
                      <div className={`alert ${selectedPoint.confirmed ? "alert-success" : "alert-warning"} py-2 mt-2 mb-0`}>
                        <div>
                          <b>{selectedPoint.confirmed ? "Titik dikonfirmasi" : "Periksa lokasi sebelum lanjut"}</b>
                          <div>{selectedPoint.label}</div>
                          {selectedPoint.matchQuality === "approximate" && <small>Nama jalan kandidat: {selectedPoint.matchedStreet ?? "tidak tersedia"}. Pastikan pin berada di alamat yang dimaksud.</small>}
                        </div>
                        {!selectedPoint.confirmed && (
                          <button type="button" className="btn btn-sm btn-outline-primary mt-2" onClick={() => setSelectedPoint((current) => (current ? { ...current, confirmed: true } : current))}>
                            Konfirmasi titik ini
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <div className="form-text mt-3">
                  <i className="bi bi-info-circle me-1" />
                  Ketik dan pilih saran nama jalan untuk mengisi wilayah otomatis. Jika hasil wilayah tidak tersedia, Anda dapat memilihnya manual.
                </div>
                <div className="d-flex justify-content-between align-items-center mt-4">
                  <button
                    type="button"
                    className="btn btn-link text-secondary p-0"
                    onClick={() => {
                      regionLookupId.current += 1;
                      setAddress({ street: "", number: "", postalCode: "", provinceCode: "", cityCode: "", districtCode: "", subdistrictCode: "" });
                      setSelectedPoint(null);
                      setShowPinPicker(false);
                      setDebouncedQuery("");
                      analyze.reset();
                    }}
                  >
                    Bersihkan
                  </button>
                  <button className="btn btn-primary px-4" disabled={analyze.isPending || !address.street.trim() || !hasSearchArea || !selectedPoint?.confirmed}>
                    {analyze.isPending ? (
                      <>
                        <span className="spinner-border spinner-border-sm me-2" />
                        Menganalisis...
                      </>
                    ) : (
                      <>
                        <i className="bi bi-search me-2" />
                        Analisis jaringan
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </section>
          <div className="info-note mt-3">
            <i className="bi bi-lightbulb" />
            <p>
              <b>Bagaimana hasil dihitung?</b>
              <br />
              ATLAS menggunakan titik yang Anda pilih, mencari segmen terdekat, lalu menghitung jarak mengikuti jalan jika layanan routing tersedia.
            </p>
          </div>
        </div>
        <div className="col-lg-5">
          {analyze.data ? (
            <section className="card panel-card result-card">
              <div className={`result-success ${analyze.data.distanceMeters === null ? "result-pending" : ""}`}>
                <span>
                  <i className={`bi ${analyze.data.distanceMeters === null ? "bi-info-lg" : "bi-check-lg"}`} />
                </span>
                <div>
                  <b>{analyze.data.distanceMeters === null ? "Hasil parsial" : "Analisis berhasil"}</b>
                  <small>{analyze.data.message ?? "Koordinat dan jaringan terdekat ditemukan."}</small>
                </div>
              </div>
              <div className="card-body">
                {analyze.data.geocodingMatch === "approximate" && (
                  <div className="alert alert-warning">
                    Nama jalan tidak cocok sepenuhnya dengan data peta. Titik mengikuti ruas <b>{analyze.data.matchedStreet ?? "yang paling sesuai"}</b> berdasarkan kecamatan dan kode pos. Periksa posisi di peta sebelum menyimpan aset atau
                    membuat draft.
                  </div>
                )}
                <div className="detail-label">HASIL KONVERSI</div>
                <div className="result-address">
                  <i className="bi bi-geo-alt-fill" />
                  <span>{analyze.data.address}</span>
                </div>
                <div className="w-100 rounded border bg-body-tertiary px-3 py-2 mt-3 d-flex align-items-center justify-content-between gap-2" aria-label="Koordinat">
                  <div className="min-w-0">
                    <small className="d-block text-secondary">Koordinat</small>
                    <b className="font-monospace user-select-all text-break">{coordinates}</b>
                  </div>
                  <button type="button" className="btn btn-sm btn-outline-primary flex-shrink-0" onClick={copyCoordinates} aria-label="Salin koordinat" title={coordinateCopyStatus === "copied" ? "Tersalin" : "Salin koordinat"}>
                    <i className={`bi ${coordinateCopyStatus === "copied" ? "bi-check2" : coordinateCopyStatus === "error" ? "bi-exclamation-triangle" : "bi-clipboard"}`} />
                  </button>
                </div>
                <a className="btn btn-outline-primary w-100 mt-2" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coordinates)}`} target="_blank" rel="noreferrer">
                  <i className="bi bi-map me-2" />
                  Buka Google Maps
                </a>
                <div className="border rounded p-3 mt-3">
                  <label className="form-label fw-semibold" htmlFor="ftth-asset-kind">
                    Simpan titik sebagai aset FTTH
                  </label>
                  <div className="d-flex gap-2">
                    <select
                      id="ftth-asset-kind"
                      className="form-select"
                      value={assetKind}
                      onChange={(event) => {
                        setAssetKind(event.target.value);
                        saveAsset.reset();
                        setDesignFeatures([]);
                        setDesignError("");
                        setDesignNotice("");
                        saveDesign.reset();
                      }}
                      disabled={saveAsset.isPending}
                    >
                      <option value="OLT">OLT</option>
                      <option value="JOINT_CLOSURE">Joint Closure</option>
                      <option value="HANDHOLE">Handhole</option>
                      <option value="ODC">ODC</option>
                      <option value="ODP">ODP</option>
                      <option value="POLE">Tiang</option>
                    </select>
                    <button type="button" className="btn btn-primary flex-shrink-0" onClick={() => saveAsset.mutate()} disabled={saveAsset.isPending || saveAsset.isSuccess}>
                      {saveAsset.isPending ? "Menyimpan..." : "Simpan"}
                    </button>
                  </div>
                  {assetKind === "POLE" && (
                    <div className="mt-2">
                      <label className="form-label" htmlFor="ftth-pole-height">
                        Tinggi tiang
                      </label>
                      <select
                        id="ftth-pole-height"
                        className="form-select"
                        value={poleHeight}
                        onChange={(event) => {
                          setPoleHeight(event.target.value);
                          saveAsset.reset();
                        }}
                        disabled={saveAsset.isPending}
                      >
                        <option value="7 m">7 meter</option>
                        <option value="9 m">9 meter</option>
                      </select>
                    </div>
                  )}
                  <input
                    className="form-control mt-2"
                    value={assetName}
                    onChange={(event) => {
                      setAssetName(event.target.value);
                      saveAsset.reset();
                    }}
                    placeholder={`${assetKind} · Nama aset (opsional)`}
                    maxLength={150}
                    aria-label="Nama aset"
                  />
                  {saveAsset.isSuccess && <small className="text-success d-block mt-2">Aset tersimpan{assetKind === "POLE" ? ` dengan tinggi ${poleHeight}` : ""}. Buka Peta Jaringan untuk melihatnya.</small>}
                  {saveAsset.error && <small className="text-danger d-block mt-2">{saveAsset.error.message}</small>}
                </div>
                <div className="border rounded p-3 mt-3">
                  <b className="d-block">Draft FTTH otomatis</b>
                  <small className="d-block text-secondary mt-1">
                    Sistem menempatkan ODC dan ODP berdasarkan boundary 500 m, perkiraan radius layanan ODP 150 m, kapasitas maksimal 4 ODP per ODC, dan jalur yang tersedia di GraphHopper. Jarak kabel distribusi maksimal 1.500 m; jarak
                    antartiang otomatis sekitar 50 m. Tinggi tiang diperkirakan dari kelas jalan: jalan utama 9 m, jalan lokal/gang 7 m. Klik tiang di peta untuk melihat kelas jalan yang terbaca. Perkiraan ini perlu verifikasi survei
                    lapangan. Jika titik awal bukan OLT, sistem mengusulkan OLT otomatis pada jalan yang dapat dirutekan dengan mempertimbangkan kelas jalan dan rute feeder; titik ini tetap perlu diverifikasi saat survei.
                  </small>
                  <button type="button" className="btn btn-primary w-100 mt-2" onClick={() => void createFtthDraft()} disabled={designLoading}>
                    {designLoading ? (
                      <>
                        <span className="spinner-border spinner-border-sm me-2" />
                        Menghitung rute jalan...
                      </>
                    ) : (
                      <>
                        <i className="bi bi-diagram-3 me-2" />
                        Buat draft FTTH
                      </>
                    )}
                  </button>
                  {designError && <div className="alert alert-danger py-2 px-3 mt-2 mb-0">{designError}</div>}
                  {designNotice && <div className="alert alert-warning py-2 px-3 mt-2 mb-0">{designNotice}</div>}
                  {designFeatures.length > 0 && (
                    <>
                      <small className="d-block text-success mt-2">
                        Draft: {designFeatures.filter((feature) => feature.properties.kind === "ODC").length} ODC, {designFeatures.filter((feature) => feature.properties.kind === "ODP").length} ODP,{" "}
                        {designFeatures.filter((feature) => feature.properties.kind === "POLE").length} tiang, {designFeatures.filter((feature) => feature.properties.kind === "ROUTE").length} jalur.
                      </small>
                      <button type="button" className="btn btn-outline-primary w-100 mt-2" onClick={() => saveDesign.mutate()} disabled={saveDesign.isPending || saveDesign.isSuccess}>
                        {saveDesign.isPending ? "Menyimpan desain..." : saveDesign.isSuccess ? "Desain tersimpan" : "Simpan desain ke peta jaringan"}
                      </button>
                      {saveDesign.error && <small className="text-danger d-block mt-2">{saveDesign.error.message}</small>}
                    </>
                  )}
                </div>
                {coordinateCopyStatus !== "idle" && (
                  <small className={`d-block mt-1 ${coordinateCopyStatus === "error" ? "text-danger" : "text-success"}`}>{coordinateCopyStatus === "copied" ? "Koordinat tersalin." : "Gagal menyalin koordinat."}</small>
                )}
                {analyze.data.geocodingProvider === "nominatim" && (
                  <small className="text-secondary d-block mt-2">
                    Lokasi dari{" "}
                    <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
                      © OpenStreetMap contributors
                    </a>
                    .
                  </small>
                )}
                <hr />
                <div className="detail-label">JARINGAN TERDEKAT</div>
                {analyze.data.network ? (
                  <>
                    <div className="nearest-network">
                      <span className="network-icon">
                        <i className="bi bi-bezier2" />
                      </span>
                      <div>
                        <b>{analyze.data.network.name}</b>
                        <small>
                          {analyze.data.network.area} · {analyze.data.network.cableType}
                        </small>
                      </div>
                    </div>
                    <div className="distance-card">
                      <div>
                        <small>Estimasi jarak jalan</small>
                        <strong>{analyze.data.distanceMeters === null ? "Belum tersedia" : `${(analyze.data.distanceMeters / 1000).toFixed(2)} km`}</strong>
                      </div>
                      <span className="distance-icon">
                        <i className="bi bi-rulers" />
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="alert alert-secondary">Belum ada jaringan dengan geometri di dekat titik ini.</div>
                )}
                <Link to="/peta-jaringan" className="btn btn-outline-primary w-100 mt-3">
                  <i className="bi bi-map me-2" />
                  Lihat di peta jaringan
                </Link>
              </div>
            </section>
          ) : (
            <section className="empty-result">
              <div className="empty-illustration">
                <i className="bi bi-geo-alt" />
                <span />
                <span />
              </div>
              <h3>{error ? "Analisis belum tersedia" : "Hasil analisis akan tampil di sini"}</h3>
              <p>{error ? error.message : "Lengkapi alamat untuk melihat koordinat, jaringan terdekat, dan jarak jalan."}</p>
            </section>
          )}
        </div>
      </div>
      {analyze.data && (
        <section className="card panel-card mt-4">
          <div className="card-header">
            <div>
              <h3>Peta lokasi</h3>
              <p>Boundary 500 m dan perkiraan radius layanan 150 m tiap ODP.</p>
            </div>
          </div>
          <div className="card-body">
            <AddressResultMap latitude={analyze.data.latitude} longitude={analyze.data.longitude} anchorKind={assetKind} design={designFeatures} />
            <div className="d-flex flex-wrap gap-3 mt-2 small text-secondary">
              <span>
                <i className="bi bi-circle-fill text-primary me-1" />
                Boundary 500 m
              </span>
              <span>
                <i className="bi bi-circle-fill text-warning me-1" />
                Radius layanan ODP 150 m
              </span>
              <span>
                <i className="bi bi-hdd-network me-1" style={{ color: "#e8b500" }} />
                OLT
              </span>
              <span>
                <i className="bi bi-triangle-fill me-1" style={{ color: "#ff0000" }} />
                ODC
              </span>
              <span>
                <i className="bi bi-triangle-fill me-1" style={{ color: "#0000ff" }} />
                ODP
              </span>
              <span>
                <i className="bi bi-signpost-2 me-1" style={{ color: "#536177" }} />
                Tiang · ±50 m
              </span>
              <span>
                <i className="bi bi-dash-lg me-1" style={{ color: "#ff0000" }} />
                Kabel feeder
              </span>
              <span>
                <i className="bi bi-dash-lg me-1" style={{ color: "#a000ff" }} />
                Kabel distribusi
              </span>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
