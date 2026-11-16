import type { Coordinate } from "../geospatial/routing.service";

export type Line = { type: "LineString"; coordinates: Coordinate[] };
export type Terminal = { id: string; name: string; coordinate: Coordinate };
export type Segment = {
  id: string;
  name: string;
  geometry: Line;
  available: number | null;
  company?: string;
};
export type Attachment = {
  segmentId: string;
  terminalId: string;
  recorded: boolean;
};
export type Mapping = {
  terminalId: string;
  segmentA: string;
  segmentB: string;
  coreA: string;
  coreB: string;
};
export type Leg = {
  kind: "new" | "existing";
  name: string;
  distanceMeters: number;
  geometry: Line;
  confirmation: "recorded" | "survey_required";
  segmentId?: string;
};
export const TERMINAL_TOLERANCE_METERS = 20;

export function meters(a: Coordinate, b: Coordinate) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b[1] - a[1]) * rad) / 2) ** 2 +
    Math.cos(a[1] * rad) *
      Math.cos(b[1] * rad) *
      Math.sin(((b[0] - a[0]) * rad) / 2) ** 2;
  return 6_371_008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function lineMeters(line: Line) {
  return line.coordinates
    .slice(1)
    .reduce((sum, p, i) => sum + meters(line.coordinates[i], p), 0);
}
export function mergeExistingLegs(legs: Leg[]) {
  const result: Leg[] = [];
  for (const leg of legs) {
    const prior = result.at(-1);
    if (
      prior &&
      prior.kind === "existing" &&
      leg.kind === "existing" &&
      prior.segmentId === leg.segmentId &&
      prior.confirmation === leg.confirmation &&
      meters(prior.geometry.coordinates.at(-1)!, leg.geometry.coordinates[0]) <
        0.001
    ) {
      prior.geometry.coordinates.push(...leg.geometry.coordinates.slice(1));
      prior.distanceMeters += leg.distanceMeters;
    } else {
      result.push({
        ...leg,
        geometry: {
          coordinates: [...leg.geometry.coordinates],
          type: "LineString",
        },
      });
    }
  }
  for (const leg of result) {
    const points = leg.geometry.coordinates.filter(
      (p, i, all) => i === 0 || meters(all[i - 1], p) > 0.001
    );
    leg.geometry.coordinates =
      points.length > 1 ? points : [points[0], points[0]];
  }
  return result;
}
export function connectionGeometryKey(
  source: Terminal,
  destination: Terminal,
  legs: Leg[]
) {
  return JSON.stringify([
    source.coordinate,
    destination.coordinate,
    mergeExistingLegs(legs).map((l) => [
      l.kind,
      l.segmentId,
      l.geometry.coordinates.map((p) =>
        p.map((n) => Math.round(n * 1e7) / 1e7)
      ),
    ]),
  ]);
}
export function isShallowConnectionVariant(
  a: { source: Terminal; destination: Terminal; legs: Leg[] },
  b: { source: Terminal; destination: Terminal; legs: Leg[] }
) {
  const sequence = (legs: Leg[]) =>
    mergeExistingLegs(legs)
      .filter((l) => l.kind === "existing" && l.distanceMeters > 0.01)
      .map((l) => l.segmentId);
  return (
    meters(a.source.coordinate, b.source.coordinate) <=
      TERMINAL_TOLERANCE_METERS &&
    meters(a.destination.coordinate, b.destination.coordinate) <=
      TERMINAL_TOLERANCE_METERS &&
    JSON.stringify(sequence(a.legs)) === JSON.stringify(sequence(b.legs))
  );
}

