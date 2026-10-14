// preload.js 的测试。
//
// 这个文件在真机上跑在 Node 侧、由 uTools 注入全局 `utools`，所以它本来是整个项目里最难
// 验证的一块 —— 之前构建里只有一句 `node --check`，语法过了就算过。但主搜索框的直搜逻辑
// 恰恰全在这儿，而且「选中第二条却打开第一条」这类错，语法检查永远发现不了。
//
// 做法：读出 preload.js 的源码，塞进一个 CommonJS 外壳里执行，把 `utools`、`window`、
// `require` 都作为局部变量注入。
//
// 为什么不直接 require 它：本仓库 package.json 是 `"type": "module"`，Node 会把 .js 当
// ESM，require 直接报错。真机上这个文件是 Electron 以 CommonJS 加载的，不受我们
// package.json 影响，所以文件本身没问题 —— 要动的是加载方式，不是产物。
// （也不要去 utools/ 里放一个 package.json：uTools 1.x 的清单就叫 package.json，
// 往插件目录里放一个只有 `type` 字段的同名文件是在赌客户端怎么解析它。）
//
// 顺带的好处：每个用例都是全新的模块实例，正文缓存和 lastResults 不会互相串；
// 注入 require 还能精确模拟「search-core.cjs 加载失败」。
//
// 它需要构建产物 search-core.cjs，所以 `pnpm test` 会先跑 build:preload。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bridge } from '../src/lib/host';

const PRELOAD_PATH = fileURLToPath(new URL('../utools/preload.js', import.meta.url));
/** 用 preload.js 自己的位置建 require，`./search-core.cjs` 才能解析对。 */
const preloadRequire = createRequire(PRELOAD_PATH);
const PRELOAD_SOURCE = fs.readFileSync(PRELOAD_PATH, 'utf8');

type Doc = Record<string, unknown> & { _id: string };
type PushResult = { icon: string; text: string; title: string };
type PushCallback = (action: { payload: unknown }) => PushResult[];
type SelectCallback = (action: { option?: { text?: string } }) => boolean;

type Stub = {
  db: { allDocs: (prefix?: string) => Doc[]; get: (id: string) => Doc | null };
  dbStorage: {
    getItem: (key: string) => unknown;
    setItem: (key: string, value: unknown) => void;
    removeItem: (key: string) => void;
  };
  onMainPush: (push: PushCallback, select: SelectCallback) => void;
  shellShowItemInFolder: (target: string) => void;
};

/** 造一篇文档的 meta + body 两条记录。 */
function doc(
  nodeId: string,
  name: string,
  options: { parentId?: string | null; updatedAt?: number; keywords?: string[]; body?: string } = {},
): Doc[] {
  const docs: Doc[] = [
    {
      _id: `meta@${nodeId}`,
      nodeId,
      type: 'doc',
      name,
      parentId: options.parentId ?? null,
      order: 1000,
      updatedAt: options.updatedAt ?? 1,
      keywords: options.keywords ?? [],
      keywordEnabled: Boolean(options.keywords?.length),
    },
  ];
  if (options.body !== undefined) {
    docs.push({ _id: `body@${nodeId}`, nodeId, markdown: options.body, updatedAt: 1 });
  }
  return docs;
}

const dir = (nodeId: string, name: string, parentId: string | null = null): Doc => ({
  _id: `meta@${nodeId}`,
  nodeId,
  type: 'dir',
  name,
  parentId,
  order: 1000,
  updatedAt: 1,
});

let push: PushCallback;
let select: SelectCallback;
let bridge: Bridge;
let store: Map<string, Doc>;
let kv: Map<string, unknown>;
let getSpy: ReturnType<typeof vi.fn>;
let shown: string[];

/**
 * 在一个 CommonJS 外壳里执行 preload.js，拿到它挂出来的 `window.fundoc`。
 *
 * @param docs 数据库里预置的文档。
 * @param options `breakCore` 为真时让 `require('./search-core.cjs')` 抛错，模拟产物缺失。
 */
