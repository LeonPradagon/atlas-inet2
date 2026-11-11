import { BadRequestException } from "@nestjs/common";
import { AtlasService } from "./atlas.service";
import { RoutingService } from "../geospatial/routing.service";
import { buildTerminationPlan, estimateOdpLocations, type CoreRequirement, placeAlongRoute, recommendDeviceCandidates, recommendSourceCable } from "./termination-plan";

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
    const target = nearest.nearestPoint?.coordinates as
      | [number, number]
      | undefined;
    if (!target) {
      return {
        address,
        distanceMeters: null,
        geocodingMatch,
        geocodingProvider,
        latitude,
        longitude,
        matchedStreet,
        network: nearest,
        status: "NETWORK_NOT_FOUND",
        terminations,
      };
    }
    try {
      const route = await routing.previewNetwork([
        [longitude, latitude],
        target,
      ]);
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
      let allCableEnds: Awaited<
        ReturnType<AtlasService["cableEndsAlongRoute"]>
      > = [];
      try {
        const ends = await atlas.cableEndsAlongRoute(route.geometry);
        allCableEnds = ends;
        connectionCandidatesIncomplete =
          ends.length >= 100 || routeEvidenceIncomplete;
        // Proximity is evidence of a possible connection, not proof of a required device.
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
            !ends
              .slice(0, index)
              .some((previous) => withinTenMeters(end, previous))
        );
      } catch {
        connectionCandidatesIncomplete = true;
      }
      const targetPoint = terminations.points.find(
        (point) => point.id === nearest.id
      );
      const targetOdp = targetPoint?.type === "ODP" ? targetPoint : undefined;
      const sourceCable = recommendSourceCable(
        (
          terminations.points as unknown as {
            id: string;
            cables: {
              id: string;
              name: string;
              recorded: boolean;
              verified: boolean;
              available: number[] | null;
              totalCores: number;
            }[];
          }[]
        ).find((point) => point.id === nearest.id)?.cables ?? []
      );
      const calculatedPlan = buildTerminationPlan(
        nearest.id,
        route.geometry,
        route.distanceMeters,
        coreRequirement,
        sourceCable,
        targetPoint?.type
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
      let terminationPatterns: Awaited<ReturnType<AtlasService["terminationPatterns"]>> | null = null;
      try {
        terminationPatterns = await atlas.terminationPatterns(longitude, latitude);
      } catch {
        // Without a reliable sample, do not invent an ODP spacing.
      }
      const odpPattern = terminationPatterns?.find((p) => p.type === "ODP" && p.sampleSize >= 5);
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
            const pattern = terminationPatterns?.find((p) => p.type === candidate.kind && p.sampleSize >= 5);
            return pattern ? { ...candidate, reason: `${candidate.reason} Median jarak lurus ${candidate.kind} terdekat di data KMZ sekitar lokasi: ${Math.round(pattern.medianMeters)} m (${pattern.sampleSize} titik); bukan aturan pemasangan.` } : candidate;
          }),
          ...(!routeEvidenceIncomplete && odpPattern
            ? estimateOdpLocations(route.geometry, routeEvidence, odpPattern.medianMeters)
            : []),
        ],
        terminationPatterns,
        deviceRecommendation: targetOdp
          ? {
              kind: "REUSE_ODP",
              name: targetOdp.name,
              relatedDevices: targetOdp.relatedDevices,
            }
          : {
              kind: "NEW_ODP",
              name: "Usulan ODP",
              relatedDevices: targetPoint?.relatedDevices ?? [],
            },
        routeEvidence,
        routeEvidenceIncomplete,
        sourceCable,
        upstreamRecommendation:
          targetPoint &&
          ["OLT", "OTB", "ODP", "ODC", "Closure", "Slack / Coil"].includes(
            targetPoint.type
          )
            ? {
                id: targetPoint.id,
                name: targetPoint.name,
                recordedCables: targetPoint.cables.filter(
                  (cable) => (cable as { recorded?: boolean }).recorded
                ).length,
                type: targetPoint.type,
              }
            : null,
      };
      return {
        address,
        distanceMeters: route.distanceMeters,
        geocodingMatch,
        geocodingProvider,
        latitude,
        longitude,
        matchedStreet,
        network: nearest,
        proposal,
        routeGeometry: route.geometry,
        status: "OK",
        terminationPlan,
        terminations,
      };
    } catch {
      return {
        address,
        distanceMeters: null,
        geocodingMatch,
        geocodingProvider,
        latitude,
        longitude,
        matchedStreet,
        message:
          "Rute jalan belum tersedia; jarak penarikan tidak ditampilkan.",
        network: nearest,
        status: "ROUTING_UNAVAILABLE",
        terminations,
      };
    }
  }

