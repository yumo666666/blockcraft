import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';

const subscription = vi.hoisted(() => ({ onData: null as null | ((data: unknown) => void) }));

vi.mock('../lib/api.ts', () => ({
  subscribe: (_path: string, onData: (data: unknown) => void) => {
    subscription.onData = onData;
    return () => {
      subscription.onData = null;
    };
  },
}));

import JobProgress from '../components/JobProgress.vue';

function job(lineCount: number) {
  return {
    id: 'create-test',
    kind: 'create',
    title: '创建测试世界',
    instanceId: 'test-world',
    status: 'running',
    stages: [],
    lines: Array.from({ length: lineCount }, (_, index) => `创建日志 ${index + 1}`),
    progress: 20,
    error: null,
    startedAt: Date.now(),
    endedAt: null,
  };
}

function setScrollMetrics(el: HTMLElement, scrollHeight: number, clientHeight = 100): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
}

describe('创建任务日志跟随', () => {
  it('初始跟随最新日志；用户上翻暂停，回到底部后恢复', async () => {
    const wrapper = mount(JobProgress, {
      props: { open: true, jobId: 'create-test' },
      global: {
        stubs: {
          Modal: { template: '<div><slot /><slot name="footer" /></div>' },
        },
      },
    });
    await nextTick();

    subscription.onData?.(job(4));
    await flushPromises();
    await nextTick();
    const log = wrapper.get('[data-testid="job-log"]').element as HTMLElement;
    setScrollMetrics(log, 400);
    subscription.onData?.(job(4));
    await flushPromises();
    await nextTick();
    expect(log.scrollTop).toBe(400);

    log.scrollTop = 0;
    log.dispatchEvent(new Event('scroll'));
    setScrollMetrics(log, 500);
    subscription.onData?.(job(5));
    await flushPromises();
    await nextTick();
    expect(log.scrollTop).toBe(0);

    log.scrollTop = 400;
    log.dispatchEvent(new Event('scroll'));
    setScrollMetrics(log, 600);
    subscription.onData?.(job(6));
    await flushPromises();
    await nextTick();
    expect(log.scrollTop).toBe(600);

    wrapper.unmount();
  });
});
