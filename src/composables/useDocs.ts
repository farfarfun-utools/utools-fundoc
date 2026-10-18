// 全局状态与所有写库动作。界面组件只读 state、只调这里的函数，不直接碰 storage/host。
import { computed, reactive, ref, watch } from 'vue';
import { nanoid } from 'nanoid';
import { host } from '../lib/host';
import {
  byteSize,
  loadAllMeta,
  loadBody,
  loadSettings,
  removeBody,
  removeMeta,
  saveBody,
  saveMeta,
  saveSettings,
  nodeIdFromBodyId,
  nodeIdFromMetaId,
} from '../lib/storage';
import {
  ORDER_STEP,
  buildTree,
  descendantsOf,
  isSelfOrDescendant,
  orderBetween,
  pathOf,
  reindex,
  siblingsOf,
} from '../lib/tree';
import {
  assetDocId,
  collectAssetIds,
  findOrphanAssets,
  releaseAssetUrls,
  removeAssets,
  toStorable,
} from '../lib/asset';
import { settleWithin, timeoutError } from '../lib/deadline';
import { buildExportPlan, sanitizeSegment, type ExportIO } from '../lib/export';
import { deliverBytes, deliverPlan } from '../lib/export-sink';
import { numberHeadings } from '../lib/heading-number';
import { printDocument } from '../lib/print';
import { snapshotMarkdown, type Snapshot } from '../lib/snapshot';
import { nodeIdFromFeatureCode, reconcileFeatures, unregisterFeature } from '../lib/keyword';
import { firstHeading, parseOutline } from '../lib/outline';
import type { NodeMeta, NodeType, Settings } from '../lib/types';

const EXPANDED_KEY = 'fundoc.ui.expanded';

/**
 * 出一张图的总期限。
 *
 * 比里面各步期限之和短：那些是单步上限，正常一篇长文全程也就一两秒。到这个点还没结果，
 * 说明有一步挂住了，这时候「报错并把按钮放开」远好于继续等。
 */
const IMAGE_TIMEOUT = 45_000;

const WELCOME = `# 欢迎使用 FunDoc

左边是文档树，右边是本文大纲。试试在工具栏切换 **所见即所得 / 即时渲染 / 分屏** 三种模式。

## 公式

行内公式：当 $a \\ne 0$ 时，$ax^2 + bx + c = 0$ 有两个根。

块级公式：

$$
x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
$$

公式引擎是 KaTeX，字体和脚本都打包在插件里，**断网也能渲染**。

## 关键词

点标题栏的关键词按钮，打开开关就能把这篇文档注册成 uTools 的全局搜索入口 ——
之后在 uTools 主搜索框直接敲关键词就能跳到这里。留空关键词时用标题当关键词。

## 代码

\`\`\`python
def fib(n: int) -> int:
    return n if n < 2 else fib(n - 1) + fib(n - 2)
\`\`\`
`;

type State = {
  metas: NodeMeta[];
  activeNodeId: string | null;
  /** 当前文档正文，**存库形态**（图片是 fundoc-asset:// 而不是 blob URL）。 */
  markdown: string;
  loading: boolean;
  dirty: boolean;
  /**
   * 正文被**外部**替换的次数（切换文档、同步覆盖、冲突处理）。
   *
   * 编辑器靠它决定何时回灌内容。不能直接 watch `markdown`：那是编辑器自己输入时也会变的，
   * 会变成「输入 → 回灌 → 光标跳到开头」的回环。
   */
  contentEpoch: number;
  settings: Settings;
  /**
   * 系统当前是不是暗色。
   *
   * 不直接用 `host.isDarkColors()`：那是个普通函数调用，不是响应式的，用户在系统设置里
   * 切换深浅色时界面不会跟着变。这里由 matchMedia 监听器维护。
   */
  systemDark: boolean;
  expanded: string[];
  /**
   * 「请编辑器重贴一次主题」的计数。
   *
   * 打印会把 Vditor 的全局内容主题切成亮色（见 printActive），编辑器得知道该恢复。
   * 不直接盯 `dark`：那个值在打印前后并没有变，watch 不会触发。
   */
  themeEpoch: number;
  /**
   * 正在跑一件要等的活儿（目前只有出图）。
   *
   * 出一张长文的 PNG 是几百毫秒到几秒的事，期间按钮要禁掉：重复点会并发开好几个离屏
   * 渲染，它们都会抢着切 Vditor 的全局内容主题，收尾顺序一乱编辑器就留在亮色上了。
   */
  busy: boolean;
  /** 当前文档在别的设备上被改了，而本地有未保存改动。非 null 时界面显示冲突条。 */
  conflict: { remoteMarkdown: string } | null;
  notice: string;
};

