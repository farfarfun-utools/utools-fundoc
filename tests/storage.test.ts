import { beforeEach, describe, expect, it } from 'vitest';
import { host } from '../src/lib/host';
import {
  MAX_DOC_BYTES,
  bodyId,
  byteSize,
  getMeta,
  loadAllMeta,
  loadBody,
  loadSettings,
  metaId,
  nodeIdFromBodyId,
  nodeIdFromMetaId,
  removeBody,
  removeMeta,
  saveBody,
  saveMeta,
  saveSettings,
} from '../src/lib/storage';
import { DEFAULT_SETTINGS, type NodeMeta } from '../src/lib/types';
import { resetStorage } from './setup';

function meta(nodeId: string, options: Partial<NodeMeta> = {}): NodeMeta {
  return {
    _id: metaId(nodeId),
    nodeId,
    type: 'doc',
    name: nodeId,
    parentId: null,
    order: 1000,
    createdAt: 0,
    updatedAt: 0,
    ...options,
  };
}

beforeEach(resetStorage);

describe('ID 拼装与反解', () => {
  it('meta@ 来回转换对称', () => {
    expect(nodeIdFromMetaId(metaId('abc'))).toBe('abc');
  });

  it('body@ 来回转换对称', () => {
    expect(nodeIdFromBodyId(bodyId('abc'))).toBe('abc');
  });

  // onDbPull 会把三种命名空间的文档混在一个数组里送来，靠这两个函数分流。
  it('两个命名空间互不认领', () => {
    expect(nodeIdFromMetaId(bodyId('abc'))).toBeNull();
    expect(nodeIdFromBodyId(metaId('abc'))).toBeNull();
    expect(nodeIdFromMetaId('asset@abc')).toBeNull();
  });
});

describe('byteSize', () => {
  it('量的是 UTF-8 字节，不是字符数', () => {
    // JSON.stringify 加上两个引号，汉字各占 3 字节。
    expect(byteSize('中')).toBe(5);
    expect(byteSize('ab')).toBe(4);
  });
});

describe('元数据读写', () => {
  it('存完能取回，并带上新 _rev', () => {
    const saved = saveMeta(meta('a', { name: '线性代数' }));
    expect(saved._rev).toBeTruthy();
    expect(getMeta('a')?.name).toBe('线性代数');
  });

  it('不存在的节点返回 null', () => {
    expect(getMeta('ghost')).toBeNull();
  });

  it('loadAllMeta 只认有 nodeId 的文档', async () => {
    saveMeta(meta('a'));
    // 混进一条不是我们写的 meta@ 文档，模拟其他版本留下的脏数据。
    host.db.put({ _id: metaId('junk'), whatever: true });
    const all = await loadAllMeta();
    expect(all.map((item) => item.nodeId)).toEqual(['a']);
  });

  it('loadAllMeta 不会把 body@ 也捞进来', async () => {
    saveMeta(meta('a'));
    saveBody('a', '正文');
    expect((await loadAllMeta()).length).toBe(1);
  });

  // _rev 过期意味着别处写过同一条（另一台设备同步进来）。必须重试，
  // 不能把失败咽下去 —— 咽下去用户的这次改动就凭空消失了。
  it('_rev 过期时自动取回最新版本重试', () => {
    const first = saveMeta(meta('a', { name: '第一版' }));
    // 模拟另一条路径先写了一次，让手里的 _rev 变旧。
    saveMeta({ ...first, name: '别处写的' });
    // 仍然拿着旧 _rev 写入，应当成功而不是抛错。
    expect(() => saveMeta({ ...first, name: '我的改动' })).not.toThrow();
    expect(getMeta('a')?.name).toBe('我的改动');
  });

  it('removeMeta 删得掉，删不存在的也不报错', () => {
    saveMeta(meta('a'));
    removeMeta('a');
    expect(getMeta('a')).toBeNull();
    expect(() => removeMeta('a')).not.toThrow();
  });
});

describe('正文读写', () => {
  it('存完能取回', async () => {
    saveBody('a', '# 标题');
    expect(await loadBody('a')).toBe('# 标题');
  });

  it('没有正文记录时返回空串，而不是 undefined', async () => {
    expect(await loadBody('ghost')).toBe('');
  });

  it('覆盖写不会撞 _rev 冲突', () => {
    saveBody('a', '第一版');
    expect(() => saveBody('a', '第二版')).not.toThrow();
  });

  it('返回字节数，供写进 meta.bodySize', () => {
    const bytes = saveBody('a', '# 标题');
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(MAX_DOC_BYTES);
  });

  // put 失败在 uTools 上是静默的 —— 真超了内容会凭空消失。
  // 所以必须在进 put 之前自己拦下来，并给用户一句看得懂的话。
  it('超出单条上限时抛错，且不写进数据库', () => {
    expect(() => saveBody('a', 'x'.repeat(MAX_DOC_BYTES + 1))).toThrow(/1MB 上限/);
    expect(host.db.get(bodyId('a'))).toBeNull();
  });

  it('上限留了余量，不是顶着 1MB 判', () => {
    expect(MAX_DOC_BYTES).toBeLessThan(1024 * 1024);
  });

  it('removeBody 删得掉，删不存在的也不报错', async () => {
    saveBody('a', '正文');
    removeBody('a');
    expect(await loadBody('a')).toBe('');
    expect(() => removeBody('a')).not.toThrow();
  });
});

describe('设置', () => {
  it('没存过时给出厂设置', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('存完能取回', () => {
    saveSettings({ ...DEFAULT_SETTINGS, mode: 'sv', autoSaveDelay: 1500 });
    expect(loadSettings().mode).toBe('sv');
    expect(loadSettings().autoSaveDelay).toBe(1500);
  });

  // 老版本存下来的设置缺字段是常态（新增了开关）。缺的必须用默认值补齐，
  // 否则界面上会出现 undefined 绑到 select 上的空白选项。
  it('缺字段用默认值补齐', () => {
    host.dbStorage.setItem('fundoc.settings', { mode: 'wysiwyg' });
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, mode: 'wysiwyg' });
  });

  it('存成了不是对象的东西时退回出厂设置', () => {
    host.dbStorage.setItem('fundoc.settings', 'broken');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
