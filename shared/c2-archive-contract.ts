import { array, boolean, ContractValidationError, enumeration, identifier, integer, isoTimestamp, object,
  parseImportCoreSnapshot, requestId, string, type Input } from "./c1-contract";
import { assertTimezone } from "./c1-rules";
import { parseImportScheduleSnapshot } from "./c1-schedule-contract";
import { parseImportSignupSnapshot } from "./c1-signup-contract";
import { parseImportSeatingSnapshot } from "./c1-seating-contract";

// Internal, pure format. This is NOT a C1/C2 HTTP contract or a deployed archive protocol.
export const ARCHIVE_FORMAT = "c2-annual-plan-v1";
export const ARCHIVE_LIMITS = Object.freeze({ input_bytes: 2_000_000, records: 5000,
  chunk_bytes: 64_000, chunk_records: 100, total_bytes: 2_000_000, depth: 40 });
export function archiveAssert(condition: unknown, field: string): asserts condition {
  if (!condition) throw new ContractValidationError("Archive input is incomplete or inconsistent.", field);
}
export function utf8Bytes(text: string): number { return new TextEncoder().encode(text).length; }
// Canonical comparisons can include an entire saved SQL row (four independently
// bounded 2MB texts, escaped once more), rather than just a 2MB annual plan.
const CANONICAL_BYTES = 8 * ARCHIVE_LIMITS.total_bytes + 100_000;

function archiveJson(value: unknown, budget: number, integersOnly: boolean): string {
  const ownErrors = new Set<Error>();
  const ancestors = new Set<object>();
  let bytes = 0;
  const require = (condition: unknown, field: string): void => {
    if (condition) return;
    const error = new ContractValidationError("Archive input is incomplete or inconsistent.", field);
    ownErrors.add(error);
    throw error;
  };
  const emit = (text: string): string => {
    bytes += utf8Bytes(text);
    require(bytes <= budget, "input_bytes");
    return text;
  };
  const quoted = (text: string): string => {
    // Check before allocating an escaped copy of a possibly enormous string.
    require(text.length <= budget - bytes, "input_bytes");
    require(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text), "unicode");
    return emit(JSON.stringify(text));
  };
  const visit = (entry: unknown, depth: number): string => {
    require(depth <= ARCHIVE_LIMITS.depth, "json_depth");
    if (entry === null || typeof entry === "boolean") return emit(JSON.stringify(entry));
    if (typeof entry === "string") return quoted(entry);
    if (typeof entry === "number") {
      require(integersOnly ? Number.isSafeInteger(entry) : Number.isFinite(entry), "number");
      return emit(JSON.stringify(entry));
    }
    require(entry !== null && typeof entry === "object", "json");
    const container = entry as object;
    require(!ancestors.has(container), "json_cycle");
    const array = Array.isArray(container);
    const prototype = Object.getPrototypeOf(container);
    require(prototype === (array ? Array.prototype : Object.prototype) ||
      !integersOnly && !array && prototype === null, "json");
    // Arrays have a non-accessor, nonconfigurable own length. Check it before
    // enumerating keys, and inspect individual descriptors only after degree proof.
    const length = array ? Object.getOwnPropertyDescriptor(container, "length")?.value : 0;
    require(!array || Number.isSafeInteger(length) && length <= budget - bytes, "input_bytes");
    const keys = Reflect.ownKeys(container);
    require(keys.length <= budget - bytes, "input_bytes");
    require(keys.every(key => typeof key === "string"), "json");
    if (array) require(keys.length === length + 1, "json_array");
    ancestors.add(container);
    const parts: string[] = [emit(array ? "[" : "{")];
    const names = array ? null : (keys as string[]).sort();
    const count = array ? length : keys.length;
    for (let index = 0; index < count; index++) {
      const key = array ? String(index) : names![index];
      const descriptor = Object.getOwnPropertyDescriptor(container, key);
      require(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, "value"), "json_descriptor");
      if (index) parts.push(emit(","));
      if (!array) parts.push(quoted(key), emit(":"));
      parts.push(visit(descriptor!.value, depth + 1));
    }
    parts.push(emit(array ? "]" : "}"));
    ancestors.delete(container);
    return parts.join("");
  };
  try { return visit(value, 0); }
  catch (error) {
    if (ownErrors.has(error as Error)) throw error;
    // A Proxy's reflection trap may throw any private message or error class.
    archiveAssert(false, "json");
  }
}

export function archiveCanonical(value: unknown): string {
  return archiveJson(value, CANONICAL_BYTES, true);
}

