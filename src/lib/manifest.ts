// 导出包里的清单 `fundoc.json`：导出与导入共用的那份「结构说明书」。
//
// 为什么要它：导出的 `.md` 文件只带得走正文和层级，而关键词配置、同级排序、创建时间全在
// `meta@` 里 —— 没有清单的话，「整库导出 → 重装插件 → 导回来」会把这些一并丢掉，而 README
// 里「卸载插件会一并删除，重要内容请先导出」这句话就只兑现了一半。
//
// 两条刻意的取舍：
//
// 1. **清单是附加信息，不是必需品。** `.md` 文件本身仍然是干净的 Markdown，别的编辑器照常打开；
//    导入时清单缺失、坏掉、或者这个包本来就来自别处，一律退回「按目录结构导入」。
// 2. **靠 `path` 和包里的文件对账**，不靠顺序、也不靠文件名编码进 id。用户在外面改个名、删一篇、
//    手动塞一篇进去都不会让整份清单失效 —— 对不上的条目跳过，清单里没有的文件照常导入。
import type { NodeType } from './types';

/** 清单文件名。放在导出根下。 */
export const MANIFEST_NAME = 'fundoc.json';

/** 当前清单格式版本。读到更大的版本号就不认，免得按旧字段猜新结构。 */
export const MANIFEST_VERSION = 1;

export type ManifestNode = {
  /** 原节点 nodeId。导入时**只在库里没被占用时复用**，让还原后的关键词入口接着生效。 */
  nodeId: string;
  type: NodeType;
  /** 节点名。可能和文件名不同（文件名洗过：去掉非法字符、同层去重、限长）。 */
  name: string;
  /** 相对导出根的路径，文档带 `.md`，目录不带。认领包里的文件就靠它。 */
  path: string;
  /** 同级排序。导入时只用来定先后，不保证原值落库。 */
  order: number;
  createdAt: number;
  updatedAt: number;
  keywordEnabled?: boolean;
  keywords?: string[];
};

export type Manifest = {
  /** 格式版本，见 MANIFEST_VERSION。 */
  fundoc: number;
  exportedAt: number;
  /** 导出根目录名。只给人看，导入时不依赖它。 */
  root: string;
  nodes: ManifestNode[];
};

/**
 * 序列化清单。
 * @param manifest 清单。
 * @returns JSON 文本。缩进 2 空格、末尾带换行 —— 这份文件会进用户的备份目录，
 *   有人会拿 git 管它，压成一行的 diff 没法看。
 */
export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验一条节点记录。有一个字段不对就整条作废。 */
function parseNode(raw: unknown): ManifestNode | null {
  if (!isPlainObject(raw)) return null;
  const { nodeId, type, name, path, order, createdAt, updatedAt } = raw;
  if (typeof nodeId !== 'string' || !nodeId) return null;
  if (type !== 'dir' && type !== 'doc') return null;
  if (typeof name !== 'string' || typeof path !== 'string' || !path) return null;
  if (typeof order !== 'number' || !Number.isFinite(order)) return null;
  if (typeof createdAt !== 'number' || typeof updatedAt !== 'number') return null;

  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.filter((word): word is string => typeof word === 'string')
    : undefined;

  return {
    nodeId,
    type,
    name,
    path,
    order,
    createdAt,
    updatedAt,
    ...(typeof raw.keywordEnabled === 'boolean' ? { keywordEnabled: raw.keywordEnabled } : {}),
    ...(keywords ? { keywords } : {}),
  };
}

/**
 * 解析清单。
 *
 * 防御式到底：这是一个外部文件，可能被手改坏、可能是别的工具同名产物。任何一处不合法就返回
 * null，调用方退回「按目录结构导入」—— **半信半疑地用比不用更糟**，那会造出名字对、顺序乱、
 * 关键词指向错文档的还原结果，而用户完全看不出哪里不对。
 *
 * 单条节点坏掉只丢那一条：一篇文档的记录被改烂，不该让另外两百篇的关键词也跟着丢。
 *
 * @param text JSON 文本。
 * @returns 清单；不是合法清单时返回 null。
 */
export function parseManifest(text: string): Manifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(raw)) return null;
  // 版本号不认就不认，不要按旧字段猜新结构。
  if (typeof raw.fundoc !== 'number' || raw.fundoc > MANIFEST_VERSION || raw.fundoc < 1) {
    return null;
  }
  if (!Array.isArray(raw.nodes)) return null;

  const nodes = raw.nodes.map(parseNode).filter((node): node is ManifestNode => node !== null);
  if (!nodes.length) return null;

  return {
    fundoc: raw.fundoc,
    exportedAt: typeof raw.exportedAt === 'number' ? raw.exportedAt : 0,
    root: typeof raw.root === 'string' ? raw.root : '',
    nodes,
  };
}
