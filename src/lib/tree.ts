// 邻接表（parentId）→ 内存树。
//
// 为什么不用「路径即 _id」：uTools 的 _id 不可变，重命名一个目录就等于删掉并重建它下面
// 所有子孙，同步到另一台机器是几十条删除 + 几十条新增，中途失败留下半棵残树；而且关键词的
// feature code 绑在路径上，改名就失效。详见 docs/design.md §3.3。
//
// 代价是必须自己防环和孤儿 —— 同步真的会造出环：两台机器各拖一次，就可能出现
// A 的父亲是 B、B 的父亲是 A。不检测的话装树会直接死循环，整个界面卡死。
import type { NodeMeta, TreeNode } from './types';

/** 同级排序的步长。稀疏取值，插入时取相邻中值，避免拖一下就重写整个同级列表。 */
export const ORDER_STEP = 1000;

export type BuildResult = {
  roots: TreeNode[];
  /** 被修复（挂回根下）的节点 nodeId。界面据此提示用户。 */
  repaired: string[];
};

function compareSiblings(left: NodeMeta, right: NodeMeta): number {
  // 目录排在文档前面，和文件管理器的习惯一致。
  if (left.type !== right.type) return left.type === 'dir' ? -1 : 1;
  if (left.order !== right.order) return left.order - right.order;
  return left.name.localeCompare(right.name, 'zh-CN');
}

/**
 * 把扁平的节点列表装成树，顺带修掉环和孤儿。
 *
 * 三种异常一律挂回根下，而不是丢弃 —— 用户的文档不能因为一次同步事故就消失：
 * - 父节点不存在（孤儿）：另一台机器删了目录但本机还留着子节点。
 * - 父节点是文档：文档不能有子节点。
 * - 处在环上：两台机器各拖一次造出来的 A→B→A。
 *
 * @param metas 全部节点元数据。
 * @returns 根节点列表，以及被修复的节点标识。
 */
export function buildTree(metas: NodeMeta[]): BuildResult {
  const byId = new Map<string, NodeMeta>();
  for (const meta of metas) byId.set(meta.nodeId, meta);

  const repaired: string[] = [];
  // 每个节点的父链是否能走到 null。OK = 能，BAD = 环上或父链中断。
  const verdict = new Map<string, 'ok' | 'bad'>();

  const resolve = (start: NodeMeta): 'ok' | 'bad' => {
    const chain: string[] = [];
    let cursor: NodeMeta | undefined = start;

    for (;;) {
      if (!cursor) {
        // 父链中断（孤儿）：链上所有节点都判坏，它们各自会被挂回根下。
        for (const id of chain) verdict.set(id, 'bad');
        return 'bad';
      }

      const known = verdict.get(cursor.nodeId);
      if (known) {
        for (const id of chain) verdict.set(id, known);
        return known;
      }

      if (chain.includes(cursor.nodeId)) {
        // 撞上自己 = 环。
        for (const id of chain) verdict.set(id, 'bad');
        return 'bad';
      }

      chain.push(cursor.nodeId);

      if (cursor.parentId === null) {
        for (const id of chain) verdict.set(id, 'ok');
        return 'ok';
      }

      const parent = byId.get(cursor.parentId);
      // 父节点是文档：文档不能有子节点，当作父链中断处理。
      if (parent && parent.type === 'doc') {
        for (const id of chain) verdict.set(id, 'bad');
        return 'bad';
      }
      cursor = parent;
    }
  };

  const nodes = new Map<string, TreeNode>();
  for (const meta of metas) {
    const healthy = resolve(meta) === 'ok';
    const parentId = healthy ? meta.parentId : null;
    if (!healthy && meta.parentId !== null) repaired.push(meta.nodeId);
    nodes.set(meta.nodeId, { ...meta, parentId, children: [], depth: 0 });
  }

  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    if (node.parentId === null) {
      roots.push(node);
      continue;
    }
    // resolve 已经保证父节点存在且是目录。
    nodes.get(node.parentId)!.children.push(node);
  }

  const sortRecursive = (list: TreeNode[], depth: number) => {
    list.sort(compareSiblings);
    for (const node of list) {
      node.depth = depth;
      sortRecursive(node.children, depth + 1);
    }
  };
  sortRecursive(roots, 0);

  return { roots, repaired };
}

/**
 * 取某个父节点下的同级节点，已按显示顺序排好。
 * @param metas 全部节点元数据。
 * @param parentId 父节点标识；null 表示根。
 * @returns 排好序的同级节点。
 */