function loadPreload(docs: Doc[], options: { breakCore?: boolean } = {}): void {
  store = new Map(docs.map((item) => [item._id, item]));
  kv = new Map();
  shown = [];

  getSpy = vi.fn((id: string) => store.get(id) ?? null);
  const stub: Stub = {
    db: {
      allDocs: (prefix = '') => [...store.values()].filter((item) => item._id.startsWith(prefix)),
      get: getSpy as unknown as (id: string) => Doc | null,
    },
    dbStorage: {
      getItem: (key) => (kv.has(key) ? kv.get(key) : null),
      setItem: (key, value) => void kv.set(key, value),
      removeItem: (key) => void kv.delete(key),
    },
    onMainPush: (pushCallback, selectCallback) => {
      push = pushCallback;
      select = selectCallback;
    },
    shellShowItemInFolder: (target) => void shown.push(target),
  };

  const windowStub: { fundoc?: Bridge } = {};
  const injectedRequire = (id: string): unknown => {
    if (options.breakCore && id.includes('search-core')) throw new Error('模拟加载失败');
    return preloadRequire(id);
  };

  const factory = new Function(
    'require',
    'module',
    'exports',
    '__dirname',
    '__filename',
    'utools',
    'window',
    'console',
    PRELOAD_SOURCE,
  );
  const module = { exports: {} };
  factory(
    injectedRequire,
    module,
    module.exports,
    path.dirname(PRELOAD_PATH),
    PRELOAD_PATH,
    stub,
    windowStub,
    console,
  );

  bridge = windowStub.fundoc!;
}

describe('onMainPush 搜索', () => {
  beforeEach(() => {
    loadPreload([
      dir('math', '数学'),
      ...doc('linear', '线性代数', { parentId: 'math', updatedAt: 10 }),
      ...doc('note', '随笔', { keywords: ['矩阵'], updatedAt: 20 }),
      ...doc('deep', '无关标题', { body: '正文里提到了矩阵分解这件事', updatedAt: 30 }),
    ]);
  });

  it('空查询返回空数组', () => {
    expect(push({ payload: '' })).toEqual([]);
    expect(push({ payload: '   ' })).toEqual([]);
  });

  it('标题命中，title 里带完整路径', () => {
    const results = push({ payload: '线性代数' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ icon: 'logo.png', text: '线性代数' });
    // 路径要带上目录，否则同名文档没法区分。
    expect(results[0].title).toBe('FunDoc · 数学/线性代数');
  });

  it('关键词命中', () => {
    const texts = push({ payload: '矩阵' }).map((item) => item.text);
    expect(texts).toContain('随笔');
  });

  it('正文命中，title 里换成正文片段', () => {
    const hit = push({ payload: '矩阵分解' }).find((item) => item.text === '无关标题');
    expect(hit).toBeDefined();
    expect(hit!.title).toContain('矩阵分解');
    expect(hit!.title).not.toContain('FunDoc ·');
  });

  // 单字查询翻全库正文没有意义（几乎每篇都命中），代价却是把所有正文读一遍。
  it('单字查询不读正文', () => {
    push({ payload: '矩' });
    expect(getSpy.mock.calls.filter((call) => String(call[0]).startsWith('body@'))).toHaveLength(0);
  });

  it('两个字以上才读正文，且每篇只读一次', () => {
    push({ payload: '矩阵分解' });
    const first = getSpy.mock.calls.filter((call) => String(call[0]) === 'body@deep').length;
    expect(first).toBe(1);

    // 再搜一次应该全走缓存。
    push({ payload: '矩阵分解' });
    expect(getSpy.mock.calls.filter((call) => String(call[0]) === 'body@deep')).toHaveLength(1);
  });

  it('文档更新后正文缓存失效', () => {
    push({ payload: '矩阵分解' });
    const before = getSpy.mock.calls.filter((call) => String(call[0]) === 'body@deep').length;

    // 模拟另一台设备同步进来一次改动：meta.updatedAt 变了。
    const meta = store.get('meta@deep')!;
    store.set('meta@deep', { ...meta, updatedAt: 999 });
    store.set('body@deep', { _id: 'body@deep', nodeId: 'deep', markdown: '矩阵分解改过了' });

    push({ payload: '矩阵分解' });
    expect(
      getSpy.mock.calls.filter((call) => String(call[0]) === 'body@deep').length,
    ).toBeGreaterThan(before);
  });
});