const state = reactive<State>({
  metas: [],
  activeNodeId: null,
  markdown: '',
  loading: true,
  dirty: false,
  contentEpoch: 0,
  settings: loadSettings(),
  systemDark: host.isDarkColors(),
  expanded: (host.dbStorage.getItem(EXPANDED_KEY) as string[]) ?? [],
  themeEpoch: 0,
  busy: false,
  conflict: null,
  notice: '',
});

/** 正文已经变化但还没落盘时的定时器。 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** 外部请求打开某篇文档（来自 onPluginEnter 的关键词跳转）。 */
const pendingOpen = ref<string | null>(null);

const tree = computed(() => buildTree(state.metas));
const activeMeta = computed(() =>
  state.activeNodeId ? (state.metas.find((m) => m.nodeId === state.activeNodeId) ?? null) : null,
);
const outline = computed(() => parseOutline(state.markdown));
// 编号单独算而不是塞进 OutlineItem：parseOutline 的结果还被标题兜底关键词和搜索用着，
// 那两处不关心编号。开关关掉时也不必白算一遍。
const outlineNumbers = computed(() =>
  state.settings.headingNumber ? numberHeadings(outline.value.map((item) => item.level)) : [],
);
/** 当前该用暗色还是亮色。设置里选了固定值就用固定值，否则跟随系统。 */
const dark = computed(() =>
  state.settings.theme === 'system' ? state.systemDark : state.settings.theme === 'dark',
);
const activePath = computed(() =>
  state.activeNodeId ? pathOf(state.metas, state.activeNodeId) : '',
);

function notify(message: string): void {
  state.notice = message;
  if (message) setTimeout(() => void (state.notice === message && (state.notice = '')), 4000);
}

/**
 * 从外部替换正文（切文档、同步覆盖），并通知编辑器回灌。
 * @param markdown 新正文，存库形态。
 */
function setMarkdownExternal(markdown: string): void {
  state.markdown = markdown;
  state.dirty = false;
  state.contentEpoch += 1;
}

function replaceMeta(meta: NodeMeta): void {
  const index = state.metas.findIndex((m) => m.nodeId === meta.nodeId);
  if (index < 0) state.metas.push(meta);
  else state.metas[index] = meta;
}

/** 写一条元数据并更新内存，失败时把错误提示出去而不是静默吞掉。 */
function commitMeta(meta: NodeMeta): boolean {
  try {
    replaceMeta(saveMeta({ ...meta, updatedAt: Date.now() }));
    return true;
  } catch (error) {
    notify(error instanceof Error ? error.message : '保存失败');
    return false;
  }
}

// ───────────────────────────── 加载 ─────────────────────────────

/**
 * 重读全部元数据、装树并调和关键词。
 * @param options.keepActive 是否保留当前打开的文档（同步刷新时为 true）。
 */
async function reload(options: { keepActive?: boolean } = {}): Promise<void> {
  state.metas = await loadAllMeta();

  const { repaired } = tree.value;
  if (repaired.length) {
    // 同步事故造出的环或孤儿已经被挂回根下。告诉用户，别让文档"莫名跑到根目录"显得像 bug。
    notify(`已修复 ${repaired.length} 个异常节点（原父目录丢失或存在循环），它们被移到了根目录`);
  }

  // 关键词配置随库同步过来了，但动态功能是本机状态、不会同步 —— 必须在这里对齐一次，
  // 否则另一台设备上配好的关键词在本机搜不到（docs/design.md §5.3）。
  if (host.native) reconcileFeatures(state.metas);

  if (!options.keepActive) {
    const target = pendingOpen.value ?? state.activeNodeId;
    pendingOpen.value = null;
    const exists = target && state.metas.some((m) => m.nodeId === target && m.type === 'doc');
    await openNode(exists ? target! : firstDocId());
  }

  state.loading = false;
}

