export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly retryable = false
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8"
    }
  });
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ApiError("INVALID_JSON", "The request body is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "The request must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function apiMeta(env: Env, requestId: string | null = null, contractVersion: string = env.CONTRACT_VERSION): Record<string, unknown> {
  return {
    contract_version: contractVersion,
    service_version: env.SERVICE_VERSION,
    backend_instance: env.BACKEND_INSTANCE,
    backend_generation: env.BACKEND_GENERATION,
    writer_epoch: Number(env.WRITER_EPOCH),
    environment: env.ENVIRONMENT,
    server_time: new Date().toISOString(),
    request_id: requestId
  };
}

export function apiSuccess(data: Record<string, unknown>, env: Env, requestId: string | null = null,
  contractVersion: string = env.CONTRACT_VERSION): Response {
  return jsonResponse({ ok: true, data, meta: apiMeta(env, requestId, contractVersion) });
}

export function apiFailure(error: unknown, env: Env, requestId: string | null = null,
  contractVersion: string = env.CONTRACT_VERSION): Response {
  const known = error instanceof ApiError;
  const status = known ? error.status : 500;
  return jsonResponse(
    {
      ok: false,
      error: {
        code: known ? error.code : "INTERNAL_ERROR",
        message: known ? error.message : "The service could not complete the request.",
        retryable: known ? error.retryable : true
      },
      meta: apiMeta(env, requestId, contractVersion)
    },
    status
  );
}

export function requireString(
  input: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number
): string {
  const value = typeof input[field] === "string" ? input[field].trim() : "";
  if (value.length < minimum || value.length > maximum) {
    throw new ApiError("INVALID_REQUEST", `A valid ${field} is required.`);
  }
  return value;
}

export function requireRequestId(input: Record<string, unknown>): string {
  const value = typeof input.request_id === "string" ? input.request_id.trim() : "";
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(value)) {
    throw new ApiError("INVALID_REQUEST_ID", "The request identifier is invalid.");
  }
  return value;
}

export function optionalInteger(input: Record<string, unknown>, field: string, fallback: number,
  minimum: number, maximum: number): number {
  const value = input[field] === undefined ? fallback : input[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ApiError("INVALID_REQUEST", `${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

export function optionalBoolean(input: Record<string, unknown>, field: string): boolean {
  const value = input[field] === undefined ? false : input[field];
  if (typeof value !== "boolean") throw new ApiError("INVALID_REQUEST", `${field} must be a boolean.`);
  return value;
}
