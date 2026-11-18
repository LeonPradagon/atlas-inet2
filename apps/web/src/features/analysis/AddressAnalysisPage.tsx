import { notify } from "../../components/Snackbar";
import { formatDistance } from "../../lib/format";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AtlasTag } from "../../components/AtlasTag";
import { DetailTable } from "../../components/DetailTable";
import { PageHeader } from "../../components/PageHeader";
import { type ApiError, api, postJson } from "../../lib/api";
import {
  AddressPinPicker,
  type SearchViewport,
  type SelectedPoint,
} from "./AddressPinPicker";
import {
  ConnectionAnalysisResult,
  type ConnectionResult,
} from "./ConnectionAnalysisResult";
import {
  NearestNetworkMap,
  type NetworkRouteOption,
  type NetworkSearchResult,
  resultForRoute,
} from "./NearestNetworkMap";
import { NetworkCapacityDetail } from "./NetworkCapacityDetail";
import { SubmitSurveyButton } from "./SubmitSurveyButton";
import { TerminationDetail } from "./TerminationDetail";

type Result = NetworkSearchResult & {
  address: string;
  latitude: number;
  longitude: number;
  historyId: string;
  distanceMeters: number | null;
  status: string;
  message?: string;
  geocodingProvider?: "photon" | "nominatim" | "manual";
  geocodingMatch?: "approximate";
  matchedStreet?: string;
};

type RegionOption = { code: string; name: string };

type Subdistrict = RegionOption & { postalCode: string };

type AddressFields = {
  street: string;
  number: string;
  postalCode: string;
  provinceCode: string;
  cityCode: string;
  districtCode: string;
  subdistrictCode: string;
};

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

type ResolvedRegion = {
  provinceCode: string;
  cityCode: string;
  districtCode: string | null;
  subdistrictCode: string | null;
  postalCode?: string | null;
};

async function resolveRegionParams(
  params: URLSearchParams,
  allowPostalFallback = false
) {
  let result = await api<ResolvedRegion | null>(`/regions/resolve?${params}`);
  if (!result && params.has("province")) {
    const withoutProviderProvince = new URLSearchParams(params);
    withoutProviderProvince.delete("province");
    result = await api<ResolvedRegion | null>(
      `/regions/resolve?${withoutProviderProvince}`
    );
  }
  if (
    !result &&
    allowPostalFallback &&
    /^\d{5}$/u.test(params.get("postalCode") ?? "") &&
    (params.has("city") || params.has("cityCandidate"))
  ) {
    const postalParams = new URLSearchParams(params);
    postalParams.delete("city");
    postalParams.delete("cityCandidate");
    postalParams.delete("province");
    result = await api<ResolvedRegion | null>(
      `/regions/resolve?${postalParams}`
    );
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
  })) {
    if (value) {
      params.set(key, value);
    }
  }
  for (const [key, values] of Object.entries({
    cityCandidate: fields.cityCandidates,
    districtCandidate: fields.districtCandidates,
    subdistrictCandidate: fields.subdistrictCandidates,
  })) {
    for (const value of values ?? []) {
      params.append(key, value);
    }
  }
  return params;
}

export function AddressAnalysisPage() {
  return <AddressAnalysisEditor />;
}

