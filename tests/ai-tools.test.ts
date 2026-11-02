import { expect, it } from 'vitest';
import { useDocs } from '../src/composables/useDocs';
import { host } from '../src/lib/host';
import { saveBody, saveMeta } from '../src/lib/storage';
import { resetStorage } from './setup';

it('AI 文档搜索只返回命中片段，且能搜索尚未保存的当前正文', async () => {
  resetStorage();
  saveMeta({ _id: 'meta@test', nodeId: 'test', type: 'doc', name: '测试文档', parentId: null,
    order: 1, createdAt: 1, updatedAt: 1 });
  saveBody('test', '原来的正文');

  let search: ((params: Record<string, unknown>) => unknown) | undefined;
  host.registerTool = (name, handler) => {
    if (name === 'search_documents') search = handler;
  };
  const docs = useDocs();
  await docs.initialize();
  docs.state.markdown = '这里有 AI 搜索需要找到的新内容';

  expect(search).toBeDefined();
  const result = search!({ query: '新内容' }) as { results: Array<{ snippet: string }> };
  expect(result.results).toHaveLength(1);
  expect(result.results[0].snippet).toContain('新内容');
  expect(JSON.stringify(result)).not.toContain('原来的正文');
  expect(() => search!({ query: ' ' })).toThrow('搜索词');
});