// Project on each actual polyline edge. Never replace a cable by its endpoint chord.
function locate(line: Line, at: Coordinate) {
  let before = 0;
  let best = {
    distance: Number.POSITIVE_INFINITY,
    measure: 0,
    point: line.coordinates[0],
  };
  for (let i = 1; i < line.coordinates.length; i++) {
    const a = line.coordinates[i - 1],
      b = line.coordinates[i];
    const sx = Math.cos((at[1] * Math.PI) / 180);
    const dx = (b[0] - a[0]) * sx,
      dy = b[1] - a[1];
    const t = Math.max(
      0,
      Math.min(
        1,
        ((at[0] - a[0]) * sx * dx + (at[1] - a[1]) * dy) /
          (dx * dx + dy * dy) || 0
      )
    );
    const point: Coordinate = [
      a[0] + t * (b[0] - a[0]),
      a[1] + t * (b[1] - a[1]),
    ];
    const distance = meters(at, point),
      length = meters(a, b);
    if (distance < best.distance) {
      best = { distance, measure: before + t * length, point };
    }
    before += length;
  }
  return best;
}
function slice(
  line: Line,
  from: ReturnType<typeof locate>,
  to: ReturnType<typeof locate>
): Line {
  let measure = 0;
  const coordinates: Coordinate[] = [from.point];
  for (let i = 1; i < line.coordinates.length; i++) {
    measure += meters(line.coordinates[i - 1], line.coordinates[i]);
    if (measure > from.measure && measure < to.measure) {
      coordinates.push(line.coordinates[i]);
    }
  }
  coordinates.push(to.point);
  return { coordinates, type: "LineString" };
}

type Edge = {
  to: string;
  leg?: Leg;
  distance: number;
  terminalId?: string;
  recorded: boolean;
};
export function buildConnectionGraph(
  segments: Segment[],
  terminals: Terminal[],
  attachments: Attachment[],
  mappings: Mapping[]
) {
  const graph = new Map<string, Edge[]>();
  const attach = new Map<
    string,
    {
      terminal: Terminal;
      segment: Segment;
      location: ReturnType<typeof locate>;
      recorded: boolean;
    }
  >();
  const add = (a: string, b: string, edge: Omit<Edge, "to">) => {
    graph.set(a, [...(graph.get(a) ?? []), { ...edge, to: b }]);
    graph.set(b, [
      ...(graph.get(b) ?? []),
      {
        ...edge,
        leg: edge.leg
          ? {
              ...edge.leg,
              geometry: {
                coordinates: [...edge.leg.geometry.coordinates].reverse(),
                type: "LineString",
              },
            }
          : undefined,
        to: a,
      },
    ]);
  };
  for (const segment of segments) {
    // Allocation status is not connectivity. Report capacity separately, never remove used circuits.
    const nodes: string[] = [];
    for (const terminal of terminals) {
      const location = locate(segment.geometry, terminal.coordinate);
      const recorded = attachments.some(
        (a) =>
          a.segmentId === segment.id &&
          a.terminalId === terminal.id &&
          a.recorded
      );
      if (!recorded && location.distance > TERMINAL_TOLERANCE_METERS) {
        continue;
      }
      // A remote recorded relation has no reliable attachment measure: do not invent a cable extension.
      if (location.distance > TERMINAL_TOLERANCE_METERS) {
        continue;
      }
      const id = JSON.stringify([segment.id, terminal.id]);
      attach.set(id, { location, recorded, segment, terminal });
      nodes.push(id);
    }
    nodes.sort(
      (a, b) =>
        attach.get(a)!.location.measure - attach.get(b)!.location.measure
    );
    for (let i = 1; i < nodes.length; i++) {
      const a = attach.get(nodes[i - 1])!,
        b = attach.get(nodes[i])!;
      const geometry = slice(segment.geometry, a.location, b.location);
      add(nodes[i - 1], nodes[i], {
        distance: lineMeters(geometry),
        leg: {
          confirmation: "survey_required",
          distanceMeters: lineMeters(geometry),
          geometry,
          kind: "existing",
          name: segment.name,
          segmentId: segment.id,
        },
        recorded: a.recorded && b.recorded,
      });
    }
  }
  // Only shared termination assets permit an interchange. Cable crossings alone create no edges.
  for (const terminal of terminals) {
    const nodes = [...attach.keys()].filter(
      (id) => attach.get(id)!.terminal.id === terminal.id
    );
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = attach.get(nodes[i])!,
          b = attach.get(nodes[j])!;
        const recorded = mappings.some(
          (m) =>
            m.terminalId === terminal.id &&
            ((m.segmentA === a.segment.id && m.segmentB === b.segment.id) ||
              (m.segmentB === a.segment.id && m.segmentA === b.segment.id))
        );
        if (
          !recorded &&
          a.segment.company &&
          b.segment.company &&
          a.segment.company !== b.segment.company
        ) {
          continue;
        }
        add(nodes[i], nodes[j], {
          distance:
            meters(a.location.point, terminal.coordinate) +
            meters(terminal.coordinate, b.location.point),
          recorded,
          terminalId: terminal.id,
        });
      }
    }
  }
  return { attach, graph, mappings };
}

