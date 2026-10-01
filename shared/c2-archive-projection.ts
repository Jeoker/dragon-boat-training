import { ARCHIVE_FORMAT, ARCHIVE_LIMITS, archiveAssert, archiveCanonical, parseArchiveInput, utf8Bytes,
  type ArchiveInput } from "./c2-archive-contract";
import { dateInTimezone, validateSeasonSnapshot } from "./c1-rules";

const DAY = 86_400_000;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function sorted<T>(rows: T[], key: (row: T) => string): T[] {
  const result = [...rows].sort((a, b) => compare(key(a), key(b)));
  archiveAssert(new Set(result.map(key)).size === result.length, "duplicate_key"); return result;
}
export interface ArchiveRecord { type: string; key: string; value: unknown; }
export interface ArchiveChunk { chunk_index: number; row_offset: number; row_count: number; payload_text: string; utf8_bytes: number; }
export interface ArchivePlan {
  format: typeof ARCHIVE_FORMAT; request_id: string; snapshot_id: string; kind: "PRACTICE" | "SEASON";
  archive_year: number; metadata_text: string; chunks: ArchiveChunk[]; record_count: number;
  source_status: "SOURCE_NOT_YET_VERIFIED"; state: "LOCAL_PLAN_ONLY"; canonical_text: string;
}

