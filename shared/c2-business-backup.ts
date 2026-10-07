import { BACKUP_TABLES, BUSINESS_BACKUP_COLUMNS } from "./c2-business-backup-tables";
import { canonicalJson } from "./c1-rules";
import { sha256Base64Url } from "../cloudflare/src/crypto";
import { boundedBackupText } from "../cloudflare/src/backup-json";

type Row = Record<string, string | number | null>;
const fail = (): never => { throw new Error("RECOVERY_UNCONFIRMED"); };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  return value as Record<string, unknown>;
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const integer = (v: unknown, min = 0): number => typeof v === "number" && Number.isSafeInteger(v) && v >= min ? v : fail();
const digest = (v: unknown): string => typeof v === "string" && /^sha256_v1:[A-Za-z0-9_-]{43}$/u.test(v) ? v : fail();
export interface BusinessBackupBundle { manifest: unknown; chunks: unknown[]; }

/** Reviewed schema table whitelist; client SQL/schema/columns are never executed. */
export async function verifyBusinessBackup(value: unknown) {
  const raw = boundedBackupText(value, 30_000_000);
  const bundle = object(JSON.parse(raw)), manifest = object(bundle.manifest);
  if (Object.keys(bundle).sort().join() !== "chunks,manifest" || !Array.isArray(bundle.chunks)) fail();
  const chunks = bundle.chunks as unknown[];
  const schema = integer(manifest.schema_version);
  if ((schema !== 14 && schema !== 16) || manifest.format !== "sqlite-json-chunks-v1" ||
      typeof manifest.snapshot_id !== "string" || !/^backup_[A-Za-z0-9_-]{8,128}$/u.test(manifest.snapshot_id) ||
      typeof manifest.created_at !== "string" || !Number.isFinite(Date.parse(manifest.created_at))) fail();
  if (Object.keys(manifest).sort().join() !== "chunk_count,chunks,content_digest,created_at,format,record_count,schema_version,snapshot_id,table_count,tables") fail();
  const expectedTables = schema === 14 ? BACKUP_TABLES.slice(0, 47) : [...BACKUP_TABLES];
  if (!Array.isArray(manifest.tables) || !Array.isArray(manifest.chunks) || manifest.table_count !== expectedTables.length ||
      (manifest.tables as unknown[]).length !== expectedTables.length ||
      manifest.chunk_count !== chunks.length || (manifest.chunks as unknown[]).length !== chunks.length || chunks.length > 10_000) fail();
  const tableManifest = manifest.tables as unknown[], descriptors = manifest.chunks as unknown[];
  const { content_digest, ...core } = manifest;
  if (digest(content_digest) !== `sha256_v1:${await sha256Base64Url(canonicalJson(core))}`) fail();
  const tables = new Map<string, Row[]>(); let index = 0, total = 0, bytes = 0;
  for (let t = 0; t < expectedTables.length; t++) {
    const table = object(tableManifest[t]), name = expectedTables[t];
    if (Object.keys(table).sort().join() !== "chunk_indices,name,row_count" || table.name !== name || !Array.isArray(table.chunk_indices)) fail();
    const rows: Row[] = [], indices: number[] = []; const count = integer(table.row_count);
    while (rows.length < count) {
      const chunk = object(chunks[index]), descriptor = object(descriptors[index]), payload = object(chunk.payload);
      if (Object.keys(chunk).sort().join() !== "chunk_index,payload,payload_digest,row_count,row_offset,table_name" ||
          Object.keys(descriptor).sort().join() !== "chunk_index,payload_digest,row_count,row_offset,table_name" ||
          Object.keys(payload).sort().join() !== "row_offset,rows,table" || !Array.isArray(payload.rows) ||
          chunk.chunk_index !== index || chunk.table_name !== name || chunk.row_offset !== rows.length ||
          payload.table !== name || payload.row_offset !== rows.length ||
          chunk.row_count !== Math.min(100, count - rows.length) || payload.rows.length !== chunk.row_count) fail();
      const { payload: _payload, ...actualDescriptor } = chunk;
      const text = canonicalJson(payload); bytes += new TextEncoder().encode(text).byteLength;
      if (bytes > 29_000_000 || !same(actualDescriptor, descriptor) ||
          digest(chunk.payload_digest) !== `sha256_v1:${await sha256Base64Url(text)}`) fail();
      for (const value of payload.rows as unknown[]) {
        const row = object(value);
        if (!same(Object.keys(row).sort(), [...BUSINESS_BACKUP_COLUMNS[name]].sort())) fail();
        if (Object.values(row).some(v => v !== null && typeof v !== "string" && !(typeof v === "number" && Number.isFinite(v)))) fail();
        rows.push(row as Row);
      }
      indices.push(index++);
    }
    if (!same(table.chunk_indices, indices)) fail(); total += count; tables.set(name, rows);
  }
  if (index !== chunks.length || manifest.record_count !== total ||
      tables.get("app_meta")?.filter(row => row.key === "schema_version" && row.value === String(schema)).length !== 1) fail();
  return { manifest, tables, sourceSchemaVersion: schema };
}
