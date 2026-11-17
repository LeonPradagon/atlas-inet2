import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { Database } from "../database/database";
import { type Coordinate, RoutingService } from "../geospatial/routing.service";
import {
  type Attachment,
  buildConnectionGraph,
  connectionGeometryKey,
  type Leg,
  lineMeters,
  type Mapping,
  meters,
  type Segment,
  shortestConnection,
  TERMINAL_TOLERANCE_METERS,
  type Terminal,
} from "./connection-graph";
import { analyzeCoordinates } from "./address-analysis";
import { AtlasService } from "./atlas.service";
import { buildTerminationPlan, type CoreRequirement } from "./termination-plan";

export type ConnectionPoint = {
  longitude: number;
  latitude: number;
  label?: string;
};
export type ConnectionInput = {
  start: ConnectionPoint;
  end: ConnectionPoint;
  allowExpand2km?: boolean;
  coreRequirement?: CoreRequirement;
};
export function validateConnectionInput(input: ConnectionInput) {
  for (const p of [input?.start, input?.end]) {
    if (
      !p ||
      typeof p.longitude !== "number" ||
      !Number.isFinite(p.longitude) ||
      Math.abs(p.longitude) > 180 ||
      typeof p.latitude !== "number" ||
      !Number.isFinite(p.latitude) ||
      Math.abs(p.latitude) > 90 ||
      (p.label !== undefined &&
        (typeof p.label !== "string" || p.label.length > 500))
    ) {
      throw new BadRequestException("Koordinat A dan B tidak valid.");
    }
  }
  if (
    meters(
      [input.start.longitude, input.start.latitude],
      [input.end.longitude, input.end.latitude]
    ) < 0.01
  ) {
    throw new BadRequestException("Titik A dan B harus berbeda.");
  }
  const r = input.coreRequirement;
  if (
    r !== undefined &&
    (!r ||
      !Number.isInteger(r.services) ||
      r.services < 1 ||
      !Number.isInteger(r.reserve) ||
      r.reserve < 0 ||
      r.services + r.reserve > 4096)
  ) {
    throw new BadRequestException("Kebutuhan core tidak valid.");
  }
  if (
    input.allowExpand2km !== undefined &&
    typeof input.allowExpand2km !== "boolean"
  ) {
    throw new BadRequestException("allowExpand2km harus boolean.");
  }
  return {
    allowExpand2km: input.allowExpand2km === true,
    coreRequirement: r
      ? { reserve: r.reserve, services: r.services }
      : undefined,
    end: {
      label: input.end.label?.trim() || "B",
      latitude: input.end.latitude,
      longitude: input.end.longitude,
    },
    start: {
      label: input.start.label?.trim() || "A",
      latitude: input.start.latitude,
      longitude: input.start.longitude,
    },
  };
}

