/**
 * Hardened text fetch for **remote trust material** — the online `verify`
 * artifact and a `bundle export --release <url>` document. Both read an
 * attacker-influenceable URL and hand the body to the protocol *before* it is
 * validated, so the raw `fetch` is wrapped to bound the three things a hostile or
 * misbehaving endpoint controls:
 *
 * - **Body size** — the response is streamed under a hard byte cap
 *   ({@link MAX_FETCH_BYTES}). A declared `Content-Length` over the cap is refused
 *   up front, and the running total is enforced chunk-by-chunk so a chunked or
 *   absent length cannot stream unbounded bytes into memory before parsing.
 * - **Redirects** — `redirect: 'error'` refuses *any* redirect, so a URL cannot
 *   silently hop to an unvetted origin; the caller fetches exactly the URL it named.
 * - **Scheme** — only `http(s)` is accepted (no `file:`/`data:`/etc.), on both the
 *   requested URL and, defensively, the URL actually fetched.
 *
 * Trust-metadata documents (release + envelope + inclusion proof + trust root) are
 * small, so the cap is deliberately tight: it bounds abuse without constraining
 * legitimate use. Exported and documented so both fetch call sites share one
 * hardened path (docs/verify.md, docs/bundle.md).
 */

/** Hard cap on a fetched trust-document body (bytes). Trust metadata is small; this bounds a hostile endpoint. */
export const MAX_FETCH_BYTES = 16 * 1024 * 1024;

/** Reject anything that is not an `http(s)` URL before (and after) the request is made. */
function assertHttpUrl(url: string, context: 'requested' | 'final'): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported ${context} URL scheme "${parsed.protocol}" (only http/https)`);
  }
}

/**
 * Fetch `url` as UTF-8 text under a hard size cap, refusing redirects and
 * non-`http(s)` schemes. Throws (never returns oversized/partial data) on a
 * non-2xx status, a redirect, a bad scheme, a `Content-Length` over the cap, or a
 * body that streams past the cap. See the module doc for the threat model.
 */
export async function fetchTextCapped(url: string, maxBytes: number = MAX_FETCH_BYTES): Promise<string> {
  assertHttpUrl(url, 'requested');

  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  // `redirect: 'error'` means the final URL equals the request URL; re-check it defensively.
  if (typeof response.url === 'string' && response.url.length > 0) {
    assertHttpUrl(response.url, 'final');
  }

  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new Error(`response body exceeds the ${maxBytes}-byte cap (declared ${length})`);
    }
  }

  const body = response.body;
  if (!body) {
    // No stream available (e.g. an empty body): fall back, but still cap the size.
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`response body exceeds the ${maxBytes}-byte cap`);
    }
    return text;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response body exceeds the ${maxBytes}-byte cap`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}