describe('onMainPush 选中', () => {
  it('选中后把 nodeId 暂存，界面侧取走并清除', () => {
    loadPreload([...doc('linear', '线性代数')]);
    push({ payload: '线性代数' });

    expect(select({ option: { text: '线性代数' } })).toBe(true);
    expect(bridge.takePendingOpen()).toBe('linear');
    // 取过一次就没了，否则下次进插件会莫名跳转。
    expect(bridge.takePendingOpen()).toBeNull();
  });

  it('没有选中项时什么都不写', () => {
    loadPreload([...doc('linear', '线性代数')]);
    expect(select({})).toBe(true);
    expect(bridge.takePendingOpen()).toBeNull();
  });

  // 这是 option.text 这条窄通道上最容易出的错：两篇同名时，用户点第二条却打开了第一条。
  it('同名文档显示成不同的 text，选中的就是看到的那篇', () => {
    loadPreload([
      dir('math', '数学'),
      dir('life', '生活'),
      ...doc('a', '周报', { parentId: 'math', updatedAt: 10 }),
      ...doc('b', '周报', { parentId: 'life', updatedAt: 20 }),
    ]);

    const results = push({ payload: '周报' });
    expect(results).toHaveLength(2);
    const texts = results.map((item) => item.text);
    expect(new Set(texts).size).toBe(2);

    // 逐条验证：每个 text 都要能定位回它自己那篇。
    const opened: string[] = [];
    for (const text of texts) {
      select({ option: { text } });
      opened.push(bridge.takePendingOpen()!);
    }
    expect(new Set(opened).size).toBe(2);
    expect(opened.sort()).toEqual(['a', 'b']);
  });

  it('同名同路径时继续编号，仍然各自可定位', () => {
    loadPreload([
      ...doc('a', '周报', { updatedAt: 10 }),
      ...doc('b', '周报', { updatedAt: 20 }),
      ...doc('c', '周报', { updatedAt: 30 }),
    ]);

    const texts = push({ payload: '周报' }).map((item) => item.text);
    expect(new Set(texts).size).toBe(3);

    const opened = texts.map((text) => {
      select({ option: { text } });
      return bridge.takePendingOpen();
    });
    expect(new Set(opened).size).toBe(3);
  });

  it('推送记录丢了也能按名字兜底', () => {
    loadPreload([...doc('a', '周报', { updatedAt: 10 }), ...doc('b', '周报', { updatedAt: 20 })]);

    // 不先 push，直接 select —— 模拟进程重启后的状态。
    select({ option: { text: '周报' } });
    // 同名取最近更新的那篇，和搜索结果的次级排序规则一致。
    expect(bridge.takePendingOpen()).toBe('b');
  });

  it('过期的待打开记录会被丢弃', () => {
    loadPreload([...doc('a', '周报')]);
    push({ payload: '周报' });
    select({ option: { text: '周报' } });

    // dbStorage 会跨设备同步，不加时效的话，另一台机器上几天前的一次搜索会在本机触发跳转。
    const pending = kv.get('fundoc.pending-open') as { nodeId: string; at: number };
    kv.set('fundoc.pending-open', { ...pending, at: Date.now() - 60_000 });
    expect(bridge.takePendingOpen()).toBeNull();
  });
});