function AddressAnalysisEditor({
  onPick,
}: {
  onPick?: (point: SelectedPoint | null) => void;
}) {
  const pickerOnly = Boolean(onPick);
  const fieldId = useId();
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const [twoPoint, setTwoPoint] = useState(false);
  const [destination, setDestination] = useState<SelectedPoint | null>(null);
  const [allowExpand2km, setAllowExpand2km] = useState(false);
  const [coreRequirement, setCoreRequirement] = useState("");
  const connection = useMutation({
    meta: { successNotice: "Analisis dua titik selesai.", errorNotice: "Analisis dua titik gagal." },
    mutationFn: (value: {
      start: { longitude: number; latitude: number; label: string };
      end: { longitude: number; latitude: number; label: string };
      allowExpand2km: boolean;
      coreRequirement?: { services: number; reserve: number };
    }) => api<ConnectionResult>("/analysis/connection", postJson(value)),
  });
  const [selectedRouteId, setSelectedRouteId] =
    useState<NetworkRouteOption["id"]>("A");
  const [inputMode, setInputMode] = useState<"address" | "coordinates" | null>(
    null
  );
  const [coordinateDraft, setCoordinateDraft] = useState({
    latitude: "",
    longitude: "",
  });
  const [address, setAddress] = useState<AddressFields>({
    street: "",
    number: "",
    postalCode: "",
    provinceCode: "",
    cityCode: "",
    districtCode: "",
    subdistrictCode: "",
  });
  const [selectedPoint, setSelectedPoint] = useState<SelectedPoint | null>(
    null
  );
  const [manualStreetStatus, setManualStreetStatus] = useState<
    "loading" | "unavailable" | null
  >(null);
  const pinPickerRef = useRef<HTMLDivElement>(null);
  const [searchViewport, setSearchViewport] = useState<SearchViewport | null>(
    null
  );
  const [showPinPicker, setShowPinPicker] = useState(false);
  const [hideAddressSuggestions, setHideAddressSuggestions] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [coordinateCopyStatus, setCoordinateCopyStatus] = useState<
    "idle" | "copied" | "error"
  >("idle");
  const regionLookupId = useRef(0);
  useEffect(() => {
    if (!showPinPicker) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      pinPickerRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      pinPickerRef.current
        ?.querySelector<HTMLCanvasElement>(".maplibregl-canvas")
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showPinPicker]);
  const addressQuery = [
    address.street,
    address.number && `No. ${address.number}`,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(addressQuery), 350);
    return () => window.clearTimeout(timer);
  }, [addressQuery]);
  const { data: regions = [] } = useQuery({
    queryKey: ["indonesia-provinces"],
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () => api<RegionOption[]>("/regions/provinces"),
  });
  const { data: cities = [] } = useQuery({
    queryKey: ["indonesia-cities", address.provinceCode],
    enabled: Boolean(address.provinceCode),
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () =>
      api<RegionOption[]>(
        `/regions/cities?provinceCode=${encodeURIComponent(address.provinceCode)}`
      ),
  });
  const { data: districts = [] } = useQuery({
    queryKey: ["indonesia-districts", address.cityCode],
    enabled: Boolean(address.cityCode),
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () =>
      api<RegionOption[]>(
        `/regions/districts?cityCode=${encodeURIComponent(address.cityCode)}`
      ),
  });
  const {
    data: subdistricts = [],
    isLoading: loadingSubdistricts,
    isError: subdistrictLoadError,
  } = useQuery({
    queryKey: ["indonesia-subdistricts", address.districtCode],
    enabled: Boolean(address.districtCode),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: () =>
      api<Subdistrict[]>(
        `/regions/subdistricts?districtCode=${encodeURIComponent(address.districtCode)}`
      ),
  });
  const province = regions.find(
    (region) => region.code === address.provinceCode
  );
  const city = cities.find((item) => item.code === address.cityCode);
  const district = districts.find((item) => item.code === address.districtCode);
  const subdistrict = subdistricts.find(
    (item) => item.code === address.subdistrictCode
  );
  const hasSearchArea = Boolean(province && city && district && subdistrict);
  const postalRegionQuery = useQuery({
    queryKey: [
      "region-by-postal",
      address.provinceCode,
      address.cityCode,
      address.postalCode,
    ],
    // A postal code may conflict with the street (or cover multiple kelurahan).
    // Prefer the street suggestion whenever one is being entered.
    enabled: Boolean(
      (selectedPoint || !address.street.trim()) &&
        /^\d{5}$/u.test(address.postalCode) &&
        !(district && subdistrict)
    ),
    staleTime: 60_000,
    retry: false,
    queryFn: () => {
      const params = new URLSearchParams({ postalCode: address.postalCode });
      if (city) {
        params.set("city", city.name);
      }
      if (province) {
        params.set("province", province.name);
      }
      return resolveRegionParams(params);
    },
  });
  useEffect(() => {
    const resolved = postalRegionQuery.data;
    if (!resolved) {
      return;
    }
    setAddress((current) =>
      (!current.provinceCode ||
        current.provinceCode === resolved.provinceCode) &&
      (!current.cityCode || current.cityCode === resolved.cityCode) &&
      (!current.districtCode ||
        !resolved.districtCode ||
        current.districtCode === resolved.districtCode) &&
      current.postalCode === address.postalCode
        ? {
            ...current,
            provinceCode: resolved.provinceCode,
            cityCode: resolved.cityCode,
            districtCode: current.districtCode || resolved.districtCode || "",
            subdistrictCode:
              current.subdistrictCode || resolved.subdistrictCode || "",
          }
        : current
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
  const selectedRegionName =
    subdistrict?.name ?? district?.name ?? city?.name ?? province?.name;
  const regionMapQuery = useQuery({
    queryKey: [
      "address-region-map",
      address.subdistrictCode,
      address.districtCode,
      address.cityCode,
      address.provinceCode,
    ],
    enabled: Boolean(selectedRegionName),
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ q: selectedRegionName! });
      if (subdistrict?.name) {
        params.set("subdistrict", subdistrict.name);
      }
      if (district?.name) {
        params.set("district", district.name);
      }
      if (city?.name) {
        params.set("city", city.name);
      }
      if (province?.name) {
        params.set("province", province.name);
      }
      const candidates = await api<AddressSuggestion[]>(
        `/analysis/address/suggestions?${params}`,
        { signal }
      );
      const candidate = candidates[0];
      if (!candidate) {
        return null;
      }
      const zoom = subdistrict ? 13 : district ? 12 : city ? 10 : 7;
      return {
        longitude: candidate.longitude,
        latitude: candidate.latitude,
        zoom,
      };
    },
  });
  const suggestionsQuery = useQuery({
    queryKey: [
      "address-suggestions",
      debouncedQuery,
      address.subdistrictCode,
      address.districtCode,
      address.cityCode,
      address.provinceCode,
      address.postalCode,
      searchViewport?.longitude,
      searchViewport?.latitude,
      searchViewport?.zoom,
    ],
    enabled:
      debouncedQuery.length >= 3 &&
      debouncedQuery === addressQuery &&
      !selectedPoint,
    staleTime: 60_000,
    retry: false,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ q: debouncedQuery, lang: "id" });
      if (subdistrict?.name) {
        params.set("subdistrict", subdistrict.name);
      }
      if (district?.name) {
        params.set("district", district.name);
      }
      if (city?.name) {
        params.set("city", city.name);
      }
      if (province?.name) {
        params.set("province", province.name);
      }
      if (address.postalCode) {
        params.set("postalCode", address.postalCode);
      }
      const bias = searchViewport ??
        regionMapQuery.data ?? { longitude: 118, latitude: -2, zoom: 4.5 };
      params.set("lon", String(bias.longitude));
      params.set("lat", String(bias.latitude));
      params.set("zoom", String(bias.zoom));
      return api<AddressSuggestion[]>(
        `/analysis/address/suggestions?${params}`,
        { signal }
      );
    },
  });
  const analyze = useMutation({
    meta: { successNotice: "Analisis jaringan selesai.", errorNotice: "Analisis jaringan gagal." },
    mutationFn: (value: {
      address: string;
      structured: {
        street: string;
        number: string;
        subdistrict: string;
        district: string;
        city: string;
        province: string;
        postalCode: string;
      };
      coordinates: {
        longitude: number;
        latitude: number;
        provider: "photon" | "manual";
        matchQuality?: "approximate";
        matchedStreet?: string;
      };
      coordinateConfirmed: true;
      allowExpand2km?: boolean;
    }) => api<Result>("/analysis/address", postJson(value)),
  });
  const selectedResult = useMemo(
    () => (analyze.data ? resultForRoute(analyze.data, selectedRouteId) : null),
    [analyze.data, selectedRouteId]
  );
  const activeRouteId = selectedResult?.selectedRouteId ?? "A";
  const submitAnalysis = (point = selectedPoint) => {
    if (!point?.confirmed) {
      return;
    }
    if (onPick) {
      onPick({
        ...point,
        label:
          inputMode === "address" ? fullAddress || point.label : point.label,
      });
      return;
    }
    if (twoPoint) {
      if (!destination?.confirmed) {
        return;
      }
      analyze.reset();
      connection.mutate({
        start: {
          longitude: point.longitude,
          latitude: point.latitude,
          label:
            inputMode === "address" ? fullAddress || point.label : point.label,
        },
        end: {
          longitude: destination.longitude,
          latitude: destination.latitude,
          label: destination.label,
        },
        allowExpand2km,
        ...(coreRequirement
          ? {
              coreRequirement: {
                services: Number(coreRequirement),
                reserve: 0,
              },
            }
          : {}),
      });
      return;
    }
    setSelectedRouteId("A");
    const usesAddress = inputMode === "address";
    analyze.mutate({
      address: usesAddress ? fullAddress || address.street : point.label,
      structured: {
        street: usesAddress ? address.street : "",
        number: usesAddress ? address.number : "",
        subdistrict: usesAddress ? (subdistrict?.name ?? "") : "",
        district: usesAddress ? (district?.name ?? "") : "",
        city: usesAddress ? (city?.name ?? "") : "",
        province: usesAddress ? (province?.name ?? "") : "",
        postalCode: usesAddress ? address.postalCode : "",
      },
      coordinates: {
        longitude: point.longitude,
        latitude: point.latitude,
        provider: point.provider,
        matchQuality: point.matchQuality,
        matchedStreet: point.matchedStreet,
      },
      coordinateConfirmed: true,
    });
  };
  const parsedCoordinates = (() => {
    const { latitude, longitude } = coordinateDraft;
    if (!latitude.trim() || !longitude.trim()) {
      return null;
    }
    const lat = Number(latitude.replace(",", "."));
    const lon = Number(longitude.replace(",", "."));
    return Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180
      ? { latitude: lat, longitude: lon }
      : null;
  })();
  const chooseInputMode = (mode: "address" | "coordinates") => {
    setInputMode(mode);
    setManualStreetStatus(null);
    setSelectedPoint(null);
    analyze.reset();
    connection.reset();
  };
  const error = analyze.error as ApiError | null;
  const updateAddress = (field: keyof AddressFields, value: string) => {
    regionLookupId.current += 1;
    setManualStreetStatus(null);
    setAddress((current) => ({
      ...current,
      [field]: value,
      ...(field === "street"
        ? {
            postalCode: "",
            provinceCode: "",
            cityCode: "",
            districtCode: "",
            subdistrictCode: "",
          }
        : field === "postalCode"
          ? { districtCode: "", subdistrictCode: "" }
          : {}),
    }));
    setSelectedPoint(null);
    analyze.reset();
    connection.reset();
  };
  const resolveSuggestionRegions = async (suggestion: AddressSuggestion) => {
    const resolve = (fields: Partial<AddressSuggestion>) => {
      const params = regionParams({
        ...fields,
        city: fields.city ?? city?.name,
        district: fields.district ?? district?.name,
        subdistrict:
          fields.subdistrict && !/^(?:rt|rw)\s*\d/iu.test(fields.subdistrict)
            ? fields.subdistrict
            : subdistrict?.name,
        province: fields.province ?? province?.name,
        postalCode: fields.postalCode ?? address.postalCode,
        street: fields.street ?? address.street,
      });
      if (
        !(
          params.has("city") ||
          params.has("cityCandidate") ||
          /^\d{5}$/u.test(params.get("postalCode") ?? "")
        )
      ) {
        return Promise.resolve(null);
      }
      return resolveRegionParams(
        params,
        !address.provinceCode && !address.cityCode
      );
    };
    let direct: ResolvedRegion | null = null;
    try {
      direct = await resolve(suggestion);
    } catch {
      /* Try reverse geocoding if the name resolver is unavailable. */
    }
    if (
      direct?.provinceCode &&
      direct.cityCode &&
      direct.districtCode &&
      direct.subdistrictCode
    ) {
      return direct;
    }
    const reverseParams = new URLSearchParams({
      longitude: String(suggestion.longitude),
      latitude: String(suggestion.latitude),
    });
    let reverse: Partial<AddressSuggestion> | null = null;
    try {
      reverse = await api<Partial<AddressSuggestion> | null>(
        `/analysis/address/reverse?${reverseParams}`
      );
    } catch {
      return direct;
    }
    if (!reverse) {
      return direct;
    }
    const refined = await resolve({
      ...suggestion,
      ...reverse,
      city: reverse.city ?? suggestion.city,
      district: reverse.district ?? suggestion.district,
      subdistrict:
        reverse.subdistrict && !/^(?:rt|rw)\s*\d/iu.test(reverse.subdistrict)
          ? reverse.subdistrict
          : suggestion.subdistrict &&
              !/^(?:rt|rw)\s*\d/iu.test(suggestion.subdistrict)
            ? suggestion.subdistrict
            : undefined,
      province: reverse.province ?? suggestion.province,
      postalCode: reverse.postalCode ?? suggestion.postalCode,
      cityCandidates: [
        ...(suggestion.cityCandidates ?? []),
        ...(reverse.cityCandidates ?? []),
      ],
      districtCandidates: [
        ...(suggestion.districtCandidates ?? []),
        ...(reverse.districtCandidates ?? []),
      ],
      subdistrictCandidates: [
        ...(suggestion.subdistrictCandidates ?? []),
        ...(reverse.subdistrictCandidates ?? []),
      ],
    });
    return refined ?? direct;
  };
  const resolvePointRegions = async (longitude: number, latitude: number) => {
    const lookupId = ++regionLookupId.current;
    try {
      const reverse = await api<Partial<AddressSuggestion> | null>(
        `/analysis/address/reverse?${new URLSearchParams({ longitude: String(longitude), latitude: String(latitude) })}`
      );
      if (lookupId !== regionLookupId.current) {
        return;
      }
      if (!reverse) {
        setManualStreetStatus("unavailable");
        return;
      }
      setAddress((current) => ({
        ...current,
        street: reverse.street ?? "",
        number: reverse.number ?? "",
        ...(reverse.postalCode ? { postalCode: reverse.postalCode } : {}),
      }));
      setManualStreetStatus(reverse.street ? null : "unavailable");
      if (
        !(
          reverse.city ||
          reverse.cityCandidates?.length ||
          /^\d{5}$/u.test(reverse.postalCode ?? "")
        )
      ) {
        return;
      }
      const params = regionParams(reverse);
      const resolved = await resolveRegionParams(params, true);
      if (!resolved || lookupId !== regionLookupId.current) {
        return;
      }
      setAddress((current) => ({
        ...current,
        provinceCode: resolved.provinceCode,
        cityCode: resolved.cityCode,
        districtCode: resolved.districtCode ?? "",
        subdistrictCode: resolved.subdistrictCode ?? "",
        postalCode: resolved.postalCode ?? current.postalCode,
      }));
    } catch {
      if (lookupId === regionLookupId.current) {
        setManualStreetStatus("unavailable");
      }
      // Keep the point usable when reverse geocoding or region lookup is unavailable.
    }
  };
  const selectSuggestion = async (suggestion: AddressSuggestion) => {
    const lookupId = ++regionLookupId.current;
    setManualStreetStatus(null);
    const selectedLabel = suggestion.label;
    setSelectedPoint({
      longitude: suggestion.longitude,
      latitude: suggestion.latitude,
      label: selectedLabel,
      provider: "photon",
      matchQuality: "approximate",
      matchedStreet: suggestion.street,
      confirmed: false,
    });
    analyze.reset();
    connection.reset();
    let resolved: ResolvedRegion | null = null;
    try {
      resolved = await resolveSuggestionRegions(suggestion);
    } catch {
      /* Keep manual region inputs available if auto-fill is unavailable. */
    }
    if (lookupId !== regionLookupId.current) {
      return;
    }
    setAddress((current) => ({
      ...current,
      street: suggestion.street || suggestion.label,
      number: suggestion.number || current.number,
      postalCode:
        resolved?.postalCode ?? suggestion.postalCode ?? current.postalCode,
      ...(resolved
        ? {
            provinceCode: resolved.provinceCode,
            cityCode: resolved.cityCode,
            districtCode: resolved.districtCode ?? "",
            subdistrictCode: resolved.subdistrictCode ?? "",
          }
        : {}),
    }));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveSuggestionRegions is recreated every render; listing it would re-run this lookup in a loop
  useEffect(() => {
    const normalizeStreet = (value: string) => {
      const romanToArabic: Record<string, string> = {
        i: "1",
        ii: "2",
        iii: "3",
        iv: "4",
        v: "5",
        vi: "6",
        vii: "7",
        viii: "8",
        ix: "9",
        x: "10",
        xi: "11",
        xii: "12",
        xiii: "13",
        xiv: "14",
        xv: "15",
        xvi: "16",
        xvii: "17",
        xviii: "18",
        xix: "19",
        xx: "20",
      };
      return value
        .toLocaleLowerCase("id")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/gu, "")
        .replace(/^\s*(?:jalan|jln|jl)\.?\s*/u, "")
        .replace(/\b(?:letjen|letjend)\b/gu, "letnan jenderal")
        .replace(/\bmayjen\b/gu, "mayor jenderal")
        .replace(/\bbrigjen\b/gu, "brigadir jenderal")
        .replace(/^(?:(?:brigadir|letnan|mayor)\s+)?jenderal\s+/u, "")
        .replace(/\bkol\.?\b/gu, "kolonel")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .split(/\s+/u)
        .map((token) => romanToArabic[token] ?? token)
        .join(" ");
    };
    const matchingSuggestions = (suggestionsQuery.data ?? []).filter(
      (candidate) => {
        if (!candidate.street) {
          return false;
        }
        const regionTokens = new Set(
          normalizeStreet(
            [candidate.city, candidate.province, candidate.postalCode]
              .filter(Boolean)
              .join(" ")
          ).split(" ")
        );
        const requestedStreet = normalizeStreet(address.street)
          .split(" ")
          .filter((token) => token && !regionTokens.has(token));
        const suggestedStreet = normalizeStreet(candidate.street)
          .split(" ")
          .filter((token) => token && !regionTokens.has(token));
        return (
          requestedStreet.length > 0 &&
          requestedStreet.join(" ") === suggestedStreet.join(" ")
        );
      }
    );
    if (!matchingSuggestions.length || selectedPoint) {
      return;
    }
    const lookupId = regionLookupId.current;
    let cancelled = false;
    void Promise.all(
      matchingSuggestions.map((suggestion) =>
        resolveSuggestionRegions(suggestion).catch(() => null)
      )
    ).then((results) => {
      if (cancelled || lookupId !== regionLookupId.current) {
        return;
      }
      const valid = results.filter(
        (result) =>
          result &&
          (!address.provinceCode ||
            result.provinceCode === address.provinceCode) &&
          (!address.cityCode || result.cityCode === address.cityCode)
      );
      const common = (
        field:
          | "provinceCode"
          | "cityCode"
          | "districtCode"
          | "subdistrictCode"
          | "postalCode"
      ) => {
        const values = new Set(
          valid
            .map((result) => result?.[field])
            .filter((value): value is string => Boolean(value))
        );
        return values.size === 1 ? (values.values().next().value ?? "") : "";
      };
      const provinceCode = common("provinceCode");
      const cityCode = common("cityCode");
      if (!(provinceCode && cityCode)) {
        return;
      }
      setAddress((current) =>
        current.street === address.street &&
        (!current.cityCode || current.cityCode === cityCode)
          ? {
              ...current,
              provinceCode,
              cityCode,
              districtCode: common("districtCode") || current.districtCode,
              subdistrictCode:
                common("subdistrictCode") || current.subdistrictCode,
              postalCode:
                common("postalCode") ||
                matchingSuggestions.find((candidate) => candidate.postalCode)
                  ?.postalCode ||
                current.postalCode,
            }
          : current
      );
    });
    return () => {
      cancelled = true;
    };
  }, [
    suggestionsQuery.data,
    address.street,
    address.provinceCode,
    address.cityCode,
    selectedPoint,
  ]);
  useEffect(() => {
    onPickRef.current?.(selectedPoint?.confirmed ? {
      ...selectedPoint,
      label: inputMode === "address" ? fullAddress || selectedPoint.label : selectedPoint.label,
    } : null);
  }, [selectedPoint, fullAddress, inputMode]);
  const coordinates = analyze.data
    ? `${analyze.data.latitude}, ${analyze.data.longitude}`
    : "";
  const copyCoordinates = async () => {
    try {
      await navigator.clipboard.writeText(coordinates);
      setCoordinateCopyStatus("copied");
      window.setTimeout(() => setCoordinateCopyStatus("idle"), 2000);
    } catch {
      setCoordinateCopyStatus("error");
    }
  };
  const destinationEditor = (
    <section aria-label="Titik tujuan" className="mt-4 border-top pt-3">
      {twoPoint ? (
        <>
          <div className="d-flex align-items-center justify-content-between gap-3 mb-3">
            <h4 className="h6 mb-0">Titik lokasi 2</h4>
            <button
              className="btn btn-sm btn-outline-secondary"
              onClick={() => {
                setTwoPoint(false);
                setDestination(null);
                connection.reset();
                analyze.reset();
              }}
              type="button"
            >
              Hapus titik tujuan
            </button>
          </div>
          <AddressAnalysisEditor
            onPick={(point) => {
              setDestination(point);
              connection.reset();
            }}
          />
          <label className="form-check mt-3">
            <input
              checked={allowExpand2km}
              className="form-check-input"
              onChange={(event) => {
                setAllowExpand2km(event.target.checked);
                connection.reset();
              }}
              type="checkbox"
            />
            <span className="form-check-label">
              Perluas pencarian hingga 2 km
            </span>
          </label>
          <label className="form-label d-block mt-3">
            Kebutuhan core (opsional)
            <input
              className="form-control mt-1"
              max="4096"
              min="1"
              onChange={(event) => {
                setCoreRequirement(event.target.value);
                connection.reset();
              }}
              step="1"
              type="number"
              value={coreRequirement}
            />
          </label>
        </>
      ) : (
        <button
          className="btn btn-outline-primary atlas-secondary-action"
          onClick={() => {
            setTwoPoint(true);
            analyze.reset();
            connection.reset();
          }}
          type="button"
        >
          <span aria-hidden="true" className="atlas-secondary-action-icon">+</span>
          Tambah titik tujuan
        </button>
      )}
    </section>
  );
  const locationSummary = (
    <summary className="analysis-location-summary mb-3">
      <span className="d-flex flex-wrap justify-content-between align-items-center gap-2">
        <strong>{pickerOnly ? "Titik lokasi 2" : twoPoint ? "Titik lokasi 1" : "Lokasi analisis"}</strong>
        {selectedPoint?.confirmed ? (
          <span className="analysis-location-edit">
            Edit lokasi
          </span>
        ) : (
          <i className="bi bi-chevron-down analysis-location-chevron" aria-hidden="true" />
        )}
      </span>
      {selectedPoint?.confirmed ? (
        <span className="d-grid gap-1 mt-1">
          <span className="text-break">{selectedPoint.label}</span>
          <span className="d-flex flex-wrap align-items-center gap-2 small">
            <span className="text-body-secondary">
              {selectedPoint.latitude.toFixed(6)}, {selectedPoint.longitude.toFixed(6)}
            </span>
            <span className="text-success-emphasis">
              <i className="bi bi-check-circle me-1" aria-hidden="true" /> Dikonfirmasi
            </span>
          </span>
        </span>
      ) : (
        <small className="d-block mt-1">Lengkapi dan konfirmasi lokasi</small>
      )}
    </summary>
  );
  return (
    <>
      {!pickerOnly && (
        <PageHeader
          subtitle="Temukan jaringan terdekat dari alamat rumah atau koordinat."
          title="Analisis alamat"
        />
      )}
      <div className={`row g-4 ${pickerOnly ? "location-input-embedded" : ""}`}>
        <div className="col-12">
          <section className="card panel-card">
            {!pickerOnly && (
              <div className="card-header analysis-form-header">
                <div>
                  <h3>{twoPoint ? "Titik lokasi 1" : "Lokasi pelanggan"}</h3>
                  <p>Pilih metode input lokasi: alamat rumah atau koordinat.</p>
                </div>
                <AtlasTag className="is-accent">
                  {twoPoint ? "ANALISIS DUA TITIK" : "ANALISIS TUNGGAL"}
                </AtlasTag>
              </div>
            )}
            <div className="card-body">
              {!inputMode && (
                <div>
                  <div className="fw-semibold mb-2">
                    Bagaimana Anda ingin memasukkan lokasi?
                  </div>
                  <div className="row g-3">
                    <div className="col-md-6">
                      <button
                        className="btn btn-outline-primary atlas-choice atlas-choice-card text-start w-100 h-100 p-3"
                        onClick={() => chooseInputMode("address")}
                        type="button"
                      >
                        <b>Alamat rumah</b>
                        <small className="d-block mt-1">
                          Cari alamat dan pilih titiknya pada peta.
                        </small>
                      </button>
                    </div>
                    <div className="col-md-6">
                      <button
                        className="btn btn-outline-primary atlas-choice atlas-choice-card text-start w-100 h-100 p-3"
                        onClick={() => chooseInputMode("coordinates")}
                        type="button"
                      >
                        <b>Koordinat langsung</b>
                        <small className="d-block mt-1">
                          Masukkan latitude dan longitude.
                        </small>
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {inputMode && (
                // biome-ignore lint/a11y/useSemanticElements: Bootstrap btn-group markup; a fieldset breaks its layout
                <div
                  aria-label="Metode input lokasi"
                  className="btn-group mb-3"
                  role="group"
                >
                  <button
                    aria-pressed={inputMode === "address"}
                    className="btn btn-outline-primary atlas-choice"
                    onClick={() => chooseInputMode("address")}
                    type="button"
                  >
                    Alamat rumah
                  </button>
                  <button
                    aria-pressed={inputMode === "coordinates"}
                    className="btn btn-outline-primary atlas-choice"
                    onClick={() => chooseInputMode("coordinates")}
                    type="button"
                  >
                    Koordinat langsung
                  </button>
                </div>
              )}
              {inputMode === "address" && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!twoPoint) submitAnalysis();
                  }}
                >
                  <details
                    className="analysis-point-editor"
                    open={!selectedPoint?.confirmed}
                  >
                    {locationSummary}
                    <div className="row g-3">
                      <div className="position-relative col-12">
                        <label
                          className="form-label fw-semibold"
                          htmlFor={`${fieldId}-street`}
                        >
                          Nama jalan
                        </label>
                        <input
                          aria-autocomplete="list"
                          aria-controls={`${fieldId}-address-suggestions`}
                          aria-expanded={
                            !hideAddressSuggestions &&
                            !selectedPoint &&
                            addressQuery.length >= 3 &&
                            Boolean(suggestionsQuery.data?.length)
                          }
                          autoComplete="street-address"
                          className="form-control"
                          id={`${fieldId}-street`}
                          onChange={(event) => {
                            setHideAddressSuggestions(false);
                            updateAddress("street", event.target.value);
                          }}
                          placeholder="Contoh: Jl. Panjang Arteri Klp. Dua Raya"
                          role="combobox"
                          value={address.street}
                        />
                        {manualStreetStatus && (
                          <div
                            className={`form-text ${manualStreetStatus === "unavailable" ? "text-warning" : ""}`}
                            role="status"
                          >
                            {manualStreetStatus === "loading"
                              ? "Mencari nama jalan di titik yang dipilih…"
                              : "Nama jalan tidak tersedia untuk titik ini. Silakan isi manual jika diketahui."}
                          </div>
                        )}
                        {!hideAddressSuggestions &&
                          !selectedPoint &&
                          addressQuery.length >= 3 && (
                            <div
                              aria-label="Saran alamat"
                              className="list-group position-absolute start-0 end-0 top-100 shadow"
                              id={`${fieldId}-address-suggestions`}
                              role="listbox"
                              style={{ zIndex: 20 }}
                            >
                              {debouncedQuery !== addressQuery ||
                              suggestionsQuery.isFetching ? (
                                <div className="list-group-item text-secondary">
                                  <span className="spinner-border spinner-border-sm me-2" />
                                  Mencari alamat...
                                </div>
                              ) : suggestionsQuery.isError ? (
                                <div className="list-group-item text-danger">
                                  Saran alamat gagal dimuat. Anda tetap bisa
                                  memilih titik pada peta.
                                </div>
                              ) : suggestionsQuery.data?.length ? (
                                <>
                                  {suggestionsQuery.data.map((suggestion) => (
                                    <button
                                      aria-selected={false}
                                      className="list-group-item list-group-item-action text-start"
                                      key={suggestion.id}
                                      onClick={() =>
                                        void selectSuggestion(suggestion)
                                      }
                                      role="option"
                                      type="button"
                                    >
                                      <b className="d-block">
                                        {suggestion.label}
                                      </b>
                                      <small className="text-secondary">
                                        {[
                                          suggestion.category,
                                          suggestion.location,
                                        ]
                                          .filter(Boolean)
                                          .join(", ") || "Kandidat Photon"}{" "}
                                        · periksa pin pada peta
                                      </small>
                                    </button>
                                  ))}
                                  <button
                                    className="list-group-item list-group-item-action text-primary text-start"
                                    onClick={() => {
                                      setHideAddressSuggestions(true);
                                      setShowPinPicker(true);
                                    }}
                                    type="button"
                                  >
                                    <i className="bi bi-geo-alt me-2" />
                                    Pilih titik manual di peta
                                  </button>
                                </>
                              ) : suggestionsQuery.isSuccess ? (
                                <div className="list-group-item text-secondary">
                                  Belum ada saran yang cocok. Pilih titik secara
                                  manual pada peta.
                                </div>
                              ) : null}
                            </div>
                          )}
                      </div>
                      <div className="col-12">
                        <div className="fw-semibold">
                          Pilih Wilayah{" "}
                          <span className="text-secondary">(wajib)</span>
                        </div>
                        <div className="form-text mb-2">
                          Lengkapi keempat wilayah. Saran alamat dapat
                          mengisinya otomatis.
                        </div>
                        <div className="row g-3">
                          <div className="col-md-6">
                            <label
                              className="form-label fw-semibold"
                              htmlFor={`${fieldId}-province`}
                            >
                              Provinsi *
                            </label>
                            <select
                              className="form-select"
                              id={`${fieldId}-province`}
                              onChange={(event) => {
                                regionLookupId.current += 1;
                                setAddress((current) => ({
                                  ...current,
                                  provinceCode: event.target.value,
                                  cityCode: "",
                                  districtCode: "",
                                  subdistrictCode: "",
                                  postalCode: "",
                                }));
                                setSelectedPoint(null);
                                analyze.reset();
                                connection.reset();
                              }}
                              required
                              value={address.provinceCode}
                            >
                              <option value="">Pilih provinsi</option>
                              {[...regions]
                                .sort((a, b) =>
                                  a.name.localeCompare(b.name, "id")
                                )
                                .map((item) => (
                                  <option key={item.code} value={item.code}>
                                    {item.name}
                                  </option>
                                ))}
                            </select>
                          </div>
                          <div className="col-md-6">
                            <label
                              className="form-label fw-semibold"
                              htmlFor={`${fieldId}-city`}
                            >
                              Kabupaten / kota *
                            </label>
                            <select
                              className="form-select"
                              disabled={!province}
                              id={`${fieldId}-city`}
                              onChange={(event) => {
                                regionLookupId.current += 1;
                                setAddress((current) => ({
                                  ...current,
                                  cityCode: event.target.value,
                                  districtCode: "",
                                  subdistrictCode: "",
                                  postalCode: "",
                                }));
                                setSelectedPoint(null);
                                analyze.reset();
                                connection.reset();
                              }}
                              required
                              value={address.cityCode}
                            >
                              <option value="">Pilih kabupaten/kota</option>
                              {cities.map((item) => (
                                <option key={item.code} value={item.code}>
                                  {item.name}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="col-md-6">
                            <label
                              className="form-label fw-semibold"
                              htmlFor={`${fieldId}-district`}
                            >
                              Kecamatan *
                            </label>
                            <select
                              className="form-select"
                              disabled={!city}
                              id={`${fieldId}-district`}
                              onChange={(event) => {
                                regionLookupId.current += 1;
                                setAddress((current) => ({
                                  ...current,
                                  districtCode: event.target.value,
                                  subdistrictCode: "",
                                  postalCode: "",
                                }));
                                setSelectedPoint(null);
                                analyze.reset();
                                connection.reset();
                              }}
                              required
                              value={address.districtCode}
                            >
                              <option value="">Pilih kecamatan</option>
                              {districts.map((item) => (
                                <option key={item.code} value={item.code}>
                                  {item.name}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="col-md-6">
                            <label
                              className="form-label fw-semibold"
                              htmlFor={`${fieldId}-subdistrict`}
                            >
                              Kelurahan / desa *
                            </label>
                            <select
                              className="form-select"
                              disabled={
                                !district ||
                                loadingSubdistricts ||
                                subdistrictLoadError
                              }
                              id={`${fieldId}-subdistrict`}
                              onChange={(event) => {
                                regionLookupId.current += 1;
                                const selected = subdistricts.find(
                                  (item) => item.code === event.target.value
                                );
                                setAddress((current) => ({
                                  ...current,
                                  subdistrictCode: event.target.value,
                                  postalCode: selected?.postalCode ?? "",
                                }));
                                setSelectedPoint(null);
                                analyze.reset();
                                connection.reset();
                              }}
                              required
                              value={address.subdistrictCode}
                            >
                              <option value="">
                                {loadingSubdistricts
                                  ? "Memuat daftar..."
                                  : "Pilih kelurahan/desa"}
                              </option>
                              {subdistricts.map(({ code, name }) => (
                                <option key={code} value={code}>
                                  {name}
                                </option>
                              ))}
                            </select>
                            {subdistrictLoadError && (
                              <div className="form-text text-danger">
                                Daftar kelurahan/desa gagal dimuat. Coba pilih
                                ulang kabupaten/kota.
                              </div>
                            )}
                          </div>
                          <div className="col-md-6">
                            <label
                              className="form-label fw-semibold"
                              htmlFor={`${fieldId}-street-number`}
                            >
                              Nomor rumah
                            </label>
                            <input
                              className="form-control"
                              id={`${fieldId}-street-number`}
                              onChange={(event) =>
                                updateAddress("number", event.target.value)
                              }
                              placeholder="Contoh: 12 atau A-12"
                              value={address.number}
                            />
                          </div>
                          <div className="col-md-6">
                            <label
                              className="form-label fw-semibold"
                              htmlFor={`${fieldId}-postal-code`}
                            >
                              Kode pos
                            </label>
                            <input
                              autoComplete="postal-code"
                              className="form-control"
                              id={`${fieldId}-postal-code`}
                              inputMode="numeric"
                              maxLength={5}
                              onChange={(event) =>
                                updateAddress("postalCode", event.target.value)
                              }
                              pattern="[0-9]{5}"
                              placeholder="Opsional"
                              value={address.postalCode}
                            />
                            {postalRegionQuery.data && (
                              <div className="form-text">
                                Wilayah ditemukan dari kode pos. Pastikan
                                kelurahan sesuai dengan nama jalan.
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                    {(selectedPoint ||
                      selectedRegionName ||
                      showPinPicker ||
                      (addressQuery.length >= 3 &&
                        debouncedQuery === addressQuery &&
                        suggestionsQuery.isSuccess &&
                        !suggestionsQuery.data?.length) ||
                      suggestionsQuery.isError) && (
                      <div className="mt-3" ref={pinPickerRef}>
                        <div className="d-flex align-items-center justify-content-between mb-2 gap-2">
                          <b>Pilih atau periksa titik alamat</b>
                          {selectedPoint && (
                            <small className="text-secondary">
                              {selectedPoint.latitude.toFixed(6)},{" "}
                              {selectedPoint.longitude.toFixed(6)}
                            </small>
                          )}
                        </div>
                        <AddressPinPicker
                          onChange={(longitude, latitude) => {
                            setManualStreetStatus("loading");
                            setAddress((current) => ({
                              ...current,
                              street: "",
                              number: "",
                            }));
                            void resolvePointRegions(longitude, latitude);
                            setSelectedPoint(() => ({
                              longitude,
                              latitude,
                              label: "Titik dipilih manual",
                              provider: "manual",
                              confirmed: false,
                            }));
                            analyze.reset();
                            connection.reset();
                          }}
                          onViewportChange={setSearchViewport}
                          point={selectedPoint}
                          regionView={regionMapQuery.data ?? null}
                        />
                        <div className="form-text">
                          {selectedPoint
                            ? "Klik peta atau geser pin untuk mengoreksi posisi."
                            : selectedRegionName
                              ? `Peta diarahkan ke perkiraan area ${subdistrict ? "kelurahan" : district ? "kecamatan" : city ? "kabupaten/kota" : "provinsi"} ${selectedRegionName}. Klik lokasi yang tepat untuk menaruh pin.`
                              : "Arahkan kursor ke lokasi yang tepat, lalu klik peta untuk menaruh pin."}
                        </div>
                        {selectedPoint && (
                          <div
                            className={`alert ${selectedPoint.confirmed ? "alert-success" : "alert-warning"} mt-2 mb-0 py-2`}
                          >
                            <div>
                              <b>
                                {selectedPoint.confirmed
                                  ? "Titik dikonfirmasi"
                                  : "Periksa lokasi sebelum lanjut"}
                              </b>
                              <div>{selectedPoint.label}</div>
                              {selectedPoint.matchQuality === "approximate" && (
                                <small>
                                  Nama jalan kandidat:{" "}
                                  {selectedPoint.matchedStreet ??
                                    "tidak tersedia"}
                                  . Pastikan pin berada di alamat yang dimaksud.
                                </small>
                              )}
                            </div>
                            {!selectedPoint.confirmed && (
                              <button
                                className="btn btn-sm btn-outline-primary mt-2"
                                onClick={() => {
                                  setSelectedPoint({ ...selectedPoint, confirmed: true });
                                  notify("Lokasi dikonfirmasi.");
                                }}
                                type="button"
                              >
                                Konfirmasi titik ini
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    <div className="form-text mt-3">
                      <i className="bi bi-info-circle me-1" />
                      Ketik dan pilih saran nama jalan untuk mengisi wilayah
                      otomatis. Jika hasil wilayah tidak tersedia, Anda dapat
                      memilihnya manual.
                    </div>
                  </details>
                  <div className="d-flex flex-wrap gap-3 justify-content-between align-items-center mt-4">
                    <button
                      className="btn btn-link text-secondary p-0"
                      onClick={() => {
                        regionLookupId.current += 1;
                        setManualStreetStatus(null);
                        setAddress({
                          street: "",
                          number: "",
                          postalCode: "",
                          provinceCode: "",
                          cityCode: "",
                          districtCode: "",
                          subdistrictCode: "",
                        });
                        setSelectedPoint(null);
                        setShowPinPicker(false);
                        setHideAddressSuggestions(false);
                        setDebouncedQuery("");
                        analyze.reset();
                        connection.reset();
                      }}
                      type="button"
                    >
                      Bersihkan
                    </button>
                    <button
                      className="btn btn-outline-primary atlas-secondary-action"
                      disabled={
                        analyze.isPending ||
                        connection.isPending ||
                        ((pickerOnly || twoPoint) && Boolean(selectedPoint?.confirmed)) ||
                        !address.street.trim() ||
                        !hasSearchArea ||
                        !selectedPoint?.confirmed
                      }
                      type="submit"
                    >
                      {analyze.isPending || connection.isPending ? (
                        <>
                          <span className="spinner-border spinner-border-sm me-2" />
                          Menganalisis...
                        </>
                      ) : (
                        <>
                          <i aria-hidden="true" className="bi bi-search atlas-secondary-action-icon" />
                          {pickerOnly || twoPoint
                            ? selectedPoint?.confirmed ? "Lokasi dikonfirmasi" : "Konfirmasi lokasi"
                            : "Analisis jaringan"}
                        </>
                      )}
                    </button>
                  </div>
                </form>
              )}
              {inputMode === "coordinates" && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!parsedCoordinates) {
                      return;
                    }
                    const point: SelectedPoint = {
                      ...parsedCoordinates,
                      label: "Koordinat langsung",
                      provider: "manual",
                      confirmed: true,
                    };
                    setSelectedPoint(point);
                    if (twoPoint || pickerOnly) notify("Lokasi dikonfirmasi.");
                    if (!twoPoint) submitAnalysis(point);
                  }}
                >
                  <details
                    className="analysis-point-editor"
                    open={!selectedPoint?.confirmed}
                  >
                    {locationSummary}
                    <div className="row g-3">
                      <div className="col-md-6">
                        <label
                          className="form-label fw-semibold"
                          htmlFor={`${fieldId}-coordinate-latitude`}
                        >
                          Latitude
                        </label>
                        <input
                          className="form-control"
                          id={`${fieldId}-coordinate-latitude`}
                          inputMode="decimal"
                          max="90"
                          min="-90"
                          onChange={(event) => {
                            setCoordinateDraft((current) => ({
                              ...current,
                              latitude: event.target.value,
                            }));
                            setSelectedPoint(null);
                            analyze.reset();
                            connection.reset();
                          }}
                          placeholder="Contoh: -6.1754"
                          required
                          step="any"
                          type="text"
                          value={coordinateDraft.latitude}
                        />
                      </div>
                      <div className="col-md-6">
                        <label
                          className="form-label fw-semibold"
                          htmlFor={`${fieldId}-coordinate-longitude`}
                        >
                          Longitude
                        </label>
                        <input
                          className="form-control"
                          id={`${fieldId}-coordinate-longitude`}
                          inputMode="decimal"
                          max="180"
                          min="-180"
                          onChange={(event) => {
                            setCoordinateDraft((current) => ({
                              ...current,
                              longitude: event.target.value,
                            }));
                            setSelectedPoint(null);
                            analyze.reset();
                            connection.reset();
                          }}
                          placeholder="Contoh: 106.8272"
                          required
                          step="any"
                          type="text"
                          value={coordinateDraft.longitude}
                        />
                      </div>
                    </div>
                    <div className="form-text mt-2">
                      Latitude: -90 sampai 90. Longitude: -180 sampai 180.
                    </div>
                  </details>
                  <div className="d-flex flex-wrap gap-3 justify-content-between align-items-center mt-4">
                    <button
                      className="btn btn-link text-secondary p-0"
                      onClick={() => {
                        setCoordinateDraft({ latitude: "", longitude: "" });
                        setSelectedPoint(null);
                        analyze.reset();
                        connection.reset();
                      }}
                      type="button"
                    >
                      Bersihkan
                    </button>
                    <button
                      className="btn btn-outline-primary atlas-secondary-action"
                      disabled={
                        analyze.isPending ||
                        connection.isPending ||
                        ((pickerOnly || twoPoint) && Boolean(selectedPoint?.confirmed)) ||
                        !parsedCoordinates
                      }
                      type="submit"
                    >
                      {analyze.isPending || connection.isPending ? (
                        <>
                          <span className="spinner-border spinner-border-sm me-2" />
                          Menganalisis...
                        </>
                      ) : selectedPoint?.confirmed ? (
                        <>
                          <i aria-hidden="true" className="bi bi-search atlas-secondary-action-icon" />
                          {pickerOnly || twoPoint
                            ? selectedPoint?.confirmed ? "Lokasi dikonfirmasi" : "Konfirmasi lokasi"
                            : "Analisis jaringan"}
                        </>
                      ) : (
                        <>
                          <i aria-hidden="true" className="bi bi-search atlas-secondary-action-icon" />
                          {pickerOnly || twoPoint
                            ? selectedPoint?.confirmed ? "Lokasi dikonfirmasi" : "Konfirmasi lokasi"
                            : "Analisis jaringan"}
                        </>
                      )}
                    </button>
                  </div>
                </form>
              )}
              {!pickerOnly && destinationEditor}
              {twoPoint && (
                <div className="analysis-submit-bar mt-4">
                  <button
                    className="btn btn-outline-primary atlas-secondary-action"
                    type="button"
                    disabled={
                      connection.isPending ||
                      !destination?.confirmed ||
                      !selectedPoint?.confirmed
                    }
                    onClick={() => submitAnalysis(selectedPoint)}
                  >
                    {connection.isPending
                      ? "Menganalisis…"
                      : "Analisis dua titik"}
                  </button>
                </div>
              )}
            </div>
          </section>
          {!pickerOnly && (
            <div className="info-note mt-3">
              <i className="bi bi-lightbulb" />
              <p>
                <b>Bagaimana hasil dihitung?</b>
                <br />
                {twoPoint ? (
                  "Analisis mencari jalur melalui jaringan di antara titik lokasi 1 dan 2. Kedekatan geometri tidak membuktikan sambungan fisik atau ketersediaan core."
                ) : (
                  <>
                    ATLAS memilih terminasi dengan jalur jalan terpendek. Rute A
                    dan B menuju terminasi yang sama, tetapi memakai jalur
                    berbeda. Rute B ditampilkan jika jalur alternatif tersedia.
                  </>
                )}
              </p>
            </div>
          )}
        </div>
        {!pickerOnly && (
          <div className="col-12">
            {twoPoint ? (
              <section className="card panel-card">
                <div className="card-body">
                  {connection.isPending ? (
                    <p role="status">Menganalisis jalur dua titik…</p>
                  ) : connection.error ? (
                    <div className="alert alert-danger" role="alert">
                      {connection.error.message} Coba analisis kembali.
                    </div>
                  ) : connection.data ? (
                    <ConnectionAnalysisResult
                      key={connection.data.historyId}
                      result={connection.data}
                    />
                  ) : (
                    <p className="text-secondary mb-0">
                      Konfirmasi kedua titik lokasi, lalu analisis koneksinya.
                    </p>
                  )}
                </div>
              </section>
            ) : analyze.data && selectedResult ? (
              <section className="card panel-card result-card">
                <div
                  className={`result-success ${selectedResult.distanceMeters === null ? "result-pending" : ""}`}
                >
                  <span>
                    <i
                      className={`bi ${selectedResult.distanceMeters === null ? "bi-info-lg" : "bi-check-lg"}`}
                    />
                  </span>
                  <div>
                    <b>
                      {selectedResult.distanceMeters === null
                        ? "Hasil parsial"
                        : "Analisis berhasil"}
                    </b>
                    <small>
                      {analyze.data.message ??
                      (!selectedResult.network
                        ? "Koordinat ditemukan, tetapi jaringan belum ditemukan dalam radius pencarian."
                        : selectedResult.distanceMeters === null
                          ? "Jaringan ditemukan, tetapi rute belum tersedia."
                          : "Koordinat dan jaringan terdekat ditemukan.")}
                    </small>
                  </div>
                </div>
                <div className="card-body">
                  {analyze.data.geocodingMatch === "approximate" && (
                    <div className="alert alert-warning">
                      Nama jalan tidak cocok sepenuhnya dengan data peta. Titik
                      mengikuti ruas{" "}
                      <b>
                        {analyze.data.matchedStreet ?? "yang paling sesuai"}
                      </b>{" "}
                      berdasarkan kecamatan dan kode pos. Periksa posisi di peta
                      sebelum menyimpan aset atau menentukan jalur kabel.
                    </div>
                  )}
                  <div className="detail-label">HASIL KONVERSI</div>
                  <DetailTable
                    label="Hasil konversi alamat"
                    rows={[
                      { label: "Alamat", value: analyze.data.address },
                      {
                        label: "Koordinat",
                        value: (
                          <span className="d-flex align-items-center justify-content-between gap-2">
                            <span className="font-monospace user-select-all text-break">
                              {coordinates}
                            </span>
                            <button
                              aria-label="Salin koordinat"
                              className="btn btn-sm btn-outline-primary flex-shrink-0"
                              onClick={copyCoordinates}
                              title={
                                coordinateCopyStatus === "copied"
                                  ? "Tersalin"
                                  : "Salin koordinat"
                              }
                              type="button"
                            >
                              <i
                                className={`bi ${coordinateCopyStatus === "copied" ? "bi-check2" : coordinateCopyStatus === "error" ? "bi-exclamation-triangle" : "bi-clipboard"}`}
                              />
                            </button>
                          </span>
                        ),
                      },
                    ]}
                  />
                  <a
                    className="btn btn-outline-primary mt-2 w-100"
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coordinates)}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <i className="bi bi-map me-2" />
                    Buka Google Maps
                  </a>
                  {coordinateCopyStatus !== "idle" && (
                    <small
                      className={`d-block mt-1 ${coordinateCopyStatus === "error" ? "text-danger" : "text-success"}`}
                    >
                      {coordinateCopyStatus === "copied"
                        ? "Koordinat tersalin."
                        : "Gagal menyalin koordinat."}
                    </small>
                  )}
                  {analyze.data.geocodingProvider === "nominatim" && (
                    <small className="text-secondary d-block mt-2">
                      Lokasi dari{" "}
                      <a
                        href="https://www.openstreetmap.org/copyright"
                        rel="noreferrer"
                        target="_blank"
                      >
                        © OpenStreetMap contributors
                      </a>
                      .
                    </small>
                  )}
                  <hr />
                  <div className="detail-label">TUJUAN RUTE TERPILIH</div>
                  {selectedResult.network ? (
                    <>
                      <DetailTable
                        label="Informasi jaringan terdekat"
                        rows={[
                          {
                            label: "Perangkat tujuan",
                            value: selectedResult.network.name,
                          },
                          {
                            label: "Area",
                            value: selectedResult.network.area,
                          },
                          {
                            label: "Jenis kabel",
                            value: selectedResult.network.cableType,
                          },
                          {
                            label: "Radius ditemukan",
                            value: `${selectedResult.network.searchRadiusMeters ?? 1000} m`,
                          },
                          {
                            label: "Jarak lurus ke tujuan",
                            value: formatDistance(
                              selectedResult.network.straightDistanceMeters
                            ),
                          },
                          {
                            label: `Jarak Rute ${activeRouteId} mengikuti jalan`,
                            value: formatDistance(
                              selectedResult.distanceMeters
                            ),
                          },
                        ]}
                      />
                      <NetworkCapacityDetail
                        capacity={selectedResult.network.capacity}
                      />
                    </>
                  ) : (
                    <div className="alert alert-secondary">
                      Tidak ditemukan jaringan dalam radius{" "}
                      {analyze.data.searchRadiusMeters ?? 1000} m.
                      {analyze.data.expansionAvailable && (
                        <div className="mt-2">
                          Perluas pencarian hingga 2 km?
                          <button
                            className="btn btn-outline-primary atlas-secondary-action btn-sm ms-2"
                            disabled={analyze.isPending}
                            onClick={() => {
                              if (analyze.variables) {
                                analyze.mutate({
                                  ...analyze.variables,
                                  allowExpand2km: true,
                                });
                              }
                            }}
                            type="button"
                          >
                            Ya, cari hingga 2 km
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  <TerminationDetail data={analyze.data.terminations} />
                  {selectedResult.network &&
                    analyze.data.terminations?.points.length === 0 &&
                    analyze.data.terminations.searchRadiusMeters === 1000 && (
                      <button
                        className="btn btn-outline-primary btn-sm mt-2"
                        disabled={analyze.isPending}
                        onClick={() => {
                          if (analyze.variables) {
                            analyze.mutate({
                              ...analyze.variables,
                              allowExpand2km: true,
                            });
                          }
                        }}
                        type="button"
                      >
                        Cari terminasi hingga 2 km
                      </button>
                    )}
                  <Link
                    className="btn btn-outline-primary mt-3 w-100"
                    to="/peta-jaringan"
                  >
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
                <h3>
                  {error
                    ? "Analisis belum tersedia"
                    : "Hasil analisis akan tampil di sini"}
                </h3>
                <p>
                  {error
                    ? error.message
                    : "Lengkapi alamat untuk melihat koordinat, jaringan terdekat, dan jarak jalan."}
                </p>
              </section>
            )}
          </div>
        )}
      </div>
      {!pickerOnly && !twoPoint && analyze.data && (
        <section className="card panel-card mt-4">
          <div className="card-header">
            <div>
              <h3>Perbandingan rute</h3>
              <p>Pilih rute untuk menampilkan jalurnya pada peta.</p>
            </div>
          </div>
          <div className="card-body">
            {selectedResult && (
              <NearestNetworkMap
                key={analyze.data.historyId}
                onSelectRoute={setSelectedRouteId}
                result={selectedResult}
                selectedRouteId={activeRouteId}
              />
            )}
            <SubmitSurveyButton
              historyId={analyze.data.historyId}
              key={analyze.data.historyId}
              latitude={analyze.data.latitude}
              longitude={analyze.data.longitude}
              plan={selectedResult?.terminationPlan}
              planRequired={Boolean(selectedResult?.terminationPlan)}
              requireProposal={!selectedResult?.network}
            />
            <small className="d-block text-secondary mt-2">
              Lingkaran: radius pencarian. Klik aset atau jalur untuk melihat
              detail.
            </small>
          </div>
        </section>
      )}
    </>
  );
}
