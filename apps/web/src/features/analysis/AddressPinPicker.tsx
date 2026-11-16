import {
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useRef } from "react";

export type SelectedPoint = {
  longitude: number;
  latitude: number;
  label: string;
  provider: "photon" | "manual";
  matchQuality?: "approximate";
  matchedStreet?: string;
  confirmed: boolean;
};

export type SearchViewport = {
  longitude: number;
  latitude: number;
  zoom: number;
};

export function AddressPinPicker({
  point,
  regionView,
  onChange,
  onViewportChange,
}: {
  point: SelectedPoint | null;
  regionView: SearchViewport | null;
  onChange: (longitude: number, latitude: number) => void;
  onViewportChange: (viewport: SearchViewport) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onViewportChangeRef = useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;
  const pointRef = useRef(point);
  pointRef.current = point;
  // biome-ignore lint/correctness/useExhaustiveDependencies: create the map once; later point/viewport changes are applied by the effects below
  useEffect(() => {
    if (!container.current) {
      return;
    }
    setWorkerUrl(workerUrl);
    const map = new MapLibreMap({
      container: container.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: point
        ? [point.longitude, point.latitude]
        : regionView
          ? [regionView.longitude, regionView.latitude]
          : [118, -2],
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
      onViewportChangeRef.current({
        longitude: center.lng,
        latitude: center.lat,
        zoom: map.getZoom(),
      });
    };
    map.on("moveend", reportViewport);
    map.on("load", () => {
      if (pointRef.current) {
        marker
          .setLngLat([pointRef.current.longitude, pointRef.current.latitude])
          .addTo(map);
      }
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on coordinates so a new point object with the same position does not re-ease the map
  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!(map && marker)) {
      return;
    }
    if (!point) {
      marker.remove();
      return;
    }
    marker.setLngLat([point.longitude, point.latitude]).addTo(map);
    map.easeTo({
      center: [point.longitude, point.latitude],
      zoom: Math.max(map.getZoom(), 16),
    });
  }, [point?.longitude, point?.latitude]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on viewport values so a new regionView object with the same values does not re-ease the map
  useEffect(() => {
    const map = mapRef.current;
    if (!map || point || !regionView) {
      return;
    }
    map.easeTo({
      center: [regionView.longitude, regionView.latitude],
      zoom: regionView.zoom,
      duration: 700,
    });
  }, [point, regionView?.longitude, regionView?.latitude, regionView?.zoom]);
  return (
    <div
      aria-label="Pilih atau koreksi titik alamat pada peta"
      className="address-pin-picker"
      ref={container}
      role="application"
      style={{
        height: 320,
        width: "100%",
        borderRadius: 8,
        overflow: "hidden",
      }}
    />
  );
}