describe('search-core 加载失败时', () => {
  it('退化成只按标题搜，window.fundoc 仍然可用', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadPreload([...doc('a', '线性代数', { keywords: ['矩阵'] })], { breakCore: true });
    // 必须留下日志，否则这种退化没人会发现。
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();

    // 标题还能搜到。
    expect(push({ payload: '线性' }).map((item) => item.text)).toEqual(['线性代数']);
    // 关键词搜不到了 —— 这正是「退化」的代价，但不该整个崩掉。
    expect(push({ payload: '矩阵' })).toEqual([]);
    // 读文件、导出这些毫不相干的能力必须还在：preload 抛异常会把 window.fundoc 一起带走。
    expect(typeof bridge.readTextFile).toBe('function');
    expect(typeof bridge.writeFiles).toBe('function');
    expect(typeof bridge.takePendingOpen).toBe('function');
  });
});

describe('window.fundoc', () => {
  let tempDir: string;

  beforeEach(() => {
    loadPreload([]);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fundoc-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('readTextFile 读得到内容，读不到返回 null', () => {
    const file = path.join(tempDir, 'a.md');
    fs.writeFileSync(file, '# 标题');
    expect(bridge.readTextFile(file)).toBe('# 标题');

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(bridge.readTextFile(path.join(tempDir, '不存在.md'))).toBeNull();
    errors.mockRestore();
  });

  it('writeFiles 建目录、写文本、写二进制', () => {
    const result = bridge.writeFiles(
      tempDir,
      '导出',
      ['assets', '数学'],
      [
        { path: '数学/线性代数.md', text: '# 线性代数' },
        { path: 'assets/img.png', base64: Buffer.from([1, 2, 3]).toString('base64') },
      ],
    );

    const root = path.join(tempDir, '导出');
    expect(result).toEqual({ ok: true, root });
    expect(fs.readFileSync(path.join(root, '数学/线性代数.md'), 'utf8')).toBe('# 线性代数');
    expect([...fs.readFileSync(path.join(root, 'assets/img.png'))]).toEqual([1, 2, 3]);
  });

  it('writeFiles 自动补齐中间目录', () => {
    bridge.writeFiles(tempDir, '导出', [], [{ path: 'a/b/c.md', text: '深' }]);
    expect(fs.readFileSync(path.join(tempDir, '导出/a/b/c.md'), 'utf8')).toBe('深');
  });

  // 路径是我们自己生成的，但写错地方不可逆 —— 这道防线不花钱。
  it('writeFiles 拒绝写到导出目录外面', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = bridge.writeFiles(tempDir, '导出', [], [{ path: '../逃出去.md', text: 'x' }]);
    errors.mockRestore();

    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(tempDir, '逃出去.md'))).toBe(false);
  });

  // rootName 来自文档名，洗过一遍；带分隔符时必须拦住，否则整个导出目录会落到用户没选的地方。
  it('writeFiles 拒绝带分隔符的根目录名', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = bridge.writeFiles(tempDir, `..${path.sep}外面`, [], []);
    errors.mockRestore();

    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(tempDir, '..', '外面'))).toBe(false);
  });

  it('writeFiles 失败时返回消息而不是抛出', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 用一个已存在的普通文件当父目录，mkdir 必然失败。
    const file = path.join(tempDir, 'file');
    fs.writeFileSync(file, 'x');
    const result = bridge.writeFiles(file, '导出', [], [{ path: 'a.md', text: 'x' }]);
    errors.mockRestore();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBeTruthy();
  });

  it('writeTextFile 写到绝对路径，父目录自动创建', () => {
    const target = path.join(tempDir, '新建/一篇.md');
    const result = bridge.writeTextFile(target, '# 一篇');

    expect(result).toEqual({ ok: true, root: target });
    expect(fs.readFileSync(target, 'utf8')).toBe('# 一篇');
  });

  it('writeTextFile 失败时返回消息而不是抛出', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // tempDir 本身是目录，往目录路径上写文件必然失败。
    const result = bridge.writeTextFile(tempDir, 'x');
    errors.mockRestore();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBeTruthy();
  });

  it('showInFolder 转交给 uTools', () => {
    bridge.showInFolder('/tmp/x');
    expect(shown).toEqual(['/tmp/x']);
  });
});