function firstDocId(): string | null {
  const walk = (nodes: ReturnType<typeof buildTree>['roots']): string | null => {
    for (const node of nodes) {
      if (node.type === 'doc') return node.nodeId;
      const found = walk(node.children);
      if (found) return found;
    }
    return null;
  };
  return walk(tree.value.roots);
}

/** 首次运行时放一篇欢迎文档，顺带演示公式与关键词。 */
async function seedIfEmpty(): Promise<void> {
  if (state.metas.length) return;
  const nodeId = nanoid();
  const now = Date.now();
  const meta: NodeMeta = {
    _id: `meta@${nodeId}`,
    nodeId,
    type: 'doc',
    name: '欢迎使用 FunDoc',
    parentId: null,
    order: ORDER_STEP,
    createdAt: now,
    updatedAt: now,
    keywordEnabled: false,
    keywords: [],
    bodySize: byteSize(WELCOME),
  };
  try {
    saveBody(nodeId, WELCOME);
    replaceMeta(saveMeta(meta));
  } catch (error) {
    notify(error instanceof Error ? error.message : '初始化失败');
  }
}

// ───────────────────────────── 打开与保存 ─────────────────────────────

/**
 * 打开一篇文档。会先把当前文档落盘。
 * @param nodeId 要打开的文档标识；传 null 表示清空编辑区。
 */
async function openNode(nodeId: string | null): Promise<void> {
  if (nodeId === state.activeNodeId) return;
  flush();
  if (state.dirty) {
    notify(state.conflict ? '先处理当前文档的同步冲突' : '当前文档尚未保存，无法切换');
    return;
  }

  // blob URL 是按 assetId 缓存的，换文档时统一回收，否则长时间使用会攒一堆。
  releaseAssetUrls();

  state.conflict = null;
  state.activeNodeId = nodeId;
  setMarkdownExternal(nodeId ? await loadBody(nodeId) : '');
}

/**
 * 编辑器内容变化时调用。只更新内存并重置防抖计时，不立即写库。
 * @param markdown 编辑器当前内容（渲染形态，图片可能是 blob URL）。
 */
function setMarkdown(markdown: string): void {
  // 存库前把 blob URL 还原成 fundoc-asset://。blob URL 是一次性的，
  // 存进库等于存了个死链接。
  const storable = toStorable(markdown);
  if (storable === state.markdown) return;
  state.markdown = storable;
  state.dirty = true;

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, state.settings.autoSaveDelay);
}

/**
 * 立即把当前文档落盘。
 *
 * 切换文档、退出插件、窗口失焦时都要调。**`onPluginOut` 和 `pagehide` 两个都得注册** ——
 * uTools 退出插件默认是转后台，不触发 `pagehide`（funchat 为此丢过整轮回复）。
 */
function flush(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const nodeId = state.activeNodeId;
  if (!nodeId || !state.dirty || state.conflict) return;

  try {
    // 先写正文再写元数据：万一中间失败，"正文已存但时间戳旧"远好于
    // "元数据说更新了但正文没落盘"。
    const bytes = saveBody(nodeId, state.markdown);
    const meta = state.metas.find((m) => m.nodeId === nodeId);
    if (meta) {
      const heading = state.settings.syncTitleFromHeading ? firstHeading(state.markdown) : '';
      const name = heading || meta.name;
      const next = { ...meta, name, bodySize: bytes, updatedAt: Date.now() };
      replaceMeta(saveMeta(next));
      // 标题可能正被用作关键词（开关开 + 没填自定义词），改了标题要重新注册。
      if (host.native && next.name !== meta.name) reconcileFeatures(state.metas);
    }
    state.dirty = false;
  } catch (error) {
    notify(error instanceof Error ? error.message : '保存失败');
  }
}

