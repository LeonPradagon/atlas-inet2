import { formatDistance } from "../lib/format";

export type RouteChoice = {
  id: "A" | "B";
  distanceMeters: number;
  destination: string;
  description?: string;
};
export function RouteSelector({
  routes,
  selected,
  onSelect,
}: {
  routes: RouteChoice[];
  selected: "A" | "B";
  onSelect: (id: "A" | "B") => void;
}) {
  if (!routes.length) return null;
  const primary = routes.find((route) => route.id === "A") ?? routes[0];
  return (
    <section
      className="analysis-route-options"
      aria-label="Pilihan rute jaringan"
    >
      <div className="analysis-route-options-heading">
        <div>
          <h3>Pilih rute</h3>
          <p>Tujuan sama, jalur berbeda. Peta mengikuti rute yang dipilih.</p>
        </div>
      </div>
      <div className="analysis-route-option-grid">
        {(["A", "B"] as const).map((id) => {
          const route = routes.find((item) => item.id === id);
          return route ? (
            <button
              key={id}
              type="button"
              aria-pressed={selected === id}
              className={`analysis-route-option is-route-${id.toLowerCase()}${selected === id ? " is-selected" : ""}`}
              onClick={() => onSelect(id)}
            >
              <span className="analysis-route-option-topline">
                <span className="analysis-route-option-label">
                  <i
                    className={`analysis-route-swatch is-route-${id.toLowerCase()}`}
                  />
                  Rute {id}
                  {id === "A" && <small>Utama</small>}
                </span>
                <strong>{formatDistance(route.distanceMeters)}</strong>
              </span>
              <span className="analysis-route-option-destination">
                {route.destination}
              </span>
              {route.description && (
                <span className="analysis-route-option-network">
                  {route.description}
                </span>
              )}
              {id === "B" && (
                <span className="analysis-route-option-network">
                  Selisih{" "}
                  {formatDistance(
                    Math.abs(route.distanceMeters - primary.distanceMeters)
                  )}{" "}
                  dari Rute A
                </span>
              )}
            </button>
          ) : (
            <div key={id} className="analysis-route-option-unavailable">
              <span className="analysis-route-option-label">
                <i className="analysis-route-swatch is-route-b" />
                Rute B
              </span>
              <span>
                Belum ada jalur alternatif yang cukup berbeda ke tujuan ini.
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
