import { runInDurableObject } from "cloudflare:test";
import type { PrivateSourceEnv } from "../src/index";
import { PrivateSourceSqlStore } from "../src/store";

/** Tests access real SQLite through the test harness, without exposing storage RPC. */
export function sqlStoreFixture(stub: ReturnType<PrivateSourceEnv["PRIVATE_SOURCE_STATE"]["getByName"]>) {
  return {
    read: (key: string) => runInDurableObject(stub, (_instance, ctx) => new PrivateSourceSqlStore(ctx.storage).read(key)),
    compareAndSet: (key: string, revision: number | null, value: unknown) =>
      runInDurableObject(stub, (_instance, ctx) => new PrivateSourceSqlStore(ctx.storage).compareAndSet(key, revision, value)),
  };
}