// ───────────────────────────── 增删改 ─────────────────────────────

/**
 * 新建目录或文档。
 *
 * @param type 节点类型。
 * @param parentId 放在哪个目录下；null 表示根。
 * @param options.name 节点名；默认按类型取「新建目录」/「未命名文档」。
 * @param options.markdown 文档初始正文；默认空。
 * @param options.open 建完是否打开；默认只有文档会打开。冲突「另存副本」要留在当前
 *   文档上，必须显式传 false。
 * @returns 新节点标识；失败时返回 null。
 */
async function createNode(
  type: NodeType,
  parentId: string | null,
  options: { name?: string; markdown?: string; open?: boolean } = {},
): Promise<string | null> {
  const nodeId = nanoid();
  const now = Date.now();
  const siblings = siblingsOf(state.metas, parentId);
  const last = siblings.at(-1)?.order ?? null;
  const order = orderBetween(last, null) ?? (siblings.length + 1) * ORDER_STEP;
  const markdown = options.markdown ?? '';

  const meta: NodeMeta = {
    _id: `meta@${nodeId}`,
    nodeId,
    type,
    name: options.name ?? (type === 'dir' ? '新建目录' : '未命名文档'),
    parentId,
    order,
    createdAt: now,
    updatedAt: now,
    ...(type === 'doc'
      ? { keywordEnabled: false, keywords: [], bodySize: byteSize(markdown) }
      : {}),
  };

  if (type === 'doc') {
    try {
      saveBody(nodeId, markdown);
    } catch (error) {
      notify(error instanceof Error ? error.message : '新建失败');
      return null;
    }
  }
  if (!commitMeta(meta)) return null;

  if (parentId && !state.expanded.includes(parentId)) state.expanded.push(parentId);
  if (options.open ?? type === 'doc') await openNode(nodeId);
  return nodeId;
}

/** 改名。文档改名可能影响关键词（标题兜底），所以要重新调和。 */
function renameNode(nodeId: string, name: string): void {
  const meta = state.metas.find((m) => m.nodeId === nodeId);
  const trimmed = name.trim();
  if (!meta || !trimmed || trimmed === meta.name) return;
  if (!commitMeta({ ...meta, name: trimmed })) return;
  if (host.native) reconcileFeatures(state.metas);
}

/**
 * 移动节点到新的父目录，并插到某个同级节点之前。
 *
 * @param nodeId 被拖动的节点。
 * @param parentId 目标父目录；null 表示根。
 * @param beforeNodeId 插到这个同级节点之前；null 表示放到末尾。
 * @returns 是否成功。
 */
function moveNode(nodeId: string, parentId: string | null, beforeNodeId: string | null): boolean {
  const meta = state.metas.find((m) => m.nodeId === nodeId);
  if (!meta) return false;

  // 把目录拖进它自己的子树会当场造出一个环，必须挡住。
  if (meta.type === 'dir' && isSelfOrDescendant(state.metas, nodeId, parentId)) {
    notify('不能把目录移动到它自己的下级目录里');
    return false;
  }
  if (parentId) {
    const parent = state.metas.find((m) => m.nodeId === parentId);
    if (!parent || parent.type !== 'dir') return false;
  }

  const siblings = siblingsOf(state.metas, parentId).filter((m) => m.nodeId !== nodeId);
  const index = beforeNodeId ? siblings.findIndex((m) => m.nodeId === beforeNodeId) : -1;
  const before = index < 0 ? (siblings.at(-1)?.order ?? null) : (siblings[index - 1]?.order ?? null);
  const after = index < 0 ? null : siblings[index].order;

  const order = orderBetween(before, after);
  if (order === null) {
    // 相邻 order 挤没整数空隙了，对这一层做一次重排。罕见路径，不是每次拖拽都走。
    const target = [...siblings];
    target.splice(index < 0 ? target.length : index, 0, { ...meta, parentId });
    for (const changed of reindex(target)) {
      if (!commitMeta(changed)) return false;
    }
    const fresh = state.metas.find((m) => m.nodeId === nodeId)!;
    return commitMeta({ ...fresh, parentId });
  }

  return commitMeta({ ...meta, parentId, order });
}