@Injectable()
export class ConnectionService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(RoutingService) private readonly routing: RoutingService,
    @Inject(AtlasService) private readonly atlas: AtlasService
  ) {}

  async loadGraph() {
    // Load the complete inventory: a valid detour can leave the A/B search radius.
    // Disconnected MultiLineStrings are intentionally excluded; joining their parts invents connectivity.
    const { rows: segments } =
      await this.db.query<Segment>(`SELECT a.id,a.name,ST_AsGeoJSON(ST_LineMerge(a.geometry))::json AS geometry,
      NULL::int AS available, lower(trim(COALESCE(a.attributes->>'company',a.attributes->>'Company',a.attributes->>'operator',a.attributes->>'owner',a.attributes->>'Perusahaan',''))) AS company
      FROM network_assets a WHERE a.asset_type='segment' AND GeometryType(ST_LineMerge(a.geometry))='LINESTRING'
      AND COALESCE(a.attributes->>'source','')<>'ftth-design' ORDER BY a.id`);
    const { rows: terminals } =
      await this.db.query<Terminal>(`SELECT id,name,json_build_array(ST_X(geometry),ST_Y(geometry)) AS coordinate FROM network_assets a
      WHERE asset_type='asset' AND GeometryType(geometry)='POINT' AND COALESCE(attributes->>'source','')<>'ftth-design'
      AND lower(concat_ws(' ',name,attributes->>'folderPath',attributes->>'assetKind',attributes->>'Tipe Perangkat',attributes->>'tipe_perangkat')) ~ '(^|[^a-z0-9])(pop|olt|otb|odc|odp|fat|closure|slack|coil|cs[-_ ]?[0-9]+c|slk[-_ ]?[0-9]+|spl[-_ ]?1[:_-][0-9]+)([^a-z0-9]|$)' ORDER BY id`);
    const { rows: attachments } =
      await this.db.query<Attachment>(`SELECT segment_id AS "segmentId",asset_id AS "terminalId",true AS recorded FROM network_asset_relations WHERE kind<>'POLE'
      UNION SELECT c.asset_id,m.node_asset_id,true FROM network_core_mappings m JOIN network_cores c ON c.id IN (m.core_a_id,m.core_b_id)
      UNION SELECT c.asset_id,e.node_asset_id,true FROM network_core_end_connections e JOIN network_cores c ON c.id=e.core_id`);
    const { rows: mappings } =
      await this.db.query<Mapping>(`SELECT m.node_asset_id AS "terminalId",a.asset_id AS "segmentA",b.asset_id AS "segmentB",a.id::text AS "coreA",b.id::text AS "coreB"
      FROM network_core_mappings m JOIN network_cores a ON a.id=m.core_a_id JOIN network_cores b ON b.id=m.core_b_id
      UNION SELECT e.node_asset_id,a.asset_id,b.asset_id,a.id::text,b.id::text FROM network_core_end_connections e JOIN network_cores a ON a.id=e.core_id JOIN network_cores b ON b.id=e.peer_core_id WHERE e.connection_type='splice'`);
    return { attachments, mappings, segments, terminals };
  }

  async analyze(body: ConnectionInput) {
    const input = validateConnectionInput(body);
    const start: Coordinate = [input.start.longitude, input.start.latitude],
      end: Coordinate = [input.end.longitude, input.end.latitude];
    const inventory = await this.loadGraph();
    const graph = buildConnectionGraph(
      inventory.segments,
      inventory.terminals,
      inventory.attachments,
      inventory.mappings
    );
    // Each endpoint uses the same selection and access geometry as single-point analysis.
    const [first, second] = await Promise.all([
      this.analyzePoint(
        input.start,
        input.allowExpand2km,
        input.coreRequirement
      ),
      this.analyzePoint(input.end, input.allowExpand2km, input.coreRequirement),
    ]);
    const terminal = (result: typeof first): Terminal | null => {
      const t = result.routes?.[0]?.destination;
      return t
        ? { id: t.id, name: t.name, coordinate: [t.longitude, t.latitude] }
        : null;
    };
    const source = terminal(first),
      destination = terminal(second);
    const base = {
      ...input,
      address: `${input.start.label} → ${input.end.label}`,
      inputMode: "connection",
      latitude: input.end.latitude,
      longitude: input.end.longitude,
      mode: "connection",
      searchRadiusMeters: input.allowExpand2km ? 2000 : 1000,
      selectionStrategy: "independent_single_point_terminations",
      terminalToleranceMeters: TERMINAL_TOLERANCE_METERS,
    };
    const path =
      source && destination
        ? source.id === destination.id
          ? {
              source,
              destination,
              legs: [] as Leg[],
              links: [],
              recorded: false,
            }
          : (shortestConnection(graph, source, destination, true) ??
            shortestConnection(graph, source, destination))
        : null;
    if (!path) {
      return {
        ...base,
        source,
        destination,
        message:
          source && destination
            ? `Belum ditemukan jalur jaringan antara ${source.name} dan ${destination.name}, hasil analisis tunggal masing-masing titik.`
            : "Rute akses ke terminasi salah satu titik belum tersedia. Periksa lokasi atau perluas pencarian.",
        network: null,
        routes: [],
        terminationPlan: null,
        status:
          source && destination
            ? "NO_CONFIRMED_NETWORK_CONNECTION"
            : "ACCESS_ROUTING_UNAVAILABLE",
      };
    }
    const paths = [path];
    const access = (result: typeof first) => {
      if (!("routeGeometry" in result) || !result.routeGeometry) return [];
      return [
        { geometry: result.routeGeometry },
        ...(result.routes ?? []).flatMap((route) =>
          "routeGeometry" in route && route.routeGeometry
            ? [{ geometry: route.routeGeometry }]
            : []
        ),
      ];
    };
    const sourceAccess = access(first);
    // Preserve single-point road routing, including its direction, by reversing its geometry.
    const destinationAccess = access(second).map((route) => ({
      geometry: {
        type: "LineString" as const,
        coordinates: [...route.geometry.coordinates].reverse(),
      },
    }));
    const routeCandidates: Array<{
      path: (typeof paths)[number];
      legs: Leg[];
      distanceMeters: number;
      newCableMeters: number;
      existingNetworkMeters: number;
      unverifiedGapMeters: number;
      terminationPlan: Record<string, unknown>;
      terminalLinks: Array<Record<string, unknown>>;
      roadSnapGaps: Array<Record<string, unknown>>;
      key: string;
    }> = [];
    for (const path of paths) {
      try {
        const combinations = sourceAccess.flatMap((a) =>
          destinationAccess.map((b) => [a, b] as const)
        );
        for (const accesses of combinations) {
          const newLegs: Leg[] = accesses.map((r, i) => ({
            confirmation: "survey_required",
            distanceMeters: lineMeters(r.geometry),
            geometry: r.geometry,
            kind: "new",
            name: i
              ? `${path.destination.name} → B`
              : `A → ${path.source.name}`,
          }));
          const legs = [newLegs[0], ...path.legs, newLegs[1]];
          const key = connectionGeometryKey(
            path.source,
            path.destination,
            legs
          );
          if (routeCandidates.some((candidate) => candidate.key === key)) {
            continue;
          }
          const terminationPlan = {
            ...buildTerminationPlan(
              path.destination.id,
              newLegs[0].geometry,
              newLegs[0].distanceMeters,
              input.coreRequirement
            ),
            cables: newLegs.map((l) => ({
              cores: null,
              distanceMeters: l.distanceMeters,
              geometry: l.geometry,
              type: "Distribusi",
            })),
            inputMode: "connection",
            points: [],
          };
          const gaps = [
            {
              from: start,
              name: "A → road",
              to: newLegs[0].geometry.coordinates[0],
            },
            {
              from: newLegs[0].geometry.coordinates.at(-1)!,
              name: "road → source termination",
              to: path.source.coordinate,
            },
            {
              from: path.destination.coordinate,
              name: "destination termination → road",
              to: newLegs[1].geometry.coordinates[0],
            },
            {
              from: newLegs[1].geometry.coordinates.at(-1)!,
              name: "road → B",
              to: end,
            },
          ].map((g) => ({
            basis: "road_snap_gap",
            confirmation: "survey_required",
            gapMeters: meters(g.from, g.to),
            geometry: { coordinates: [g.from, g.to], type: "LineString" },
            name: g.name,
          }));
          const newCableMeters = newLegs.reduce(
              (s, l) => s + l.distanceMeters,
              0
            ),
            existingNetworkMeters = path.legs.reduce(
              (s, l) => s + l.distanceMeters,
              0
            );
          const terminalGaps = path.legs.length
            ? [
                {
                  basis: "termination_attachment_gap",
                  confirmation: "survey_required",
                  gapMeters: meters(
                    path.source.coordinate,
                    path.legs[0].geometry.coordinates[0]
                  ),
                  geometry: {
                    coordinates: [
                      path.source.coordinate,
                      path.legs[0].geometry.coordinates[0],
                    ],
                    type: "LineString",
                  },
                  name: path.source.name,
                },
                ...path.links,
                {
                  basis: "termination_attachment_gap",
                  confirmation: "survey_required",
                  gapMeters: meters(
                    path.legs.at(-1)!.geometry.coordinates.at(-1)!,
                    path.destination.coordinate
                  ),
                  geometry: {
                    coordinates: [
                      path.legs.at(-1)!.geometry.coordinates.at(-1)!,
                      path.destination.coordinate,
                    ],
                    type: "LineString",
                  },
                  name: path.destination.name,
                },
              ]
            : [];
          const unverifiedGapMeters = [...gaps, ...terminalGaps].reduce(
            (s, g) => s + g.gapMeters,
            0
          );
          routeCandidates.push({
            distanceMeters:
              newCableMeters + existingNetworkMeters + unverifiedGapMeters,
            existingNetworkMeters,
            key,
            legs,
            newCableMeters,
            path,
            roadSnapGaps: gaps,
            terminalLinks: terminalGaps,
            terminationPlan,
            unverifiedGapMeters,
          });
        }
      } catch (error) {
        // No straight-line replacement if the road router is unavailable or cannot connect the access legs.
        if (!(error instanceof Error)) {
          throw error;
        }
      }
    }
    const preferredPath = routeCandidates[0]?.path;
    const sameTerminations = preferredPath
      ? routeCandidates
          .filter(
            (candidate) =>
              candidate.path.source.id === preferredPath.source.id &&
              candidate.path.destination.id === preferredPath.destination.id
          )
          .sort((a, b) => a.distanceMeters - b.distanceMeters)
      : [];
    const primary = sameTerminations[0];
    const chosen = primary
      ? [
          primary,
          ...sameTerminations
            .filter((candidate) => candidate.key !== primary.key)
            .slice(0, 1),
        ]
      : [];
    const routes = chosen.map((candidate, index) => ({
      capacityConfirmation: "survey_required",
      destination: candidate.path.destination,
      distanceMeters: candidate.distanceMeters,
      existingNetworkMeters: candidate.existingNetworkMeters,
      id: index ? ("B" as const) : ("A" as const),
      legs: candidate.legs,
      networkConfirmation: candidate.path.recorded
        ? "recorded"
        : "survey_required",
      newCableMeters: candidate.newCableMeters,
      roadSnapGaps: candidate.roadSnapGaps,
      source: candidate.path.source,
      terminalLinks: candidate.terminalLinks,
      terminationPlan: candidate.terminationPlan,
      unverifiedGapMeters: candidate.unverifiedGapMeters,
    }));
    const route = routes[0];
    return {
      ...base,
      message: route
        ? "Kabel akses baru, celah snapping jalan/terminasi, kapasitas, dan koneksi kandidat memerlukan survei. Relasi aset bukan bukti splice; perusahaan tidak diketahui perlu verifikasi."
        : "Jalur jaringan ditemukan tetapi routing jalan kabel akses tidak tersedia. Tidak dibuat pengganti garis lurus.",
      network: route
        ? { id: route.destination.id, name: route.destination.name }
        : null,
      routes,
      status: route
        ? route.networkConfirmation === "recorded"
          ? "RECORDED_CONNECTION"
          : "PLANNING_CONNECTION"
        : "ACCESS_ROUTING_UNAVAILABLE",
      terminationPlan: route?.terminationPlan ?? null,
    };
  }

  async analyzePoint(
    point: ConnectionPoint,
    expand: boolean,
    requirement?: CoreRequirement
  ) {
    return analyzeCoordinates(
      this.atlas,
      this.routing,
      point.longitude,
      point.latitude,
      point.label,
      "manual",
      undefined,
      undefined,
      expand,
      requirement
    );
  }
}
