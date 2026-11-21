import { beforeEach, expect, it } from 'vitest';
import { useDocs } from '../src/composables/useDocs';
import { assetDocId, storeAsset } from '../src/lib/asset';
import { host } from '../src/lib/host';
import { loadBody, MAX_DOC_BYTES, saveBody } from '../src/lib/storage';
import { resetStorage } from './setup';

const docs = useDocs();

beforeEach(() => {
  resetStorage();
  docs.state.metas = [{
    _id: 'meta@local', nodeId: 'local', type: 'doc', parentId: null, name: '笔记',
    order: 1, createdAt: 1, updatedAt: 1,
  }];
  docs.state.activeNodeId = 'local';
  docs.state.markdown = '本机草稿';
  docs.state.dirty = true;
  docs.state.conflict = { remoteMarkdown: '远端版本' };
});

it('副本保存失败时保留本机草稿与冲突，缩短正文后可以重试', async () => {
  docs.state.markdown = 'a'.repeat(MAX_DOC_BYTES);
  await docs.resolveConflictKeepBoth();

  expect(docs.state.markdown.length).toBe(MAX_DOC_BYTES);
  expect(docs.state.conflict?.remoteMarkdown).toBe('远端版本');
  expect(docs.state.dirty).toBe(true);
  expect(docs.state.notice).toContain('上限');

  docs.setMarkdown('缩短后的草稿');
  await docs.resolveConflictKeepBoth();
  const copy = docs.state.metas.find((meta) => meta.nodeId !== 'local')!;
  expect(await loadBody(copy.nodeId)).toBe('缩短后的草稿');
  expect(docs.state.markdown).toBe('远端版本');
  expect(docs.state.conflict).toBeNull();
});

it('删除冲突副本时保留原文引用的图片，回收副本独有的图片', async () => {
  const shared = storeAsset(new Uint8Array([1]), 'image/png');
  const local = storeAsset(new Uint8Array([2]), 'image/png');
  const remote = `![图](fundoc-asset://${shared})`;
  saveBody('local', remote);
  docs.state.markdown = `${remote}\n![本地图](fundoc-asset://${local})`;
  docs.state.conflict = { remoteMarkdown: remote };
  await docs.resolveConflictKeepBoth();
  const copy = docs.state.metas.find((meta) => meta.nodeId !== 'local')!;

  await docs.deleteNode(copy.nodeId);

  expect(host.db.getAttachment(assetDocId(shared))).toEqual(new Uint8Array([1]));
  expect(host.db.getAttachment(assetDocId(local))).toBeNull();
});

it('清理图片时也保护冲突中尚未写入正文的图片', async () => {
  const draftImage = storeAsset(new Uint8Array([1]), 'image/png');
  storeAsset(new Uint8Array([2]), 'image/png');
  docs.state.markdown = `![本地图](fundoc-asset://${draftImage})`;

  expect(await docs.cleanOrphanAssets()).toBe(1);
  expect(host.db.getAttachment(assetDocId(draftImage))).toEqual(new Uint8Array([1]));
  expect(docs.state.dirty).toBe(true);
});

it('冲突未解决时不会自动覆盖远端或切走本机草稿', async () => {
  saveBody('local', '远端版本');
  saveBody('other', '另一篇');

  docs.flush();
  await docs.openNode('other');

  expect(await loadBody('local')).toBe('远端版本');
  expect(docs.state.activeNodeId).toBe('local');
  expect(docs.state.markdown).toBe('本机草稿');
  expect(docs.state.conflict?.remoteMarkdown).toBe('远端版本');
});

it('删除当前正在编辑的文档时先取消自动保存定时器，避免把已删文档复活', async () => {
  docs.state.conflict = null;
  docs.state.settings.autoSaveDelay = 20;
  saveBody('local', '初始内容');
  docs.setMarkdown('刚改过但马上要删的内容');

  await docs.deleteNode('local');
  await new Promise((resolve) => setTimeout(resolve, 60));

  expect(host.db.get('meta@local')).toBeNull();
  expect(host.db.get('body@local')).toBeNull();
});

it('新建文档写入元数据失败时会清理已写入的孤立正文', async () => {
  const originalPut = host.db.put;
  host.db.put = (doc) => {
    if (doc._id.startsWith('meta@')) return { id: doc._id, ok: false, error: true, message: 'meta write failed' };
    return originalPut(doc);
  };
  try {
    const id = await docs.createNode('doc', null, { name: '孤立测试', markdown: '孤立正文', open: false });
    expect(id).toBeNull();
    expect(host.db.allDocs('body@').some((doc) => doc.markdown === '孤立正文')).toBe(false);
  } finally {
    host.db.put = originalPut;
  }
});
