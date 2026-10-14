import { beforeEach, describe, expect, it } from 'vitest';
import { ASSET_SCHEME } from '../src/lib/asset';
import {
  buildExportPlan,
  extensionFor,
  sanitizeSegment,
  uniqueSegment,
  type ExportIO,
} from '../src/lib/export';
import type { NodeMeta } from '../src/lib/types';

function node(nodeId: string, parentId: string | null, options: Partial<NodeMeta> = {}): NodeMeta {
  return {
    _id: `meta@${nodeId}`,
    nodeId,
    type: 'doc',
    name: nodeId,
    parentId,
    order: 1000,
    createdAt: 1,
    updatedAt: 1,
    keywordEnabled: false,
    keywords: [],
    ...options,
  };
}

const dir = (nodeId: string, parentId: string | null, options: Partial<NodeMeta> = {}) =>
  node(nodeId, parentId, { type: 'dir', ...options });

/** 只认得正文的 IO，附件一律当作不存在。 */
function io(bodies: Record<string, string> = {}): ExportIO {
  return {
    bodyOf: (nodeId) => bodies[nodeId] ?? '',
    assetOf: () => null,
  };
}

const textOf = (plan: ReturnType<typeof buildExportPlan>, path: string) => {
  const file = plan.files.find((item) => item.path === path);
  if (!file || file.kind !== 'text') throw new Error(`计划里没有文本文件 ${path}`);
  return file.text;
};

describe('extensionFor', () => {
  it('认得常见图片类型', () => {
    expect(extensionFor('image/png')).toBe('png');
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('image/svg+xml')).toBe('svg');
  });

  it('带参数和大写的 MIME 也能认', () => {
    expect(extensionFor('IMAGE/PNG; charset=binary')).toBe('png');
  });

  it('没列出来的 image/* 从 subtype 里取', () => {
    expect(extensionFor('image/heic')).toBe('heic');
    // 按 subtype 推会得到 `icon`，所以这两个在表里写死成 ico。
    expect(extensionFor('image/x-icon')).toBe('ico');
    expect(extensionFor('image/vnd.microsoft.icon')).toBe('ico');
  });

  it('完全认不出来时兜底成 png', () => {
    expect(extensionFor('')).toBe('png');
    expect(extensionFor('application/octet-stream')).toBe('png');
    // subtype 太长或带奇怪字符，不能直接当扩展名用。
    expect(extensionFor('image/vnd.adobe.photoshop')).toBe('png');
  });
});

describe('sanitizeSegment', () => {
  it('中文、空格和连字号原样保留', () => {
    expect(sanitizeSegment('线性代数 第 1 章')).toBe('线性代数 第 1 章');
    expect(sanitizeSegment('utools-fundoc')).toBe('utools-fundoc');
  });

  it('路径分隔符换成下划线，不会凭空多出一层目录', () => {
    expect(sanitizeSegment('2024/05 周报')).toBe('2024_05 周报');
    expect(sanitizeSegment('a\\b')).toBe('a_b');
  });

  it('Windows 不允许的字符换成下划线', () => {
    expect(sanitizeSegment('a<b>c:d"e|f?g*h')).toBe('a_b_c_d_e_f_g_h');
  });

  it('控制字符也洗掉，但普通空格留着', () => {
    // 控制字符一律写成转义，别在源码里放裸字节 —— git 会把整个文件当二进制。
    expect(sanitizeSegment('a\u0000b\u001fc\nd')).toBe('a_b_c_d');
    expect(sanitizeSegment('a b')).toBe('a b');
  });

  // Windows 会悄悄吃掉结尾的点和空格，于是「周报.」和「周报」落到同一个文件上，
  // 后导出的那篇直接覆盖前一篇 —— 而且没有任何报错。
  it('结尾的点和空格去掉', () => {
    expect(sanitizeSegment('周报. ')).toBe('周报');
    expect(sanitizeSegment('...')).toBe('未命名');
  });

  it('空名字兜底成「未命名」', () => {
    expect(sanitizeSegment('')).toBe('未命名');
    expect(sanitizeSegment('   ')).toBe('未命名');
  });

  it('Windows 保留设备名前面加下划线', () => {
    // CON.md 在 Windows 上根本创建不了，必须躲开。
    expect(sanitizeSegment('CON')).toBe('_CON');
    expect(sanitizeSegment('nul')).toBe('_nul');
    expect(sanitizeSegment('com3')).toBe('_com3');
    // 只有整段就是保留名才算，`console` 是正常名字。
    expect(sanitizeSegment('console')).toBe('console');
  });

  it('超长名字截断，且截完不留结尾的点', () => {
    expect(sanitizeSegment('长'.repeat(200))).toHaveLength(80);
    expect(sanitizeSegment(`${'a'.repeat(79)}.bc`)).toBe('a'.repeat(79));
  });
});

