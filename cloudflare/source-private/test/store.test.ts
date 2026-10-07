import { env } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type PrivateSourceEnv } from "../src/index";
import { PrivateSourceSqlStore, PRIVATE_STORE_LIMITS } from "../src/store";
import { PrivateSourceRpcStore } from "../src/rpc-store";
import { sha256Base64Url } from "../../src/crypto";

const privateEnv = env as unknown as PrivateSourceEnv;
const recordKey = "a".repeat(43);
const stub = (name: string) => privateEnv.PRIVATE_SOURCE_STATE.getByName(name);
const rpc = (object: ReturnType<typeof stub>) => new PrivateSourceRpcStore(object);
const value = (revision = 1, raw = "虚构原回答 😀") => ({ key: recordKey, revision, format: "fixture-private-record", raw });

describe("private source SQLite CAS", () => {
  it("has no storage HTTP endpoint", async () => {
    const response = worker.fetch();
    expect(response.status).toBe(404); expect(await response.text()).toBe("");
  });

  it("persists multi-megabyte UTF8 bytes in bounded rows and survives actual DO eviction", async () => {
    const object = stub("large-record"), original = value(1, "虚构😀".repeat(230_000));
    expect(await rpc(object).compareAndSet(recordKey, null, original)).toBe(true);
    await runInDurableObject(object, (_instance, ctx) => {
      const chunks = ctx.storage.sql.exec<{ size: number }>("SELECT length(bytes) AS size FROM source_private_chunks").toArray();
      expect(chunks.length).toBeGreaterThan(32);
      expect(chunks.every(row => row.size <= PRIVATE_STORE_LIMITS.chunkBytes)).toBe(true);
    });
    await evictDurableObject(object);
    expect(await rpc(object).read(recordKey)).toEqual(original);
    expect(await rpc(object).compareAndSet(recordKey, 1, value(2, "第二版"))).toBe(true);
    expect(await rpc(object).compareAndSet(recordKey, 1, value(2, "过期覆盖"))).toBe(false);
    await runInDurableObject(object, (_instance, ctx) => {
      expect(ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM source_private_chunks").one().count).toBe(1);
    });
  });

  it("permits only one same-revision concurrent commit and keeps object namespaces isolated", async () => {
    const object = stub("concurrent");
    const results = await Promise.all([rpc(object).compareAndSet(recordKey, null, value(1, "A")), rpc(object).compareAndSet(recordKey, null, value(1, "B"))]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const saved = await rpc(object).read(recordKey) as ReturnType<typeof value>;
    expect(["A", "B"]).toContain(saved.raw);
    expect(await rpc(stub("separate")).read(recordKey)).toBeNull();
    expect(await rpc(object).compareAndSet(recordKey, null, value())).toBe(false);
  });

  it("rolls back all chunks and the manifest when a write fails mid-transaction", async () => {
    const object = stub("rollback"); await rpc(object).compareAndSet(recordKey, null, value());
    await runInDurableObject(object, async (_instance, ctx) => {
      const native = ctx.storage.sql;
      const broken = new Proxy(native, { get(target, property) {
        if (property === "exec") return (query: string, ...bindings: SqlStorageValue[]) => {
          if (query.startsWith("INSERT INTO source_private_chunks") && bindings[1] === 1) throw Error("PRIVATE_RAW_ERROR_SENTINEL");
          return target.exec(query, ...bindings);
        };
        const result = Reflect.get(target, property); return typeof result === "function" ? result.bind(target) : result;
      } });
      const store = new PrivateSourceSqlStore({ sql: broken, transactionSync: ctx.storage.transactionSync.bind(ctx.storage) });
      await expect(store.compareAndSet(recordKey, 1, value(2, "x".repeat(150_000)))).rejects.toThrow(/^SOURCE_PRIVATE_STORE_UNCONFIRMED$/u);
      expect(await new PrivateSourceSqlStore(ctx.storage).read(recordKey)).toEqual(value());
    });
  });

  it.each(["missing", "changed", "orphan", "manifest", "revision", "oversized-blob", "text-blob"])("rejects %s corruption without overwriting it", async mode => {
    const object = stub(`corrupt-${mode}`); await rpc(object).compareAndSet(recordKey, null, value());
    await runInDurableObject(object, async (_instance, ctx) => {
      if (mode === "missing") ctx.storage.sql.exec("DELETE FROM source_private_chunks WHERE key=?", recordKey);
      if (mode === "changed") ctx.storage.sql.exec("UPDATE source_private_chunks SET bytes=? WHERE key=?", new TextEncoder().encode("PRIVATE_CORRUPTION_SENTINEL").buffer, recordKey);
      if (mode === "orphan") ctx.storage.sql.exec("DELETE FROM source_private_records WHERE key=?", recordKey);
      if (mode === "manifest") ctx.storage.sql.exec("UPDATE source_private_records SET chunk_count=50000 WHERE key=?", recordKey);
      if (mode === "revision") ctx.storage.sql.exec("UPDATE source_private_records SET revision=2 WHERE key=?", recordKey);
      if (mode === "oversized-blob") ctx.storage.sql.exec("UPDATE source_private_chunks SET bytes=? WHERE key=?", new Uint8Array(70_000).buffer, recordKey);
      if (mode === "text-blob") ctx.storage.sql.exec("UPDATE source_private_chunks SET bytes=? WHERE key=?", "PRIVATE_TEXT_SENTINEL", recordKey);
      const store = new PrivateSourceSqlStore(ctx.storage);
      await expect(store.read(recordKey)).rejects.toThrow(/^SOURCE_PRIVATE_STORE_UNCONFIRMED$/u);
      await expect(store.compareAndSet(recordKey, 1, value(2))).rejects.toThrow(/^SOURCE_PRIVATE_STORE_UNCONFIRMED$/u);
    });
  });

  it("rejects over-budget records, invalid revision and getters without invoking them", async () => {
    const object = stub("rejects");
    await runInDurableObject(object, async (_instance, ctx) => {
      const bad = value(); let called = false;
      Object.defineProperty(bad, "raw", { enumerable: true, get() { called = true; throw Error("PRIVATE_GETTER_SENTINEL"); } });
      await expect(new PrivateSourceSqlStore(ctx.storage).compareAndSet(recordKey, null, bad)).rejects.toThrow("SOURCE_PRIVATE_STORE_UNCONFIRMED");
      expect(called).toBe(false);
    });
    await expect(rpc(object).compareAndSet(recordKey, null, value(2))).rejects.toThrow("SOURCE_PRIVATE_STORE_UNCONFIRMED");
    await expect(rpc(object).compareAndSet(recordKey, null, value(1, "x".repeat(PRIVATE_STORE_LIMITS.recordBytes)))).rejects.toThrow("SOURCE_PRIVATE_STORE_UNCONFIRMED");
    expect(await rpc(object).read(recordKey)).toBeNull();
  });

  it("refuses an unknown schema rather than modifying the private namespace", async () => {
    const object = stub("schema"); await rpc(object).compareAndSet(recordKey, null, value());
    await runInDurableObject(object, (_instance, ctx) => {
      ctx.storage.sql.exec("UPDATE source_private_schema SET version=2 WHERE id=1");
      expect(() => new PrivateSourceSqlStore(ctx.storage)).toThrow("SOURCE_PRIVATE_STORE_UNCONFIRMED");
      expect(ctx.storage.sql.exec<{ revision: number }>("SELECT revision FROM source_private_records WHERE key=?", recordKey).one().revision).toBe(1);
    });
  });

  it("retains application-level source hashes instead of treating storage integrity as verification", async () => {
    const object = stub("hash");
    const original = { ...value(), source_status: "SOURCE_NOT_VERIFIED", annual_export_authorized: false, source_digest: await sha256Base64Url("original source") };
    await rpc(object).compareAndSet(recordKey, null, original);
    expect(await rpc(object).read(recordKey)).toEqual(original);
  });
});
