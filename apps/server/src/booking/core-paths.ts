/**
 * A verified section is an indivisible piece of fibre between two access
 * points. Its endpoints include the physical side of an access point.
 */
export type CorePathSection = {
  id: string;
  cableId: string;
  coreId: number;
  from: string;
  to: string;
  lengthMeters: number;
  available: boolean;
  startMeters?: number;
  endMeters?: number;
};

/** A link exists only for a recorded and confirmed physical connection. */
export type CorePathLink = { from: string; to: string };

export type CorePath = {
  sections: CorePathSection[];
  lengthMeters: number;
};

export type CorePathOption = {
  routeKey: string;
  cableIds: string[];
  paths: CorePath[];
  lengthMeters: number;
};

export type MidspanCut = {
  positionMeters: number;
  physicalSide: "toward_A" | "toward_B" | null;
  confirmed: boolean;
};

export type RecordedCoreConnection = {
  coreId: number;
  side: "A" | "B" | "R";
  positionMeters: number | null;
  physicalSide: "toward_A" | "toward_B" | null;
  nodeId: string;
  type: "splice" | "termination" | "device_port";
  groupId: string;
  confirmed: boolean;
  peerCoreId: number | null;
  peerSide: "A" | "B" | "R" | null;
  peerPositionMeters: number | null;
  peerPhysicalSide: "toward_A" | "toward_B" | null;
};

export function buildRecordedTopology(
  cores: Array<{ coreId: number; cableId: string; lengthMeters: number; available: boolean }>,
  connections: RecordedCoreConnection[],
  allocations: Array<{ coreId: number; startMeters: number; endMeters: number }> = []
) {
  const sections: CorePathSection[] = [];
  const endpointsByNode = new Map<string, string[]>();
  const spliceGroups = new Map<string, Array<{ endpoint: string; record: RecordedCoreConnection }>>();
  for (const core of cores) {
    const records = connections.filter((record) => record.coreId === core.coreId);
    const cuts = records.filter((record) => record.side === "R").map((record) => ({
      positionMeters: record.positionMeters ?? NaN,
      physicalSide: record.physicalSide,
      confirmed: record.confirmed,
    }));
    const coreSections = buildCoreSections({ ...core, cuts });
    if (!coreSections.length) continue;
    for (const section of coreSections) {
      if (allocations.some((allocation) =>
        allocation.coreId === section.coreId &&
        allocation.startMeters < section.endMeters! &&
        section.startMeters! < allocation.endMeters
      )) {
        section.available = false;
      }
    }
    sections.push(...coreSections);
    for (const record of records) {
      if (!record.confirmed) continue;
      const endpoint = record.side === "R"
        ? `${core.coreId}:R:${record.positionMeters}:${record.physicalSide}`
        : `${core.coreId}:${record.side}`;
      if (record.type === "termination") {
        const existing = endpointsByNode.get(record.nodeId) ?? [];
        existing.push(endpoint);
        endpointsByNode.set(record.nodeId, existing);
      }
      if (record.type === "splice") {
        const existing = spliceGroups.get(record.groupId) ?? [];
        existing.push({ endpoint, record });
        spliceGroups.set(record.groupId, existing);
      }
    }
  }
  const links: CorePathLink[] = [];
  for (const group of spliceGroups.values()) {
    if (group.length === 2 && group[0].record.nodeId === group[1].record.nodeId &&
        group[0].endpoint !== group[1].endpoint &&
        group.every((item, index) => {
          const other = group[1 - index].record;
          return item.record.peerCoreId === other.coreId &&
            item.record.peerSide === other.side &&
            (other.side !== "R" ||
              (item.record.peerPositionMeters === other.positionMeters &&
               item.record.peerPhysicalSide === other.physicalSide));
        })) {
      links.push({ from: group[0].endpoint, to: group[1].endpoint });
    }
  }
  return { sections, endpointsByNode, links };
}

/**
 * Split a single physical fibre into sections at confirmed access points.
 * The two sides of a cut have different endpoint IDs and are never joined
 * merely because they share a position.
 */
export function buildCoreSections(input: {
  coreId: number;
  cableId: string;
  lengthMeters: number;
  available: boolean;
  cuts: MidspanCut[];
}): CorePathSection[] {
  const { coreId, cableId, lengthMeters, available } = input;
  if (!Number.isSafeInteger(coreId) || coreId <= 0 || !cableId ||
      !Number.isFinite(lengthMeters) || lengthMeters <= 0) {
    throw new Error("Data core atau panjang kabel tidak valid.");
  }
  const cuts = [...input.cuts].sort((a, b) => a.positionMeters - b.positionMeters);
  if (cuts.some((cut, index) =>
    !cut.confirmed || !cut.physicalSide ||
    !Number.isFinite(cut.positionMeters) || cut.positionMeters <= 0 ||
    cut.positionMeters >= lengthMeters ||
    (index > 0 && cut.positionMeters === cuts[index - 1].positionMeters)
  )) {
    return [];
  }
  const sections: CorePathSection[] = [];
  let from = `${coreId}:A`;
  let previous = 0;
  for (const cut of cuts) {
    const position = cut.positionMeters;
    const left = `${coreId}:R:${position}:toward_A`;
    const right = `${coreId}:R:${position}:toward_B`;
    sections.push({
      id: `${coreId}:${previous}:${position}`, coreId, cableId, from, to: left,
      lengthMeters: position - previous, available, startMeters: previous, endMeters: position,
    });
    from = right;
    previous = position;
  }
  sections.push({
    id: `${coreId}:${previous}:${lengthMeters}`, coreId, cableId,
    from, to: `${coreId}:B`, lengthMeters: lengthMeters - previous, available,
    startMeters: previous, endMeters: lengthMeters,
  });
  return sections;
}

