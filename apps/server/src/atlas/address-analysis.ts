import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { RoutingService } from "../geospatial/routing.service";
import type { AtlasService } from "./atlas.service";
import {
  buildTerminationPlan,
  type CoreRequirement,
  estimateOdpLocations,
  placeAlongRoute,
  recommendDeviceCandidates,
  recommendSourceCable,
} from "./termination-plan";

type NearbyPoint = {
  id: string;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
  relatedDevices: unknown[];
  cables: Parameters<typeof recommendSourceCable>[0];
};

type CandidateRoute = {
  target: NearbyPoint;
  route: Awaited<
    ReturnType<RoutingService["previewNetworkAlternatives"]>
  >[number];
  routeIndex: number;
};

async function mapWithConcurrency<Input, Output>(
  items: Input[],
  concurrency: number,
  mapItem: (item: Input) => Promise<Output>
): Promise<Output[]> {
  const output = new Array<Output>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        output[index] = await mapItem(items[index]);
      }
    }
  );
  await Promise.all(workers);
  return output;
}

function routeGeometryKey(route: CandidateRoute) {
  const coordinates = route.route.geometry.coordinates.map((coordinate) =>
    coordinate.map((value) => Number(value.toFixed(6)))
  );
  return `${route.target.id}:${JSON.stringify(coordinates)}`;
}

function terminationPriority(type: string) {
  return type === "Closure" ? 0 : type === "Slack / Coil" ? 2 : 1;
}

function compareCandidateRoutes(a: CandidateRoute, b: CandidateRoute) {
  const distanceDifference = a.route.distanceMeters - b.route.distanceMeters;
  if (Math.abs(distanceDifference) > 1) {
    return distanceDifference;
  }
  return (
    terminationPriority(a.target.type) - terminationPriority(b.target.type) ||
    distanceDifference ||
    a.target.id.localeCompare(b.target.id) ||
    a.routeIndex - b.routeIndex
  );
}

const ROUTE_OVERLAP_TOLERANCE_METERS = 12;
const ROUTE_SAMPLE_SPACING_METERS = 15;
const MAX_SHARED_ROUTE_RATIO = 0.75;
const MIN_DIVERGENT_ROUTE_METERS = 100;

type ProjectedPoint = { x: number; y: number };

function projectRoute(
  coordinates: [number, number][],
  referenceLatitude: number
): ProjectedPoint[] {
  const metersPerDegree = (Math.PI * 6_371_008.8) / 180;
  const longitudeScale =
    metersPerDegree * Math.cos((referenceLatitude * Math.PI) / 180);
  return coordinates.map(([longitude, latitude]) => ({
    x: longitude * longitudeScale,
    y: latitude * metersPerDegree,
  }));
}

function routeLengthMeters(points: ProjectedPoint[]) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(
      points[index].x - points[index - 1].x,
      points[index].y - points[index - 1].y
    );
  }
  return length;
}

function distanceToSegmentMeters(
  point: ProjectedPoint,
  start: ProjectedPoint,
  end: ProjectedPoint
) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const segmentLengthSquared = dx * dx + dy * dy;
  if (segmentLengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const projection = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) /
        segmentLengthSquared
    )
  );
  return Math.hypot(
    point.x - (start.x + projection * dx),
    point.y - (start.y + projection * dy)
  );
}

function sharedRouteLengthMeters(
  route: ProjectedPoint[],
  comparison: ProjectedPoint[]
) {
  if (route.length < 2 || comparison.length < 2) {
    return 0;
  }
  let sharedLength = 0;
  for (let index = 1; index < route.length; index += 1) {
    const start = route[index - 1];
    const end = route[index];
    const segmentLength = Math.hypot(end.x - start.x, end.y - start.y);
    const sampleCount = Math.max(
      1,
      Math.ceil(segmentLength / ROUTE_SAMPLE_SPACING_METERS)
    );
    const sampleLength = segmentLength / sampleCount;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const fraction = (sampleIndex + 0.5) / sampleCount;
      const sample = {
        x: start.x + (end.x - start.x) * fraction,
        y: start.y + (end.y - start.y) * fraction,
      };
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (
        let comparisonIndex = 1;
        comparisonIndex < comparison.length;
        comparisonIndex += 1
      ) {
        nearestDistance = Math.min(
          nearestDistance,
          distanceToSegmentMeters(
            sample,
            comparison[comparisonIndex - 1],
            comparison[comparisonIndex]
          )
        );
        if (nearestDistance <= ROUTE_OVERLAP_TOLERANCE_METERS) {
          break;
        }
      }
      if (nearestDistance <= ROUTE_OVERLAP_TOLERANCE_METERS) {
        sharedLength += sampleLength;
      }
    }
  }
  return sharedLength;
}

