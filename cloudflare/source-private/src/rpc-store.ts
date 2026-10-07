const failure = () => new Error("SOURCE_PRIVATE_STORE_UNCONFIRMED");
export interface PrivateSourceStoreRpc {
  readRecord(key: string): Promise<{ ok: true; value: unknown | null } | { ok: false }>;
  commitRecord(key: string, revision: number | null, value: unknown): Promise<{ ok: true; swapped: boolean } | { ok: false }>;
}

/** Keeps the existing operation-store port, with no dependency errors crossing RPC. */
export class PrivateSourceRpcStore {
  constructor(private readonly rpc: PrivateSourceStoreRpc) {}
  async read(key: string): Promise<unknown | null> {
    try {
      const result = await this.rpc.readRecord(key);
      if (!result.ok) throw failure();
      return result.value;
    } catch { throw failure(); }
  }
  async compareAndSet(key: string, revision: number | null, value: unknown): Promise<boolean> {
    try {
      const result = await this.rpc.commitRecord(key, revision, value);
      if (!result.ok || typeof result.swapped !== "boolean") throw failure();
      return result.swapped;
    } catch { throw failure(); }
  }
}
