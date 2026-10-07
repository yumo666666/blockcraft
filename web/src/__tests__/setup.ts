/**
 * 渲染测试的公共准备。
 * 页面里的请求是相对路径 /api/...，测试环境的 origin 被设成面板自己，
 * 于是走的是**真实运行中的面板**——验证的是真实数据，而不是我手写的假 fixture。
 */
const originalFetch = globalThis.fetch;

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers ?? {});
  // 服务端要求写操作带这个标记，统一补上
  headers.set('X-Blockcraft', '1');
  // happy-dom 会按 URL 缓存 GET 响应：测试里改了数据再读会拿到旧值，
  // 表现为「同样的用例有时过有时不过」。一律禁用缓存。
  headers.set('cache-control', 'no-cache');
  return originalFetch(input, { ...init, headers, cache: 'no-store' });
}) as typeof fetch;

/** happy-dom 没有 EventSource，用空实现占位（SSE 逻辑在真实浏览器里才跑） */
class FakeEventSource {
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    setTimeout(() => this.onerror?.(new Error('test: SSE disabled')), 5);
  }
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

export const TEST_BASE = 'http://127.0.0.1:8081';
