// 全局快捷键。
//
// **整套键位是绕开 Vditor 之后选出来的**，不是凭手感选的。Vditor 自己占了这些
// （`grep -oE 'hotkey: "[^"]+"' node_modules/vditor/dist/index.js | sort -u`）：
//
//   ⌘' ⌘; ⌘B ⌘D ⌘E ⌘G ⌘H ⌘I ⌘J ⌘K ⌘L ⌘M ⌘O ⌘P ⌘U ⌘Y ⌘Z
//   ⇧⌘B ⇧⌘E ⇧⌘H ⇧⌘I ⇧⌘O
//
// 所以「⌘P 快速打开」「⌘O 打开文件」「⌘M 切模式」这类常规选择全部不可用 ——
// 抢过来会让加粗、链接、撤销这些高频编辑键失效，那是更大的损失。带 ⇧ 的组合里
// 除上面五个之外都是空的，所以本应用的功能键基本都落在 ⇧⌘ 上。
//
// 唯一刻意抢的是 ⌘P（见 PRINT 那条的说明）。
import { onBeforeUnmount, onMounted } from 'vue';
import { useDocs } from './useDocs';
import { useSearch } from './useSearch';
import type { EditorMode } from '../lib/types';

/** 模式切换的循环顺序，和工具栏里的排列一致。 */
const MODE_CYCLE: EditorMode[] = ['wysiwyg', 'ir', 'sv'];

export type ShortcutAction =
  | 'search'
  | 'searchAlias'
  | 'save'
  | 'newDoc'
  | 'newDir'
  | 'export'
  | 'print'
  | 'toggleTree'
  | 'toggleOutline'
  | 'cycleMode';

export type Shortcut = {
  action: ShortcutAction;
  /** 展示用的键位说明，Mac 上 `Ctrl` 会换成 `⌘`。 */
  keys: string;
  label: string;
  /** 主键，小写。 */
  key: string;
  /** 是否要求同时按下 Shift。 */
  shift: boolean;
};

/**
 * 键位表。
 *
 * 放在模块级而不是 `useShortcuts()` 里面：设置面板要把它列成速查表，但不该顺手
 * 再装一遍监听。动作和实现靠 `ShortcutAction` 对上，`Record` 的穷尽性保证不会漏。
 */
export const SHORTCUTS: Shortcut[] = [
  { action: 'search', keys: 'Ctrl+Shift+P', label: '搜索文档', key: 'p', shift: true },
  // ⌘F 的「页内查找」在 uTools 的插件窗口里本来就没有 UI，留着不如拿来当搜索别名 ——
  // 跨文档搜索正是用户按 ⌘F 时想做的事。
  { action: 'searchAlias', keys: 'Ctrl+Shift+F', label: '搜索文档（同上）', key: 'f', shift: true },
  { action: 'save', keys: 'Ctrl+S', label: '立即保存', key: 's', shift: false },
  { action: 'newDoc', keys: 'Ctrl+N', label: '新建文档', key: 'n', shift: false },
  { action: 'newDir', keys: 'Ctrl+Shift+N', label: '新建目录', key: 'n', shift: true },
  { action: 'export', keys: 'Ctrl+Shift+S', label: '导出当前文档', key: 's', shift: true },
  // Vditor 用 ⌘P 切预览，这里刻意抢过来：焦点不在编辑器里时 ⌘P 会触发浏览器打印整个
  // 三栏界面，印出来是一张没用的截图。而「按 ⌘P 想打印正在看的文档」是绝大多数人的
  // 预期。代价是 Vditor 的预览切换只能点工具栏按钮 —— 它有按钮。
  { action: 'print', keys: 'Ctrl+P', label: '打印 / 导出 PDF', key: 'p', shift: false },
  { action: 'toggleTree', keys: 'Ctrl+Shift+T', label: '显示 / 隐藏文档树', key: 't', shift: true },
  { action: 'toggleOutline', keys: 'Ctrl+Shift+L', label: '显示 / 隐藏大纲', key: 'l', shift: true },
  { action: 'cycleMode', keys: 'Ctrl+Shift+M', label: '切换编辑模式', key: 'm', shift: true },
];

function isMac(): boolean {
  return /mac/i.test(globalThis.navigator?.platform ?? '');
}

/** 把 `Ctrl+Shift+P` 这样的说明按平台改写。 */
export function formatKeys(keys: string): string {
  return isMac() ? keys.replace('Ctrl', '⌘').replace('Shift', '⇧').replace(/\+/g, '') : keys;
}

/**
 * 装上全局快捷键，并返回这份键位表。
 *
 * 监听挂在 window 的**捕获阶段**：Vditor 把自己的监听挂在编辑器元素上，冒泡阶段才会
 * 轮到它，所以捕获阶段先拿到事件，命中后 stopPropagation 就能保证不会被双重处理。
 */
export function useShortcuts() {
  const { state, activeMeta, flush, createNode, exportNode, printActive } = useDocs();
  const { open: paletteOpen, openPalette, closePalette } = useSearch();

  const togglePalette = () => (paletteOpen.value ? closePalette() : openPalette());

  // 返回值一律丢掉（createNode 会返回新 nodeId），所以这里不约束返回类型。
  const actions: Record<ShortcutAction, () => void | Promise<unknown>> = {
    search: togglePalette,
    searchAlias: togglePalette,
    // 自动保存已经在跑，这条是给「不亲手存一下不放心」的手感准备的。
    // 必须 preventDefault，否则浏览器会弹「保存网页」。
    save: () => flush(),
    // 建在当前文档的同级目录下，而不是一律丢到根目录。
    newDoc: () => createNode('doc', activeMeta.value?.parentId ?? null),
    newDir: () => createNode('dir', activeMeta.value?.parentId ?? null),
    export: () => exportNode(state.activeNodeId),
    print: () => printActive(),
    toggleTree: () => void (state.settings.treeVisible = !state.settings.treeVisible),
    toggleOutline: () => void (state.settings.outlineVisible = !state.settings.outlineVisible),
    cycleMode: () => {
      const next = (MODE_CYCLE.indexOf(state.settings.mode) + 1) % MODE_CYCLE.length;
      state.settings.mode = MODE_CYCLE[next];
    },
  };

  function onKeyDown(event: KeyboardEvent): void {
    // 输入法组合期间不抢键：中文输入时按下的键属于候选框。
    if (event.isComposing) return;
    // Ctrl 和 Cmd 都认：Mac 用户按 ⌘，其他平台按 Ctrl。
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

    const key = event.key.toLowerCase();
    const hit = SHORTCUTS.find((item) => item.key === key && item.shift === event.shiftKey);
    if (!hit) return;

    event.preventDefault();
    // 命中后不让事件继续走：Vditor 的监听在冒泡阶段，不拦住会被处理两次。
    event.stopPropagation();
    void actions[hit.action]();
  }

  onMounted(() => globalThis.addEventListener('keydown', onKeyDown, { capture: true }));
  onBeforeUnmount(() => globalThis.removeEventListener('keydown', onKeyDown, { capture: true }));

  return { shortcuts: SHORTCUTS };
}
