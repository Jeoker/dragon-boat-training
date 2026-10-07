import { sourceCanonical, type SourceJson } from "../../../shared/c2-source-capture-contract";
import { sha256Base64Url } from "../../src/crypto";

export const PRIVATE_STORE_LIMITS = Object.freeze({ recordBytes: 14_000_000, chunkBytes: 64_000, storeBytes: 256_000_000 });
const failure = () => new Error("SOURCE_PRIVATE_STORE_UNCONFIRMED");
const validKey = (key: unknown): key is string => typeof key === "string" && /^[A-Za-z0-9_-]{43}$/u.test(key);
interface Manifest extends Record<string, SqlStorageValue> { key: string; revision: number; byte_count: number; chunk_count: number; digest: string; }
type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

/** Private namespace only. Business TeamState and its backups never use this store. */
export class PrivateSourceSqlStore {
  constructor(private readonly storage: Storage) {
    try {
      storage.transactionSync(() => {
        storage.sql.exec("CREATE TABLE IF NOT EXISTS source_private_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)");
        const rows = storage.sql.exec<{ version: number }>("SELECT version FROM source_private_schema WHERE id=1").toArray();
        if (rows.length === 0) storage.sql.exec("INSERT INTO source_private_schema VALUES (1,1)");
        else if (rows.length !== 1 || rows[0].version !== 1) throw failure();
        storage.sql.exec("CREATE TABLE IF NOT EXISTS source_private_records (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, byte_count INTEGER NOT NULL, chunk_count INTEGER NOT NULL, digest TEXT NOT NULL)");
        storage.sql.exec("CREATE TABLE IF NOT EXISTS source_private_chunks (key TEXT NOT NULL, chunk_index INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(key,chunk_index))");
      });
    } catch { throw failure(); }
  }

  private snapshot(key: string): { manifest: Manifest; bytes: Uint8Array } | null {
    return this.storage.transactionSync(() => {
      const manifests = this.storage.sql.exec<Manifest>("SELECT * FROM source_private_records WHERE key=?", key).toArray();
      if (manifests.length === 0) {
        if (this.storage.sql.exec("SELECT 1 FROM source_private_chunks WHERE key=? LIMIT 1", key).toArray().length) throw failure();
        return null;
      }
      if (manifests.length !== 1) throw failure();
      const manifest = manifests[0];
      if (manifest.key !== key || !Number.isSafeInteger(manifest.revision) || manifest.revision < 1 ||
        !Number.isSafeInteger(manifest.byte_count) || manifest.byte_count < 1 || manifest.byte_count > PRIVATE_STORE_LIMITS.recordBytes ||
        manifest.chunk_count !== Math.ceil(manifest.byte_count / PRIVATE_STORE_LIMITS.chunkBytes) ||
        !validKey(manifest.digest)) throw failure();
      // Prove the BLOB collection's count/types/size in SQL before materializing it.
      const budget = this.storage.sql.exec<{ count: number; invalid: number }>(
        "SELECT COUNT(*) AS count,COALESCE(SUM(CASE WHEN typeof(bytes)!='blob' OR length(bytes)<1 OR length(bytes)>? THEN 1 ELSE 0 END),0) AS invalid FROM source_private_chunks WHERE key=?",
        PRIVATE_STORE_LIMITS.chunkBytes, key).one();
      if (budget.count !== manifest.chunk_count || budget.invalid !== 0) throw failure();
      const chunks = this.storage.sql.exec<{ chunk_index: number; bytes: ArrayBuffer }>(
        "SELECT chunk_index,bytes FROM source_private_chunks WHERE key=? ORDER BY chunk_index", key).toArray();
      const bytes = new Uint8Array(manifest.byte_count);
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index], expected = Math.min(PRIVATE_STORE_LIMITS.chunkBytes, bytes.byteLength - index * PRIVATE_STORE_LIMITS.chunkBytes);
        if (chunk.chunk_index !== index || !(chunk.bytes instanceof ArrayBuffer) || chunk.bytes.byteLength !== expected) throw failure();
        bytes.set(new Uint8Array(chunk.bytes), index * PRIVATE_STORE_LIMITS.chunkBytes);
      }
      return { manifest, bytes };
    });
  }

  private async decode(saved: NonNullable<ReturnType<PrivateSourceSqlStore["snapshot"]>>) {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(saved.bytes);
    if (await sha256Base64Url(text) !== saved.manifest.digest) throw failure();
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getOwnPropertyDescriptor(value, "key")?.value !== saved.manifest.key ||
      Object.getOwnPropertyDescriptor(value, "revision")?.value !== saved.manifest.revision ||
      sourceCanonical(value as SourceJson) !== text) throw failure();
    return value;
  }

  async read(key: string): Promise<unknown | null> {
    try {
      if (!validKey(key)) throw failure();
      const saved = this.snapshot(key);
      return saved ? await this.decode(saved) : null;
    } catch { throw failure(); }
  }

  async compareAndSet(key: string, revision: number | null, value: unknown): Promise<boolean> {
    try {
      if (!validKey(key) || (revision !== null && (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER))) throw failure();
      const text = sourceCanonical(value as SourceJson), bytes = new TextEncoder().encode(text);
      if (!bytes.byteLength || bytes.byteLength > PRIVATE_STORE_LIMITS.recordBytes) throw failure();
      const record: unknown = JSON.parse(text), nextRevision = revision === null ? 1 : revision + 1;
      if (!record || typeof record !== "object" || Array.isArray(record) ||
        Object.getOwnPropertyDescriptor(record, "key")?.value !== key ||
        Object.getOwnPropertyDescriptor(record, "revision")?.value !== nextRevision) throw failure();
      const saved = this.snapshot(key);
      if (saved) await this.decode(saved);
      if ((saved?.manifest.revision ?? null) !== revision) return false;
      const digest = await sha256Base64Url(text), chunkCount = Math.ceil(bytes.byteLength / PRIVATE_STORE_LIMITS.chunkBytes);
      return this.storage.transactionSync(() => {
        const current = this.storage.sql.exec<Manifest>("SELECT * FROM source_private_records WHERE key=?", key).toArray();
        // Hashing yields: another writer may have committed during validation.
        if (current.length > 1) throw failure();
        if ((current[0]?.revision ?? null) !== revision) return false;
        if (saved && JSON.stringify(current[0]) !== JSON.stringify(saved.manifest)) throw failure();
        if (!saved && this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM source_private_chunks WHERE key=?", key).one().count) throw failure();
        const total = this.storage.sql.exec<{ total: number }>("SELECT COALESCE(SUM(byte_count),0) AS total FROM source_private_records").one().total;
        if (!Number.isSafeInteger(total) || total < 0 || total - (saved?.manifest.byte_count ?? 0) + bytes.byteLength > PRIVATE_STORE_LIMITS.storeBytes) throw failure();
        this.storage.sql.exec("DELETE FROM source_private_chunks WHERE key=?", key);
        for (let index = 0; index < chunkCount; index++) {
          const chunk = bytes.slice(index * PRIVATE_STORE_LIMITS.chunkBytes, (index + 1) * PRIVATE_STORE_LIMITS.chunkBytes);
          this.storage.sql.exec("INSERT INTO source_private_chunks VALUES (?,?,?)", key, index, chunk.buffer);
        }
        this.storage.sql.exec("INSERT INTO source_private_records VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,byte_count=excluded.byte_count,chunk_count=excluded.chunk_count,digest=excluded.digest",
          key, nextRevision, bytes.byteLength, chunkCount, digest);
        return true;
      });
    } catch { throw failure(); }
  }
}
