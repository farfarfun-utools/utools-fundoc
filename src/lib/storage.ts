// meta@ / body@ 的读写。所有进出数据库的路径都收在这里，别处不要直接碰 host.db。
import { host } from './host';
import { clonePlain } from './plain-clone';
import { DEFAULT_SETTINGS, type NodeBody, type NodeMeta, type Settings } from './types';

const META_PREFIX = 'meta@';
const BODY_PREFIX = 'body@';
const SETTINGS_KEY = 'fundoc.settings';

/**
 * uTools 单条数据库文档上限 1MB。
 *
 * 留 8KB 余量而不是顶着 1MB 判：存储层自己会往文档上附加元数据（_rev、序列化开销），
 * 顶着边界判等于把失败让给 `put`，而 **put 失败是静默的** —— funchat 的注释写得很清楚，
 * 真超了内容会凭空消失。宁可早 8KB 拦下来，给用户一句看得懂的话。
 */
export const MAX_DOC_BYTES = 1024 * 1024 - 8 * 1024;

/** 拼节点元数据的文档 ID。 */
export function metaId(nodeId: string): string {
  return `${META_PREFIX}${nodeId}`;
}

/** 拼节点正文的文档 ID。 */
export function bodyId(nodeId: string): string {
  return `${BODY_PREFIX}${nodeId}`;
}

/** 从 `meta@xxx` 反解出 nodeId；不是 meta 文档则返回 null。 */
export function nodeIdFromMetaId(id: string): string | null {
  return id.startsWith(META_PREFIX) ? id.slice(META_PREFIX.length) : null;
}

/** 从 `body@xxx` 反解出 nodeId；不是 body 文档则返回 null。 */
export function nodeIdFromBodyId(id: string): string | null {
  return id.startsWith(BODY_PREFIX) ? id.slice(BODY_PREFIX.length) : null;
}

/** 量一条文档序列化后的 UTF-8 字节数。 */
export function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * 写入文档，`_rev` 冲突时取回最新版本号重试一次。
 *
 * `_rev` 过期说明同一条文档在别处被写过（另一台设备同步进来，或我们自己并发写了两次）。
 * 取回当前 `_rev` 重试，让本次改动生效，而不是把失败咽下去。
 *
 * @param doc 要写入的文档，必须是纯数据（调用方负责脱响应式）。
 * @returns 数据库返回的结果。
 * @throws 重试后仍然失败时抛出，带上数据库给的错误信息。
 */
function putDocument(doc: DbDoc): DbResult {
  const result = host.db.put(doc);
  if (!result?.error) return result;

  const current = host.db.get(doc._id);
  if (!current) throw new Error(`写入失败：${result.message || result.name || '未知错误'}`);

  const retried = host.db.put({ ...doc, _rev: current._rev });
  if (retried?.error) {
    throw new Error(`写入冲突未能解决：${retried.message || retried.name || '未知错误'}`);
  }
  return retried;
}

// ───────────────────────────── 元数据 ─────────────────────────────

/**
 * 读取全部节点元数据。
 *
 * 走异步接口：同步版 `allDocs` 是阻塞式 IPC，节点多时整个界面会卡在这里。
 * 元数据每条才几百字节，几百个节点也就几十 KB —— 这正是把正文拆出去的收益
 * （docs/design.md §3.2）。
 *
 * @returns 全部节点元数据。
 */
export async function loadAllMeta(): Promise<NodeMeta[]> {
  const docs = await host.db.promises.allDocs(META_PREFIX);
  return docs.filter((doc): doc is NodeMeta => typeof doc.nodeId === 'string');
}

/**
 * 写入节点元数据，并把最新 `_rev` 写回传入对象。
 * @param meta 要保存的节点元数据。
 * @returns 带最新 `_rev` 的元数据副本。
 */
export function saveMeta(meta: NodeMeta): NodeMeta {
  const doc = clonePlain(meta) as unknown as DbDoc;
  const result = putDocument(doc);
  const saved = { ...meta, _rev: result.rev ?? meta._rev };
  return saved;
}

/** 按 nodeId 读一条元数据；不存在返回 null。 */
export function getMeta(nodeId: string): NodeMeta | null {
  const doc = host.db.get(metaId(nodeId));
  return doc && typeof doc.nodeId === 'string' ? (doc as NodeMeta) : null;
}

// ───────────────────────────── 正文 ─────────────────────────────

/**
 * 读取某篇文档的正文。
 * @param nodeId 节点标识。
 * @returns Markdown 正文；没有正文记录时返回空串。
 */
export async function loadBody(nodeId: string): Promise<string> {
  const doc = await host.db.promises.get(bodyId(nodeId));
  return typeof doc?.markdown === 'string' ? doc.markdown : '';
}

/**
 * 写入某篇文档的正文。
 *
 * @param nodeId 节点标识。
 * @param markdown Markdown 正文。
 * @returns 正文序列化后的字节数，供调用方写进 `meta.bodySize`。
 * @throws 超出 uTools 单条文档上限时抛出，不会进入 `put`。
 */
export function saveBody(nodeId: string, markdown: string): number {
  const existing = host.db.get(bodyId(nodeId));
  const doc: NodeBody & DbDoc = {
    _id: bodyId(nodeId),
    ...(existing?._rev ? { _rev: existing._rev } : {}),
    nodeId,
    markdown,
    updatedAt: Date.now(),
  };

  const bytes = byteSize(doc);
  if (bytes > MAX_DOC_BYTES) {
    throw new Error(
      `这篇文档已达 ${Math.round(bytes / 1024)}KB，超出 uTools 单条数据 1MB 上限。` +
        '请把图片改为粘贴（会自动转存为附件）或拆分文档。',
    );
  }

  putDocument(doc);
  return bytes;
}

/** 删除某篇文档的正文记录；不存在则无动作。 */
export function removeBody(nodeId: string): void {
  const doc = host.db.get(bodyId(nodeId));
  if (doc) host.db.remove(doc);
}

/** 删除某个节点的元数据；不存在则无动作。 */
export function removeMeta(nodeId: string): void {
  const doc = host.db.get(metaId(nodeId));
  if (doc) host.db.remove(doc);
}

// ───────────────────────────── 设置 ─────────────────────────────

/**
 * 读取设置，缺失字段用默认值补齐。
 * @returns 当前设置。
 */
export function loadSettings(): Settings {
  const stored = host.dbStorage.getItem(SETTINGS_KEY);
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) };
}

/** 写入设置。 */
export function saveSettings(settings: Settings): void {
  host.dbStorage.setItem(SETTINGS_KEY, clonePlain(settings));
}
