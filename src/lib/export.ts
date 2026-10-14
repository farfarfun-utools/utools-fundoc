// 导出：把库里的节点摊成一组待写文件。
//
// 这里只**算**要写什么，不碰文件系统 —— 真机上写盘要走 preload（Node 侧），浏览器预览里
// 只能触发下载，两个落地方式完全不同。把计算和落盘分开，计算部分就能被单测覆盖，
// 而「中文文件名在 Windows 上变成乱码」「两篇同名文档互相覆盖」这类问题恰恰全在计算这一侧。
import { ASSET_SCHEME, collectAssetIds } from './asset';
import { buildTree } from './tree';
import type { NodeMeta, TreeNode } from './types';

/** 导出时图片统一放在根下的这个目录里。 */
export const ASSET_DIR = 'assets';

/** MIME → 扩展名。只列我们真会存的图片类型，其余走 `extensionFor` 的兜底。 */
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  // 这两个按 subtype 推会得到 `icon` / `vnd.microsoft.icon`，都不是真正的扩展名。
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

/**
 * 按 MIME 定扩展名。
 * @param mime MIME 类型。
 * @returns 不带点的扩展名；认不出来时返回 `png`（我们只存图片）。
 */
export function extensionFor(mime: string): string {
  const key = String(mime || '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  if (MIME_EXT[key]) return MIME_EXT[key];
  // image/x-icon → ico 这类还能救一下：取 subtype 里的字母数字部分。
  const subtype = key.startsWith('image/') ? key.slice(6).replace(/^x-/, '') : '';
  return /^[a-z0-9]{1,8}$/.test(subtype) ? subtype : 'png';
}

/**
 * Windows 的保留设备名。即使带扩展名，`CON.md` 这样的文件在 Windows 上也创建不了。
 *
 * 插件要跨三个平台，导出到 Windows 是常规场景，不能只按 Linux 的规则放行。
 */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** 单个路径段的最大字符数。多数文件系统限 255 **字节**，汉字占 3 字节，80 字留足余量。 */
const MAX_SEGMENT = 80;

/**
 * 把节点名洗成一个安全的文件名片段。
 *
 * @param name 原始名字。
 * @returns 可直接拼进路径的片段；洗完为空时返回 `未命名`。
 */
export function sanitizeSegment(name: string): string {
  let result = String(name ?? '')
    // 路径分隔符和 Windows 不允许的字符，连控制字符一起换成下划线。
    // 空格、连字号和中文都原样留着 —— 三个平台都支持，没必要转拼音或挤掉空格。
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    // Windows 会悄悄吃掉结尾的点和空格，于是「a.」和「a」变成同一个文件、互相覆盖。
    .replace(/[. ]+$/, '');

  if (result.length > MAX_SEGMENT) result = result.slice(0, MAX_SEGMENT).replace(/[. ]+$/, '');
  if (!result) return '未命名';
  // 保留名前面加下划线，而不是整段换掉 —— 用户还能认出这是哪篇。
  if (RESERVED.has(result.toLowerCase())) return `_${result}`;
  return result;
}

/**
 * 在同一层里避开重名。
 *
 * 文档名在我们的模型里**不要求唯一**（两篇都叫「周报」是完全合法的），但文件名必须唯一，
 * 否则后写的那篇把前一篇覆盖掉，而且是静默的。
 *
 * @param used 这一层已经用掉的名字（小写），会被就地更新。
 * @param base 不含扩展名的基础名。
 * @param extension 扩展名（含点），目录传空串。
 * @returns 未被占用的完整名字。
 */
export function uniqueSegment(used: Set<string>, base: string, extension = ''): string {
  let candidate = `${base}${extension}`;
  let counter = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base} (${counter})${extension}`;
    counter += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export type ExportFile =
  | { path: string; kind: 'text'; text: string }
  | { path: string; kind: 'binary'; bytes: Uint8Array; mime: string };

export type ExportPlan = {
  /** 建议的落地名字：单篇是 `标题.md`，整棵树是根目录名。 */
  rootName: string;
  /** 需要先建出来的目录，相对导出根，自上而下排好。空目录也在里面，不会在导出时丢掉。 */
  dirs: string[];
  files: ExportFile[];
  /** 正文引用了、但库里已经没有的附件数。非 0 时界面要提示，别让用户以为图片导丢了。 */
  missingAssets: number;
};

export type ExportIO = {
  /** 取某篇文档的正文（存库形态，图片是 `fundoc-asset://`）。 */
  bodyOf(nodeId: string): string;
  /** 取某个附件的字节与类型；不存在返回 null。 */
  assetOf(assetId: string): { bytes: Uint8Array; mime: string } | null;
};

/**
 * 把正文里的 `fundoc-asset://<id>` 换成相对导出根的图片路径。
 *
 * @param markdown 存库形态的正文。
 * @param depth 这篇文档所在的层级（根下为 0），决定要回退几层。
 * @param nameOf assetId → 图片文件名（不含目录）；返回 null 表示附件已丢失。
 * @returns 改写后的正文。
 */