function hasMeaningfulRouteDivergence(
  routeA: CandidateRoute["route"],
  routeB: CandidateRoute["route"]
) {
  const coordinatesA = routeA.geometry.coordinates;
  const coordinatesB = routeB.geometry.coordinates;
  if (coordinatesA.length < 2 || coordinatesB.length < 2) {
    return false;
  }
  const referenceLatitude = (coordinatesA[0][1] + coordinatesB[0][1]) / 2;
  const projectedA = projectRoute(coordinatesA, referenceLatitude);
  const projectedB = projectRoute(coordinatesB, referenceLatitude);
  const lengthA = routeLengthMeters(projectedA);
  const lengthB = routeLengthMeters(projectedB);
  if (lengthA === 0 || lengthB === 0) {
    return false;
  }

  const sharedA = sharedRouteLengthMeters(projectedA, projectedB);
  const sharedB = sharedRouteLengthMeters(projectedB, projectedA);
  const divergentA = lengthA - sharedA;
  const divergentB = lengthB - sharedB;
  const sharedRatio = Math.max(sharedA / lengthA, sharedB / lengthB);
  return (
    divergentA >= MIN_DIVERGENT_ROUTE_METERS &&
    divergentB >= MIN_DIVERGENT_ROUTE_METERS &&
    sharedRatio <= MAX_SHARED_ROUTE_RATIO
  );
}

async function buildRouteDetails(
  atlas: AtlasService,
  route: CandidateRoute["route"],
  target: NearbyPoint,
  longitude: number,
  latitude: number,
  coreRequirement: CoreRequirement | undefined,
  terminationPatterns: Awaited<
    ReturnType<AtlasService["terminationPatterns"]>
  > | null
) {
  let routeEvidence: Awaited<
    ReturnType<AtlasService["terminationsAlongRoute"]>
  > = [];
  let routeEvidenceIncomplete = false;
  try {
    routeEvidence = await atlas.terminationsAlongRoute(route.geometry);
    routeEvidenceIncomplete = routeEvidence.length >= 100;
  } catch {
    routeEvidenceIncomplete = true;
  }

  let connectionCandidates: Awaited<
    ReturnType<AtlasService["cableEndsAlongRoute"]>
  > = [];
  let connectionCandidatesIncomplete = false;
  let allCableEnds: Awaited<ReturnType<AtlasService["cableEndsAlongRoute"]>> =
    [];
  try {
    const ends = await atlas.cableEndsAlongRoute(route.geometry);
    allCableEnds = ends;
    connectionCandidatesIncomplete =
      ends.length >= 100 || routeEvidenceIncomplete;
    const withinTenMeters = (
      a: { latitude: number; longitude: number },
      b: { latitude: number; longitude: number }
    ) =>
      Math.hypot(
        (a.latitude - b.latitude) * 111_320,
        (a.longitude - b.longitude) *
          111_320 *
          Math.cos((a.latitude * Math.PI) / 180)
      ) <= 10;
    connectionCandidates = ends.filter(
      (end, index) =>
        !routeEvidence.some((point) => withinTenMeters(end, point)) &&
        !ends.slice(0, index).some((previous) => withinTenMeters(end, previous))
    );
  } catch {
    connectionCandidatesIncomplete = true;
  }

  const targetOdp = target.type === "ODP" ? target : undefined;
  const sourceCable = recommendSourceCable(target.cables);
  const calculatedPlan = buildTerminationPlan(
    target.id,
    route.geometry,
    route.distanceMeters,
    coreRequirement,
    sourceCable,
    target.type
  );
  const proposal = targetOdp
    ? undefined
    : {
        cores: calculatedPlan.cables[0].cores,
        kind: "ODP",
        latitude,
        longitude,
      };
  const evidenceCandidates = placeAlongRoute(
    recommendDeviceCandidates(
      routeEvidence,
      allCableEnds,
      connectionCandidatesIncomplete
    ),
    route.geometry
  );
  const odpPattern = terminationPatterns?.find(
    (pattern) => pattern.type === "ODP" && pattern.sampleSize >= 5
  );
  const terminationPlan = {
    ...calculatedPlan,
    connectionCandidates: placeAlongRoute(
      connectionCandidates,
      route.geometry
    ).map((point) => ({
      ...point,
      recommendedKind: "Closure" as const,
    })),
    connectionCandidatesIncomplete,
    deviceCandidates: [
      ...evidenceCandidates.map((candidate) => {
        const pattern = terminationPatterns?.find(
          (item) => item.type === candidate.kind && item.sampleSize >= 5
        );
        return pattern
          ? {
              ...candidate,
              reason: `${candidate.reason} Median jarak lurus ${candidate.kind} terdekat di data KMZ sekitar lokasi: ${Math.round(pattern.medianMeters)} m (${pattern.sampleSize} titik); bukan aturan pemasangan.`,
            }
          : candidate;
      }),
      ...(!routeEvidenceIncomplete && odpPattern
        ? estimateOdpLocations(
            route.geometry,
            routeEvidence,
            odpPattern.medianMeters
          )
        : []),
    ],
    deviceRecommendation: targetOdp
      ? {
          kind: "REUSE_ODP",
          name: targetOdp.name,
          relatedDevices: targetOdp.relatedDevices,
        }
      : {
          kind: "NEW_ODP",
          name: "Usulan ODP",
          relatedDevices: target.relatedDevices,
        },
    routeEvidence,
    routeEvidenceIncomplete,
    sourceCable,
    terminationPatterns,
    upstreamRecommendation: [
      "OLT",
      "OTB",
      "ODP",
      "ODC",
      "Closure",
      "Slack / Coil",
    ].includes(target.type)
      ? {
          id: target.id,
          name: target.name,
          recordedCables: target.cables.filter((cable) => cable.recorded)
            .length,
          type: target.type,
        }
      : null,
  };

  return { proposal, terminationPlan };
}

