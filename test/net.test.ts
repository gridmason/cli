import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTextCapped, MAX_FETCH_BYTES } from '../src/net.js';

/** A one-shot ReadableStream-like body that yields `text` once, with a spyable `cancel`. */
function body(text: string, onCancel?: () => void) {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    getReader() {
      return {
        read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })),
        cancel: async () => onCancel?.(),
      };
    },
  };
}

/** Build a minimal Response-like object matching exactly what fetchTextCapped reads. */
function response(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: ReturnType<typeof body>;
  text?: () => Promise<string>;
}) {
  const headers = opts.headers ?? {};
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? 'OK',
    url: opts.url ?? 'https://registry.example/doc',
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: opts.body,
    text: opts.text ?? (async () => ''),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchTextCapped — scheme enforcement', () => {
  it('rejects a non-http(s) scheme before making any request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(fetchTextCapped('file:///etc/passwd')).rejects.toThrow(/scheme/);
    await expect(fetchTextCapped('data:text/plain,hi')).rejects.toThrow(/scheme/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed URL', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(fetchTextCapped('not a url')).rejects.toThrow(/valid URL/);
  });
});

describe('fetchTextCapped — redirect policy', () => {
  it('requests with redirect: "error"', async () => {
    const fetchSpy = vi.fn(async () => response({ body: body('{"ok":true}') }));
    vi.stubGlobal('fetch', fetchSpy);
    await fetchTextCapped('https://registry.example/doc');
    expect(fetchSpy).toHaveBeenCalledWith('https://registry.example/doc', { redirect: 'error' });
  });

  it('propagates the fetch rejection a redirect triggers under redirect: "error"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('unexpected redirect');
    }));
    await expect(fetchTextCapped('https://registry.example/doc')).rejects.toThrow(/redirect/);
  });
});

describe('fetchTextCapped — size cap', () => {
  it('refuses up front when Content-Length exceeds the cap (body never read)', async () => {
    const onCancel = vi.fn();
    const fetchSpy = vi.fn(async () =>
      response({ headers: { 'content-length': String(MAX_FETCH_BYTES + 1) }, body: body('small', onCancel) }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    await expect(fetchTextCapped('https://registry.example/doc')).rejects.toThrow(/exceeds the .* cap/);
  });

  it('refuses when a streamed body (no Content-Length) passes the cap, cancelling the stream', async () => {
    const onCancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => response({ body: body('A'.repeat(100), onCancel) })));
    await expect(fetchTextCapped('https://registry.example/doc', 8)).rejects.toThrow(/exceeds the 8-byte cap/);
    expect(onCancel).toHaveBeenCalled();
  });

  it('returns the body when within the cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ body: body('{"release":1}') })));
    await expect(fetchTextCapped('https://registry.example/doc')).resolves.toBe('{"release":1}');
  });

  it('caps a bodyless response via the text() fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ text: async () => 'X'.repeat(100) })));
    await expect(fetchTextCapped('https://registry.example/doc', 8)).rejects.toThrow(/exceeds the 8-byte cap/);
  });
});

describe('fetchTextCapped — transport failures', () => {
  it('throws on a non-2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ ok: false, status: 404, statusText: 'Not Found' })));
    await expect(fetchTextCapped('https://registry.example/doc')).rejects.toThrow(/HTTP 404 Not Found/);
  });

  it('rejects when the final (post-request) URL is not http(s)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ url: 'file:///etc/passwd', body: body('x') })));
    await expect(fetchTextCapped('https://registry.example/doc')).rejects.toThrow(/final URL scheme/);
  });
});
