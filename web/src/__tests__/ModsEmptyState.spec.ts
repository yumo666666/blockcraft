import { flushPromises, shallowMount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api.ts', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
    downloadArchive: vi.fn(),
  },
  subscribe: vi.fn(() => () => undefined),
}));

vi.mock('../lib/browserSnapshot.ts', () => ({
  readBrowserSnapshot: vi.fn(() => null),
  writeBrowserSnapshot: vi.fn(),
  clearBrowserSnapshots: vi.fn(),
}));

vi.mock('../lib/toast.ts', () => ({ toast: vi.fn(), toastError: vi.fn() }));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { api } from '../lib/api.ts';
import Mods from '../pages/Mods.vue';

describe('MOD 页空状态', () => {
  afterEach(() => vi.clearAllMocks());

  it('搜索无结果时说明没有匹配项，清除筛选后仍区分空目录', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.includes('/mods?')) {
        return { total: 0, page: 1, size: 24, pages: 1, items: [], dir: '/world/server/mods' } as never;
      }
      return { instance: { id: 'world', name: '测试世界', status: 'stopped' } } as never;
    });

    const wrapper = shallowMount(Mods, { props: { id: 'world' } });
    await flushPromises();

    expect(wrapper.text()).toContain('mods 目录还是空的');
    expect(wrapper.text()).toContain('导入第一个 MOD');

    const search = wrapper.get('input[placeholder="名称 / 文件名 / modId / 描述"]');
    await search.setValue('missing-mod');
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    await flushPromises();

    expect(wrapper.text()).toContain('没有找到与“missing-mod”匹配的 MOD');
    expect(wrapper.text()).toContain('当前结果 0 个 MOD');
    expect(wrapper.text()).toContain('清除筛选');
    expect(wrapper.text()).not.toContain('mods 目录还是空的');
    expect(wrapper.text()).not.toContain('导入第一个 MOD');

    const clearButton = wrapper.findAll('button').find((button) => button.text().includes('清除筛选'));
    expect(clearButton).toBeDefined();
    await clearButton!.trigger('click');
    await flushPromises();

    expect((search.element as HTMLInputElement).value).toBe('');
    expect(wrapper.text()).toContain('mods 目录还是空的');

    wrapper.unmount();
  });
});