export async function analyzeCoordinates(
  atlas: AtlasService,
  routing: RoutingService,
  longitude: number,
  latitude: number,
  address?: string,
  geocodingProvider?: "photon" | "nominatim" | "manual",
  geocodingMatch?: "approximate",
  matchedStreet?: string,
  allowExpand2km = false,
  coreRequirement?: CoreRequirement
) {
  if (
    !(Number.isFinite(longitude) && Number.isFinite(latitude)) ||
    Math.abs(longitude) > 180 ||
    Math.abs(latitude) > 90
  ) {
    throw new BadRequestException({ message: "Koordinat tidak valid." });
  }

  const terminations = await atlas.nearbyTerminations(
    longitude,
    latitude,
    allowExpand2km
  );
  const nearest = await atlas.nearestNetwork(
    longitude,
    latitude,
    allowExpand2km
  );
  if (!nearest) {
    return {
      address,
      distanceMeters: null,
      expansionAvailable: !allowExpand2km,
      geocodingMatch,
      geocodingProvider,
      latitude,
      longitude,
      matchedStreet,
      network: null,
      searchRadiusMeters: allowExpand2km ? 2000 : 1000,
      status: "NETWORK_NOT_FOUND",
      terminations,
    };
  }

  const targets: NearbyPoint[] = terminations.points.length
    ? terminations.points.map((point) => ({
        cables: point.cables.map((cable) => ({
          available: Array.isArray(cable.available)
            ? (cable.available as number[])
            : null,
          id: String(cable.id),
          name: String(cable.name),
          recorded: Boolean(cable.recorded),
          distanceMeters: Number.isFinite(cable.distanceMeters)
            ? Number(cable.distanceMeters)
            : undefined,
          totalCores: Number(cable.totalCores ?? 0),
          verified: Boolean(cable.verified),
        })),
        id: point.id,
        latitude: point.latitude,
        longitude: point.longitude,
        name: point.name,
        relatedDevices: point.relatedDevices,
        type: point.type,
      }))
    : [
        {
          cables: [],
          id: nearest.id,
          latitude: nearest.nearestPoint.coordinates[1],
          longitude: nearest.nearestPoint.coordinates[0],
          name: nearest.name,
          relatedDevices: [],
          // nearestNetwork can be supplied by older callers and test doubles
          // without the optional capacity summary. Keep planning usable when
          // that enrichment is absent.
          type: String(
            nearest.capacity?.deviceType ?? inferNetworkType(nearest.name)
          ),
        },
      ];

  const routesByTarget = await mapWithConcurrency(
    targets,
    6,
    async (target) => {
      try {
        const coordinates: [number, number][] = [
          [longitude, latitude],
          [target.longitude, target.latitude],
        ];
        // Alternative routing was added after the original previewNetwork
        // contract. Preserve compatibility with routing adapters that expose
        // only the single-route method; production RoutingService always
        // provides alternatives.
        const routes =
          typeof routing.previewNetworkAlternatives === "function"
            ? await routing.previewNetworkAlternatives(coordinates)
            : [await routing.previewNetwork(coordinates)];
        return routes.map((route, routeIndex) => ({
          route,
          routeIndex,
          target,
        }));
      } catch (error) {
        // A provider outage is not evidence that a candidate is unreachable.
        // Never rank a partial candidate set after rate limiting or a timeout.
        if (error instanceof ServiceUnavailableException) throw error;
        // An unreachable candidate should not hide a usable route to another asset.
        return [];
      }
    }
  );
  const routeByKey = new Map<string, CandidateRoute>();
  for (const candidate of routesByTarget.flat()) {
    routeByKey.set(routeGeometryKey(candidate), candidate);
  }
  const rankedRoutes = [...routeByKey.values()].sort(
    compareCandidateRoutes
  );
  if (!rankedRoutes.length) {
    return {
      address,
      distanceMeters: null,
      geocodingMatch,
      geocodingProvider,
      latitude,
      longitude,
      matchedStreet,
      message:
        "Rute jalan belum tersedia ke perangkat jaringan dalam radius pencarian.",
      network: nearest,
      status: "ROUTING_UNAVAILABLE",
      terminations,
    };
  }
  const routeA = rankedRoutes[0];
  const routeB = rankedRoutes.find(
    (candidate) =>
      candidate.target.id === routeA.target.id &&
      routeGeometryKey(candidate) !== routeGeometryKey(routeA) &&
      hasMeaningfulRouteDivergence(routeA.route, candidate.route)
  );
  const selectedRoutes = routeB ? [routeA, routeB] : [routeA];

  let terminationPatterns: Awaited<
    ReturnType<AtlasService["terminationPatterns"]>
  > | null = null;
  try {
    terminationPatterns = await atlas.terminationPatterns(longitude, latitude);
  } catch {
    // Without a reliable sample, do not invent an ODP spacing.
  }

  const networkByTarget = new Map<
    string,
    ReturnType<AtlasService["nearestNetwork"]>
  >();
  const routeOptions = await Promise.all(
    selectedRoutes.map(async (candidate, index) => {
      let networkPromise = networkByTarget.get(candidate.target.id);
      if (!networkPromise) {
        networkPromise =
          candidate.target.id === nearest.id
            ? Promise.resolve(nearest)
            : atlas.nearestNetwork(
                longitude,
                latitude,
                allowExpand2km,
                candidate.target.id
              );
        networkByTarget.set(candidate.target.id, networkPromise);
      }
      const network = await networkPromise;
      const details = await buildRouteDetails(
        atlas,
        candidate.route,
        candidate.target,
        longitude,
        latitude,
        coreRequirement,
        terminationPatterns
      );
      return {
        destination: {
          id: candidate.target.id,
          latitude: candidate.target.latitude,
          longitude: candidate.target.longitude,
          name: candidate.target.name,
          type: candidate.target.type,
        },
        distanceMeters: candidate.route.distanceMeters,
        id: index === 0 ? "A" : "B",
        network,
        proposal: details.proposal,
        routeGeometry: candidate.route.geometry,
        terminationPlan: details.terminationPlan,
      };
    })
  );
  const selectedRouteA = routeOptions[0];

  return {
    address,
    distanceMeters: selectedRouteA.distanceMeters,
    geocodingMatch,
    geocodingProvider,
    latitude,
    longitude,
    matchedStreet,
    network: selectedRouteA.network ?? nearest,
    proposal: selectedRouteA.proposal,
    routeGeometry: selectedRouteA.routeGeometry,
    routes: routeOptions.map((route) =>
      route.id === "A"
        ? {
            destination: route.destination,
            distanceMeters: route.distanceMeters,
            id: route.id,
          }
        : route
    ),
    status: "OK",
    terminationPlan: selectedRouteA.terminationPlan,
    terminations,
  };
}

function inferNetworkType(name: unknown): string {
  const value = String(name ?? "");
  const match = value.match(/\b(OLT|OTB|ODC|ODP|Closure|Slack|Coil)\b/iu);
  return match?.[1] ?? "Aset jaringan";
}