/**
 * 删除节点。目录会连带删除全部子孙。
 *
 * 顺序是刻意的：先摘关键词入口，再删正文和附件，最后删元数据。中途失败也不会留下
 * "能搜到但打不开"的死入口。
 *
 * @param nodeId 要删除的节点。
 */
async function deleteNode(nodeId: string): Promise<void> {
  const meta = state.metas.find((m) => m.nodeId === nodeId);
  if (!meta) return;

  const victims = [meta, ...descendantsOf(state.metas, nodeId)];

  for (const victim of victims) {
    if (victim.type === 'doc') {
      if (host.native) unregisterFeature(victim.nodeId);
      // 附件不参与任何自动回收，不手动清就会永久留在库里。
      const markdown = await loadBody(victim.nodeId);
      removeAssets(collectAssetIds(markdown));
      removeBody(victim.nodeId);
    }
    removeMeta(victim.nodeId);
  }

  const gone = new Set(victims.map((v) => v.nodeId));
  state.metas = state.metas.filter((m) => !gone.has(m.nodeId));
  state.expanded = state.expanded.filter((id) => !gone.has(id));

  if (state.activeNodeId && gone.has(state.activeNodeId)) {
    state.dirty = false; // 文档已经删了，别再把内容写回去
    state.activeNodeId = null;
    await openNode(firstDocId());
  }
}

/**
 * 设置某篇文档的关键词。
 * @param nodeId 文档标识。
 * @param enabled 开关。
 * @param keywords 自定义关键词；空数组表示用标题兜底。
 */
function setKeywords(nodeId: string, enabled: boolean, keywords: string[]): void {
  const meta = state.metas.find((m) => m.nodeId === nodeId);
  if (!meta) return;
  const cleaned = [...new Set(keywords.map((w) => w.trim()).filter(Boolean))];
  if (!commitMeta({ ...meta, keywordEnabled: enabled, keywords: cleaned })) return;
  if (host.native) reconcileFeatures(state.metas);
}

/**
 * 清理没有被任何正文引用的附件。
 *
 * 兜底用：异常退出、同步冲突都可能留下孤立图片，而附件不参与任何自动回收。
 * 设置面板提供一个按钮调它。
 *
 * @returns 清掉的附件数量。
 */
async function cleanOrphanAssets(): Promise<number> {
  flush(); // 当前文档里刚贴的图还没落盘的话，会被误判成孤儿
  const bodies = await Promise.all(
    state.metas.filter((m) => m.type === 'doc').map((m) => loadBody(m.nodeId)),
  );
  const orphans = findOrphanAssets(bodies);
  removeAssets(orphans);
  notify(orphans.length ? `已清理 ${orphans.length} 张无引用图片` : '没有需要清理的图片');
  return orphans.length;
}

// ───────────────────────────── 导出 ─────────────────────────────

/**
 * 导出一个节点。
 *
 * @param rootId 文档则导出单篇 `.md`，目录则导出整棵子树，null 表示导出整个库。
 */
