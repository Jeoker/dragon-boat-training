import { PrivateSourceSqlStore, PRIVATE_STORE_LIMITS } from "./store";
import { sourceCanonical, type SourceJson } from "../../../shared/c2-source-capture-contract";
import { sha256Base64Url } from "../../src/crypto";
import { boundedBackupText } from "../../src/backup-json";

type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
const fail = (): never => { throw new Error("PRIVATE_BACKUP_UNCONFIRMED"); };
export const PRIVATE_BACKUP_LIMITS = Object.freeze({ totalBytes: 16_000_000, records: 128 });
interface RecordManifest { key: string; revision: number; byte_count: number; chunk_count: number; digest: string; }
export interface PrivateBackupManifest { format: "c2-private-backup-v1"; schema_version: 1; object_name: string;
  records: RecordManifest[]; total_bytes: number; chunk_count: number; content_digest: string; }
export interface PrivateBackupChunk { key: string; chunk_index: number; bytes_base64: string; }
const hash = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
const text = (value: unknown) => sourceCanonical(value as SourceJson);
function assertSchema(storage: Storage) {
  const definitions = [
    "CREATE TABLE source_private_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)",
    "CREATE TABLE source_private_records (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, byte_count INTEGER NOT NULL, chunk_count INTEGER NOT NULL, digest TEXT NOT NULL)",
    "CREATE TABLE source_private_chunks (key TEXT NOT NULL, chunk_index INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(key,chunk_index))",
  ];
  const normalize = (sql: string) => sql.replace(/ IF NOT EXISTS/gu, "").replace(/\s+/gu, " ").trim();
  for (const definition of definitions) {
    const name = definition.split(" ")[2], rows = storage.sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", name).toArray();
    if (rows.length !== 1 || normalize(rows[0].sql) !== definition) return fail();
  }
  const versions = storage.sql.exec<{ id: number; version: number }>("SELECT id,version FROM source_private_schema").toArray();
  if (versions.length !== 1 || versions[0].id !== 1 || versions[0].version !== 1) return fail();
}
const toBase64 = (bytes: Uint8Array) => { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); };
const fromBase64 = (value: string) => {
  if (value.length > 86_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return fail();
  const binary = atob(value), bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  if (toBase64(bytes) !== value) return fail(); return bytes;
};

/** Explicit bounded snapshot. Larger objects fail without partial exports;
 * this operational bound is separate from the 256 MB runtime store capacity. */
export async function exportPrivateBackup(storage: Storage, objectName: string) {
  if (objectName.length > 512 || !/^c2-private-source-v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/u.test(objectName)) return fail();
  assertSchema(storage);
  const budget = storage.sql.exec<{ count: number; total: number; invalid: number }>("SELECT COUNT(*) count,COALESCE(SUM(byte_count),0) total,COALESCE(SUM(CASE WHEN typeof(byte_count)!='integer' OR byte_count<1 OR byte_count>? OR typeof(key)!='text' OR length(key)!=43 OR typeof(digest)!='text' OR length(digest)!=43 OR typeof(revision)!='integer' OR revision<1 THEN 1 ELSE 0 END),0) invalid FROM source_private_records", PRIVATE_STORE_LIMITS.recordBytes).one();
  if (!Number.isSafeInteger(budget.count) || budget.count > PRIVATE_BACKUP_LIMITS.records || budget.invalid !== 0 ||
      !Number.isSafeInteger(budget.total) || budget.total < 0 || budget.total > PRIVATE_BACKUP_LIMITS.totalBytes) return fail();
  const records = storage.sql.exec<RecordManifest & Record<string, SqlStorageValue>>("SELECT * FROM source_private_records ORDER BY key").toArray();
  const total = records.reduce((sum, row) => sum + row.byte_count, 0);
  if (records.length > PRIVATE_BACKUP_LIMITS.records || !Number.isSafeInteger(total) || total < 0 || total > PRIVATE_BACKUP_LIMITS.totalBytes ||
      storage.sql.exec("SELECT 1 FROM source_private_chunks c LEFT JOIN source_private_records r ON c.key=r.key WHERE r.key IS NULL LIMIT 1").toArray().length) return fail();
  const store = new PrivateSourceSqlStore(storage), chunks: PrivateBackupChunk[] = [];
  for (const record of records) {
    // Validates UTF8, canonical complete record, digest and original revision.
    if (!await store.read(record.key)) return fail();
    for (const chunk of storage.sql.exec<{ chunk_index: number; bytes: ArrayBuffer }>("SELECT chunk_index,bytes FROM source_private_chunks WHERE key=? ORDER BY chunk_index", record.key)) {
      chunks.push({ key: record.key, chunk_index: chunk.chunk_index, bytes_base64: toBase64(new Uint8Array(chunk.bytes)) });
    }
  }
  const core = { format: "c2-private-backup-v1" as const, schema_version: 1 as const, object_name: objectName,
    records, total_bytes: total, chunk_count: chunks.length };
  const content_digest = await sha256Base64Url(text(core));
  // Hashing yields. A writer may have replaced a revision; never issue a mixed snapshot.
  assertSchema(storage);
  if (text(records) !== text(storage.sql.exec("SELECT * FROM source_private_records ORDER BY key").toArray()) ||
      storage.sql.exec("SELECT 1 FROM source_private_chunks c LEFT JOIN source_private_records r ON c.key=r.key WHERE r.key IS NULL LIMIT 1").toArray().length) return fail();
  return { manifest: { ...core, content_digest }, chunks };
}

export async function restorePrivateBackup(storage: Storage, value: unknown, expectedDigest: string, authorize?: () => Promise<void>) {
  const encoded = boundedBackupText(value, 23_000_000);
  const bundle = JSON.parse(encoded) as { manifest: PrivateBackupManifest; chunks: PrivateBackupChunk[] };
  if (!bundle || Object.keys(bundle).sort().join() !== "chunks,manifest" || !bundle.manifest || !Array.isArray(bundle.chunks)) return fail();
  const manifest = bundle.manifest, { content_digest, ...core } = manifest;
  if (Object.keys(manifest).sort().join() !== "chunk_count,content_digest,format,object_name,records,schema_version,total_bytes" ||
      manifest.format !== "c2-private-backup-v1" || manifest.schema_version !== 1 || !hash(expectedDigest) || content_digest !== expectedDigest ||
      typeof manifest.object_name !== "string" || manifest.object_name.length > 512 || !/^c2-private-source-v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/u.test(manifest.object_name) ||
      !Array.isArray(manifest.records) || manifest.records.length > PRIVATE_BACKUP_LIMITS.records ||
      manifest.chunk_count !== bundle.chunks.length || content_digest !== await sha256Base64Url(text(core))) return fail();
  const prepared: Array<{ manifest: RecordManifest; chunks: Uint8Array[] }> = []; let index = 0, total = 0, previousKey = "";
  for (const record of manifest.records) {
    if (!record || Object.keys(record).sort().join() !== "byte_count,chunk_count,digest,key,revision" || !hash(record.key) || record.key <= previousKey || !hash(record.digest) ||
        !Number.isSafeInteger(record.revision) || record.revision < 1 || !Number.isSafeInteger(record.byte_count) || record.byte_count < 1 ||
        record.byte_count > PRIVATE_STORE_LIMITS.recordBytes || record.chunk_count !== Math.ceil(record.byte_count / PRIVATE_STORE_LIMITS.chunkBytes)) return fail();
    total += record.byte_count; if (total > PRIVATE_BACKUP_LIMITS.totalBytes) return fail(); previousKey = record.key;
    const chunks: Uint8Array[] = [], bytes = new Uint8Array(record.byte_count);
    for (let i = 0; i < record.chunk_count; i++) {
      const chunk = bundle.chunks[index++];
      if (!chunk || Object.keys(chunk).sort().join() !== "bytes_base64,chunk_index,key" || chunk.key !== record.key || chunk.chunk_index !== i || typeof chunk.bytes_base64 !== "string") return fail();
      const part = fromBase64(chunk.bytes_base64);
      if (part.byteLength !== Math.min(PRIVATE_STORE_LIMITS.chunkBytes, record.byte_count - i * PRIVATE_STORE_LIMITS.chunkBytes)) return fail();
      bytes.set(part, i * PRIVATE_STORE_LIMITS.chunkBytes); chunks.push(part);
    }
    const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes), raw = JSON.parse(body) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.key !== record.key || raw.revision !== record.revision ||
        text(raw) !== body || await sha256Base64Url(body) !== record.digest) return fail();
    prepared.push({ manifest: record, chunks });
  }
  if (index !== bundle.chunks.length || total !== manifest.total_bytes) return fail();
  await authorize?.();
  return storage.transactionSync(() => {
    if (storage.sql.exec("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").toArray().length) return fail();
    new PrivateSourceSqlStore(storage);
    assertSchema(storage);
    for (const { manifest: record, chunks } of prepared) {
      storage.sql.exec("INSERT INTO source_private_records VALUES (?,?,?,?,?)", record.key, record.revision, record.byte_count, record.chunk_count, record.digest);
      chunks.forEach((chunk, i) => storage.sql.exec("INSERT INTO source_private_chunks VALUES (?,?,?)", record.key, i, chunk.buffer as ArrayBuffer));
      const saved = storage.sql.exec("SELECT * FROM source_private_records WHERE key=?", record.key).toArray();
      if (saved.length !== 1 || text(saved[0]) !== text(record)) return fail();
      let i = 0;
      for (const savedChunk of storage.sql.exec<{ chunk_index: number; bytes: ArrayBuffer }>("SELECT chunk_index,bytes FROM source_private_chunks WHERE key=? ORDER BY chunk_index", record.key)) {
        const expected = chunks[i];
        if (savedChunk.chunk_index !== i++ || !(savedChunk.bytes instanceof ArrayBuffer) || !expected ||
            savedChunk.bytes.byteLength !== expected.byteLength || new Uint8Array(savedChunk.bytes).some((byte, index) => byte !== expected[index])) return fail();
      }
      if (i !== record.chunk_count) return fail();
    }
    storage.sql.exec("CREATE TABLE recovery_seal(id INTEGER PRIMARY KEY CHECK(id=1), content_digest TEXT NOT NULL, object_name TEXT NOT NULL)");
    storage.sql.exec("INSERT INTO recovery_seal VALUES (1,?,?)", content_digest, manifest.object_name);
    return { state: "ISOLATED_PRIVATE_RESTORED" as const, record_count: prepared.length, content_digest,
      source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false, execution_enabled: false };
  });
}
