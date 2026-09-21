export const DRAGON_BOAT_CONTRACT_VERSION = "2026-09-02.p2.1";

export class DragonBoatApiError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "DragonBoatApiError";
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.requestId = options.requestId || null;
  }
}

// A retryable transport/protocol failure never proves a write was rejected.
// Every write flow must retain its original ID and payload in this state.
export function isUncertainWriteError(error) {
  return !(error instanceof DragonBoatApiError) || error.retryable ||
    ["INVALID_RESPONSE", "CONTRACT_MISMATCH", "REQUEST_ABORTED"].includes(error.code);
}

export class DragonBoatApiClient {
  /**
   * @param {{
   *   baseUrl?: string,
   *   fetchImpl?: typeof globalThis.fetch,
   *   timeoutMs?: number
   * }} options
   */
  constructor({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    this.baseUrl = normalizeApiUrl(baseUrl);
    if (typeof fetchImpl !== "function") {
      throw new DragonBoatApiError("FETCH_UNAVAILABLE", "This browser cannot contact the training service.");
    }
    this.fetchImpl = fetchImpl.bind(globalThis);
    this.timeoutMs = timeoutMs;
  }

  get(action, parameters = {}, options = {}) {
    if (Object.hasOwn(parameters, "session_token") || Object.hasOwn(parameters, "coach_code")) {
      throw new DragonBoatApiError("INVALID_REQUEST", "Credentials must be sent in a POST body.");
    }
    const requestId = options.requestId || createRequestId();
    const url = new URL(this.baseUrl);
    url.searchParams.set("action", action);
    url.searchParams.set("request_id", requestId);

    for (const [key, value] of Object.entries(parameters)) {
      if (key !== "action" && key !== "request_id" && value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    return this.request(url, { method: "GET" }, { ...options, requestId });
  }

  post(action, payload = {}, options = {}) {
    const requestId = options.requestId || createRequestId();
    const body = JSON.stringify({ ...payload, action, request_id: requestId });

    return this.request(
      this.baseUrl,
      {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body
      },
      { ...options, requestId }
    );
  }

  async request(url, init, { requestId, signal } = {}) {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(signal?.reason);

    if (signal?.aborted) {
      abortFromCaller();
    } else {
      signal?.addEventListener("abort", abortFromCaller, { once: true });
    }

    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        ...init,
        cache: "no-store",
        credentials: "omit",
        redirect: "follow",
        signal: controller.signal
      });
      const text = await response.text();
      let envelope;

      try {
        envelope = JSON.parse(text);
      } catch (error) {
        throw new DragonBoatApiError(
          "INVALID_RESPONSE",
          "The training service returned an unreadable response.",
          { cause: error, requestId, retryable: true }
        );
      }

      assertEnvelope(envelope, requestId);

      if (!response.ok && envelope.ok === true) {
        throw new DragonBoatApiError("INVALID_RESPONSE", "The HTTP status contradicts the service response.", {
          requestId, retryable: true
        });
      }
      if (envelope.ok !== true) {
        throw new DragonBoatApiError(
          envelope.error?.code || "REQUEST_FAILED",
          envelope.error?.message || "The training service rejected the request.",
          {
            retryable: envelope.error?.retryable,
            requestId: envelope.meta?.request_id || requestId
          }
        );
      }

      return envelope;
    } catch (error) {
      if (error instanceof DragonBoatApiError) {
        throw error;
      }
      if (timedOut) {
        throw new DragonBoatApiError("REQUEST_TIMEOUT", "The training service took too long to respond.", {
          cause: error,
          retryable: true,
          requestId
        });
      }
      if (signal?.aborted) {
        throw new DragonBoatApiError("REQUEST_ABORTED", "The request was cancelled.", {
          cause: error,
          retryable: true,
          requestId
        });
      }
      throw new DragonBoatApiError("NETWORK_ERROR", "The training service could not be reached.", {
        cause: error,
        retryable: true,
        requestId
      });
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

export function createRequestId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID().replaceAll("-", "_");
  }

  const random = Math.random().toString(36).slice(2);
  return `req_${Date.now().toString(36)}_${random}`;
}

export function normalizeApiUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new DragonBoatApiError("API_NOT_CONFIGURED", "The training service URL is not configured.");
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch (error) {
    throw new DragonBoatApiError("INVALID_API_URL", "The training service URL is invalid.", { cause: error });
  }

  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new DragonBoatApiError("INVALID_API_URL", "The training service URL must use HTTPS.");
  }

  return url.toString();
}

function assertEnvelope(envelope, requestId) {
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(envelope) || typeof envelope.ok !== "boolean" || !isObject(envelope.meta)) {
    throw new DragonBoatApiError("INVALID_RESPONSE", "The training service response is incomplete.", { requestId, retryable: true });
  }
  if (envelope.meta.contract_version !== DRAGON_BOAT_CONTRACT_VERSION) {
    throw new DragonBoatApiError(
      "CONTRACT_MISMATCH",
      "The website and training service versions do not match.",
      { requestId, retryable: true }
    );
  }
  if (envelope.meta.request_id !== requestId || typeof envelope.meta.server_time !== "string" ||
      !Number.isFinite(Date.parse(envelope.meta.server_time)) ||
      (envelope.ok ? !isObject(envelope.data) || Object.hasOwn(envelope, "error") :
        !isObject(envelope.error) || typeof envelope.error.code !== "string" || !envelope.error.code ||
        typeof envelope.error.message !== "string" || !envelope.error.message ||
        typeof envelope.error.retryable !== "boolean" || Object.hasOwn(envelope, "data"))) {
    throw new DragonBoatApiError("INVALID_RESPONSE", "The training service response is incomplete or belongs to another request.", {
      requestId, retryable: true
    });
  }
}
