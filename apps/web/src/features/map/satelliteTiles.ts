import { addProtocol } from "maplibre-gl";

const imageryUrl =
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";
let placeholders: Promise<Uint8Array[]> | undefined;

async function getTile(z: number, x: number, y: number, signal?: AbortSignal) {
  const response = await fetch(`${imageryUrl}/${z}/${y}/${x}`, { signal });
  if (!response.ok) {
    throw new Error(`Satellite tile request failed: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function registerSatelliteTiles() {
  addProtocol("atlas-satellite", async (request, controller) => {
    const [zoom, x, y] = request.url.split("://")[1].split("/").map(Number);
    // Esri returns a successful JPEG response even when no imagery exists.
    placeholders ??= Promise.all([getTile(19, 0, 0), getTile(20, 0, 0)]).catch(
      (error) => {
        placeholders = undefined;
        throw error;
      }
    );
    const missing = await placeholders;
    for (let z = zoom; z >= 0; z--) {
      const scale = 2 ** (zoom - z);
      const data = await getTile(
        z,
        Math.floor(x / scale),
        Math.floor(y / scale),
        controller.signal
      );
      if (
        missing.some(
          (tile) =>
            data.length === tile.length &&
            data.every((value, index) => value === tile[index])
        )
      ) {
        continue;
      }
      if (scale === 1) {
        return { data: data.buffer };
      }
      const bitmap = await createImageBitmap(new Blob([data]));
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const context = canvas.getContext("2d");
      if (!context) {
        bitmap.close();
        throw new Error("Could not create satellite tile canvas");
      }
      const size = 256 / scale;
      context.drawImage(
        bitmap,
        (x % scale) * size,
        (y % scale) * size,
        size,
        size,
        0,
        0,
        256,
        256
      );
      bitmap.close();
      return { data: await createImageBitmap(canvas) };
    }
    throw new Error("Satellite imagery is unavailable for this area");
  });
}
