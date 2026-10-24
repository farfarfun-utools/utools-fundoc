import { beforeEach, describe, expect, it } from 'vitest';
import { host } from '../src/lib/host';
import {
  FEATURE_PREFIX,
  desiredFeatures,
  featureCode,
  keywordsOf,
  nodeIdFromFeatureCode,
  reconcileFeatures,
  unregisterFeature,
} from '../src/lib/keyword';
import { ORDER_STEP } from '../src/lib/tree';
import type { NodeMeta } from '../src/lib/types';

function doc(nodeId: string, options: Partial<NodeMeta> = {}): NodeMeta {
  return {
    _id: `meta@${nodeId}`,
    nodeId,
    type: 'doc',
    name: nodeId,
    parentId: null,
    order: ORDER_STEP,
    createdAt: 0,
    updatedAt: 0,
    ...options,
  };
}

/** 垫片的动态功能存在模块级内存里，用例之间得自己清。 */
function clearFeatures(): void {
  for (const feature of host.getFeatures()) host.removeFeature(feature.code);
}

/** 模拟 plugin.json 里的静态功能 —— 它不该被调和逻辑碰到。 */
function registerStatic(): void {
  host.setFeature({ code: 'fundoc', description: '静态功能', cmds: ['FunDoc'] });
}

beforeEach(clearFeatures);

describe('featureCode / nodeIdFromFeatureCode', () => {
  it('来回转换是对称的', () => {
    expect(nodeIdFromFeatureCode(featureCode('abc'))).toBe('abc');
  });

  it('不是我们的 code 返回 null', () => {
    expect(nodeIdFromFeatureCode('fundoc-search')).toBeNull();
  });
});

describe('keywordsOf', () => {
  it('开关关着就不注册', () => {
    expect(keywordsOf(doc('a', { name: '标题', keywords: ['词'] }))).toEqual([]);
  });

  // 用户点名要的规则：开关开、没填词 → 标题当关键词。
  it('开关开、没填词 → 用标题', () => {
    expect(keywordsOf(doc('a', { name: '线性代数', keywordEnabled: true }))).toEqual(['线性代数']);
    expect(keywordsOf(doc('a', { name: '线性代数', keywordEnabled: true, keywords: [] }))).toEqual([
      '线性代数',
    ]);
  });

  it('只填了空白词也算没填，落回标题', () => {
    expect(
      keywordsOf(doc('a', { name: '线性代数', keywordEnabled: true, keywords: ['  ', ''] })),
    ).toEqual(['线性代数']);
  });

  it('开关开、填了词 → 用这些词，保持填写顺序', () => {
    expect(
      keywordsOf(doc('a', { name: '线性代数', keywordEnabled: true, keywords: ['矩阵', '特征值'] })),
    ).toEqual(['矩阵', '特征值']);
  });

  it('去首尾空白并去重', () => {
    expect(
      keywordsOf(doc('a', { name: 'x', keywordEnabled: true, keywords: [' 矩阵 ', '矩阵', '行列式'] })),
    ).toEqual(['矩阵', '行列式']);
  });

  // cmds 不能是空数组，也不能含空串 —— 真机上会注册出一个点不开的死入口。
  it('开关开、没填词、标题也是空的 → 空数组（界面负责提示）', () => {
    expect(keywordsOf(doc('a', { name: '   ', keywordEnabled: true }))).toEqual([]);
  });

  it('目录永远不注册，哪怕开关被写开了', () => {
    expect(keywordsOf(doc('a', { type: 'dir', name: '笔记', keywordEnabled: true }))).toEqual([]);
  });
});

describe('desiredFeatures', () => {
  it('description 用完整路径，好让同名关键词能区分', () => {
    const metas = [
      doc('root', { type: 'dir', name: '笔记' }),
      doc('a', { name: '线性代数', parentId: 'root', keywordEnabled: true }),
    ];
    expect(desiredFeatures(metas).get(featureCode('a'))).toEqual({
      code: 'doc/a',
      description: '落笔成章 · 笔记/线性代数',
      icon: 'logo.png',
      cmds: ['线性代数'],
    });
  });

  it('没有关键词的节点不出现在期望集合里', () => {
    expect(desiredFeatures([doc('a'), doc('b', { type: 'dir' })]).size).toBe(0);
  });
});

