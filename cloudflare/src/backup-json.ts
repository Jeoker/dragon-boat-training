import { sourceCanonical, type SourceJson } from "../../shared/c2-source-capture-contract";

/** Reject oversized/getter inputs before serializing or cloning a whole backup.
 * Count exact serialized UTF8 primitives with a bounded descriptor-only walk. */
export function boundedBackupText(value: unknown, maxBytes: number): string {
  let bytes = 0, nodes = 0; const ancestors = new Set<object>();
  const add = (count: number) => { bytes += count; if (bytes > maxBytes) throw Error("BACKUP_RESOURCE_EXCEEDED"); };
  const primitive = (v: unknown) => {
    if (typeof v === "string" && v.length > maxBytes) throw Error("BACKUP_RESOURCE_EXCEEDED");
    const text = JSON.stringify(v); if (typeof text !== "string") throw Error("BACKUP_INVALID_JSON");
    add(new TextEncoder().encode(text).byteLength);
  };
  const walk = (node: unknown, depth: number) => {
    if (++nodes > 1_000_000 || depth > 40) throw Error("BACKUP_RESOURCE_EXCEEDED");
    if (node === null || typeof node !== "object") { primitive(node); return; }
    if (ancestors.has(node) || (!Array.isArray(node) && Object.getPrototypeOf(node) !== Object.prototype)) throw Error("BACKUP_INVALID_JSON");
    ancestors.add(node); const keys = Object.keys(node); add(2 + Math.max(0, keys.length - 1));
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw Error("BACKUP_INVALID_JSON");
      if (!Array.isArray(node)) { primitive(key); add(1); }
      walk(descriptor.value, depth + 1);
    }
    ancestors.delete(node);
  };
  walk(value, 0); return sourceCanonical(value as SourceJson);
}
