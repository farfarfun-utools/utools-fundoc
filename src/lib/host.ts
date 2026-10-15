// uTools 宿主能力的唯一入口。真机走 window.utools，浏览器里 pnpm dev 预览时走 localStorage 垫片。
//
// 为什么要这一层：官方类型声明里 `interface Window { utools: typeof utools }` 是**非可选**的
// —— 类型上 window.utools 永远存在，运行时在浏览器里却是 undefined。没有这层抽象，每个调用点
// 都得自己记得判空，漏一个就是预览模式白屏。
//
// 另外，接口形状一律从官方声明 `Pick<typeof utools, ...>` 里取，不手写。funchat 的 CHANGELOG
// 记过这个教训：一句 `var utools: any` 盖掉官方声明后，`setExpendHeight`（8.0 已改名
// `setExpandHeight`）这类拼写错误无人校对，可选调用把「接口不存在」咽下去，功能静默失效很久
// 没人发现。把接口名交给上游兜底，拼错会在 typecheck 时就报出来。
import { fromBase64, toBase64 } from './base64';
import { clonePlain } from './plain-clone';

/** 垫片的存储键。全部压在 `fundoc.shim.` 下面 ——
 *  刻意不和业务用的 dbStorage 键（`fundoc.settings`）共享前缀：funchat 踩过这个，
 *  垫片键和业务键拼成同一个字符串时 db 与 dbStorage 会互相覆盖，
 *  "测试就会在生产不存在的路径上通过"。 */
const SHIM_DB_KEY = 'fundoc.shim.db';
const SHIM_KV_KEY = 'fundoc.shim.kv';
const SHIM_ATTACHMENT_KEY = 'fundoc.shim.attachments';

export type Db = {
  put(doc: DbDoc): DbResult;
  get(id: string): DbDoc | null;
  remove(doc: DbDoc | string): DbResult;
  allDocs(idStartsWith?: string): DbDoc[];
  postAttachment(id: string, attachment: Uint8Array, type: string): DbResult;
  getAttachment(id: string): Uint8Array | null;
  getAttachmentType(id: string): string | null;
  promises: {
    allDocs(idStartsWith?: string): Promise<DbDoc[]>;
    get(id: string): Promise<DbDoc | null>;
    put(doc: DbDoc): Promise<DbResult>;
  };
};

export type KeyValue = {
  getItem(key: string): unknown;
  setItem(key: string, value: unknown): void;
  removeItem(key: string): void;
};

/** 一次导出要写的单个文件。文本走 `text`，二进制走 base64 —— 跨进程边界传不了 Uint8Array。 */
export type WritableFile = { path: string; text?: string; base64?: string };

export type WriteResult = { ok: true; root: string } | { ok: false; message: string };

/**
 * preload.js 暴露到 `window.fundoc` 上的 Node 侧能力。浏览器预览时为 null。
 *
 * 只放渲染进程做不到的事：读写本地文件，以及取回 mainPush 选中的文档。
 */
export type Bridge = {
  /** 读一个文本文件；路径不存在或不是文本时返回 null。 */
  readTextFile(filePath: string): string | null;
  /**
   * 取出并清除「用户刚从主搜索框选中的文档」。
   *
   * 这件事必须绕一道：`MainPushResult` 只有 icon/text/title 三个字段，挂不了自定义
   * 载荷，`PluginEnterAction.option` 也只回传 text。所以 preload 在 onSelect 里把
   * nodeId 暂存起来，界面进来时取走。
   */
  takePendingOpen(): string | null;
  /**
   * 在 `parentDir` 下建出 `rootName` 目录，并把一批文件写进去，子目录自动创建。
   *
   * 路径拼接全留在 Node 侧：渲染进程里没有 `path`，自己拿 `/` 拼接在 Windows 上要出问题。
   *
   * @param parentDir 用户选的父目录（绝对路径）。
   * @param rootName 导出根目录名，单段。
   * @param dirs 需要预先建出来的相对目录，自上而下。
   * @param files 待写文件，路径相对导出根目录。
   */
  writeFiles(
    parentDir: string,
    rootName: string,
    dirs: string[],
    files: WritableFile[]
  ): WriteResult;
  /** 写单个文本文件到绝对路径（用户在保存对话框里选好的那个）。 */
  writeTextFile(filePath: string, text: string): WriteResult;
  /**
   * 写单个二进制文件到绝对路径（导出的 PNG 走这条）。
   *
   * 字节用 base64 传：跨 preload 边界的 Uint8Array 到了 Node 侧不保证还是同一种
   * 视图类型，base64 是两边都没有歧义的形态。
   */
  writeBinaryFile(filePath: string, base64: string): WriteResult;
  /** 在系统文件管理器里定位某个路径。 */
  showInFolder(target: string): void;
};

