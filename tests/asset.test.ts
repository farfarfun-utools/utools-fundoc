import { beforeEach, describe, expect, it } from 'vitest';
import {
  ASSET_SCHEME,
  assetDocId,
  collectAssetIds,
  findOrphanAssets,
  releaseAssetUrls,
  removeAssets,
  storeAsset,
  toRenderable,
  toStorable,
} from '../src/lib/asset';
import { host } from '../src/lib/host';
import { resetStorage } from './setup';

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

beforeEach(() => {
  resetStorage();
  releaseAssetUrls();
});

describe('collectAssetIds', () => {
  it('从 Markdown 图片语法里挖出 assetId', () => {
    const markdown = `![图](${ASSET_SCHEME}abc123)\n![另一张](${ASSET_SCHEME}def456)`;
    expect(collectAssetIds(markdown)).toEqual(['abc123', 'def456']);
  });

  it('同一张图引用多次只算一次', () => {
    const markdown = `![a](${ASSET_SCHEME}abc)![b](${ASSET_SCHEME}abc)`;
    expect(collectAssetIds(markdown)).toEqual(['abc']);
  });

  it('nanoid 里的 - 和 _ 不会把 id 截断', () => {
    expect(collectAssetIds(`![a](${ASSET_SCHEME}a-b_c)`)).toEqual(['a-b_c']);
  });

  it('没有图片时给空列表', () => {
    expect(collectAssetIds('# 纯文字')).toEqual([]);
  });

  it('不碰普通的 http 图片链接', () => {
    expect(collectAssetIds('![a](https://example.com/a.png)')).toEqual([]);
  });
});

describe('storeAsset', () => {
  it('存完能按 assetId 取回字节与类型', () => {
    const assetId = storeAsset(png(), 'image/png');
    expect(host.db.getAttachment(assetDocId(assetId))).toEqual(png());
    expect(host.db.getAttachmentType(assetDocId(assetId))).toBe('image/png');
  });

  it('每次调用生成不同的 assetId —— 附件只能创建不能更新', () => {
    expect(storeAsset(png(), 'image/png')).not.toBe(storeAsset(png(), 'image/png'));
  });

  it('超出附件 10MB 上限时抛错', () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    expect(() => storeAsset(big, 'image/png')).toThrow(/10MB 上限/);
  });
});

describe('toRenderable / toStorable', () => {
  // 存库形态必须是 fundoc-asset://，blob URL 进程重启就失效，存进库等于死链接。
  it('渲染时换成 blob URL，存库时还原回来', () => {
    const assetId = storeAsset(png(), 'image/png');
    const storable = `![图](${ASSET_SCHEME}${assetId})`;

    const renderable = toRenderable(storable);
    expect(renderable).toMatch(/^!\[图\]\(blob:/);
    expect(renderable).not.toContain(ASSET_SCHEME);

    expect(toStorable(renderable)).toBe(storable);
  });

  it('同一个 assetId 多次渲染复用同一个 URL', () => {
    const assetId = storeAsset(png(), 'image/png');
    const once = toRenderable(`${ASSET_SCHEME}${assetId}`);
    expect(toRenderable(`${ASSET_SCHEME}${assetId}`)).toBe(once);
  });

  // 附件被清掉但正文还留着引用（同步冲突会造出这种状态）：
  // 保持原样，让用户看到一个坏图占位，而不是把引用悄悄抹掉。
  it('附件不存在时原样保留引用', () => {
    const markdown = `![图](${ASSET_SCHEME}ghost)`;
    expect(toRenderable(markdown)).toBe(markdown);
  });

  it('纯文字原样穿过，不做多余替换', () => {
    expect(toStorable('# 标题')).toBe('# 标题');
  });
});

describe('removeAssets', () => {
  it('删掉附件，删不存在的也不报错', () => {
    const assetId = storeAsset(png(), 'image/png');
    removeAssets([assetId]);
    expect(host.db.getAttachment(assetDocId(assetId))).toBeNull();
    expect(() => removeAssets(['ghost'])).not.toThrow();
  });
});

describe('findOrphanAssets', () => {
  it('挑出没有任何正文引用的附件', () => {
    const used = storeAsset(png(), 'image/png');
    const orphan = storeAsset(png(), 'image/png');
    expect(findOrphanAssets([`![图](${ASSET_SCHEME}${used})`])).toEqual([orphan]);
  });

  it('全都有引用时返回空列表', () => {
    const assetId = storeAsset(png(), 'image/png');
    expect(findOrphanAssets([`${ASSET_SCHEME}${assetId}`])).toEqual([]);
  });

  it('引用分散在多篇文档里也认', () => {
    const a = storeAsset(png(), 'image/png');
    const b = storeAsset(png(), 'image/png');
    expect(findOrphanAssets([`${ASSET_SCHEME}${a}`, `${ASSET_SCHEME}${b}`])).toEqual([]);
  });
});
