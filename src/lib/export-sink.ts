// 把导出计划真正落地。
//
// 刻意和 export.ts 分开：那边是「要写哪些文件」的纯计算，这边是「怎么写出去」的副作用。
// 两条落地路径差别很大 —— 真机有 fs，能写成真的目录结构，用户之后可以直接编辑；
// 浏览器里只能下载，一次只能给一个文件，所以多文件要打成 zip。
//
// 计划里的路径一律是相对导出根的 `a/b/c.md`。真机上的拼接全交给 preload（它有 path），
// 这里不做任何平台相关的拼接。
import { toBase64 } from './base64';
import type { ExportFile, ExportPlan } from './export';
import { host, type WritableFile } from './host';
import { createZip, type ZipEntry } from './zip';

export type ExportOutcome =
  /** 写成了。`target` 是落地路径（真机）或下载的文件名（浏览器）。 */
  | { status: 'done'; target: string; revealable: boolean }
  /** 用户在对话框里取消了。不是错误，界面不该报红。 */
  | { status: 'cancelled' }
  | { status: 'failed'; message: string };

/** 计划是不是「只有一个 .md、没有图片也没有子目录」。这种情况直接存成单文件更顺手。 */
function isSingleFile(plan: ExportPlan): boolean {
  return plan.dirs.length === 0 && plan.files.length === 1 && plan.files[0].kind === 'text';
}

function toWritable(file: ExportFile): WritableFile {
  return file.kind === 'text'
    ? { path: file.path, text: file.text }
    : { path: file.path, base64: toBase64(file.bytes) };
}

/** 触发一次浏览器下载。 */
function download(name: string, bytes: Uint8Array | string, mime: string): void {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  // 立刻 revoke 会在部分浏览器里把下载打断（下载是异步开始的），延后一拍。
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * 浏览器里落地：单文件直接下载 .md，多文件打成 zip。
 *
 * zip 里所有东西都套在 `rootName/` 下面 —— 不套的话用户在下载目录里解压，
 * 十几个 .md 会直接散到当前目录。
 */
function deliverInBrowser(plan: ExportPlan): ExportOutcome {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return { status: 'failed', message: '当前环境不支持下载' };
  }

  if (isSingleFile(plan)) {
    const file = plan.files[0];
    download(plan.rootName, file.kind === 'text' ? file.text : '', 'text/markdown;charset=utf-8');
    return { status: 'done', target: plan.rootName, revealable: false };
  }

  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [
    { path: `${plan.rootName}/` },
    // 空目录也要留着：文档树里的空目录是用户自己建的结构，导出时丢掉是信息损失。
    ...plan.dirs.map((dir) => ({ path: `${plan.rootName}/${dir}/` })),
    ...plan.files.map((file) => ({
      path: `${plan.rootName}/${file.path}`,
      bytes: file.kind === 'text' ? encoder.encode(file.text) : file.bytes,
    })),
  ];

  const name = `${plan.rootName}.zip`;
  download(name, createZip(entries), 'application/zip');
  return { status: 'done', target: name, revealable: false };
}

/**
 * 把一份导出计划写出去。
 *
 * 真机会弹原生对话框让用户选位置；浏览器预览走下载。
 *
 * @param plan buildExportPlan 的结果。
 * @returns 落地结果。用户取消时是 `cancelled`，不是失败。
 */
export function deliverPlan(plan: ExportPlan): ExportOutcome {
  if (!plan.files.length && !plan.dirs.length) {
    return { status: 'failed', message: '没有可导出的内容' };
  }

  // 用 host.native 而不是「对话框返回了 undefined」来分流：垫片里的对话框永远返回
  // undefined，和「用户点了取消」长得一样，混在一起会把浏览器预览里的导出变成静默失败。
  const bridge = host.bridge;
  if (!host.native || !bridge) return deliverInBrowser(plan);

  if (isSingleFile(plan)) {
    const file = plan.files[0];
    const target = host.showSaveDialog({
      title: '导出 Markdown',
      defaultPath: plan.rootName,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (!target) return { status: 'cancelled' };
    const result = bridge.writeTextFile(target, file.kind === 'text' ? file.text : '');
    return result.ok
      ? { status: 'done', target: result.root, revealable: true }
      : { status: 'failed', message: result.message };
  }

  const picked = host.showOpenDialog({
    title: '选择导出到哪个目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  const parent = picked?.[0];
  if (!parent) return { status: 'cancelled' };

  const result = bridge.writeFiles(parent, plan.rootName, plan.dirs, plan.files.map(toWritable));
  return result.ok
    ? { status: 'done', target: result.root, revealable: true }
    : { status: 'failed', message: result.message };
}
