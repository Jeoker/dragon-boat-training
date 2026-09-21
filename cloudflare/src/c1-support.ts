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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
