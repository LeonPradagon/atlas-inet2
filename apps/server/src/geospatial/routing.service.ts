import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";

export type Coordinate = [longitude: number, latitude: number];

type GraphHopperResponse = {
  paths?: {
    distance: number;
    time: number;
    points: { type: "LineString"; coordinates: Coordinate[] };
    details?: { road_class?: [number, number, string][] };
  }[];
};

type RoutedPath = {
  distanceMeters: number;
  durationSeconds: number;
  geometry: { type: "LineString"; coordinates: Coordinate[] };
  roadClasses: (string | null)[];
};

@Injectable()
export class RoutingService {
  private nextRequestAt = 0;

  private async fetchRoute(url: string) {
    // The public provider shares a 10 requests/second Nginx limit. Reserve
    // slots across all analyses on this service, including both endpoints.
    for (let attempt = 0; ; attempt++) {
      const slot = Math.max(Date.now(), this.nextRequestAt);
      this.nextRequestAt = slot + 150;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, slot - Date.now()))
      );
      let response: Response;
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      } catch {
        if (attempt < 2) continue;
        throw new ServiceUnavailableException({
          code: "ROUTING_UNAVAILABLE",
          message:
            "Layanan routing tidak dapat dihubungi. Coba analisis kembali.",
        });
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        if (attempt < 3) {
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * (attempt + 1))
          );
          continue;
        }
        throw new ServiceUnavailableException({
          code: "ROUTING_UNAVAILABLE",
          message:
            "Layanan routing sedang sibuk. Analisis belum dapat membandingkan seluruh kandidat; coba kembali.",
        });
      }
      return response;
    }
  }

  async status(): Promise<"ok" | "unavailable"> {
    const baseUrl = process.env.ROUTING_URL;
    if (!baseUrl) {
      return "unavailable";
    }
    try {
      const response = await fetch(
        new URL("info", `${baseUrl.replace(/\/$/u, "")}/`),
        { signal: AbortSignal.timeout(3000) }
      );
      return response.ok ? "ok" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async preview(coordinates: Coordinate[]) {
    return this.route(coordinates, process.env.ROUTING_PROFILE ?? "car");
  }

  async previewNetwork(coordinates: Coordinate[]) {
    return this.route(coordinates, "car");
  }

  async previewNetworkAlternatives(coordinates: Coordinate[]) {
    return this.routePaths(
      coordinates,
      process.env.NETWORK_SHORTEST_ROUTING_PROFILE ?? "car_shortest",
      true
    );
  }

  async previewFtth(coordinates: Coordinate[]) {
    const profiles = [
      ...new Set([
        process.env.ROUTING_PROFILE ?? "car",
        process.env.FTTH_ROUTING_PROFILE ?? "bike",
        "foot",
      ]),
    ];
    const routes = await Promise.allSettled(
      profiles.map((profile) => this.route(coordinates, profile))
    );
    const available = routes.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    );
    if (!available.length) {
      throw routes.find((result) => result.status === "rejected")?.reason;
    }
    return available.reduce((shortest, route) =>
      route.distanceMeters < shortest.distanceMeters ? route : shortest
    );
  }

  private async route(coordinates: Coordinate[], profile: string) {
    const [route] = await this.routePaths(coordinates, profile);
    if (!route) {
      throw new BadGatewayException({
        message:
          "GraphHopper tidak menemukan rute pada data jalan yang tersedia.",
      });
    }
    return route;
  }

  private async routePaths(
    coordinates: Coordinate[],
    profile: string,
    alternatives = false
  ): Promise<RoutedPath[]> {
    const baseUrl = process.env.ROUTING_URL;
    if (!baseUrl) {
      throw new ServiceUnavailableException({
        code: "ROUTING_UNAVAILABLE",
        message:
          "Provider routing belum dikonfigurasi. Ekstrak data jalan belum diaktifkan.",
      });
    }
    const query = new URLSearchParams();
    for (const [longitude, latitude] of coordinates) {
      query.append("point", `${latitude},${longitude}`);
    }
    query.set("profile", profile);
    query.set("points_encoded", "false");
    query.append("details", "road_class");
    if (alternatives) {
      query.set("algorithm", "alternative_route");
      query.set("alternative_route.max_paths", "2");
    }
    if (alternatives || profile === "bike" || profile === "foot") {
      query.set("ch.disable", "true");
    }
    const response = await this.fetchRoute(
      `${baseUrl.replace(/\/$/u, "")}/route?${query}`
    );
    if (!response.ok) {
      throw new BadGatewayException({
        message:
          "GraphHopper tidak menemukan rute pada cakupan data jalan yang tersedia.",
      });
    }
    let result: GraphHopperResponse;
    try {
      result = (await response.json()) as GraphHopperResponse;
    } catch {
      throw new BadGatewayException({
        message: "Respons GraphHopper tidak valid.",
      });
    }
    const routes = (result.paths ?? []).filter(
      (route) => route.points?.coordinates?.length
    );
    if (!routes.length) {
      throw new BadGatewayException({
        message:
          "Tidak ditemukan jalur jalan yang menghubungkan titik-titik tersebut. Pastikan semua titik berada di Pulau Jawa dan terhubung ke jalan pada data OSM.",
      });
    }
    return routes.map((route) => {
      const roadClasses: (string | null)[] = Array(
        Math.max(0, route.points.coordinates.length - 1)
      ).fill(null);
      for (const [from, to, roadClass] of route.details?.road_class ?? []) {
        for (
          let index = from;
          index < to && index < roadClasses.length;
          index++
        ) {
          roadClasses[index] = roadClass;
        }
      }
      return {
        distanceMeters: route.distance,
        durationSeconds: route.time / 1000,
        geometry: route.points,
        roadClasses,
      };
    });
  }
}
