import { expect } from "vitest";
import { canonicalJson } from "../../shared/c1-rules";
import { sha256Base64Url } from "../src/crypto";

type Row = Record<string, SqlStorageValue>;
export const FIXTURE_TIME = "2020-09-01T12:00:00.000Z";
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** SQL integrity fixture, not a simulated business scenario. Every exported
 * table has a nonempty row and actual PK/FK/CHECK constraints remain enabled. */
export function seedBackupTables(sql: SqlStorage, tables: readonly string[]) {
  for (const table of tables) {
    if (table === "app_meta") continue;
    if (sql.exec(`SELECT COUNT(*) n FROM ${quoted(table)}`).one().n) continue;
    const definition = String(sql.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", table).one().sql);
    const columns = sql.exec<{ name: string; type: string; notnull: number }>(`PRAGMA table_info(${quoted(table)})`).toArray();
    const row: Row = {};
    for (const column of columns) {
      const allowed = new RegExp(`\\b${column.name}\\b[\\s\\S]*?CHECK\\s*\\(\\s*${column.name}\\s+IN\\s*\\(([^)]*)\\)`, "iu").exec(definition);
      const minimum = new RegExp(`CHECK\\s*\\(\\s*${column.name}\\s*>=\\s*(\\d+)`, "iu").exec(definition);
      const enumValue = allowed?.[1].match(/'([^']*)'/u)?.[1];
      row[column.name] = /INT/u.test(column.type) ? Math.max(1, Number(minimum?.[1] ?? 1)) :
        enumValue ?? (column.name.endsWith("_json") ? "{}" :
          /(?:_at|_date)$/u.test(column.name) ? FIXTURE_TIME : `fixture_${column.name}`);
    }
    // Composite foreign keys copy all referenced columns from the same parent.
    for (const fk of sql.exec<{ table: string; from: string; to: string }>(`PRAGMA foreign_key_list(${quoted(table)})`).toArray()) {
      const parent = sql.exec<Row>(`SELECT * FROM ${quoted(fk.table)} ORDER BY rowid LIMIT 1`).toArray()[0];
      if (!parent) throw new Error(`Fixture parent missing: ${table} -> ${fk.table}`);
      row[fk.from] = parent[fk.to];
    }
    const names = columns.map(column => column.name);
    sql.exec(`INSERT INTO ${quoted(table)} (${names.map(quoted).join(",")}) VALUES (${names.map(() => "?").join(",")})`,
      ...names.map(name => row[name])).toArray();
  }
  expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
}

export function dumpTables(sql: SqlStorage, tables: readonly string[]) {
  return Object.fromEntries(tables.map(table => [table, sql.exec<Row>(`SELECT * FROM ${quoted(table)} ORDER BY rowid`).toArray()]));
}

export function schemaShape(sql: SqlStorage, tables: readonly string[]) {
  return Object.fromEntries(tables.map(table => [table, {
    columns: sql.exec(`PRAGMA table_info(${quoted(table)})`).toArray(),
    foreign_keys: sql.exec(`PRAGMA foreign_key_list(${quoted(table)})`).toArray(),
    indexes: sql.exec(`PRAGMA index_list(${quoted(table)})`).toArray(),
  }]));
}

export async function bundleFromRows(tables: Record<string, Row[]>, version = 16) {
  const chunks: any[] = [], descriptors: any[] = [], tableManifest: any[] = [];
  let count = 0;
  for (const [table, rows] of Object.entries(tables)) {
    const indices: number[] = []; count += rows.length;
    for (let offset = 0; offset < rows.length; offset += 100) {
      const payload = { table, row_offset: offset, rows: rows.slice(offset, offset + 100) };
      const descriptor = { chunk_index: chunks.length, table_name: table, row_offset: offset,
        row_count: payload.rows.length, payload_digest: `sha256_v1:${await sha256Base64Url(canonicalJson(payload))}` };
      indices.push(chunks.length); descriptors.push(descriptor); chunks.push({ ...descriptor, payload });
    }
    tableManifest.push({ name: table, row_count: rows.length, chunk_indices: indices });
  }
  const core = { snapshot_id: "backup_fixture_integrity", schema_version: version, format: "sqlite-json-chunks-v1",
    created_at: FIXTURE_TIME, tables: tableManifest, table_count: tableManifest.length, record_count: count,
    chunk_count: chunks.length, chunks: descriptors };
  return { manifest: { ...core, content_digest: `sha256_v1:${await sha256Base64Url(canonicalJson(core))}` }, chunks };
}

export async function resealBundle(bundle: any) {
  for (const chunk of bundle.chunks) {
    chunk.payload_digest = `sha256_v1:${await sha256Base64Url(canonicalJson(chunk.payload))}`;
    Object.assign(bundle.manifest.chunks[chunk.chunk_index], { payload_digest: chunk.payload_digest });
  }
  const { content_digest: _, ...core } = bundle.manifest;
  bundle.manifest.content_digest = `sha256_v1:${await sha256Base64Url(canonicalJson(core))}`;
  return bundle;
}
