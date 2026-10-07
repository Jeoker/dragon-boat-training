import { readSourceAuthorityPin, sourceAuthorityText } from "../../shared/c2-source-authority-contract";
import { createAuthorizedSourceOperation, bindSourceAuthorityContext } from "./authority-context";
import { type PrivateSourceOperationRecord } from "./operation";
import { PrivateSourceReadAttempt, type PrivateSourceReadRecord } from "./read-attempt";
import { GoogleSourceReader } from "./source-reader";
import { GoogleSourceJournalStore } from "./google-store";
import { PrivateSourceJournal, journalAssert, SourceJournalError, type JournalControl } from "./service";
import { createNativeCaptureEvidence, validateNativeCaptureEvidence, nativeCaptureUrl } from "./native-evidence";

export interface PrivateSourceRuntimePorts {
  authorize(): Promise<unknown>;
  registeredTarget(operationId: string): Promise<unknown>;
  store: {
    read(key: string): Promise<unknown | null>;
    compareAndSet(key: string, revision: number | null, value: PrivateSourceOperationRecord | PrivateSourceReadRecord): Promise<boolean>;
  };
  hash(text: string): Promise<string>;
  oauthToken(): Promise<string>;
  fetchGoogle?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => string;
  beforeSourceRequest?: (url: string) => Promise<void>;
  /** Trusted authority RPC only. Absent for local CLI/legacy capture; neither
   * a client proof nor a generic dependency can grant native provenance. */
  nativeTabProof?: () => Promise<unknown>;
  /** Trusted host policy for one invocation only. Every new invocation still
   * performs a complete private Google journal readback before review. */
  reuseJournalReadbackWithinInvocation?: boolean;
}

/** Private server-side composition. Source reads always use durable request
 * checkpoints. Every actual Google request also rechecks live server authority
 * and immutable target registration; OAuth never stands in for Coach identity. */
export async function createPrivateSourceRuntime(ports: PrivateSourceRuntimePorts) {
  try {
    const hash = (text: string) => ports.hash(text), token = () => ports.oauthToken();
    const initial = readSourceAuthorityPin(await ports.authorize()), operationId = initial.source.source_operation_id;
    const target = JSON.parse(sourceAuthorityText(await ports.registeredTarget(operationId)));
    await bindSourceAuthorityContext(initial, target, hash);
    const check = async () => {
      const current = readSourceAuthorityPin(await ports.authorize());
      const registered = await ports.registeredTarget(operationId);
      journalAssert(sourceAuthorityText(current) === sourceAuthorityText(initial) &&
        sourceAuthorityText(registered) === sourceAuthorityText(target), "SOURCE_RUNTIME_AUTHORITY_UNCONFIRMED");
      await bindSourceAuthorityContext(current, registered, hash);
    };
    const guardedFetch = async (url: string, init: RequestInit) => {
      await check();
      const response = await (ports.fetchGoogle ?? fetch)(url, init);
      try { await check(); return response; }
      catch {
        await response.body?.cancel().catch(() => {});
        throw new SourceJournalError("SOURCE_RUNTIME_AUTHORITY_UNCONFIRMED");
      }
    };
    const now = ports.now ? () => ports.now!() : undefined;
    const journalProofs = new Map<string, { core_text: string; control: JournalControl }>();
    return await createAuthorizedSourceOperation(async () => { await check(); return initial; }, id => ports.registeredTarget(id), context => ({
      hash, store: ports.store,
      readSource: async () => {
        const nativeObservation = ports.nativeTabProof ? { url: nativeCaptureUrl(context(), initial.authority_digest),
          async read() {
            await check(); const start = (now ?? (() => new Date().toISOString()))();
            const proof = await ports.nativeTabProof!(); await check();
            const evidence = await createNativeCaptureEvidence(proof, initial, context(), hash);
            await validateNativeCaptureEvidence(evidence, context(), initial.authority_digest, hash, start,
              (now ?? (() => new Date().toISOString()))());
            await check(); return evidence;
          }, async validate(value: unknown, start: string, end: string) {
            await check(); await validateNativeCaptureEvidence(value, context(), initial.authority_digest, hash, start, end);
            await check();
          } } : undefined;
        return new GoogleSourceReader(() => context().read_context, token, guardedFetch, now,
          new PrivateSourceReadAttempt(context, ports.store, hash, now, ports.beforeSourceRequest), nativeObservation).read();
      },
      journal: journalContext => {
        const journal = new PrivateSourceJournal(journalContext, new GoogleSourceJournalStore(token, guardedFetch), hash);
        return {
          stage: (core: string) => journal.stage(core),
          async resume() {
            await check();
            const key = sourceAuthorityText(journalContext());
            const prior = ports.reuseJournalReadbackWithinInvocation ? journalProofs.get(key) : undefined;
            const proof = prior ?? await journal.resume();
            await check();
            journalAssert(sourceAuthorityText(journalContext()) === key, "SOURCE_RUNTIME_AUTHORITY_UNCONFIRMED");
            if (ports.reuseJournalReadbackWithinInvocation && !prior)
              journalProofs.set(key, JSON.parse(sourceAuthorityText(proof)));
            return JSON.parse(sourceAuthorityText(proof)) as { core_text: string; control: JournalControl };
          },
        };
      },
    }));
  } catch { throw new SourceJournalError("SOURCE_RUNTIME_AUTHORITY_UNCONFIRMED"); }
}
