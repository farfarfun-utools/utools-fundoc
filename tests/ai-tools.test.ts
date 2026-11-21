import { expect, it } from 'vitest';
import { useDocs } from '../src/composables/useDocs';
import { host } from '../src/lib/host';
import { loadBody, saveBody, saveMeta } from '../src/lib/storage';
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

it('AI 新建文档沿用保存流程，不切走当前文档', async () => {
  resetStorage();
  saveMeta({ _id: 'meta@folder', nodeId: 'folder', type: 'dir', name: '资料', parentId: null,
    order: 1, createdAt: 1, updatedAt: 1 });
  let create: ((params: Record<string, unknown>) => Promise<unknown>) | undefined;
  let listFolders: ((params: Record<string, unknown>) => unknown) | undefined;
  host.registerTool = (name, handler) => {
    if (name === 'create_document') create = handler;
    if (name === 'list_document_folders') listFolders = handler;
  };
  const docs = useDocs();
  await docs.initialize();
  expect(listFolders!({})).toEqual({ folders: [{ id: 'folder', path: '资料' }] });
  const previousId = docs.state.activeNodeId;
  const created = await create!({ title: '  新笔记  ', markdown: '# 新笔记', parentId: 'folder' }) as { id: string; title: string; parentId: string };
  expect(created).toMatchObject({ title: '新笔记', parentId: 'folder' });
  expect(await loadBody(created.id)).toBe('# 新笔记');
  expect(docs.state.metas.find(meta => meta.nodeId === created.id)).toMatchObject({ name: '新笔记', parentId: 'folder' });
  expect(docs.state.activeNodeId).toBe(previousId);
  await expect(create!({ title: '无效', parentId: 'missing' })).rejects.toThrow('目标目录不存在');
  await expect(create!({ title: ' ' })).rejects.toThrow('标题');
  await expect(create!({ title: '过大', markdown: 'x'.repeat(1024 * 1024 + 1) })).rejects.toThrow('文档未能保存');
});

it('AI 工具参数为 null 或 undefined 时安全报错，且搜索缓存正文读取避免重复查库', async () => {
  resetStorage();
  saveMeta({ _id: 'meta@d1', nodeId: 'd1', type: 'doc', name: '第一篇', parentId: null,
    order: 1, createdAt: 1, updatedAt: 1 });
  saveMeta({ _id: 'meta@d2', nodeId: 'd2', type: 'doc', name: '第二篇', parentId: null,
    order: 2, createdAt: 1, updatedAt: 1 });
  saveBody('d1', '正文一');
  saveBody('d2', '包含目标关键词的正文内容');

  let search: ((params: unknown) => unknown) | undefined;
  let create: ((params: unknown) => Promise<unknown>) | undefined;
  host.registerTool = (name, handler) => {
    if (name === 'search_documents') search = handler as (params: unknown) => unknown;
    if (name === 'create_document') create = handler as (params: unknown) => Promise<unknown>;
  };

  const docs = useDocs();
  await docs.initialize();
  await docs.openNode('d1');

  expect(() => search!(null)).toThrow('搜索词');
  expect(() => search!(undefined)).toThrow('搜索词');
  await expect(create!(null)).rejects.toThrow('标题');
  await expect(create!(undefined)).rejects.toThrow('标题');

  const originalGet = host.db.get;
  let d2Reads = 0;
  host.db.get = (id: string) => {
    if (id === 'body@d2') d2Reads += 1;
    return originalGet(id);
  };
  try {
    const found = search!({ query: '目标关键词' }) as { results: Array<{ nodeId: string }> };
    expect(found.results.map((item) => item.nodeId)).toEqual(['d2']);
    expect(d2Reads).toBe(1);
  } finally {
    host.db.get = originalGet;
  }
});
