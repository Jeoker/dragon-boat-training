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

export function apiFailure(error: unknown, requestId: string | null = null): Response {
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
      meta: { request_id: requestId, server_time: new Date().toISOString() }
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
  const value = requireString(input, "request_id", 8, 128);
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(value)) {
    throw new ApiError("INVALID_REQUEST_ID", "The request identifier is invalid.");
  }
  return value;
}