function validate(input: ArchiveInput): void {
  const sid = input.season.season_id, cutoff = Date.parse(input.cutoff_at), captured = Date.parse(input.captured_at);
  validateSeasonSnapshot(input.season);
  archiveAssert(input.season.start_date<=input.season.end_date && input.season.status!=="DRAFT","season_dates");
  const groups = [input.members, input.templates, input.weeks, input.practices, input.signup_states, input.signups,
    input.seating_states, input.draft_seats, input.revisions, input.frozen_practices, input.audits, input.corrections];
  for (const rows of groups) for (const row of rows) archiveAssert(row.season_id === sid, "season_scope");
  for (const row of [input.season,...groups.flat()]) {
    for (const field of ["created_at","updated_at","cancelled_at","schedule_published_at","published_at","confirmed_at","queue_at"])
      if (field in row && (row as unknown as Record<string,unknown>)[field] !== null) {
        const at = (row as unknown as Record<string,unknown>)[field];
        archiveAssert(typeof at === "string" && Number.isFinite(Date.parse(at)) && Date.parse(at) <= captured,"capture_time");
      }
  }
  const members = new Map(sorted(input.members, row => row.member_id).map(row => [row.member_id, row]));
  const weeks = new Set(sorted(input.weeks, row => row.week_id).map(row => row.week_id));
  const templates = new Set(sorted(input.templates, row => row.template_id).map(row => row.template_id));
  const practices = new Map(sorted(input.practices, row => row.practice_id).map(row => [row.practice_id, row]));
  const frozen = new Map(sorted(input.frozen_practices, row => row.practice_id).map(row => [row.practice_id, row]));
  const states = new Map(sorted(input.seating_states, row => row.practice_id).map(row => [row.practice_id, row]));
  const signupStates = new Map(sorted(input.signup_states, row => row.practice_id).map(row => [row.practice_id, row]));
  sorted(input.signups, row => `${row.practice_id}:${row.member_id}`);
  sorted(input.revisions, row => `${row.practice_id}:${row.revision_number}`);
  sorted(input.revisions, row => row.revision_id);
  sorted(input.draft_seats, row => `${row.practice_id}:${row.side}:${row.row_number}`);
  sorted(input.audits, row => row.event_id); sorted(input.corrections, row => row.correction_id);
  const member = (id: string) => archiveAssert(!id || members.has(id), "member_reference");
  const seats = (rows: Array<{ member_id: string; side: string; row_number: number }>, pid: string, roles: string[]) => {
    const practice = practices.get(pid)!; const occupied = rows.filter(row => row.member_id);
    sorted(rows, row => `${row.side}:${row.row_number}`); sorted(occupied, row => row.member_id);
    for (const row of rows) { member(row.member_id); archiveAssert(row.row_number <= (row.side === "LEFT" ? practice.left_capacity : practice.right_capacity), "seat_capacity"); }
    roles.forEach(member); const roleMembers = new Set(roles.filter(Boolean));
    archiveAssert(occupied.every(row=>!roleMembers.has(row.member_id)), "role_overlap");
  };
  for (const row of input.practices) {
    archiveAssert(weeks.has(row.week_id) && (!row.template_id || templates.has(row.template_id)), "schedule_reference");
    archiveAssert(Date.parse(row.start_at) < Date.parse(row.end_at), "practice_time");
    const localDate=dateInTimezone(row.start_at,input.season_timezone);
    archiveAssert(localDate>=input.season.start_date && localDate<=input.season.end_date,"practice_season_date");
    const state = states.get(row.practice_id), signup = signupStates.get(row.practice_id);
    archiveAssert(state && signup, "private_state_missing");
    member(state.coach_member_id); member(state.steerer_member_id);
    const draft = input.draft_seats.filter(seat => seat.practice_id === row.practice_id);
    archiveAssert(state.seat_plan_version===0?draft.length===0:draft.length===row.left_capacity+row.right_capacity,"draft_coverage");
    for (const seat of draft) archiveAssert(seat.seat_plan_version === state.seat_plan_version, "draft_version");
    seats(draft, row.practice_id, [state.coach_member_id, state.steerer_member_id]);
    const revisions = input.revisions.filter(rev => rev.practice_id === row.practice_id);
    archiveAssert(revisions.length === state.published_revision, "revision_coverage");
    const ordered = [...revisions].sort((a, b) => a.revision_number - b.revision_number);
    for (const [index, rev] of ordered.entries()) {
      archiveAssert(rev.revision_number === index + 1 && rev.seat_plan_version<=state.seat_plan_version && Date.parse(rev.published_at) <= captured &&
        (!row.schedule_published_at || Date.parse(rev.published_at) < Date.parse(row.end_at) + DAY), "revision_sequence");
      seats(rev.seats, row.practice_id, [rev.coach_member_id, rev.steerer_member_id]);
      const names = new Map(sorted(rev.names, name => name.member_id).map(name => [name.member_id, name.display_name]));
      archiveAssert(rev.seats.every(seat=>Boolean(seat.member_id)),"empty_revision_seat");
      const used = [...rev.seats.map(seat => seat.member_id), rev.coach_member_id, rev.steerer_member_id].filter(Boolean);
      for (const id of used) archiveAssert(names.has(id), "revision_name_missing");
      archiveAssert(names.size === new Set(used).size,"revision_name_coverage");
      for (const id of names.keys()) member(id);
    }
    const history = frozen.get(row.practice_id);
    if (row.cancelled_at || !row.schedule_published_at) { archiveAssert(!history, "unexpected_history"); continue; }
    if (input.kind === "PRACTICE" && row.practice_id !== input.practice_id) continue;
    archiveAssert(history && cutoff >= Date.parse(row.end_at) + DAY, "freeze_not_due");
    archiveAssert(Date.parse(history.frozen_at) >= Date.parse(row.end_at) + DAY && Date.parse(history.frozen_at) <= captured, "freeze_time");
    archiveAssert(history.frozen_revision === state.published_revision, "freeze_revision");
    const rev = ordered.at(-1); const names = new Map(rev?.names.map(name => [name.member_id, name.display_name]) ?? []);
    const expected = { practice: { practice_id: row.practice_id, start_at: row.start_at, end_at: row.end_at,
      timezone: row.timezone, location: row.location, address: row.address, map_url: row.map_url },
      final_status: rev ? "FROZEN" : "UNPUBLISHED", seat_plan: rev ? {
        status: "FROZEN", published_revision: rev.revision_number, published_at: rev.published_at, source: rev.source,
        coach: rev.coach_member_id ? { display_name: names.get(rev.coach_member_id) } : null,
        steerer: rev.steerer_member_id ? { display_name: names.get(rev.steerer_member_id) } : null,
        seats: [...rev.seats].filter(seat => seat.member_id).sort((a,b) => a.row_number - b.row_number || compare(a.side,b.side))
          .map(seat => ({ side: seat.side, row_number: seat.row_number, display_name: names.get(seat.member_id) }))
      } : { status: "UNPUBLISHED", published_revision: 0, published_at: "", source: "", coach: null, steerer: null, seats: [] } };
    sorted(history.snapshot.seat_plan.seats, seat => `${seat.side}:${seat.row_number}`);
    const normalized = { ...history.snapshot, seat_plan: { ...history.snapshot.seat_plan,
      seats: [...history.snapshot.seat_plan.seats].sort((a,b)=>a.row_number-b.row_number || compare(a.side,b.side)) } };
    archiveAssert(history.final_status === expected.final_status && archiveCanonical(normalized) === archiveCanonical(expected), "c1_frozen_snapshot_mismatch");
  }
  for (const row of [...input.signup_states, ...input.seating_states, ...input.signups, ...input.draft_seats, ...input.revisions, ...input.frozen_practices, ...input.corrections]) archiveAssert(practices.has(row.practice_id), "practice_reference");
  sorted(input.signups,row=>`${row.practice_id}:${row.queue_sequence}`);
  for (const row of input.signups) { member(row.member_id); archiveAssert(row.queue_sequence <= signupStates.get(row.practice_id)!.signup_sequence && Date.parse(row.updated_at)>=Date.parse(row.queue_at), "signup_sequence"); }
  // C1 signupCounts capacity invariants (c1-signup-service.ts:48/372); no historical re-promotion.
  for(const practice of input.practices){const confirmed=input.signups.filter(row=>row.practice_id===practice.practice_id && row.status==="CONFIRMED");
    archiveAssert(confirmed.length<=practice.left_capacity+practice.right_capacity &&
      confirmed.filter(row=>row.preference==="LEFT").length<=practice.left_capacity &&
      confirmed.filter(row=>row.preference==="RIGHT").length<=practice.right_capacity,"signup_capacity");}
  for (const row of input.audits) {
    archiveAssert(Date.parse(row.created_at) <= captured && row.details.season_id === sid, "audit_scope");
    if (row.details.practice_id !== undefined) archiveAssert(typeof row.details.practice_id === "string" && practices.has(row.details.practice_id), "audit_practice");
    if(row.details.member_id!==undefined)member(String(row.details.member_id));
    if(row.details.week_id!==undefined)archiveAssert(weeks.has(String(row.details.week_id)),"audit_week");
    for(const id of (row.details.promoted_member_ids??[]) as string[])member(id);
    for(const mismatch of (row.details.preference_mismatches??[]) as Array<{member_id:string}>)member(mismatch.member_id);
    for(const key of ["before","after"])if(row.details[key]){
      const practice=row.details[key] as Record<string,unknown>;
      archiveAssert(practice.practice_id===row.details.practice_id && practice.week_id===row.details.week_id,"audit_schedule_scope");
      archiveAssert(Date.parse(String(practice.start_at))<Date.parse(String(practice.end_at)),"audit_schedule_time");
      for(const key of ["updated_at","schedule_changed_at","schedule_published_at"])if(practice[key]!==null)
        archiveAssert(Date.parse(String(practice[key]))<=Date.parse(row.created_at),"audit_capture_time");
    }
    if(row.details.seating){
      const seating=row.details.seating as {seat_plan_version:number;published_revision:number;draft_changed:boolean;published_changed:boolean;
        snapshot:{state:ArchiveInput["seating_states"][number];draft_seats:Array<{member_id:string;side:string;row_number:number}>|null;
          revision:ArchiveInput["revisions"][number]|null}};
      const snapshot=seating.snapshot,state=snapshot.state,current=states.get(String(row.details.practice_id))!;
      archiveAssert(state.season_id===sid && state.practice_id===row.details.practice_id &&
        state.seat_plan_version===seating.seat_plan_version && state.published_revision===seating.published_revision &&
        state.seat_plan_version<=current.seat_plan_version && state.published_revision<=current.published_revision,"audit_seating_scope");
      archiveAssert(Date.parse(state.updated_at)<=Date.parse(row.created_at) &&
        seating.draft_changed===(snapshot.draft_seats!==null) && seating.published_changed===(snapshot.revision!==null),"audit_seating_snapshot");
      member(state.coach_member_id);member(state.steerer_member_id);
      if(snapshot.draft_seats){sorted(snapshot.draft_seats,seat=>`${seat.side}:${seat.row_number}`);
        const practice=practices.get(state.practice_id)!;
        archiveAssert(snapshot.draft_seats.length===practice.left_capacity+practice.right_capacity && snapshot.draft_seats.every(seat=>
          seat.row_number<=(seat.side==="LEFT"?practice.left_capacity:practice.right_capacity)),"audit_draft_coverage");
        const occupied=snapshot.draft_seats.filter(seat=>seat.member_id);sorted(occupied,seat=>seat.member_id);
        for(const seat of snapshot.draft_seats){member(seat.member_id);archiveAssert(!seat.member_id || ![state.coach_member_id,state.steerer_member_id].includes(seat.member_id),"audit_role_overlap");}}
      const revision=snapshot.revision;
      if(revision){archiveAssert(revision.season_id===sid && revision.practice_id===row.details.practice_id &&
        revision.revision_number===state.published_revision && revision.seat_plan_version<=state.seat_plan_version &&
        Date.parse(revision.published_at)<=Date.parse(row.created_at),"audit_revision_scope");
        const actual=input.revisions.find(candidate=>candidate.practice_id===revision.practice_id && candidate.revision_number===revision.revision_number);
        const normalize=(value:typeof revision)=>({...value,names:sorted(value.names,name=>name.member_id),seats:sorted(value.seats,seat=>`${seat.side}:${seat.row_number}`)});
        archiveAssert(actual && archiveCanonical(normalize(revision))===archiveCanonical(normalize(actual)),"audit_revision_mismatch");}
    }
  }
  for (const row of input.corrections) archiveAssert(frozen.has(row.practice_id) && Date.parse(row.created_at) >= Date.parse(frozen.get(row.practice_id)!.frozen_at) && Date.parse(row.created_at) <= captured && row.history_version <= frozen.get(row.practice_id)!.history_version, "correction_reference");
  for (const history of frozen.values()) {
    const corrections=input.corrections.filter(row=>row.practice_id===history.practice_id).sort((a,b)=>a.history_version-b.history_version);
    archiveAssert(corrections.length===history.history_version-1,"correction_coverage");
    for(const [index,correction]of corrections.entries()) archiveAssert(correction.history_version===index+2 &&
      (index===0 || Date.parse(correction.created_at)>=Date.parse(corrections[index-1].created_at)),"correction_sequence");
  }
  if (input.kind === "SEASON") archiveAssert(["COMPLETED", "ARCHIVED"].includes(input.season.status) && cutoff >= Date.parse(input.season.season_ends_at), "season_not_due");
  else { const practice = practices.get(input.practice_id!); archiveAssert(practice && !practice.cancelled_at && frozen.has(practice.practice_id), "practice_not_archivable"); }
}