export interface FrozenPracticeInput {
  season_id: string; practice_id: string; history_version: number; final_status: "FROZEN" | "UNPUBLISHED";
  frozen_revision: number; frozen_at: string;
  snapshot: { practice: { practice_id: string; start_at: string; end_at: string; timezone: string;
    location: string; address: string; map_url: string }; final_status: "FROZEN" | "UNPUBLISHED";
    seat_plan: { status: "FROZEN" | "UNPUBLISHED"; published_revision: number; published_at: string; source: string;
      coach: { display_name: string } | null; steerer: { display_name: string } | null;
      seats: Array<{ side: "LEFT" | "RIGHT"; row_number: number; display_name: string }> } };
}
function frozenPractice(value: unknown): FrozenPracticeInput {
  const row = object(value), snapshot = object(row.snapshot), practice = object(snapshot.practice), seat = object(snapshot.seat_plan);
  const person = (value: unknown) => value === null ? null : { display_name: string(object(value), "display_name", 1, 120) };
  return { season_id: identifier(row, "season_id"), practice_id: identifier(row, "practice_id"),
    history_version: integer(row, "history_version", 1), final_status: enumeration(row, "final_status", ["FROZEN", "UNPUBLISHED"]),
    frozen_revision: integer(row, "frozen_revision"), frozen_at: isoTimestamp(row, "frozen_at"), snapshot: {
      practice: { practice_id: identifier(practice, "practice_id"), start_at: isoTimestamp(practice, "start_at"),
        end_at: isoTimestamp(practice, "end_at"), timezone: string(practice, "timezone", 1, 100),
        location: string(practice, "location", 1, 200), address: string(practice, "address", 0, 300), map_url: string(practice, "map_url", 0, 2048) },
      final_status: enumeration(snapshot, "final_status", ["FROZEN", "UNPUBLISHED"]), seat_plan: {
        status: enumeration(seat, "status", ["FROZEN", "UNPUBLISHED"]), published_revision: integer(seat, "published_revision"),
        published_at: string(seat, "published_at", 0, 40), source: string(seat, "source", 0, 64),
        coach: person(seat.coach), steerer: person(seat.steerer),
        seats: array(seat, "seats", 100).map(value => { const entry = object(value); return {
          side: enumeration(entry, "side", ["LEFT", "RIGHT"] as const), row_number: integer(entry, "row_number", 1),
          display_name: string(entry, "display_name", 1, 120) }; }) } } };
}

