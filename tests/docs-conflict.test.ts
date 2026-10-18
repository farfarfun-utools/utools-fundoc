import { beforeEach, expect, it } from 'vitest';
import { useDocs } from '../src/composables/useDocs';
import { loadBody, saveBody } from '../src/lib/storage';
import { resetStorage } from './setup';

const docs = useDocs();

beforeEach(() => {
  resetStorage();
  docs.state.activeNodeId = 'local';
  docs.state.markdown = '本机草稿';
  docs.state.dirty = true;
  docs.state.conflict = { remoteMarkdown: '远端版本' };
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