export type Host = {
  /** 真机 = true；浏览器预览 = false。界面据此隐藏只有真机才有意义的功能。 */
  readonly native: boolean;
  db: Db;
  dbStorage: KeyValue;
  bridge: Bridge | null;
  setFeature(feature: Feature): void;
  removeFeature(code: string): boolean;
  getFeatures(codes?: string[]): Feature[];
  onPluginEnter(callback: (action: PluginEnterAction) => void): void;
  onPluginOut(callback: (isKill: boolean) => void): void;
  onDbPull(callback: (docs: DbDoc[]) => void): void;
  isDarkColors(): boolean;
  outPlugin(): void;
  copyText(text: string): void;
  /**
   * 把一张图片写进系统剪贴板。
   *
   * 真机走 `utools.copyImage`（同步返回成功与否）；浏览器里走异步的
   * `navigator.clipboard.write`，所以这个口子统一成 Promise。**不能假装成功** ——
   * 浏览器要求安全上下文 + 页面有焦点，拿不到权限时要让用户看见提示，
   * 而不是看着「已复制」然后粘出个空。
   *
   * @param bytes 图片字节。
   * @param mime MIME 类型，如 `image/png`。
   * @returns 是否真的写进去了。
   */
  copyImage(bytes: Uint8Array, mime: string): Promise<boolean>;
  showNotification(body: string): void;
  /**
   * 用系统默认浏览器打开一个外部链接。
   *
   * 正文里的超链接必须走这条路，不能靠 `<a>` 的默认行为或 `window.open`：插件页跑在
   * Electron 的 BrowserView 里，这两条要么被 uTools 拦掉（表现就是「点了没反应」），
   * 要么真的把插件页本身导航走 —— 整个界面连同还没保存的编辑内容一起没了。
   *
   * @param url 绝对 URL，协议由调用方校验（见 useEditor 的 openLink）。
   */
  openExternal(url: string): void;
  /** 保存文件对话框。用户取消返回 undefined；浏览器垫片里永远 undefined。 */
  showSaveDialog(options: Parameters<typeof utools.showSaveDialog>[0]): string | undefined;
  /** 打开文件/目录对话框。用户取消返回 undefined；浏览器垫片里永远 undefined。 */
  showOpenDialog(options: Parameters<typeof utools.showOpenDialog>[0]): string[] | undefined;
};

// ───────────────────────────── 浏览器垫片 ─────────────────────────────

function readShim<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeShim(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error('[fundoc] 垫片写入失败', error);
  }
}

function createShimDb(): Db {
  type Store = Record<string, DbDoc>;
  type Attachments = Record<string, { type: string; data: string }>;

  const load = () => readShim<Store>(SHIM_DB_KEY, {});
  const save = (store: Store) => writeShim(SHIM_DB_KEY, store);

  // 垫片也做 _rev 校验。少了它，本地开发永远撞不上冲突分支，
  // 而冲突重试恰恰是真机上最容易写错的一段（docs/design.md §4.1）。
  const put = (doc: DbDoc): DbResult => {
    const store = load();
    const current = store[doc._id];
    if (current && current._rev !== doc._rev) {
      return { id: doc._id, error: true, name: 'conflict', message: 'Document update conflict' };
    }
    const revision = Number(String(current?._rev ?? '0-shim').split('-')[0]) + 1;
    const next = { ...clonePlain(doc), _rev: `${revision}-shim` };
    store[doc._id] = next;
    save(store);
    return { id: doc._id, ok: true, rev: next._rev };
  };

  const get = (id: string): DbDoc | null => load()[id] ?? null;

  const allDocs = (idStartsWith = ''): DbDoc[] =>
    Object.values(load()).filter((doc) => doc._id.startsWith(idStartsWith));

  const remove = (doc: DbDoc | string): DbResult => {
    const id = typeof doc === 'string' ? doc : doc._id;
    const store = load();
    if (!store[id]) return { id, error: true, name: 'not_found', message: 'missing' };
    delete store[id];
    save(store);
    // 附件文档被删，字节也得跟着走，否则垫片里会留下取得到的孤儿字节。
    const attachments = readShim<Attachments>(SHIM_ATTACHMENT_KEY, {});
    if (id in attachments) {
      delete attachments[id];
      writeShim(SHIM_ATTACHMENT_KEY, attachments);
    }
    return { id, ok: true };
  };

  return {
    put,
    get,
    remove,
    allDocs,
    postAttachment(id, attachment, type) {
      const attachments = readShim<Attachments>(SHIM_ATTACHMENT_KEY, {});
      attachments[id] = { type, data: toBase64(attachment) };
      writeShim(SHIM_ATTACHMENT_KEY, attachments);

      // 真机上附件同时也是一条普通文档 —— `allDocs('asset@')` 能把它列出来，
      // 清理孤立图片（asset.ts 的 findOrphanAssets）全靠这一点。垫片必须跟着建这条文档，
      // 否则清理逻辑在本地永远是空转，测试会在生产不存在的路径上通过。
      const store = load();
      store[id] = { _id: id, _rev: '1-shim', _attachmentType: type, length: attachment.byteLength };
      save(store);
      return { id, ok: true, rev: '1-shim' };
    },
    getAttachment(id) {
      const entry = readShim<Attachments>(SHIM_ATTACHMENT_KEY, {})[id];
      return entry ? fromBase64(entry.data) : null;
    },
    getAttachmentType(id) {
      return readShim<Attachments>(SHIM_ATTACHMENT_KEY, {})[id]?.type ?? null;
    },
    promises: {
      allDocs: async (idStartsWith) => allDocs(idStartsWith),
      get: async (id) => get(id),
      put: async (doc) => put(doc),
    },
  };
}