/**
 * Paths in one option follow the same ordered cables and use distinct core
 * sections. A core ID by itself is insufficient because disjoint sections can
 * belong to the same physical core.
 */
export function groupCorePaths(paths: CorePath[]): CorePathOption[] {
  const groups = new Map<string, CorePathOption>();
  for (const path of paths) {
    const cableIds = path.sections
      .map((section) => section.cableId)
      .filter((id, index, all) => index === 0 || id !== all[index - 1]);
    // Keep separate physical routes on the same cable sequence distinct, but
    // allow alternate fibres over the same section geometry to share an option.
    const routeShape = path.sections.map((section) => [
      section.cableId,
      section.startMeters ?? null,
      section.endMeters ?? null,
    ]);
    const key = JSON.stringify(routeShape);
    const option = groups.get(key) ?? { routeKey: key, cableIds, paths: [], lengthMeters: path.lengthMeters };
    option.paths.push(path);
    option.lengthMeters = Math.min(option.lengthMeters, path.lengthMeters);
    groups.set(key, option);
  }
  return [...groups.values()].sort((a, b) => a.lengthMeters - b.lengthMeters);
}

/** Choose a requested number of paths without assigning a section twice. */
export function selectDisjointCorePaths(paths: CorePath[], count: number): CorePath[] | null {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("Jumlah core tidak valid.");
  }
  if (paths.length < count) return null;
  const choose = (start: number, selected: CorePath[], occupied: Set<string>): CorePath[] | null => {
    if (selected.length === count) return selected;
    for (let index = start; index < paths.length; index++) {
      const path = paths[index];
      if (path.sections.some((section) => occupied.has(section.id))) continue;
      const nextOccupied = new Set(occupied);
      for (const section of path.sections) nextOccupied.add(section.id);
      const result = choose(index + 1, [...selected, path], nextOccupied);
      if (result) return result;
    }
    return null;
  };
  return choose(0, [], new Set());
}

/**
 * Find simple, confirmed fibre paths. A shared geographic point is never
 * treated as a connection unless the same physical endpoint or a link is
 * explicitly supplied. Returned paths are ordered shortest first.
 */
export function findCorePaths(
  sections: CorePathSection[],
  links: CorePathLink[],
  starts: string[],
  destinations: string[],
  maxPaths = 100
): CorePath[] {
  if (!Number.isInteger(maxPaths) || maxPaths < 1) {
    throw new Error("Batas jalur tidak valid.");
  }
  type Edge = { to: string; section?: CorePathSection };
  const edges = new Map<string, Edge[]>();
  const add = (from: string, edge: Edge) => {
    const list = edges.get(from) ?? [];
    list.push(edge);
    edges.set(from, list);
  };
  for (const section of sections) {
    if (!section.available) continue;
    if (!section.id || !section.cableId || !section.from || !section.to ||
        section.from === section.to || !Number.isSafeInteger(section.coreId) ||
        section.coreId <= 0 || !Number.isFinite(section.lengthMeters) ||
        section.lengthMeters <= 0) {
      throw new Error("Data bagian core tidak valid.");
    }
    add(section.from, { to: section.to, section });
    add(section.to, { to: section.from, section });
  }
  const seenLinks = new Set<string>();
  for (const link of links) {
    if (!link.from || !link.to || link.from === link.to) {
      throw new Error("Data sambungan core tidak valid.");
    }
    const key = JSON.stringify([link.from, link.to].sort());
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    add(link.from, { to: link.to });
    add(link.to, { to: link.from });
  }
  const targets = new Set(destinations);
  type State = { node: string; visited: Set<string>; sections: CorePathSection[]; lengthMeters: number };
  const queue: State[] = [...new Set(starts)].map((node) => ({
    node, visited: new Set([node]), sections: [], lengthMeters: 0,
  }));
  const results: CorePath[] = [];
  let explored = 0;
  while (queue.length && results.length < maxPaths) {
    if (++explored > 100_000) {
      throw new Error("Pencarian jalur terlalu luas; persempit pilihan perangkat.");
    }
    queue.sort((a, b) => a.lengthMeters - b.lengthMeters);
    const current = queue.shift()!;
    if (targets.has(current.node) && current.sections.length) {
      results.push({ sections: current.sections, lengthMeters: current.lengthMeters });
      continue;
    }
    for (const edge of edges.get(current.node) ?? []) {
      if (current.visited.has(edge.to)) continue;
      queue.push({
        node: edge.to,
        visited: new Set([...current.visited, edge.to]),
        sections: edge.section ? [...current.sections, edge.section] : current.sections,
        lengthMeters: current.lengthMeters + (edge.section?.lengthMeters ?? 0),
      });
    }
  }
  return results;
}