function rewriteAssets(
  markdown: string,
  depth: number,
  nameOf: (assetId: string) => string | null,
): string {
  // 文档在 a/b/c.md 时 depth 是 2，图片在根下的 assets/，所以要退两层。
  const prefix = `${'../'.repeat(depth)}${ASSET_DIR}/`;
  return markdown.replace(
    new RegExp(`${ASSET_SCHEME}([A-Za-z0-9_-]+)`, 'g'),
    (whole, assetId: string) => {
      const name = nameOf(assetId);
      // 丢了的附件保留原样而不是换成空链接：导出的文件里留着可见的痕迹，
      // 比悄悄变成一个坏图标更容易排查。
      return name ? `${prefix}${name}` : whole;
    },
  );
}

/** 在树里按 nodeId 找节点。树已经去过环，不必再防。 */
function findNode(nodes: TreeNode[], nodeId: string): TreeNode | null {
  for (const node of nodes) {
    if (node.nodeId === nodeId) return node;
    const hit = findNode(node.children, nodeId);
    if (hit) return hit;
  }
  return null;
}

/**
 * 算出一次导出要写哪些文件。
 *
 * @param metas 全部节点元数据。
 * @param rootId 导出哪个节点：文档则导出单篇，目录则连带全部子孙，null 表示整个库。
 * @param io 正文与附件的读取方式。
 * @returns 待写文件清单。节点不存在时返回空计划。
 */
export function buildExportPlan(
  metas: NodeMeta[],
  rootId: string | null,
  io: ExportIO,
): ExportPlan {
  // 走 buildTree 装好的树，而不是自己按 parentId 过滤：同步事故造出的环（A→B→A）里，
  // 两个节点的 parentId 都不是 null，按 parentId 递归会一个都遍历不到 —— 导出悄悄丢文档，
  // 正是备份最不能出的错。buildTree 会把它们修回根下，这里直接复用那份修复结果。
  const { roots } = buildTree(metas);
  const root = rootId ? findNode(roots, rootId) : null;
  if (rootId && !root) {
    return { rootName: '未命名', dirs: [], files: [], missingAssets: 0 };
  }

  const files: ExportFile[] = [];
  const dirs: string[] = [];
  /** assetId → 导出后的图片文件名。同一张图被多篇引用时只写一次。 */
  const assetNames = new Map<string, string>();
  const assetUsed = new Set<string>();
  let missingAssets = 0;

  const nameOf = (assetId: string): string | null => {
    const known = assetNames.get(assetId);
    if (known !== undefined) return known;

    const asset = io.assetOf(assetId);
    if (!asset) {
      missingAssets += 1;
      // 记成空串缓存住，免得同一张丢失的图被重复计数。
      assetNames.set(assetId, '');
      return null;
    }
    const name = uniqueSegment(assetUsed, sanitizeSegment(assetId), `.${extensionFor(asset.mime)}`);
    assetNames.set(assetId, name);
    files.push({
      path: `${ASSET_DIR}/${name}`,
      kind: 'binary',
      bytes: asset.bytes,
      mime: asset.mime,
    });
    return name;
  };

  /** 把一篇文档摊成一个 .md 文件。`segments` 是它所在目录的路径段。 */
  const emitDoc = (meta: NodeMeta, segments: string[], used: Set<string>): void => {
    const name = uniqueSegment(used, sanitizeSegment(meta.name), '.md');
    const markdown = io.bodyOf(meta.nodeId);
    // 先问一遍附件，顺带把图片文件登记进 files。
    for (const assetId of collectAssetIds(markdown)) nameOf(assetId);
    files.push({
      path: [...segments, name].join('/'),
      kind: 'text',
      text: rewriteAssets(markdown, segments.length, (id) => assetNames.get(id) || null),
    });
  };

  const walk = (children: TreeNode[], segments: string[]): void => {
    // used 是每层独立的：`a/周报.md` 和 `b/周报.md` 不冲突，只有同一层才需要去重。
    const used = new Set<string>();
    for (const child of children) {
      if (child.type === 'doc') {
        emitDoc(child, segments, used);
        continue;
      }
      const name = uniqueSegment(used, sanitizeSegment(child.name));
      const next = [...segments, name];
      dirs.push(next.join('/'));
      walk(child.children, next);
    }
  };

  if (root?.type === 'doc') {
    emitDoc(root, [], new Set());
  } else {
    walk(root ? root.children : roots, []);
  }

  // 图片目录只在真有图片时才建。
  if (files.some((file) => file.kind === 'binary')) dirs.unshift(ASSET_DIR);

  const rootName =
    root?.type === 'doc'
      ? `${sanitizeSegment(root.name)}.md`
      : sanitizeSegment(root?.name ?? 'FunDoc');

  return { rootName, dirs, files, missingAssets };
}
