// 文档关键词 → uTools 动态功能。
//
// 这里最容易出错的地方不是注册，而是**调和**。
//
// 关键词的「配置」存在 meta@ 里，会跟着 uTools 数据同步到其他设备。但 setFeature 注册的是
// **当前这台机器上 uTools 客户端的本地状态**，它不在我们的文档库里，不会被同步。
//
// 后果：在 A 机器给文章配了关键词，同步到 B 机器后，B 的 meta@ 里有配置、界面上开关是打开的，
// 但 B 的 uTools 从没注册过这个 feature —— 主搜索框打关键词什么也搜不到。用户只会认为插件坏了。
//
// 所以每次启动、每次 onDbPull 带来 meta@ 变更之后，都必须以数据库为准把本机的动态功能集合
// 对齐一遍。详见 docs/design.md §5.3。
import { host } from './host';
import { pathOf } from './tree';
import type { NodeMeta } from './types';

/**
 * 动态关键词的 code 前缀。
 *
 * 调和时靠它筛出「属于我们管理的」动态功能。绝不能对 getFeatures() 的结果全量删除 ——
 * 那会连 plugin.json 里的静态功能一起清掉。
 */
export const FEATURE_PREFIX = 'doc/';

/** 拼某篇文档的动态功能 code。绑稳定 nodeId，标题改了也不失效。 */
export function featureCode(nodeId: string): string {
  return `${FEATURE_PREFIX}${nodeId}`;
}

/** 从动态功能 code 反解出 nodeId；不是我们的 code 则返回 null。 */
export function nodeIdFromFeatureCode(code: string): string | null {
  return code.startsWith(FEATURE_PREFIX) ? code.slice(FEATURE_PREFIX.length) : null;
}

/**
 * 按产品规则算出一篇文档实际要注册的关键词。
 *
 * 规则（docs/design.md §5.1）：
 * - 开关关 → 空数组（不注册）。
 * - 开关开 + 填了词 → 用这些词（去空白、去重、保持用户填写顺序）。
 * - 开关开 + 没填词 → **用标题当关键词**。
 *
 * @param meta 节点元数据。
 * @returns 要注册的关键词；返回空数组表示不应注册。
 */
export function keywordsOf(meta: NodeMeta): string[] {
  if (meta.type !== 'doc' || !meta.keywordEnabled) return [];

  const custom = (meta.keywords ?? []).map((word) => word.trim()).filter(Boolean);
  const words = custom.length ? custom : [meta.name.trim()].filter(Boolean);

  // cmds 不能为空，也不能含空串。开关开、没填词、标题又是空的（新建未命名）
  // 就落到这里返回空数组，界面会提示「需要先填标题或关键词」。
  return [...new Set(words)];
}

/**
 * 算出当前数据库状态下「本机应该注册哪些动态功能」。
 * @param metas 全部节点元数据。
 * @returns code → Feature 的映射。
 */
export function desiredFeatures(metas: NodeMeta[]): Map<string, Feature> {
  const desired = new Map<string, Feature>();
  for (const meta of metas) {
    const cmds = keywordsOf(meta);
    if (!cmds.length) continue;
    desired.set(featureCode(meta.nodeId), {
      code: featureCode(meta.nodeId),
      // 官方 8.0 的 Feature 只有 description，没有 explain —— 写 explain 会被静默丢掉。
      // 这里放完整路径而不是标题：同一个关键词可以被多篇文章占用，uTools 会把它们都列出来，
      // 用户只能靠路径区分。
      description: `FunDoc · ${pathOf(metas, meta.nodeId)}`,
      icon: 'logo.png',
      cmds,
    });
  }
  return desired;
}

function sameCmds(left: Array<string | Cmd>, right: Array<string | Cmd>): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => JSON.stringify(item) === JSON.stringify(right[index]));
}

export type ReconcileReport = {
  added: string[];
  updated: string[];
  removed: string[];
};

/**
 * 以数据库为准，把本机已注册的动态功能对齐到期望集合。
 *
 * 幂等：重复调用不会产生多余的 setFeature / removeFeature 调用。
 *
 * @param metas 全部节点元数据。
 * @returns 本次实际发生的增、改、删。
 */
export function reconcileFeatures(metas: NodeMeta[]): ReconcileReport {
  const desired = desiredFeatures(metas);

  // 只看我们自己前缀下的，别碰 plugin.json 里的静态功能。
  const actual = new Map<string, Feature>();
  for (const feature of host.getFeatures()) {
    if (feature.code.startsWith(FEATURE_PREFIX)) actual.set(feature.code, feature);
  }

  const report: ReconcileReport = { added: [], updated: [], removed: [] };

  for (const [code, feature] of desired) {
    const current = actual.get(code);
    if (!current) {
      host.setFeature(feature);
      report.added.push(code);
      continue;
    }
    if (!sameCmds(current.cmds, feature.cmds) || current.description !== feature.description) {
      host.setFeature(feature);
      report.updated.push(code);
    }
  }

  for (const code of actual.keys()) {
    if (!desired.has(code)) {
      host.removeFeature(code);
      report.removed.push(code);
    }
  }

  return report;
}

/**
 * 摘掉某篇文档的搜索入口。
 *
 * 删除文档时必须先调这个，否则 uTools 里留下一个指向已删节点的死关键词，点进去是空白。
 *
 * @param nodeId 节点标识。
 */
export function unregisterFeature(nodeId: string): void {
  host.removeFeature(featureCode(nodeId));
}