describe('reconcileFeatures', () => {
  it('首次调和把该注册的都注册上', () => {
    const report = reconcileFeatures([doc('a', { keywordEnabled: true, keywords: ['矩阵'] })]);
    expect(report).toEqual({ added: ['doc/a'], updated: [], removed: [] });
    expect(host.getFeatures().map((f) => f.code)).toEqual(['doc/a']);
  });

  // 幂等是这里最重要的性质：onDbPull 可能一秒内连发好几次。
  it('重复调和不产生任何动作', () => {
    const metas = [doc('a', { keywordEnabled: true, keywords: ['矩阵'] })];
    reconcileFeatures(metas);
    expect(reconcileFeatures(metas)).toEqual({ added: [], updated: [], removed: [] });
  });

  it('关键词变了算 updated', () => {
    const before = [doc('a', { keywordEnabled: true, keywords: ['矩阵'] })];
    reconcileFeatures(before);
    const report = reconcileFeatures([doc('a', { keywordEnabled: true, keywords: ['行列式'] })]);
    expect(report).toEqual({ added: [], updated: ['doc/a'], removed: [] });
    expect(host.getFeatures()[0].cmds).toEqual(['行列式']);
  });

  it('只改了标题（路径变了）也算 updated，description 要跟着走', () => {
    reconcileFeatures([doc('a', { name: '旧名', keywordEnabled: true, keywords: ['矩阵'] })]);
    const report = reconcileFeatures([
      doc('a', { name: '新名', keywordEnabled: true, keywords: ['矩阵'] }),
    ]);
    expect(report.updated).toEqual(['doc/a']);
    expect(host.getFeatures()[0].description).toBe('落笔成章 · 新名');
  });

  it('关掉开关后把注册摘掉', () => {
    reconcileFeatures([doc('a', { keywordEnabled: true, keywords: ['矩阵'] })]);
    expect(reconcileFeatures([doc('a')])).toEqual({ added: [], updated: [], removed: ['doc/a'] });
    expect(host.getFeatures()).toEqual([]);
  });

  it('节点被删掉（不在列表里）也摘掉', () => {
    reconcileFeatures([doc('a', { keywordEnabled: true, keywords: ['矩阵'] })]);
    expect(reconcileFeatures([]).removed).toEqual(['doc/a']);
  });

  // 这是最要紧的一条：绝不能对 getFeatures() 全量清理。
  it('不碰 plugin.json 里的静态功能', () => {
    registerStatic();
    reconcileFeatures([]);
    expect(host.getFeatures().map((f) => f.code)).toEqual(['fundoc']);
  });

  it('静态功能与动态功能共存时各自安好', () => {
    registerStatic();
    reconcileFeatures([doc('a', { keywordEnabled: true, keywords: ['矩阵'] })]);
    expect(host.getFeatures().map((f) => f.code).sort()).toEqual(['doc/a', 'fundoc']);
  });

  // 同步过来的配置就是「真相」：另一台机器注册过什么跟本机无关，
  // 本机只负责把自己对齐到数据库。
  it('以数据库为准：本机多出来的动态功能被清掉，缺的补上', () => {
    host.setFeature({ code: featureCode('ghost'), description: '陈旧', cmds: ['旧词'] });
    const report = reconcileFeatures([doc('a', { keywordEnabled: true, keywords: ['矩阵'] })]);
    expect(report.added).toEqual(['doc/a']);
    expect(report.removed).toEqual([`${FEATURE_PREFIX}ghost`]);
  });
});

describe('unregisterFeature', () => {
  it('按 nodeId 摘掉动态功能', () => {
    reconcileFeatures([doc('a', { keywordEnabled: true, keywords: ['矩阵'] })]);
    unregisterFeature('a');
    expect(host.getFeatures()).toEqual([]);
  });

  it('没注册过时也不报错', () => {
    expect(() => unregisterFeature('ghost')).not.toThrow();
  });
});
