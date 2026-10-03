import { SOURCE_LIMITS, exactSourceKeys, parseGeneratedSourceJson, sourceArray, sourceAssert, sourceBytes,
  sourceCanonical, sourceInstant, sourceKnownSources, sourceObject, sourcePinnedContext, sourceText,
  type SourceJson, type SourceObject, type SourcePinnedContext } from "./c2-source-capture-contract";

export interface SourceAuthorityPinCore {
  format: "c2-source-authority-pin-v1";
  state: "SERVER_AUTHORITY_PIN_ONLY";
  actor_id: string;
  source: SourcePinnedContext;
  known_sources: SourceObject[];
  response_tab_title: string;
  census_scope: "DATABASE_KNOWN_IDENTITIES_ONLY";
  pinned_at: string;
  source_status: "SOURCE_NOT_VERIFIED";
  annual_export_authorized: false;
}
export interface SourceAuthorityPin extends SourceAuthorityPinCore { authority_digest: string; }
export const sourceAuthorityText = (value: unknown) => sourceCanonical(value as SourceJson);
export function readSourceAuthorityPin(value: unknown): SourceAuthorityPin {
  const text = sourceAuthorityText(value);
  sourceAssert(sourceBytes(text) <= SOURCE_LIMITS.input_bytes, "AUTHORITY_RESOURCE_EXCEEDED");
  const row = sourceObject(parseGeneratedSourceJson(text));
  exactSourceKeys(row, ["format", "state", "actor_id", "source", "known_sources", "response_tab_title", "census_scope",
    "pinned_at", "source_status", "annual_export_authorized", "authority_digest"]);
  sourceAssert(row.format === "c2-source-authority-pin-v1" && row.state === "SERVER_AUTHORITY_PIN_ONLY" &&
    row.census_scope === "DATABASE_KNOWN_IDENTITIES_ONLY" && row.source_status === "SOURCE_NOT_VERIFIED" &&
    row.annual_export_authorized === false, "AUTHORITY_STATE_INVALID");
  const source = sourcePinnedContext(row.source), known_sources = sourceArray(row.known_sources).map(sourceObject);
  sourceAssert(known_sources.length <= SOURCE_LIMITS.records, "AUTHORITY_RESOURCE_EXCEEDED");
  sourceKnownSources(known_sources, source);
  const pinned_at = sourceText(row.pinned_at, 1, 64);
  sourceAssert(sourceInstant(pinned_at) >= sourceInstant(source.season_ends_at), "AUTHORITY_NOT_DUE");
  const authority_digest = sourceText(row.authority_digest, 43, 43);
  sourceAssert(/^[A-Za-z0-9_-]{43}$/u.test(authority_digest), "AUTHORITY_DIGEST_INVALID");
  return { format: "c2-source-authority-pin-v1", state: "SERVER_AUTHORITY_PIN_ONLY", actor_id: sourceText(row.actor_id, 1, 128),
    source, known_sources, response_tab_title: sourceText(row.response_tab_title, 1, 512),
    census_scope: "DATABASE_KNOWN_IDENTITIES_ONLY", pinned_at, source_status: "SOURCE_NOT_VERIFIED",
    annual_export_authorized: false, authority_digest };
}
