// 图片等二进制内容走 uTools 的附件存储，不内联进正文。
//
// 为什么：uTools 单条文档上限 1MB。纯文字 1MB 约等于 50 万汉字，单篇写不到；真正会撞线的是
// 图片 —— 一张截图 base64 内联就是几十万字符。所以正文里只留一个 `fundoc-asset://<id>` 引用，
// 字节全放附件（单个上限 10MB）。这样正文永远是纯文本，1MB 实际碰不到。
//
// 附件「只能创建、不能更新」（uTools v2.0 删掉了 putAttachment）正好契合：图片是不变内容，
// 换图等于换一个新 assetId。代价是删文档时要自己清理引用的附件，见 collectAssetIds。
import { nanoid } from 'nanoid';
import { host } from './host';

const ASSET_PREFIX = 'asset@';
export const ASSET_SCHEME = 'fundoc-asset://';

/** 已经换出去的 blob URL，key 是 assetId。切换文档时统一回收，避免内存泄漏。 */
const blobUrls = new Map<string, string>();

/** 拼附件文档 ID。 */
export function assetDocId(assetId: string): string {
  return `${ASSET_PREFIX}${assetId}`;
}

/**
 * 把二进制内容存成附件。
 *
 * @param bytes 图片字节。
 * @param mime MIME 类型，如 `image/png`。
 * @returns 新生成的 assetId，调用方据此往正文里写 `fundoc-asset://<id>`。
 * @throws 超出 uTools 附件 10MB 上限，或写入失败时抛出。
 */
export function storeAsset(bytes: Uint8Array, mime: string): string {
  const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `这张图 ${Math.round(bytes.byteLength / 1024 / 1024)}MB，超出 uTools 附件 10MB 上限`,
    );
  }

  const assetId = nanoid();
  const result = host.db.postAttachment(assetDocId(assetId), bytes, mime);
  if (result?.error) {
    throw new Error(`图片保存失败：${result.message || result.name || '未知错误'}`);
  }
  return assetId;
}

/**
 * 取出附件并换成可直接喂给 `<img>` 的 blob URL。
 *
 * 同一个 assetId 重复调用返回同一个 URL，不会重复解码。
 *
 * @param assetId 附件标识。
 * @returns blob URL；附件不存在时返回 null。
 */
export function assetUrl(assetId: string): string | null {
  const cached = blobUrls.get(assetId);
  if (cached) return cached;

  const bytes = host.db.getAttachment(assetDocId(assetId));
  if (!bytes) return null;
  const type = host.db.getAttachmentType(assetDocId(assetId)) ?? 'image/png';

  // Uint8Array 可能来自 Node 的 Buffer（真机上 preload 侧过来的），slice 一次拿到干净的
  // ArrayBuffer，避免把整个 Buffer 池的底层内存都塞进 Blob。
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type }));
  blobUrls.set(assetId, url);
  return url;
}

/** 回收所有已发出的 blob URL。切换文档时调用。 */
export function releaseAssetUrls(): void {
  for (const url of blobUrls.values()) URL.revokeObjectURL(url);
  blobUrls.clear();
}

/**
 * 把正文里的 `fundoc-asset://<id>` 换成 blob URL，供编辑器渲染。
 * @param markdown 存库形态的 Markdown。
 * @returns 渲染形态的 Markdown。
 */
export function toRenderable(markdown: string): string {
  return markdown.replace(
    new RegExp(`${ASSET_SCHEME}([A-Za-z0-9_-]+)`, 'g'),
    (whole, assetId: string) => assetUrl(assetId) ?? whole,
  );
}

/**
 * 把编辑器里的 blob URL 还原成 `fundoc-asset://<id>`，供写库。
 *
 * 必须在保存前调用：blob URL 是一次性的，进程重启就失效，存进库等于存了个死链接。
 *
 * @param markdown 渲染形态的 Markdown。
 * @returns 存库形态的 Markdown。
 */
export function toStorable(markdown: string): string {
  let result = markdown;
  for (const [assetId, url] of blobUrls) {
    result = result.split(url).join(`${ASSET_SCHEME}${assetId}`);
  }
  return result;
}

/**
 * 找出正文引用的全部 assetId。
 *
 * 删除文档时用它清理附件，否则库里会堆垃圾 —— 附件不参与任何自动回收。
 *
 * @param markdown 存库形态的 Markdown。
 * @returns 去重后的 assetId 列表。
 */
export function collectAssetIds(markdown: string): string[] {
  const found = markdown.matchAll(new RegExp(`${ASSET_SCHEME}([A-Za-z0-9_-]+)`, 'g'));
  return [...new Set([...found].map((match) => match[1]))];
}

/** 删除附件；不存在则无动作。 */
export function removeAssets(assetIds: string[]): void {
  for (const assetId of assetIds) {
    const doc = host.db.get(assetDocId(assetId));
    if (doc) host.db.remove(doc);
    const url = blobUrls.get(assetId);
    if (url) {
      URL.revokeObjectURL(url);
      blobUrls.delete(assetId);
    }
  }
}

/**
 * 扫出库里没有被任何正文引用的附件。
 *
 * 兜底用：异常退出、同步冲突都可能留下孤立附件。设置页提供一个「清理」按钮调它。
 *
 * @param allMarkdown 全部文档的正文。
 * @returns 无引用的 assetId 列表。
 */
export function findOrphanAssets(allMarkdown: string[]): string[] {
  const referenced = new Set(allMarkdown.flatMap(collectAssetIds));
  return host.db
    .allDocs(ASSET_PREFIX)
    .map((doc) => doc._id.slice(ASSET_PREFIX.length))
    .filter((assetId) => !referenced.has(assetId));
}