export function siblingsOf(metas: NodeMeta[], parentId: string | null): NodeMeta[] {
  return metas.filter((meta) => meta.parentId === parentId).sort(compareSiblings);
}

/**
 * 算出插在两个相邻节点之间应该用的 order。
 *
 * @param before 插入位置前一个节点的 order；插到最前面时传 null。
 * @param after 插入位置后一个节点的 order；插到最后面时传 null。
 * @returns 可用的 order；两个相邻 order 已经挤到没有整数空隙时返回 null，
 *   调用方需要对该层做一次重排（`reindex`）。
 */
export function orderBetween(before: number | null, after: number | null): number | null {
  if (before === null && after === null) return ORDER_STEP;
  if (before === null) return after! - ORDER_STEP;
  if (after === null) return before + ORDER_STEP;
  const middle = Math.floor((before + after) / 2);
  return middle === before || middle === after ? null : middle;
}

/**
 * 给一层节点重新分配等距 order。
 *
 * 只在 `orderBetween` 返回 null（挤没空隙了）时才需要调用 —— 它会产生 n 条写入，
 * 是刻意留给罕见情况的兜底，而不是每次拖拽都做的事。
 *
 * @param siblings 已按目标顺序排列的同级节点。
 * @returns 需要写回数据库的节点（order 真的变了的那些）。
 */
export function reindex(siblings: NodeMeta[]): NodeMeta[] {
  const changed: NodeMeta[] = [];
  siblings.forEach((meta, index) => {
    const order = (index + 1) * ORDER_STEP;
    if (meta.order !== order) changed.push({ ...meta, order });
  });
  return changed;
}

/**
 * 判断 `candidate` 是否是 `ancestorId` 的子孙（含自身）。
 *
 * 拖拽时用来挡住「把目录拖进它自己的子树」—— 那会当场造出一个环。
 *
 * @param metas 全部节点元数据。
 * @param ancestorId 祖先节点标识。
 * @param candidate 待判断的节点标识。
 * @returns 是子孙或就是自身时返回 true。
 */
export function isSelfOrDescendant(
  metas: NodeMeta[],
  ancestorId: string,
  candidate: string | null,
): boolean {
  const byId = new Map(metas.map((meta) => [meta.nodeId, meta]));
  let cursor = candidate;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (cursor === ancestorId) return true;
    if (seen.has(cursor)) return false; // 已有环，交给 buildTree 去修
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return false;
}

/**
 * 拼出节点的完整路径，用 `/` 分隔。
 *
 * 动态关键词的 `explain` 用它而不是标题：两篇文章用同一个关键词是允许的，
 * uTools 会把它们都列在搜索结果里，只能靠路径区分（docs/design.md §5.4）。
 *
 * @param metas 全部节点元数据。
 * @param nodeId 节点标识。
 * @returns 形如 `笔记/数学/线性代数` 的路径；节点不存在时返回空串。
 */
export function pathOf(metas: NodeMeta[], nodeId: string): string {
  const byId = new Map(metas.map((meta) => [meta.nodeId, meta]));
  const segments: string[] = [];
  let cursor: string | null = nodeId;
  const seen = new Set<string>();
  while (cursor !== null) {
    const meta = byId.get(cursor);
    if (!meta || seen.has(cursor)) break;
    seen.add(cursor);
    segments.unshift(meta.name || '未命名');
    cursor = meta.parentId;
  }
  return segments.join('/');
}

/**
 * 收集某个节点的全部子孙（不含自身），用于删除目录时连带清理。
 * @param metas 全部节点元数据。
 * @param nodeId 根节点标识。
 * @returns 全部子孙节点，深度优先。
 */
export function descendantsOf(metas: NodeMeta[], nodeId: string): NodeMeta[] {
  const childrenOf = new Map<string, NodeMeta[]>();
  for (const meta of metas) {
    if (meta.parentId === null) continue;
    const list = childrenOf.get(meta.parentId) ?? [];
    list.push(meta);
    childrenOf.set(meta.parentId, list);
  }

  const result: NodeMeta[] = [];
  const seen = new Set<string>([nodeId]);
  const walk = (id: string) => {
    for (const child of childrenOf.get(id) ?? []) {
      if (seen.has(child.nodeId)) continue; // 防环
      seen.add(child.nodeId);
      result.push(child);
      walk(child.nodeId);
    }
  };
  walk(nodeId);
  return result;
}