async function exportNode(rootId: string | null): Promise<void> {
  flush(); // 没落盘的改动不能被导丢

  if (rootId && !state.metas.some((m) => m.nodeId === rootId)) {
    notify('要导出的节点已经不存在了');
    return;
  }

  // buildExportPlan 是同步的（纯函数才好单测），而 loadBody 是异步的，所以先把正文读出来。
  const bodies = new Map<string, string>();
  const prefetch = async (ids: string[]): Promise<void> => {
    const loaded = await Promise.all(ids.map((id) => loadBody(id)));
    ids.forEach((id, index) => bodies.set(id, loaded[index]));
  };

  const scope = rootId
    ? [state.metas.find((m) => m.nodeId === rootId)!, ...descendantsOf(state.metas, rootId)]
    : state.metas;
  await prefetch(scope.filter((m) => m.type === 'doc').map((m) => m.nodeId));

  /**
   * 计划里出现了但没预读到的文档。
   *
   * 正常不会有：上面是按 parentId 收集的，而 buildExportPlan 走的是 buildTree 修过的树 ——
   * 同步事故留下的环会被提到根下，于是「子树里多出几篇」是可能的。这里把它们记下来再读一遍，
   * 而不是当成空文档导出去（备份里出现空文件是最坏的结果）。
   */
  const absent = new Set<string>();
  const io: ExportIO = {
    bodyOf: (nodeId) => {
      const body = bodies.get(nodeId);
      if (body === undefined) {
        absent.add(nodeId);
        return '';
      }
      return body;
    },
    assetOf: (assetId) => {
      const bytes = host.db.getAttachment(assetDocId(assetId));
      if (!bytes) return null;
      return { bytes, mime: host.db.getAttachmentType(assetDocId(assetId)) ?? 'image/png' };
    },
  };

  let plan = buildExportPlan(state.metas, rootId, io);
  if (absent.size) {
    await prefetch([...absent]);
    plan = buildExportPlan(state.metas, rootId, io);
  }

  const outcome = deliverPlan(plan);
  if (outcome.status === 'cancelled') return;
  if (outcome.status === 'failed') {
    notify(outcome.message);
    return;
  }

  const missing = plan.missingAssets ? `，有 ${plan.missingAssets} 张图片在库里已丢失` : '';
  notify(`已导出到 ${outcome.target}${missing}`);
  if (outcome.revealable) host.bridge?.showInFolder(outcome.target);
}

/** 打印当前文档（在对话框里选「另存为 PDF」就是导出 PDF）。 */
async function printActive(): Promise<void> {
  flush();
  const meta = activeMeta.value;
  if (!meta) {
    notify('先打开一篇文档');
    return;
  }

  // 编号跟着界面走：屏幕上看见的章节号，印出来的 PDF 里也得是同一套。
  const outcome = await printDocument(meta.name, state.markdown, {
    headingNumber: state.settings.headingNumber,
  });
  // 打印一律按亮色渲染，而 Vditor 的 setContentTheme 改的是全局那个 <link> ——
  // 暗色模式下打印完编辑器会留在亮色内容主题上。成功失败都要让编辑器重贴一次主题。
  state.themeEpoch += 1;

  if (!outcome.ok) {
    notify(outcome.message);
    return;
  }
  if (outcome.mathTimedOut) notify('部分公式渲染超时，打印结果里可能有原始 LaTeX');
}

// ───────────────────────────── 出图 ─────────────────────────────

/**
 * 把当前文档渲染成一张 PNG。
 *
 * 「复制为图片」和「下载为图片」共用这一步，只有拿到字节之后的去处不同。
 *
 * @returns 文件名、PNG 和一句追加提示；失败时 null（提示已经发出去了）。
 */
async function renderActiveImage(): Promise<{
  name: string;
  shot: Snapshot;
  warning: string;
} | null> {
  flush();
  const meta = activeMeta.value;
  if (!meta) {
    notify('先打开一篇文档');
    return null;
  }
  if (state.busy) {
    notify('上一张图还在生成');
    return null;
  }

  state.busy = true;
  notify('正在生成图片…');
  try {
    // 兜一层总期限。里面每一步都已经各自带期限了（lib/deadline.ts），这层是防「漏了一步」：
    // busy 只在 finally 里清，一旦有任何一个 await 永远不落地，工具栏就永久禁用、提示四秒后
    // 自己消失 —— 现象就是「插件卡死了还不报错」。
    // 迟到的结果不用管：snapshotMarkdown 自己在 finally 里收离屏容器，不会在页面上留东西。
    const outcome = await settleWithin(
      snapshotMarkdown(state.markdown, { headingNumber: state.settings.headingNumber }),
      IMAGE_TIMEOUT,
      { ok: false as const, message: timeoutError('生成图片', IMAGE_TIMEOUT).message },
    );
    // 和打印同理：离屏渲染一律按亮色走，会把 Vditor 的全局内容主题带偏，成功失败都要让
    // 编辑器重贴一次主题。
    state.themeEpoch += 1;

    if (!outcome.ok) {
      notify(outcome.message);
      return null;
    }
    return {
      name: meta.name,
      shot: outcome.shot,
      warning: outcome.mathTimedOut ? '，但部分公式渲染超时，图里可能有原始 LaTeX' : '',
    };
  } finally {
    state.busy = false;
  }
}

