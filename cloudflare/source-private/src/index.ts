import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { PrivateSourceSqlStore } from "./store";
import { type PrivateSourceStoreRpc } from "./rpc-store";
import { currentSourcePin, executePrivateSourceCommand, sourceObjectName, sourceRuntimeFailure, type SourceRuntimeEnv } from "./runtime";
import { GoogleRefreshTokenProvider } from "./oauth";
import { readPrivateSourceCommand, type PrivateSourceResult } from "../../../shared/c2-private-source-command";
import { exportPrivateBackup } from "./backup";

export interface PrivateSourceEnv extends SourceRuntimeEnv { PRIVATE_SOURCE_STATE: DurableObjectNamespace<PrivateSourceState>; }
export class PrivateSourceState extends DurableObject<PrivateSourceEnv> implements PrivateSourceStoreRpc {
  private readonly store: PrivateSourceSqlStore;
  private readonly oauth: GoogleRefreshTokenProvider;
  private executing = false;
  constructor(ctx: DurableObjectState, env: PrivateSourceEnv) {
    super(ctx, env);
    this.store = new PrivateSourceSqlStore(ctx.storage);
    this.oauth = new GoogleRefreshTokenProvider(env);
  }
  async readRecord(key: string): ReturnType<PrivateSourceStoreRpc["readRecord"]> {
    try { return { ok: true, value: await this.store.read(key) }; } catch { return { ok: false }; }
  }
  async commitRecord(key: string, revision: number | null, value: unknown): ReturnType<PrivateSourceStoreRpc["commitRecord"]> {
    try { return { ok: true, swapped: await this.store.compareAndSet(key, revision, value) }; } catch { return { ok: false }; }
  }
  async execute(command: unknown): Promise<PrivateSourceResult> {
    if (this.executing) return sourceRuntimeFailure();
    this.executing = true;
    try {
      const name = this.ctx.id.name; if (!name) return sourceRuntimeFailure();
      return await executePrivateSourceCommand(this.env, {
        read: key => this.store.read(key), compareAndSet: (key, revision, value) => this.store.compareAndSet(key, revision, value),
        backup: () => exportPrivateBackup(this.ctx.storage, name),
      }, command, name, this.oauth);
    } catch { return sourceRuntimeFailure(); }
    finally { this.executing = false; }
  }
}

/** Only a service binding to this named entrypoint can run commands. */
export class SourceRuntime extends WorkerEntrypoint<PrivateSourceEnv> {
  async run(command: unknown): Promise<PrivateSourceResult> {
    try {
      const input = readPrivateSourceCommand(command), pin = await currentSourcePin(this.env, input);
      using result = await this.env.PRIVATE_SOURCE_STATE.getByName(sourceObjectName(pin)).execute(input);
      // Never forward the upstream RPC result's disposer/capabilities. Return a
      // plain payload, then explicitly release the DO invocation's RPC result.
      return JSON.parse(JSON.stringify(result)) as PrivateSourceResult;
    } catch { return sourceRuntimeFailure(); }
  }
}

// Neither the named RPC entrypoint nor raw storage has an HTTP endpoint.
export default { fetch() { return new Response(null, { status: 404 }); } } satisfies ExportedHandler<PrivateSourceEnv>;
