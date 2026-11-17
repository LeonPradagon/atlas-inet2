import type { IControl, Map as MapLibreMap } from "maplibre-gl";

/** Shared display controls for result maps. Page-specific import/edit actions remain separate. */
export function addMapDisplayControls(
  map: MapLibreMap,
  options: {
    radiusLayers: string[];
    assetLayers: string[];
  }
) {
  let element: HTMLDivElement | undefined;
  const control: IControl = {
    onAdd() {
      const panel = document.createElement("div");
      element = panel;
      panel.className = "maplibregl-ctrl atlas-map-display-controls";
      panel.setAttribute("aria-label", "Tampilan peta");
      for (const [label, layers] of [
        ["Radius pencarian", options.radiusLayers],
        ["Aset jaringan", options.assetLayers],
      ] as const) {
        let visible = true;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.setAttribute("aria-pressed", "true");
        button.addEventListener("click", () => {
          visible = !visible;
          button.setAttribute("aria-pressed", String(visible));
          for (const id of layers)
            if (map.getLayer(id))
              map.setLayoutProperty(
                id,
                "visibility",
                visible ? "visible" : "none"
              );
        });
        panel.append(button);
      }
      return panel;
    },
    onRemove() {
      element?.remove();
    },
  };
  map.addControl(control, "top-left");
}
