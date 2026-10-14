import { describe, expect, it } from 'vitest';
import {
  ORDER_STEP,
  buildTree,
  descendantsOf,
  isSelfOrDescendant,
  orderBetween,
  pathOf,
  reindex,
  siblingsOf,
} from '../src/lib/tree';
import type { NodeMeta } from '../src/lib/types';

function node(
  nodeId: string,
  parentId: string | null,
  options: Partial<NodeMeta> = {},
): NodeMeta {
  return {
    _id: `meta@${nodeId}`,
    nodeId,
    type: 'doc',
    name: nodeId,
    parentId,
    order: ORDER_STEP,
    createdAt: 0,
    updatedAt: 0,
    ...options,
  };
}

const dir = (nodeId: string, parentId: string | null, options: Partial<NodeMeta> = {}) =>
  node(nodeId, parentId, { type: 'dir', ...options });

describe('buildTree', () => {
  it('把扁平列表装成多层树', () => {
    const { roots, repaired } = buildTree([
      dir('a', null),
      dir('b', 'a'),
      node('c', 'b'),
      node('d', null),
    ]);

    expect(repaired).toEqual([]);
    expect(roots.map((n) => n.nodeId)).toEqual(['a', 'd']);
    expect(roots[0].children[0].nodeId).toBe('b');
    expect(roots[0].children[0].children[0].nodeId).toBe('c');
  });

  it('按深度标注 depth', () => {
    const { roots } = buildTree([dir('a', null), dir('b', 'a'), node('c', 'b')]);
    expect(roots[0].depth).toBe(0);
    expect(roots[0].children[0].depth).toBe(1);
    expect(roots[0].children[0].children[0].depth).toBe(2);
  });

  it('目录排在文档前面，同类按 order', () => {
    const { roots } = buildTree([
      node('doc1', null, { order: 10 }),
      dir('dir1', null, { order: 20 }),
      node('doc2', null, { order: 5 }),
    ]);
    expect(roots.map((n) => n.nodeId)).toEqual(['dir1', 'doc2', 'doc1']);
  });

  it('order 相同时按中文名排序', () => {
    const { roots } = buildTree([
      node('b', null, { name: '北京', order: 1 }),
      node('a', null, { name: '阿里', order: 1 }),
    ]);
    expect(roots.map((n) => n.name)).toEqual(['阿里', '北京']);
  });

  // 以下三组是同步事故会真实造出来的形状。关键不只是「不崩」，
  // 而是**一个节点都不能丢** —— 用户的文档不能因为一次同步就消失。
  it('父节点不存在的孤儿被挂回根下', () => {
    const { roots, repaired } = buildTree([node('orphan', 'ghost')]);
    expect(repaired).toEqual(['orphan']);
    expect(roots.map((n) => n.nodeId)).toEqual(['orphan']);
  });

  it('互相成环的节点被挂回根下，不死循环', () => {
    const { roots, repaired } = buildTree([dir('a', 'b'), dir('b', 'a')]);
    expect(repaired.sort()).toEqual(['a', 'b']);
    expect(roots.map((n) => n.nodeId).sort()).toEqual(['a', 'b']);
  });

  it('父节点是文档时按断链处理', () => {
    const { roots, repaired } = buildTree([node('parent', null), node('child', 'parent')]);
    expect(repaired).toEqual(['child']);
    expect(roots.map((n) => n.nodeId).sort()).toEqual(['child', 'parent']);
  });

  it('环上的子孙也一并救回，不会整条子树消失', () => {
    const metas = [dir('a', 'b'), dir('b', 'a'), node('leaf', 'a')];
    const { roots, repaired } = buildTree(metas);
    const ids = roots.flatMap(function flatten(n): string[] {
      return [n.nodeId, ...n.children.flatMap(flatten)];
    });
    expect(ids.sort()).toEqual(['a', 'b', 'leaf']);
    expect(repaired).toContain('leaf');
  });

  it('空输入返回空树', () => {
    expect(buildTree([])).toEqual({ roots: [], repaired: [] });
  });
});

describe('orderBetween', () => {
  it('两端都空时给出起始值', () => {
    expect(orderBetween(null, null)).toBe(ORDER_STEP);
  });

  it('插到最前 / 最后时按步长外推', () => {
    expect(orderBetween(null, 1000)).toBe(0);
    expect(orderBetween(1000, null)).toBe(2000);
  });

  it('插在中间时取中值', () => {
    expect(orderBetween(1000, 2000)).toBe(1500);
  });

  it('挤没整数空隙时返回 null，交给调用方重排', () => {
    expect(orderBetween(1000, 1001)).toBeNull();
    expect(orderBetween(1000, 1000)).toBeNull();
  });
});

describe('reindex', () => {
  it('只返回 order 真的变了的节点', () => {
    const changed = reindex([
      node('a', null, { order: ORDER_STEP }), // 已经对了
      node('b', null, { order: 1 }),
    ]);
    expect(changed.map((n) => n.nodeId)).toEqual(['b']);
    expect(changed[0].order).toBe(2 * ORDER_STEP);
  });
});

describe('isSelfOrDescendant', () => {
  const metas = [dir('a', null), dir('b', 'a'), node('c', 'b')];

  it('自身算在内', () => {
    expect(isSelfOrDescendant(metas, 'a', 'a')).toBe(true);
  });

  it('隔代子孙也算', () => {
    expect(isSelfOrDescendant(metas, 'a', 'c')).toBe(true);
  });

  it('不相干的节点返回 false', () => {
    expect(isSelfOrDescendant(metas, 'b', 'a')).toBe(false);
    expect(isSelfOrDescendant(metas, 'a', null)).toBe(false);
  });

  it('已有环时不死循环', () => {
    expect(isSelfOrDescendant([dir('x', 'y'), dir('y', 'x')], 'z', 'x')).toBe(false);
  });
});

describe('pathOf', () => {
  const metas = [dir('a', null, { name: '笔记' }), dir('b', 'a', { name: '数学' }), node('c', 'b', { name: '线性代数' })];

  it('自顶向下用 / 拼接', () => {
    expect(pathOf(metas, 'c')).toBe('笔记/数学/线性代数');
  });

  it('节点不存在时返回空串', () => {
    expect(pathOf(metas, 'ghost')).toBe('');
  });

  it('名字为空时占位，不塌成空段', () => {
    expect(pathOf([node('x', null, { name: '' })], 'x')).toBe('未命名');
  });
});

describe('descendantsOf', () => {
  it('收全部子孙但不含自身', () => {
    const metas = [dir('a', null), dir('b', 'a'), node('c', 'b'), node('d', null)];
    expect(descendantsOf(metas, 'a').map((n) => n.nodeId).sort()).toEqual(['b', 'c']);
  });

  it('有环时不死循环', () => {
    expect(descendantsOf([dir('a', 'b'), dir('b', 'a')], 'a').map((n) => n.nodeId)).toEqual(['b']);
  });
});

describe('siblingsOf', () => {
  it('按显示顺序给出同级节点', () => {
    const metas = [node('x', null, { order: 20 }), node('y', null, { order: 10 }), node('z', 'x')];
    expect(siblingsOf(metas, null).map((n) => n.nodeId)).toEqual(['y', 'x']);
  });
});