function createShimKeyValue(): KeyValue {
  type Store = Record<string, unknown>;
  return {
    getItem: (key) => readShim<Store>(SHIM_KV_KEY, {})[key] ?? null,
    setItem: (key, value) => {
      const store = readShim<Store>(SHIM_KV_KEY, {});
      store[key] = clonePlain(value);
      writeShim(SHIM_KV_KEY, store);
    },
    removeItem: (key) => {
      const store = readShim<Store>(SHIM_KV_KEY, {});
      delete store[key];
      writeShim(SHIM_KV_KEY, store);
    },
  };
}

/**
 * 构造浏览器预览用的宿主垫片。
 *
 * 动态功能（setFeature）在浏览器里只记在内存里：它本质是 uTools 客户端的本地状态，
 * 没有浏览器等价物。保留一份内存实现是为了让关键词调和逻辑（keyword.ts）能被单测覆盖。
 *
 * @returns 一个行为近似真机的宿主对象。
 */
export function createShimHost(): Host {
  const features = new Map<string, Feature>();
  return {
    native: false,
    db: createShimDb(),
    dbStorage: createShimKeyValue(),
    // 浏览器里没有 Node 侧，读本地文件和 mainPush 都无从谈起。
    bridge: null,
    setFeature: (feature) => void features.set(feature.code, clonePlain(feature)),
    removeFeature: (code) => features.delete(code),
    getFeatures: (codes) =>
      [...features.values()].filter((feature) => !codes || codes.includes(feature.code)),
    onPluginEnter: () => {},
    onPluginOut: () => {},
    onDbPull: () => {},
    isDarkColors: () => globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
    outPlugin: () => {},
    copyText: (text) => void globalThis.navigator?.clipboard?.writeText(text),
    copyImage: async (bytes, mime) => {
      const clipboard = globalThis.navigator?.clipboard;
      // ClipboardItem 得用 typeof 探：Node 里（跑单测时）这个全局压根不存在，
      // 直接引用就是 ReferenceError。
      if (!clipboard?.write || typeof ClipboardItem === 'undefined') return false;
      try {
        const blob = new Blob([bytes.slice() as BlobPart], { type: mime });
        await clipboard.write([new ClipboardItem({ [mime]: blob })]);
        return true;
      } catch (error) {
        // 没有安全上下文、页面没焦点、用户拒了权限都会落到这里。
        console.warn('[fundoc] 写剪贴板图片失败', error);
        return false;
      }
    },
    showNotification: (body) => console.warn('[fundoc]', body),
    // 浏览器里新标签页就是「外部」。noopener 是必须的：不加的话打开的页面能通过
    // window.opener 反过来操作我们这一页。
    openExternal: (url) => void globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
    // 浏览器里没有原生文件对话框。返回 undefined（= 用户取消）让调用方走各自的
    // 降级分支，而不是在这里假装成功 —— 假装成功后面一定会写到不存在的路径上。
    showSaveDialog: () => undefined,
    showOpenDialog: () => undefined,
  };
}

// ───────────────────────────── 真机 ─────────────────────────────

function createNativeHost(api: typeof utools): Host {
  return {
    native: true,
    // uTools 的 db 比我们的 Db 类型多出若干重载（allDocs(ids: string[]) 等），
    // 结构上兼容，这里只收窄到用得到的部分。
    db: api.db as unknown as Db,
    dbStorage: api.dbStorage,
    // preload 和渲染页面共享同一个 window，所以这里直接取全局。
    // 用 ?? null 而不是断言：preload 加载失败时宁可降级，也别让整个界面崩掉。
    bridge: (globalThis as { fundoc?: Bridge }).fundoc ?? null,
    setFeature: (feature) => api.setFeature(feature),
    removeFeature: (code) => api.removeFeature(code),
    getFeatures: (codes) => api.getFeatures(codes),
    onPluginEnter: (callback) => api.onPluginEnter(callback),
    onPluginOut: (callback) => api.onPluginOut(callback),
    onDbPull: (callback) => api.onDbPull(callback),
    isDarkColors: () => api.isDarkColors(),
    outPlugin: () => void api.outPlugin(),
    copyText: (text) => void api.copyText(text),
    // utools.copyImage 是同步的，签名也只收字节/路径，不收 MIME —— 它自己按内容认。
    copyImage: async (bytes) => api.copyImage(bytes),
    showNotification: (body) => api.showNotification(body),
    // 返回 Promise，但没人关心结果 —— 失败时 uTools 自己不提示，我们也拿不到原因。
    openExternal: (url) => void api.shellOpenExternal(url),
    showSaveDialog: (options) => api.showSaveDialog(options),
    showOpenDialog: (options) => api.showOpenDialog(options),
  };
}

/** 当前宿主。模块加载时定一次，之后不变。 */
export const host: Host = (() => {
  const api = (globalThis as { utools?: typeof utools }).utools;
  return api ? createNativeHost(api) : createShimHost();
})();
