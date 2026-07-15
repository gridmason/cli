/**
 * The HTTP transport `publish`/`appeal` use to talk to a registry's Publish +
 * review APIs. It is a thin, injected seam (default {@link fetchTransport}) so the
 * whole publish flow is drivable in a test against an in-process fake registry —
 * or a real one — with no global stubbing.
 *
 * Only JSON request/response bodies are spoken (the Publish API is JSON+base64,
 * registry docs/api/publish.md). Responses are read under a hard byte cap so a
 * misbehaving endpoint cannot stream unbounded bytes before parse; a non-JSON body
 * surfaces as a `null` `body` the caller maps to a transport error, never a throw
 * mid-parse.
 */

/** Hard cap on a response body (bytes). Publish/review responses are small records. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** A parsed HTTP response: the status and the JSON body (`null` if the body was not JSON). */
export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Per-request options: the bearer token and an optional JSON body. */
export interface RequestOptions {
  /** Bearer OIDC token for `Authorization` (the Publish API requires it). */
  readonly token?: string;
  /** A JSON-serializable request body (for `POST`). */
  readonly body?: unknown;
}

/** Issues one HTTP request and returns the parsed response. Injected for testability. */
export interface Transport {
  request(method: 'GET' | 'POST', url: string, options?: RequestOptions): Promise<HttpResponse>;
}

/** Only `http(s)` targets are allowed — a registry URL is never `file:`/`data:`/etc. */
function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a valid registry URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported registry URL scheme "${parsed.protocol}" (only http/https)`);
  }
}

/**
 * The real transport over `fetch`. Sends/receives JSON, attaches the bearer
 * token, refuses redirects (a registry call goes exactly to the URL named), and
 * reads the body under {@link MAX_RESPONSE_BYTES}. A body that is absent or not
 * JSON comes back as `{ status, body: null }`.
 */
export function fetchTransport(): Transport {
  return {
    async request(method, url, options = {}) {
      assertHttpUrl(url);
      const headers: Record<string, string> = { accept: 'application/json' };
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      const init: RequestInit = { method, headers, redirect: 'error' };
      if (options.body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(options.body);
      }

      const response = await fetch(url, init);
      const declared = response.headers.get('content-length');
      if (declared !== null) {
        const length = Number(declared);
        if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
          throw new Error(`registry response exceeds the ${MAX_RESPONSE_BYTES}-byte cap (declared ${length})`);
        }
      }
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new Error(`registry response exceeds the ${MAX_RESPONSE_BYTES}-byte cap`);
      }
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { status: response.status, body };
    },
  };
}