export function createArchivePlan(value: unknown): ArchivePlan {
  const input = parseArchiveInput(value); validate(input);
  const selected = new Set(input.practices.filter(row => !row.cancelled_at && (input.kind === "SEASON" || row.practice_id === input.practice_id)).map(row => row.practice_id));
  const records: ArchiveRecord[] = [];
  const add = <T>(type: string, rows: T[], key: (row: T) => string) => { for (const row of sorted(rows,key)) records.push({ type, key:key(row), value:row }); };
  add("season", [input.season], row => row.season_id); add("member", input.members, row => row.member_id);
  add("template", input.templates, row => row.template_id); add("week", input.weeks, row => row.week_id);
  add("practice", input.practices.filter(row => selected.has(row.practice_id)), row => row.practice_id);
  add("signup_state", input.signup_states.filter(row => selected.has(row.practice_id)), row => row.practice_id);
  add("signup", input.signups.filter(row => selected.has(row.practice_id)), row => `${row.practice_id}:${row.member_id}`);
  add("seating_state", input.seating_states.filter(row => selected.has(row.practice_id)), row => row.practice_id);
  add("draft_seat", input.draft_seats.filter(row => selected.has(row.practice_id)), row => `${row.practice_id}:${row.side}:${row.row_number}`);
  // Nested arrays are unordered sets too; normalize them before fixed text is captured.
  add("revision", input.revisions.filter(row => selected.has(row.practice_id)).map(row => ({ ...row,
    names: sorted(row.names, name=>name.member_id), seats: sorted(row.seats, seat=>`${seat.side}:${String(seat.row_number).padStart(4,"0")}`) })), row=>`${row.practice_id}:${String(row.revision_number).padStart(10,"0")}`);
  add("frozen_practice", input.frozen_practices.filter(row=>selected.has(row.practice_id)).map(row=>({ ...row, snapshot:{ ...row.snapshot,
    seat_plan:{ ...row.snapshot.seat_plan, seats: sorted(row.snapshot.seat_plan.seats, seat=>`${String(seat.row_number).padStart(4,"0")}:${seat.side}`) } } })), row=>row.practice_id);
  add("audit", input.audits.filter(row=>row.action!=="cancelPractice" && (row.details.practice_id === undefined ? input.kind==="SEASON" : selected.has(String(row.details.practice_id)))), row=>row.event_id);
  add("correction", input.corrections.filter(row=>selected.has(row.practice_id)), row=>row.correction_id);
  archiveAssert(records.length<=ARCHIVE_LIMITS.records,"records");
  const year = input.kind === "SEASON" ? Number(input.season.end_date.slice(0,4)) : Number(dateInTimezone(input.practices.find(row=>row.practice_id===input.practice_id)!.start_at,input.season_timezone).slice(0,4));
  const { format, request_id, snapshot_id, kind, practice_id, team_id, backend_generation, writer_epoch,
    binding_version, season_timezone, captured_at, cutoff_at } = input;
  const metadata_text = archiveCanonical({ format, snapshot_id, kind, practice_id, team_id, backend_generation,
    writer_epoch, binding_version, season_id:input.season.season_id,season_timezone, captured_at, cutoff_at, archive_year:year,
    record_types:["season","member","template","week","practice","signup_state","signup","seating_state","draft_seat","revision","frozen_practice","audit","correction"],
    record_counts:Object.fromEntries(["season","member","template","week","practice","signup_state","signup","seating_state","draft_seat","revision","frozen_practice","audit","correction"].map(type=>[type,records.filter(row=>row.type===type).length])),
    source_status:"SOURCE_NOT_YET_VERIFIED" });
  const chunks: ArchiveChunk[]=[]; let rows: ArchiveRecord[]=[], offset=0;
  const flush=()=>{ if(!rows.length)return; const payload_text=archiveCanonical({format, snapshot_id, chunk_index:chunks.length,row_offset:offset,records:rows});
    archiveAssert(utf8Bytes(payload_text)<=ARCHIVE_LIMITS.chunk_bytes,"chunk_bytes"); chunks.push({chunk_index:chunks.length,row_offset:offset,row_count:rows.length,payload_text,utf8_bytes:utf8Bytes(payload_text)});offset+=rows.length;rows=[]; };
  for (const row of records) {
    const text=archiveCanonical({format,snapshot_id,chunk_index:chunks.length,row_offset:offset,records:[...rows,row]});
    if(rows.length && (rows.length>=ARCHIVE_LIMITS.chunk_records || utf8Bytes(text)>ARCHIVE_LIMITS.chunk_bytes))flush();
    rows.push(row); archiveAssert(utf8Bytes(archiveCanonical({format,snapshot_id,chunk_index:chunks.length,row_offset:offset,records:rows}))<=ARCHIVE_LIMITS.chunk_bytes,"record_bytes");
  }
  flush(); const base={format:ARCHIVE_FORMAT,request_id,snapshot_id,kind,archive_year:year,metadata_text,chunks,record_count:records.length,
    source_status:"SOURCE_NOT_YET_VERIFIED" as const,state:"LOCAL_PLAN_ONLY" as const};
  const canonical_text=archiveCanonical(base); archiveAssert(utf8Bytes(canonical_text)<=ARCHIVE_LIMITS.total_bytes,"total_bytes");
  return {...base,format:ARCHIVE_FORMAT,canonical_text};
}

