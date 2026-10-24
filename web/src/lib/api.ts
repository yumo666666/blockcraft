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

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
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
  uploadFile: <T>(path: string, file: File, onProgress?: (progress: UploadProgress) => void): Promise<T> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      xhr.setRequestHeader('X-Blockcraft', '1');
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Blockcraft-Filename', encodeURIComponent(file.name));
      xhr.upload.onprogress = (event) => {
        const total = event.lengthComputable ? event.total : file.size;
        const loaded = Math.min(event.loaded, total || event.loaded);
        onProgress?.({ loaded, total, percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0 });
      };
      xhr.onload = () => {
        if (xhr.status === 401) {
          onUnauthorized?.();
          reject(new ApiError('UNAUTHORIZED', '登录已过期，请重新登录'));
          return;
        }
        let data: unknown = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          data = { raw: xhr.responseText };
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          const err = (data as ApiErrorBody | null)?.error;
          const message = err?.message_en ? `${err.message} / ${err.message_en}` : err?.message;
          reject(new ApiError(err?.code ?? 'INTERNAL', message ?? `请求失败（HTTP ${xhr.status}）`, err?.detail));
          return;
        }
        resolve(data as T);
      };
      xhr.onerror = () => reject(new TypeError('网络连接中断或面板暂时不可用'));
      xhr.onabort = () => reject(new ApiError('ABORTED', '上传已取消'));
      xhr.send(file);
    }),
  downloadFile: async (path: string, filename: string): Promise<void> => {
    const res = await fetch(path, { method: 'HEAD', headers: { 'X-Blockcraft': '1' }, cache: 'no-store' });
    if (res.status === 401) {
      onUnauthorized?.();
      throw new ApiError('UNAUTHORIZED', '登录已过期，请重新登录');
    }
    if (!res.ok) {
      const text = await res.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      const err = (data as ApiErrorBody | null)?.error;
      const message = err?.message ?? (res.status === 409 ? '请先完全停止世界，再下载完整目录' : `下载失败（HTTP ${res.status}）`);
      throw new ApiError(err?.code ?? (res.status === 409 ? 'CONFLICT' : 'INTERNAL'), message, err?.detail);
    }
    const link = document.createElement('a');
    link.href = path;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
  },
  downloadArchive: async (path: string, paths: string[]): Promise<void> => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'X-Blockcraft': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
      cache: 'no-store',
    });
    if (res.status === 401) {
      onUnauthorized?.();
      throw new ApiError('UNAUTHORIZED', '登录已过期，请重新登录');
    }
    if (!res.ok) {
      const text = await res.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      const err = (data as ApiErrorBody | null)?.error;
      const message = err?.message_en ? `${err.message} / ${err.message_en}` : err?.message;
      throw new ApiError(err?.code ?? 'INTERNAL', message ?? `打包下载失败（HTTP ${res.status}）`, err?.detail);
    }
    const blob = await res.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = decodeURIComponent(res.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ?? 'project-files.zip');
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  },
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
