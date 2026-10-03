import { ContractValidationError } from "../../shared/c1-contract";
import { ApiError } from "./http";

export type SqlRow = Record<string, SqlStorageValue>;

export function firstRow<T extends Record<string, SqlStorageValue>>(
  sql: SqlStorage,
  query: string,
  ...bindings: SqlStorageValue[]
): T | null {
  return sql.exec<T>(query, ...bindings).toArray()[0] ?? null;
}

export function parseContract<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new ApiError("INVALID_REQUEST", error.message, 400);
    }
    throw error;
  }
}

export function operationReceipt(
  action: string,
  requestId: string,
  committedAt: string
): Record<string, unknown> {
  return { action, request_id: requestId, committed_at: committedAt };
}

export function signupProjection(row: Record<string, unknown>): Record<string, unknown> {
  return {
    member_id: String(row.member_id), preference: String(row.preference), status: String(row.status),
    queue_at: String(row.queue_at), queue_sequence: Number(row.queue_sequence)
  };
}

export function queueOrder(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return Date.parse(String(left.queue_at)) - Date.parse(String(right.queue_at)) ||
    Number(left.queue_sequence) - Number(right.queue_sequence);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
