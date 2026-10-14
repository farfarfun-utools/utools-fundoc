// 导出落地的测试。
//
// 这一层全是副作用，所以被测的恰恰是「分流对不对」：真机走原生对话框 + 写盘，
// 浏览器走下载，单文件和多文件又各走一条。分流错了的表现是「点了导出什么都没发生」，
// 这种静默失败在界面上看不出来，只能靠测试钉住。
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportPlan } from '../src/lib/export';
import { deliverPlan } from '../src/lib/export-sink';
import { host, type Bridge, type WritableFile } from '../src/lib/host';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const plan = (overrides: Partial<ExportPlan> = {}): ExportPlan => ({
  rootName: '文档.md',
  dirs: [],
  files: [{ path: '文档.md', kind: 'text', text: '# 标题' }],
  missingAssets: 0,
  ...overrides,
});

/** 带图片的单篇：两个文件 + 一个 assets 目录。 */
const planWithAsset = (): ExportPlan => ({
  rootName: '文档',
  dirs: ['assets'],
  files: [
    { path: '文档.md', kind: 'text', text: '![图](assets/1.png)' },
    { path: 'assets/1.png', kind: 'binary', bytes: png(), mime: 'image/png' },
  ],
  missingAssets: 0,
});

/**
 * 读 zip 的中央目录。
 *
 * 只取名字、CRC 和原始大小 —— 格式本身在 zip.test.ts 里已经用系统 unzip 验过，
 * 这里要确认的只是「哪些条目进了包」。
 */
function centralEntries(zip: Uint8Array): Array<{ name: string; crc: number; size: number }> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // 我们的包不带注释，EOCD 固定在最后 22 字节。
  const eocd = zip.length - 22;
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);

  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    entries.push({
      name: decoder.decode(zip.subarray(at + 46, at + 46 + nameLength)),
      crc: view.getUint32(at + 16, true),
      size: view.getUint32(at + 24, true),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ── 宿主打桩 ──
//
// host 是模块级单例（加载时按有没有 window.utools 定下来），测试里直接改它的属性，
// 跑完还原。比 vi.mock 整个模块省事，也不用管模块缓存。
type Download = { name: string; blob: Blob };

let downloads: Download[];
let revoked: string[];
const original = {
  native: host.native,
  bridge: host.bridge,
  showSaveDialog: host.showSaveDialog,
  showOpenDialog: host.showOpenDialog,
};

function setNative(value: boolean): void {
  // native 在 Host 类型上是只读的（它确实不该在运行时变），测试里绕一下。
  Object.defineProperty(host, 'native', { value, configurable: true });
}

/** 装上够 download() 用的最小 DOM 和 URL。 */
function stubBrowser(): void {
  downloads = [];
  revoked = [];
  const anchor = { href: '', download: '', click: () => {} };
  anchor.click = () => {
    const blob = blobByUrl.get(anchor.href);
    if (blob) downloads.push({ name: anchor.download, blob });
  };

  const blobByUrl = new Map<string, Blob>();
  let counter = 0;

  vi.stubGlobal('document', { createElement: () => anchor });
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => {
      const url = `blob:fundoc/${(counter += 1)}`;
      blobByUrl.set(url, blob);
      return url;
    },
    revokeObjectURL: (url: string) => void revoked.push(url),
  });
}

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

beforeEach(() => {
  // 真时钟会留一个 10 秒的 revokeObjectURL 定时器挂在那儿。
  vi.useFakeTimers();
  setNative(false);
  host.bridge = null;
  stubBrowser();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setNative(original.native);
  host.bridge = original.bridge;
  host.showSaveDialog = original.showSaveDialog;
  host.showOpenDialog = original.showOpenDialog;
});

describe('deliverPlan 空计划', () => {
  it('没有文件也没有目录时直接报错', () => {
    expect(deliverPlan(plan({ dirs: [], files: [] }))).toEqual({
      status: 'failed',
      message: '没有可导出的内容',
    });
    expect(downloads).toEqual([]);
  });
});

