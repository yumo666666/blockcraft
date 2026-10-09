/** 统一的接口客户端：带会话、带 CSRF 标记、带结构化错误 */
export interface ApiErrorBody {
  error: { code: string; message: string; message_en?: string; detail?: unknown };
}

export class ApiError extends Error {
  code: string;
  detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { contentType?: string; raw?: boolean; filename?: string } = {},
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      'X-Blockcraft': '1',
      ...(body !== undefined ? { 'Content-Type': opts.contentType ?? 'application/json' } : {}),
      ...(opts.filename ? { 'X-Blockcraft-Filename': encodeURIComponent(opts.filename) } : {}),
    },
    body: body === undefined ? undefined : opts.raw ? body as BodyInit : JSON.stringify(body),
  });
  if (res.status === 401) {
    onUnauthorized?.();
    throw new ApiError('UNAUTHORIZED', '登录已过期，请重新登录');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody)?.error;
    const message = err?.message_en ? `${err.message} / ${err.message_en}` : err?.message;
    throw new ApiError(err?.code ?? 'INTERNAL', message ?? `请求失败（HTTP ${res.status}）`, err?.detail);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  uploadFile: <T>(path: string, file: File) =>
    request<T>('POST', path, file, { contentType: 'application/octet-stream', raw: true, filename: file.name }),
  login: (token: string) => request<{ ok: boolean }>('POST', '/api/login', { token }),
  logout: () => request<{ ok: boolean }>('POST', '/api/logout'),
};

/** SSE 订阅，返回取消函数；断线自动重连 */
export function subscribe<T>(path: string, onData: (data: T) => void, opts: { onError?: (e: unknown) => void } = {}): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retry = 1000;
  const open = () => {
    if (closed) return;
    es = new EventSource(path);
    es.onmessage = (ev) => {
      retry = 1000;
      try {
        onData(JSON.parse(ev.data) as T);
      } catch {
        /* ignore */
      }
    };
    es.onerror = (e) => {
      opts.onError?.(e);
      es?.close();
      if (closed) return;
      setTimeout(open, retry);
      retry = Math.min(retry * 1.6, 15000);
    };
  };
  open();
  return () => {
    closed = true;
    es?.close();
  };
}
