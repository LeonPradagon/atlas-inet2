import type { NetworkAsset } from "../../lib/api";

/** Use the first populated ID in the original KMZ attribute order for cables. */
export function assetDetailTitle(
  asset: Pick<NetworkAsset, "assetType" | "attributes" | "name">
): string {
  const attributes = asset.attributes ?? {};
  if (asset.assetType === "segment") {
    const saved = attributes.__kmlDetailFields;
    const fields: [string, unknown][] = Array.isArray(saved)
      ? saved.filter(
          (field): field is [string, unknown] =>
            Array.isArray(field) &&
            field.length === 2 &&
            typeof field[0] === "string"
        )
      : Object.entries(attributes).filter(([key]) => !key.startsWith("__"));
    for (const [label, value] of fields) {
      if (!/(?:^|[\s_-])id$/iu.test(label.trim())) continue;
      if (typeof value !== "string" && typeof value !== "number") continue;
      const id = String(value).trim();
      if (id && !/^[—–-]+$/u.test(id)) return id;
    }
  }
  return String(attributes.name ?? asset.name);
}