// Exact texts, not invented crypto or durable storage. Returning clones prevents mutation of replay state.
export class InMemoryArchivePlans {
  private readonly requests = new Map<string, string>();
  private readonly snapshots = new Map<string, string>();
  private bytes = 0;
  prepare(value: unknown): ArchivePlan {
    const plan=createArchivePlan(value), key=archiveCanonical([JSON.parse(plan.metadata_text).team_id,plan.request_id]);
    const original=this.requests.get(key); archiveAssert(!original || original===plan.canonical_text,"IDEMPOTENCY_CONFLICT");
    const snapshotKey=archiveCanonical([JSON.parse(plan.metadata_text).team_id,plan.snapshot_id]);
    const snapshotText=archiveCanonical({metadata_text:plan.metadata_text,chunks:plan.chunks,record_count:plan.record_count});
    archiveAssert(!this.snapshots.has(snapshotKey) || this.snapshots.get(snapshotKey)===snapshotText,"SNAPSHOT_CONFLICT");
    const extra=(original ? 0 : utf8Bytes(key)+utf8Bytes(plan.canonical_text))+
      (this.snapshots.has(snapshotKey) ? 0 : utf8Bytes(snapshotKey)+utf8Bytes(snapshotText));
    archiveAssert((original || this.requests.size<ARCHIVE_LIMITS.memory_requests) && this.bytes+extra<=ARCHIVE_LIMITS.memory_bytes,"memory_budget");
    this.requests.set(key,plan.canonical_text);this.snapshots.set(snapshotKey,snapshotText);
    this.bytes+=extra;
    return { ...JSON.parse(plan.canonical_text), canonical_text:plan.canonical_text } as ArchivePlan;
  }
}