// Explicit business-event keys. Unsupported shapes stop; credentials are never spread into an archive.
const signupKeys=["season_id","practice_id","member_id","status","promoted_member_ids","seating"];
const practiceChangeKeys=["season_id","week_id","practice_id","before","after","signup_version"];
// Exactly the business recordRequest shapes, not operational/login/backup audit payloads.
const ACTION_KEYS: Record<string,string[]> = {
  createSeason:["season_id"],updateMember:["season_id","member_id","member_version"],
  updateScheduleTemplates:["season_id","template_count"],prepareTrainingWeek:["season_id","week_id","created"],
  confirmTrainingWeek:["season_id","week_id","open_at"],publishTrainingWeek:["season_id","week_id"],
  createPractice:["season_id","week_id","practice_id"],publishAdditionalPractice:["season_id","week_id","practice_id"],
  updatePractice:practiceChangeKeys,cancelPractice:practiceChangeKeys,
  signup:signupKeys,signupByCoach:signupKeys,updateSignup:signupKeys,updateSignupByCoach:signupKeys,
  cancelSignup:signupKeys,cancelSignupByCoach:signupKeys,
  saveSeatPlanDraft:["season_id","practice_id","change_kind","seat_plan_version"],
  publishSeatPlan:["season_id","practice_id","published_revision","seat_plan_version","preference_mismatches"],
  freezePracticeHistory:["season_id","practice_id","final_status"],completeSeason:["season_id"],
  archiveSeasonHistory:["season_id","practice_count"],appendHistoryCorrection:["season_id","practice_id","history_version"],
  resolveFormSource:["season_id","member_id","stable_source_id"],pullFormResponses:["season_id","counts","has_more"]
};
function knownObject(value: unknown, keys: string[]): Input {
  const row=object(value); archiveAssert(Object.keys(row).every(key=>keys.includes(key)),"audit.details"); return row;
}
function explicitRoles(value:unknown):void {
  const row=object(value);for(const key of ["coach_member_id","steerer_member_id"])
    archiveAssert(Object.hasOwn(row,key) && typeof row[key]==="string","explicit_role");
}
const seatKeys=["side","row_number","member_id"];
const stateKeys=["season_id","practice_id","seat_plan_version","published_revision","coach_member_id","steerer_member_id","updated_by","updated_at"];
const revisionKeys=["season_id","practice_id","revision_number","revision_id","source","seat_plan_version","coach_member_id","steerer_member_id","seats","names","published_by","published_at","request_id"];
function auditSeat(value:unknown) {
  const row=knownObject(value,seatKeys);return {side:enumeration(row,"side",["LEFT","RIGHT"] as const),row_number:integer(row,"row_number",1),
    member_id:row.member_id===""?"":identifier(row,"member_id")};
}
function auditSeating(value: unknown): unknown {
  if(value===null)return null;
  const row=knownObject(value,["seat_plan_version","published_revision","draft_changed","published_changed","snapshot"]);
  const snapshot=knownObject(row.snapshot,["state","draft_seats","revision"]),state=knownObject(snapshot.state,stateKeys);
  explicitRoles(state);
  if(snapshot.revision!==null){ const rev=knownObject(snapshot.revision,revisionKeys);
    explicitRoles(rev);
    array(rev,"seats",100).forEach(auditSeat); array(rev,"names",102).forEach(name=>knownObject(name,["member_id","display_name"])); }
  const parsed=parseImportSeatingSnapshot({request_id:"archive_audit_schema",source_snapshot_id:"archive_audit_source",states:[state],draft_seats:[],
    revisions:snapshot.revision===null?[]:[snapshot.revision]});
  const order=(a:string,b:string)=>a<b?-1:a>b?1:0;
  const seats=(values:ReturnType<typeof auditSeat>[])=>[...values].sort((a,b)=>order(a.side,b.side)||a.row_number-b.row_number);
  const revision=parsed.revisions[0];
  return {seat_plan_version:integer(row,"seat_plan_version"),published_revision:integer(row,"published_revision"),
    draft_changed:boolean(row,"draft_changed"),published_changed:boolean(row,"published_changed"),snapshot:{state:parsed.states[0],
      draft_seats:snapshot.draft_seats===null?null:seats(array(snapshot,"draft_seats",100).map(auditSeat)),
      revision:revision?{...revision,seats:seats(revision.seats),names:[...revision.names].sort((a,b)=>order(a.member_id,b.member_id))}:null}};
}
function auditPractice(value:unknown):unknown {
  const row=knownObject(value,["practice_id","week_id","start_at","end_at","timezone","location","address","map_url","signup_cutoff_at",
    "left_capacity","right_capacity","practice_version","schedule_published_at","cancelled","updated_at","schedule_changed_at"]);
  const timestamp=(key:string)=>row[key]===null?null:isoTimestamp(row,key);
  const timezone=string(row,"timezone",1,100);assertTimezone(timezone);
  return {practice_id:identifier(row,"practice_id"),week_id:identifier(row,"week_id"),start_at:isoTimestamp(row,"start_at"),end_at:isoTimestamp(row,"end_at"),
    timezone,location:string(row,"location",1,200),address:string(row,"address",0,300),map_url:string(row,"map_url",0,2048),signup_cutoff_at:isoTimestamp(row,"signup_cutoff_at"),
    left_capacity:integer(row,"left_capacity",1),right_capacity:integer(row,"right_capacity",1),practice_version:integer(row,"practice_version",1),
    schedule_published_at:timestamp("schedule_published_at"),cancelled:boolean(row,"cancelled"),updated_at:isoTimestamp(row,"updated_at"),schedule_changed_at:timestamp("schedule_changed_at")};
}
function eventDetails(action:string,value: unknown): Input {
  archiveAssert(Object.hasOwn(ACTION_KEYS,action),"audit.action");
  const keys=ACTION_KEYS[action],row=knownObject(value,keys),result:Input={};
  archiveAssert(keys.every(key=>Object.hasOwn(row,key)),"audit.details_missing");
  for (const key of Object.keys(row).sort()) {
    if(key==="seating")result[key]=auditSeating(row[key]);
    else if(key==="before"||key==="after")result[key]=auditPractice(row[key]);
    else if(key==="promoted_member_ids") result[key]=array(row,key,100).map(id=>identifier({id},"id"));
    else if(key==="counts"){const counts=knownObject(row[key],["created","updated","reviewed","unchanged"]);result[key]=
      Object.fromEntries(["created","updated","reviewed","unchanged"].map(field=>[field,integer(counts,field)]));}
    else if(key==="preference_mismatches")result[key]=array(row,key,100).map(value=>{const item=knownObject(value,["member_id","preference","side"]);
      return {member_id:identifier(item,"member_id"),preference:enumeration(item,"preference",["LEFT","RIGHT","AMBIENT"] as const),side:enumeration(item,"side",["LEFT","RIGHT"] as const)};});
    else if(["season_id","practice_id","member_id","week_id"].includes(key))result[key]=identifier(row,key);
    else if(key==="stable_source_id")result[key]=string(row,key,1,1000);
    else if(key==="has_more"||key==="created")result[key]=boolean(row,key);
    else if(key==="open_at")result[key]=isoTimestamp(row,key);
    else if(key==="status")result[key]=enumeration(row,key,["CONFIRMED","WAITLISTED","CANCELLED"] as const);
    else if(key==="final_status")result[key]=enumeration(row,key,["FROZEN","UNPUBLISHED"] as const);
    else if(key==="change_kind")result[key]=enumeration(row,key,["EDIT","UNDO","RESET_TO_PUBLISHED"] as const);
    else result[key]=integer(row,key,["member_version","history_version"].includes(key)?1:0);
  }
  return result;
}
export function parseArchiveInput(value: unknown) {
  // Meter every explicit JSON field, including ignored private extensions, without
  // executing getters/toJSON. Parse the fixed copy, never reread a caller object.
  const inputText = archiveJson(value, ARCHIVE_LIMITS.input_bytes, false);
  const input = object(JSON.parse(inputText)); archiveAssert(input.format === ARCHIVE_FORMAT, "format");
  const request_id = requestId(input), snapshot_id = identifier(input, "snapshot_id"), season = object(input.season);
  const seed = { request_id, source_snapshot_id: snapshot_id };
  const core = parseImportCoreSnapshot({ ...seed, settings_version: 0, default_season_id: null, coaches: [], seasons: [season], members: input.members });
  const schedule = parseImportScheduleSnapshot({ ...seed, templates: input.templates, weeks: input.weeks, practices: input.practices });
  const signup = parseImportSignupSnapshot({ ...seed, states: input.signup_states, signups: input.signups });
  // C1 migration parsers accept omitted roles/seat members as empty for compatibility.
  // An annual capture must supply explicit fields; never reconstruct missing private data.
  for(const row of array(input,"seating_states",5000))explicitRoles(row);
  for(const row of array(input,"revisions",5000)){explicitRoles(row);for(const seat of array(object(row),"seats",100))
    archiveAssert(Object.hasOwn(object(seat),"member_id") && typeof object(seat).member_id==="string","explicit_seat_member");}
  for(const seat of array(input,"draft_seats",5000))
    archiveAssert(Object.hasOwn(object(seat),"member_id") && typeof object(seat).member_id==="string","explicit_seat_member");
  const seating = parseImportSeatingSnapshot({ ...seed, states: input.seating_states, draft_seats: input.draft_seats, revisions: input.revisions });
  const season_timezone = string(input, "season_timezone", 1, 100); assertTimezone(season_timezone);
  const binding_version = integer(input, "binding_version", 1);
  const captured_at = isoTimestamp(input, "captured_at"), cutoff_at = isoTimestamp(input, "cutoff_at");
  const kind = enumeration(input, "kind", ["PRACTICE", "SEASON"] as const);
  const practice_id = input.practice_id === null ? null : identifier(input, "practice_id");
  archiveAssert((kind === "PRACTICE") === (practice_id !== null), "practice_id");
  archiveAssert(core.seasons[0].timezone === season_timezone && core.seasons[0].binding_version === binding_version, "season_binding");
  archiveAssert(Date.parse(captured_at) >= Date.parse(cutoff_at), "capture_cutoff");
  const frozen = array(input, "frozen_practices", 5000).map(frozenPractice);
  const audits = array(input, "audits", 5000).map(value => { const row = object(value); return {
    event_id: identifier(row, "event_id"), season_id: identifier(row, "season_id"), request_key: string(row, "request_key", 1, 256),
    actor_scope: string(row, "actor_scope", 1, 128), action: string(row, "action", 1, 100),
    created_at: isoTimestamp(row, "created_at"), details: eventDetails(string(row,"action",1,100),row.details) as Input }; });
  const corrections = array(input, "corrections", 5000).map(value => { const row = object(value); return {
    season_id: identifier(row, "season_id"), practice_id: identifier(row, "practice_id"), correction_id: identifier(row, "correction_id"),
    history_version: integer(row, "history_version", 2), note: string(row, "note", 1, 500),
    created_by: string(row, "created_by", 1, 128), created_at: isoTimestamp(row, "created_at") }; });
  const result = { format: ARCHIVE_FORMAT, request_id, snapshot_id, kind, practice_id,
    team_id: identifier(input, "team_id"), backend_generation: string(input, "backend_generation", 1, 128),
    writer_epoch: integer(input, "writer_epoch"), binding_version, season_timezone, captured_at, cutoff_at,
    season: core.seasons[0], members: core.members, templates: schedule.templates, weeks: schedule.weeks,
    practices: schedule.practices, signup_states: signup.states, signups: signup.signups,
    seating_states: seating.states, draft_seats: seating.draft_seats, revisions: seating.revisions, frozen_practices: frozen, audits, corrections };
  archiveCanonical(result); return result;
}
export type ArchiveInput = ReturnType<typeof parseArchiveInput>;