/** 把当前文档整篇复制成一张图片，直接粘到聊天窗口里。 */
async function copyActiveAsImage(): Promise<void> {
  const rendered = await renderActiveImage();
  if (!rendered) return;

  const { shot, warning } = rendered;
  const copied = await host.copyImage(shot.bytes, 'image/png');
  // 复制失败必须说出来。浏览器要求安全上下文 + 页面有焦点，拿不到权限时报「已复制」
  // 的结果是用户粘出一片空白，还以为是插件把图弄丢了。
  notify(
    copied
      ? `已复制为图片（${shot.width}×${shot.height}）${warning}`
      : '复制失败：拿不到剪贴板权限，可以改用「下载 → 图片」',
  );
}

/** 把当前文档整篇存成一张 PNG。 */
async function exportActiveAsImage(): Promise<void> {
  const rendered = await renderActiveImage();
  if (!rendered) return;

  const { name, shot, warning } = rendered;
  const outcome = deliverBytes(`${sanitizeSegment(name)}.png`, shot.bytes, 'image/png', {
    title: '导出图片',
    filterName: 'PNG 图片',
    extensions: ['png'],
  });
  if (outcome.status === 'cancelled') return;
  if (outcome.status === 'failed') {
    notify(outcome.message);
    return;
  }

  notify(`已导出到 ${outcome.target}${warning}`);
  if (outcome.revealable) host.bridge?.showInFolder(outcome.target);
}

// ───────────────────────────── 展开 / 设置 ─────────────────────────────

function toggleExpanded(nodeId: string): void {
  const index = state.expanded.indexOf(nodeId);
  if (index < 0) state.expanded.push(nodeId);
  else state.expanded.splice(index, 1);
}

watch(
  () => [...state.expanded],
  (value) => host.dbStorage.setItem(EXPANDED_KEY, value),
);
watch(
  () => ({ ...state.settings }),
  (value) => saveSettings(value),
);

// ───────────────────────────── 同步 ─────────────────────────────

/**
 * 处理 uTools 从其他设备同步过来的变更。
 *
 * 不监听 onDbPull 的后果（funchat 踩过）：另一台机器上新增的文档要重启插件才看得见，
 * 接着写同一份文档还会直接撞 `_rev` 冲突。
 *
 * @param docs 本次同步进来的文档。
 */
async function handleDbPull(docs: DbDoc[]): Promise<void> {
  const metaChanged = docs.some((doc) => nodeIdFromMetaId(doc._id) !== null);
  const activeBodyChanged = docs.some(
    (doc) => state.activeNodeId && nodeIdFromBodyId(doc._id) === state.activeNodeId,
  );

  if (metaChanged) await reload({ keepActive: true });

  if (!activeBodyChanged || !state.activeNodeId) return;

  const remote = await loadBody(state.activeNodeId);
  if (!state.dirty) {
    // 本地没有未保存改动，直接跟上远端。
    setMarkdownExternal(remote);
    notify('此文档已在其他设备更新，内容已同步');
    return;
  }
  // 本地有未保存改动：**不动编辑器**，把选择权交给用户。默认行为永远是保住正在打的字。
  state.conflict = { remoteMarkdown: remote };
}

/** 冲突时保留本地版本：带最新 `_rev` 覆盖写回去。 */
function resolveConflictKeepLocal(): void {
  state.conflict = null;
  state.dirty = true;
  flush();
}