export function shortestConnection(
  data: ReturnType<typeof buildConnectionGraph>,
  start: Terminal,
  end: Terminal,
  recordedOnly = false
) {
  const origins = [...data.attach.keys()].filter(
    (id) => data.attach.get(id)!.terminal.id === start.id
  );
  const targets = new Set(
    [...data.attach.keys()].filter(
      (id) => data.attach.get(id)!.terminal.id === end.id
    )
  );
  const distance = new Map(origins.map((id) => [id, 0]));
  const previous = new Map<string, { from: string; edge: Edge }>();
  const pending = new Set(origins);
  let found: string | undefined;
  while (pending.size) {
    const current = [...pending].reduce((a, b) =>
      distance.get(a)! <= distance.get(b)! ? a : b
    );
    pending.delete(current);
    if (targets.has(current)) {
      found = current;
      break;
    }
    for (const edge of data.graph.get(current) ?? []) {
      if (recordedOnly && !edge.recorded) {
        continue;
      }
      const next = distance.get(current)! + edge.distance;
      if (next < (distance.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        distance.set(edge.to, next);
        previous.set(edge.to, { edge, from: current });
        pending.add(edge.to);
      }
    }
  }
  if (!found) {
    return null;
  }
  const steps: { from: string; edge: Edge }[] = [];
  for (let current = found; previous.has(current); ) {
    const step = previous.get(current)!;
    steps.unshift(step);
    current = step.from;
  }
  if (!steps.some((s) => s.edge.leg && s.edge.distance > 0)) {
    return null;
  }
  // Check strand continuity across successive splices; pairwise segment links alone are insufficient.
  let cores: Set<string> | undefined;
  let continuous = steps.every((s) => s.edge.recorded);
  for (const step of steps.filter((s) => s.edge.terminalId)) {
    const sourceAttachment = data.attach.get(step.from)!;
    const destinationAttachment = data.attach.get(step.edge.to)!;
    const pairs = data.mappings
      .filter((m) => m.terminalId === step.edge.terminalId)
      .flatMap((m) =>
        m.segmentA === sourceAttachment.segment.id &&
        m.segmentB === destinationAttachment.segment.id
          ? [[m.coreA, m.coreB]]
          : m.segmentB === sourceAttachment.segment.id &&
              m.segmentA === destinationAttachment.segment.id
            ? [[m.coreB, m.coreA]]
            : []
      );
    const next = new Set<string>();
    for (const [sourceCore, destinationCore] of pairs) {
      if (!cores || cores.has(sourceCore)) {
        next.add(destinationCore);
      }
    }
    if (!next.size) {
      continuous = false;
    }
    cores = next;
  }
  if (recordedOnly && !continuous) {
    return null;
  }
  const legs = steps.flatMap((s) =>
    s.edge.leg
      ? [
          {
            ...s.edge.leg,
            confirmation: continuous
              ? ("recorded" as const)
              : ("survey_required" as const),
          },
        ]
      : []
  );
  const links = steps
    .filter((s) => s.edge.terminalId)
    .map((s) => ({
      basis: "termination_attachment_gap",
      confirmation: s.edge.recorded ? "recorded" : "survey_required",
      gapMeters: s.edge.distance,
      geometry: {
        coordinates: [
          data.attach.get(s.from)!.location.point,
          data.attach.get(s.from)!.terminal.coordinate,
          data.attach.get(s.edge.to)!.location.point,
        ],
        type: "LineString" as const,
      },
      name: data.attach.get(s.from)!.terminal.name,
      terminalId: s.edge.terminalId!,
    }));
  return {
    destination: end,
    distanceMeters: distance.get(found)!,
    legs: mergeExistingLegs(legs),
    links,
    recorded: continuous,
    source: start,
  };
}