describe('uniqueSegment', () => {
  it('重名的后缀是 (2)(3)，大小写不敏感', () => {
    const used = new Set<string>();
    expect(uniqueSegment(used, '周报', '.md')).toBe('周报.md');
    expect(uniqueSegment(used, '周报', '.md')).toBe('周报 (2).md');
    expect(uniqueSegment(used, '周报', '.md')).toBe('周报 (3).md');
    // macOS 和 Windows 的文件系统默认不区分大小写，README 和 readme 会撞。
    expect(uniqueSegment(used, 'Readme', '.md')).toBe('Readme.md');
    expect(uniqueSegment(used, 'readme', '.md')).toBe('readme (2).md');
  });

  it('目录（无扩展名）和同名文档互不影响', () => {
    const used = new Set<string>();
    expect(uniqueSegment(used, '数学')).toBe('数学');
    expect(uniqueSegment(used, '数学', '.md')).toBe('数学.md');
  });
});

describe('buildExportPlan', () => {
  it('单篇文档：一个文件，名字取标题', () => {
    const metas = [node('a', null, { name: '线性代数' })];
    const plan = buildExportPlan(metas, 'a', io({ a: '# 线性代数\n\n正文' }));

    expect(plan.rootName).toBe('线性代数.md');
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0].path).toBe('线性代数.md');
    expect(textOf(plan, '线性代数.md')).toBe('# 线性代数\n\n正文');
    expect(plan.dirs).toEqual([]);
  });

  it('目录：连带全部子孙，路径相对导出根（不含根目录名自身）', () => {
    const metas = [
      dir('math', null, { name: '数学' }),
      dir('linear', 'math', { name: '线性代数' }),
      node('vector', 'linear', { name: '向量' }),
      node('intro', 'math', { name: '导言' }),
      node('other', null, { name: '不该出现' }),
    ];
    const plan = buildExportPlan(metas, 'math', io());

    expect(plan.rootName).toBe('数学');
    expect(plan.files.map((file) => file.path).sort()).toEqual([
      '导言.md',
      '线性代数/向量.md',
    ]);
    expect(plan.dirs).toEqual(['线性代数']);
  });

  it('rootId 为 null 时导出整个库', () => {
    const metas = [
      dir('math', null, { name: '数学' }),
      node('vector', 'math', { name: '向量' }),
      node('diary', null, { name: '日记' }),
    ];
    const plan = buildExportPlan(metas, null, io());

    expect(plan.rootName).toBe('FunDoc');
    expect(plan.files.map((file) => file.path).sort()).toEqual(['数学/向量.md', '日记.md']);
  });

  it('空目录也留在 dirs 里，导出后结构跟界面一致', () => {
    const metas = [dir('math', null, { name: '数学' }), dir('empty', 'math', { name: '空的' })];
    const plan = buildExportPlan(metas, 'math', io());

    expect(plan.files).toEqual([]);
    expect(plan.dirs).toEqual(['空的']);
  });

  it('同一层的同名文档不会互相覆盖', () => {
    const metas = [
      node('a', null, { name: '周报', order: 1000 }),
      node('b', null, { name: '周报', order: 2000 }),
    ];
    const plan = buildExportPlan(metas, null, io({ a: '第一篇', b: '第二篇' }));

    expect(plan.files.map((file) => file.path)).toEqual(['周报.md', '周报 (2).md']);
    expect(textOf(plan, '周报.md')).toBe('第一篇');
    expect(textOf(plan, '周报 (2).md')).toBe('第二篇');
  });

  it('不同层的同名文档各自保留原名', () => {
    const metas = [
      dir('x', null, { name: 'x' }),
      dir('y', null, { name: 'y' }),
      node('a', 'x', { name: '周报' }),
      node('b', 'y', { name: '周报' }),
    ];
    const plan = buildExportPlan(metas, null, io());

    expect(plan.files.map((file) => file.path).sort()).toEqual(['x/周报.md', 'y/周报.md']);
  });

  it('文件名里的斜杠不会多造出一层目录', () => {
    const metas = [node('a', null, { name: '2024/05' })];
    const plan = buildExportPlan(metas, 'a', io());

    expect(plan.files[0].path).toBe('2024_05.md');
    expect(plan.rootName).toBe('2024_05.md');
  });

  it('找不到 rootId 时返回空计划，而不是悄悄导出整个库', () => {
    const plan = buildExportPlan([node('a', null)], 'ghost', io());
    expect(plan).toEqual({ rootName: '未命名', dirs: [], files: [], missingAssets: 0 });
  });

  // 同步事故造出的环：a 的父亲是 b，b 的父亲是 a。按 parentId 递归一个都遍历不到，
  // 导出会悄悄少文档 —— 备份最不能出这种错。
  it('环上的节点不会从导出里消失', () => {
    const metas = [
      dir('a', 'b', { name: 'A' }),
      dir('b', 'a', { name: 'B' }),
      node('doc', 'a', { name: '环里的文档' }),
      node('safe', null, { name: '正常文档' }),
    ];
    const plan = buildExportPlan(metas, null, io());

    const paths = plan.files.map((file) => file.path).sort();
    expect(paths).toContain('正常文档.md');
    // buildTree 把环上的节点连同它们的子孙一律挂回根下，所以这篇落在顶层而不是 A/ 下面。
    // 层级变了可以接受，文档丢了不行。
    expect(paths).toContain('环里的文档.md');
    expect(plan.files).toHaveLength(2);
    // A、B 被修成两个空的顶层目录，仍然导得出来。
    expect(plan.dirs.sort()).toEqual(['A', 'B']);
  });

  it('父节点不存在的孤儿节点也导得出来', () => {
    const metas = [node('orphan', 'gone', { name: '孤儿' })];
    const plan = buildExportPlan(metas, null, io());
    expect(plan.files.map((file) => file.path)).toEqual(['孤儿.md']);
  });

  describe('图片', () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const jpg = new Uint8Array([255, 216, 255]);
    let assets: Record<string, { bytes: Uint8Array; mime: string }>;

    beforeEach(() => {
      assets = { img1: { bytes: png, mime: 'image/png' }, img2: { bytes: jpg, mime: 'image/jpeg' } };
    });

    const withAssets = (bodies: Record<string, string>): ExportIO => ({
      bodyOf: (nodeId) => bodies[nodeId] ?? '',
      assetOf: (assetId) => assets[assetId] ?? null,
    });

    it('附件写进 assets/，正文里的引用改成相对路径', () => {
      const metas = [node('a', null, { name: '图文' })];
      const plan = buildExportPlan(
        metas,
        'a',
        withAssets({ a: `![图](${ASSET_SCHEME}img1)` }),
      );

      expect(textOf(plan, '图文.md')).toBe('![图](assets/img1.png)');
      const binary = plan.files.find((file) => file.kind === 'binary');
      expect(binary).toMatchObject({ path: 'assets/img1.png', kind: 'binary', mime: 'image/png' });
      expect(plan.dirs).toEqual(['assets']);
    });

    // 深层文档必须按自己的层级回退，否则导出后图片全是坏链。
    it('深层文档的图片路径按层级回退', () => {
      const metas = [
        dir('x', null, { name: 'x' }),
        dir('y', 'x', { name: 'y' }),
        node('a', 'y', { name: '深' }),
      ];
      const plan = buildExportPlan(metas, null, withAssets({ a: `![](${ASSET_SCHEME}img1)` }));

      expect(textOf(plan, 'x/y/深.md')).toBe('![](../../assets/img1.png)');
    });

    it('同一张图被多篇引用只写一次', () => {
      const metas = [
        node('a', null, { name: 'A', order: 1000 }),
        node('b', null, { name: 'B', order: 2000 }),
      ];
      const plan = buildExportPlan(
        metas,
        null,
        withAssets({ a: `![](${ASSET_SCHEME}img1)`, b: `![](${ASSET_SCHEME}img1)` }),
      );

      expect(plan.files.filter((file) => file.kind === 'binary')).toHaveLength(1);
      expect(textOf(plan, 'A.md')).toContain('assets/img1.png');
      expect(textOf(plan, 'B.md')).toContain('assets/img1.png');
    });

    it('一篇里引用多张图，各自按类型定扩展名', () => {
      const metas = [node('a', null, { name: 'A' })];
      const plan = buildExportPlan(
        metas,
        'a',
        withAssets({ a: `![1](${ASSET_SCHEME}img1) ![2](${ASSET_SCHEME}img2)` }),
      );

      expect(textOf(plan, 'A.md')).toBe('![1](assets/img1.png) ![2](assets/img2.jpg)');
    });

    // 丢失的附件保留原样：导出的文件里留着可见的痕迹，比悄悄变成坏图标好排查。
    it('附件丢了就保留原引用，并计入 missingAssets', () => {
      const metas = [node('a', null, { name: 'A' })];
      const plan = buildExportPlan(metas, 'a', withAssets({ a: `![](${ASSET_SCHEME}gone)` }));

      expect(textOf(plan, 'A.md')).toBe(`![](${ASSET_SCHEME}gone)`);
      expect(plan.missingAssets).toBe(1);
      expect(plan.files).toHaveLength(1);
    });

    it('同一张丢失的图被引用多次只计一次', () => {
      const metas = [
        node('a', null, { name: 'A', order: 1000 }),
        node('b', null, { name: 'B', order: 2000 }),
      ];
      const plan = buildExportPlan(
        metas,
        null,
        withAssets({ a: `![](${ASSET_SCHEME}gone) ![](${ASSET_SCHEME}gone)`, b: `![](${ASSET_SCHEME}gone)` }),
      );

      expect(plan.missingAssets).toBe(1);
    });

    it('没有图片时不建 assets 目录', () => {
      const plan = buildExportPlan([node('a', null, { name: 'A' })], 'a', withAssets({ a: '纯文字' }));
      expect(plan.dirs).toEqual([]);
    });
  });
});