/** 冲突时把本地改动另存为同级新文档，编辑器切到远端版本。 */
async function resolveConflictKeepBoth(): Promise<void> {
  const conflict = state.conflict;
  const meta = activeMeta.value;
  if (!conflict || !meta) return;

  const localMarkdown = state.markdown;
  state.conflict = null;
  setMarkdownExternal(conflict.remoteMarkdown);

  // open: false —— 副本建在旁边就行，当前编辑器要停在远端版本上。
  const copyId = await createNode('doc', meta.parentId, {
    name: `${meta.name}（本机副本）`,
    markdown: localMarkdown,
    open: false,
  });
  if (copyId) notify(`本地改动已另存为「${meta.name}（本机副本）」`);
}

// ───────────────────────────── 初始化 ─────────────────────────────

/** 请求打开某篇文档。初始化还没跑完时先记下，reload 结束会接手。 */
function requestOpen(nodeId: string): void {
  if (state.loading) pendingOpen.value = nodeId;
  else void openNode(nodeId);
}

/**
 * 把本地 Markdown 文件导入成文档。
 * @param files uTools 匹配到的文件列表。
 */
async function importDocuments(files: { name: string; read: () => Promise<string | null> }[]): Promise<void> {
  let imported = 0;
  let last: string | null = null;
  for (const file of files) {
    if (!/\.(md|markdown)$/i.test(file.name)) continue;
    let markdown: string | null;
    try {
      markdown = await file.read();
    } catch {
      markdown = null;
    }
    if (markdown === null) {
      notify(`读不了 ${file.name}`);
      continue;
    }
    const name = firstHeading(markdown) || file.name.replace(/\.(md|markdown)$/i, '');
    const nodeId = await createNode('doc', null, { name, markdown, open: false });
    if (nodeId) {
      imported += 1;
      last = nodeId;
    }
  }
  if (last) await openNode(last);
  if (imported) notify(`已导入 ${imported} 篇文档`);
}

async function importFiles(files: MatchFile[]): Promise<void> {
  const bridge = host.bridge;
  if (!bridge) return;
  await importDocuments(files.filter((file) => file.isFile).map((file) => ({
    name: file.name,
    read: async () => bridge.readTextFile(file.path),
  })));
}

/** 挂载时调一次：注册宿主回调、初始化数据。 */
async function initialize(): Promise<void> {
  host.onPluginEnter((action) => {
    // 动态关键词：code 形如 doc/<nodeId>。
    const nodeId = nodeIdFromFeatureCode(action.code);
    if (nodeId) {
      requestOpen(nodeId);
      return;
    }

    // 主搜索框推送结果：选中的文档由 preload 暂存，这里取走。
    if (action.code === 'fundoc-search') {
      const pending = host.bridge?.takePendingOpen();
      if (pending) requestOpen(pending);
      return;
    }

    if (action.code === 'fundoc-import' && Array.isArray(action.payload)) {
      void importFiles(action.payload as MatchFile[]);
    }
  });

  // 两个都要注册：uTools 退出插件默认是转后台，不触发 pagehide。
  host.onPluginOut(() => flush());
  globalThis.addEventListener?.('pagehide', () => flush());
  globalThis.addEventListener?.('blur', () => flush());

  host.onDbPull((docs) => void handleDbPull(docs));

  const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  if (media) {
    state.systemDark = media.matches;
    media.addEventListener('change', (event) => {
      state.systemDark = event.matches;
    });
  }

  state.metas = await loadAllMeta();
  await seedIfEmpty();
  await reload();
}

export function useDocs() {
  return {
    state,
    tree,
    activeMeta,
    activePath,
    outline,
    outlineNumbers,
    dark,
    initialize,
    reload,
    openNode,
    setMarkdown,
    flush,
    createNode,
    renameNode,
    moveNode,
    deleteNode,
    setKeywords,
    cleanOrphanAssets,
    exportNode,
    printActive,
    copyActiveAsImage,
    exportActiveAsImage,
    importDocuments,
    toggleExpanded,
    resolveConflictKeepLocal,
    resolveConflictKeepBoth,
    notify,
  };
}