describe('deliverPlan 浏览器', () => {
  it('单篇纯文本直接下载 .md', async () => {
    const outcome = deliverPlan(plan());

    expect(outcome).toEqual({ status: 'done', target: '文档.md', revealable: false });
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toBe('文档.md');
    expect(downloads[0].blob.type).toBe('text/markdown;charset=utf-8');
    expect(await downloads[0].blob.text()).toBe('# 标题');
  });

  it('下载后延迟回收 blob url，不在下载开始前就 revoke', () => {
    deliverPlan(plan());

    expect(revoked).toEqual([]);
    vi.runAllTimers();
    expect(revoked).toHaveLength(1);
  });

  it('带图片的单篇打成 zip，所有东西套在根目录下', async () => {
    const outcome = deliverPlan(planWithAsset());

    expect(outcome).toEqual({ status: 'done', target: '文档.zip', revealable: false });
    expect(downloads[0].name).toBe('文档.zip');
    expect(downloads[0].blob.type).toBe('application/zip');

    const entries = centralEntries(await bytesOf(downloads[0].blob));
    expect(entries.map((entry) => entry.name)).toEqual([
      '文档/',
      '文档/assets/',
      '文档/文档.md',
      '文档/assets/1.png',
    ]);
  });

  it('zip 里的正文和图片字节都是原样', async () => {
    deliverPlan(planWithAsset());
    const entries = centralEntries(await bytesOf(downloads[0].blob));
    const find = (name: string) => entries.find((entry) => entry.name === name)!;

    const markdown = encoder.encode('![图](assets/1.png)');
    expect(find('文档/文档.md').size).toBe(markdown.length);
    expect(find('文档/文档.md').crc).toBe(zlib.crc32(Buffer.from(markdown)));
    expect(find('文档/assets/1.png').size).toBe(png().length);
    expect(find('文档/assets/1.png').crc).toBe(zlib.crc32(Buffer.from(png())));

    // 目录条目是空的。
    expect(find('文档/').size).toBe(0);
  });

  it('空目录也进 zip —— 那是用户自己建的结构', async () => {
    const outcome = deliverPlan(
      plan({
        rootName: 'FunDoc',
        dirs: ['数学', '数学/线性代数', '空目录'],
        files: [{ path: '数学/向量.md', kind: 'text', text: '# 向量' }],
      }),
    );

    expect(outcome).toMatchObject({ status: 'done', target: 'FunDoc.zip' });
    const entries = centralEntries(await bytesOf(downloads[0].blob));
    expect(entries.map((entry) => entry.name)).toEqual([
      'FunDoc/',
      'FunDoc/数学/',
      'FunDoc/数学/线性代数/',
      'FunDoc/空目录/',
      'FunDoc/数学/向量.md',
    ]);
  });

  it('只有目录没有文件时也能导出（整库是空的但有目录结构）', async () => {
    const outcome = deliverPlan(plan({ rootName: 'FunDoc', dirs: ['草稿'], files: [] }));

    expect(outcome).toMatchObject({ status: 'done', target: 'FunDoc.zip' });
    const entries = centralEntries(await bytesOf(downloads[0].blob));
    expect(entries.map((entry) => entry.name)).toEqual(['FunDoc/', 'FunDoc/草稿/']);
  });

  it('没有 document 的环境报错而不是抛异常', () => {
    vi.stubGlobal('document', undefined);

    expect(deliverPlan(plan())).toEqual({ status: 'failed', message: '当前环境不支持下载' });
  });

  it('真机但 preload 没加载上时退回下载', () => {
    setNative(true);
    host.bridge = null;

    expect(deliverPlan(plan())).toMatchObject({ status: 'done', revealable: false });
    expect(downloads).toHaveLength(1);
  });
});

describe('deliverPlan 真机', () => {
  let written: Array<{ kind: 'text'; path: string; text: string } | {
    kind: 'files';
    parent: string;
    rootName: string;
    dirs: string[];
    files: WritableFile[];
  }>;

  /** 只实现 deliverPlan 用得到的两个方法，其余留空。 */
  function stubBridge(result: { ok: true; root: string } | { ok: false; message: string }): void {
    written = [];
    host.bridge = {
      writeTextFile: (path: string, text: string) => {
        written.push({ kind: 'text', path, text });
        return result;
      },
      writeFiles: (parent: string, rootName: string, dirs: string[], files: WritableFile[]) => {
        written.push({ kind: 'files', parent, rootName, dirs, files });
        return result;
      },
    } as unknown as Bridge;
  }

  beforeEach(() => {
    setNative(true);
    stubBridge({ ok: true, root: '/home/u/下载/文档.md' });
  });

  it('单篇走保存对话框，拿到的路径原样交给 preload', () => {
    const save = vi.fn(() => '/home/u/下载/文档.md');
    host.showSaveDialog = save;
    host.showOpenDialog = vi.fn(() => undefined);

    const outcome = deliverPlan(plan());

    expect(outcome).toEqual({
      status: 'done',
      target: '/home/u/下载/文档.md',
      revealable: true,
    });
    expect(save).toHaveBeenCalledWith({
      title: '导出 Markdown',
      defaultPath: '文档.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    expect(written).toEqual([
      { kind: 'text', path: '/home/u/下载/文档.md', text: '# 标题' },
    ]);
    // 走原生路径时不该再触发一次下载。
    expect(downloads).toEqual([]);
  });

  it('用户取消保存对话框 → cancelled，而且什么都没写', () => {
    host.showSaveDialog = vi.fn(() => undefined);

    expect(deliverPlan(plan())).toEqual({ status: 'cancelled' });
    expect(written).toEqual([]);
  });

  it('多文件走选目录对话框，目录和文件一起交给 preload', () => {
    const open = vi.fn(() => ['/home/u/下载']);
    host.showOpenDialog = open;
    stubBridge({ ok: true, root: '/home/u/下载/文档' });

    const outcome = deliverPlan(planWithAsset());

    expect(outcome).toEqual({ status: 'done', target: '/home/u/下载/文档', revealable: true });
    expect(open).toHaveBeenCalledWith({
      title: '选择导出到哪个目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    expect(written).toEqual([
      {
        kind: 'files',
        parent: '/home/u/下载',
        rootName: '文档',
        dirs: ['assets'],
        // 二进制过 IPC 要转 base64，文本不转。
        files: [
          { path: '文档.md', text: '![图](assets/1.png)' },
          { path: 'assets/1.png', base64: Buffer.from(png()).toString('base64') },
        ],
      },
    ]);
  });

  it('选目录对话框返回空数组也算取消', () => {
    host.showOpenDialog = vi.fn(() => []);

    expect(deliverPlan(planWithAsset())).toEqual({ status: 'cancelled' });
    expect(written).toEqual([]);
  });

  it('写盘失败时把 preload 的消息透出来', () => {
    host.showOpenDialog = vi.fn(() => ['/home/u/下载']);
    stubBridge({ ok: false, message: '没有写入权限' });

    expect(deliverPlan(planWithAsset())).toEqual({
      status: 'failed',
      message: '没有写入权限',
    });
  });

  it('单文件写盘失败同样透出消息', () => {
    host.showSaveDialog = vi.fn(() => '/x/文档.md');
    stubBridge({ ok: false, message: '磁盘已满' });

    expect(deliverPlan(plan())).toEqual({ status: 'failed', message: '磁盘已满' });
  });
});
