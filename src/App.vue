<script setup lang="ts">
import { onMounted, ref, watch, watchEffect } from 'vue';
import DocTree from './components/DocTree.vue';
import EditorPane from './components/EditorPane.vue';
import OutlinePane from './components/OutlinePane.vue';
import KeywordDialog from './components/KeywordDialog.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import SearchPalette from './components/SearchPalette.vue';
import Icon from './components/Icon.vue';
import { useDocs } from './composables/useDocs';
import { useSearch } from './composables/useSearch';
import { useShortcuts } from './composables/useShortcuts';
import { host } from './lib/host';

const { state, dark, initialize, resolveConflictKeepLocal, resolveConflictKeepBoth } = useDocs();
const { open: paletteOpen } = useSearch();

// 全局快捷键只在这里装一次 —— 监听挂在 window 上，装两遍会把每个命中跑两次。
useShortcuts();

const editorRef = ref<InstanceType<typeof EditorPane> | null>(null);
const keywordNodeId = ref<string | null>(null);
const settingsOpen = ref(false);

// ── 栏宽 ──
// 存在本机 UI 状态里而不是 settings：两台机器屏幕宽度不同，同步过去的栏宽多半不合适。
const WIDTH_KEY = 'fundoc.ui.widths';
const saved = (host.dbStorage.getItem(WIDTH_KEY) as { tree?: number; outline?: number }) ?? {};
const treeWidth = ref(saved.tree ?? 240);
const outlineWidth = ref(saved.outline ?? 220);

watch([treeWidth, outlineWidth], ([tree, outline]) =>
  host.dbStorage.setItem(WIDTH_KEY, { tree, outline }),
);

const dragging = ref<'tree' | 'outline' | null>(null);

/**
 * 开始拖栏宽。
 * @param which 拖的是哪一栏。
 * @param event 起始指针事件。
 */
function startResize(which: 'tree' | 'outline', event: PointerEvent): void {
  dragging.value = which;
  const startX = event.clientX;
  const startWidth = which === 'tree' ? treeWidth.value : outlineWidth.value;
  // 指针捕获：拖到编辑器区域上方时事件仍然回到把手，不会中途断掉。
  const handle = event.currentTarget as HTMLElement;
  handle.setPointerCapture(event.pointerId);

  const onMove = (move: PointerEvent) => {
    // 大纲在右侧，往左拖是变宽，所以符号相反。
    const delta = which === 'tree' ? move.clientX - startX : startX - move.clientX;
    const next = Math.min(480, Math.max(150, startWidth + delta));
    if (which === 'tree') treeWidth.value = next;
    else outlineWidth.value = next;
  };
  const onUp = () => {
    dragging.value = null;
    handle.releasePointerCapture(event.pointerId);
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
}

// 主题写到 <html data-theme> 上，CSS 变量据此切换。
//
// 这里刻意只写 'dark' / 'light' 两个确定值，不写 'system' 交给 CSS 的
// prefers-color-scheme 去判断 —— uTools 的深浅色是客户端自己的设置，不保证映射到
// 浏览器的 prefers-color-scheme。`dark` 以官方的 isDarkColors() 为准，同时也跟随
// matchMedia 变化，比纯 CSS 媒体查询可靠。
watchEffect(() => {
  document.documentElement.dataset.theme = dark.value ? 'dark' : 'light';
  // 代码块配色也写一份到 <html> 上。CSS 只需要分辨「跟随界面」和「用主题自带的底色」
  // 两种情况，但原样写出来，以后想给某个主题单独补规则不用再改这里。
  document.documentElement.dataset.codeTheme = state.settings.codeTheme;
});

onMounted(initialize);
</script>

<template>
  <div class="shell">
    <div v-if="state.conflict" class="banner banner-conflict">
      <span>
        这篇文档在其他设备上也被修改了。你本地还有未保存的改动，先选怎么处理 ——
        在此之前编辑器里的内容不会被覆盖。
      </span>
      <button class="btn btn-sm" @click="resolveConflictKeepBoth">两份都留</button>
      <button class="btn btn-sm btn-primary" @click="resolveConflictKeepLocal">用我这份</button>
    </div>

    <div v-else-if="state.notice" class="banner banner-notice">
      <span>{{ state.notice }}</span>
      <button class="icon-btn" title="关闭" @click="state.notice = ''">
        <Icon name="close" />
      </button>
    </div>

    <div class="shell-body">
      <template v-if="state.settings.treeVisible">
        <DocTree :style="{ width: `${treeWidth}px` }" @keyword="keywordNodeId = $event" />
        <div
          class="resizer"
          :class="{ dragging: dragging === 'tree' }"
          @pointerdown.prevent="startResize('tree', $event)"
        />
      </template>

      <EditorPane
        ref="editorRef"
        @keyword="keywordNodeId = state.activeNodeId"
        @settings="settingsOpen = true"
      />

      <template v-if="state.settings.outlineVisible">
        <div
          class="resizer"
          :class="{ dragging: dragging === 'outline' }"
          @pointerdown.prevent="startResize('outline', $event)"
        />
        <OutlinePane
          :style="{ width: `${outlineWidth}px` }"
          @jump="editorRef?.scrollToHeading($event)"
        />
      </template>
    </div>
  </div>

  <KeywordDialog
    v-if="keywordNodeId"
    :node-id="keywordNodeId"
    @close="keywordNodeId = null"
  />
  <SettingsDialog v-if="settingsOpen" @close="settingsOpen = false" />

  <!-- v-if 而不是 v-show：面板一打开就要 autofocus 输入框，常驻的话得另外写聚焦逻辑。 -->
  <SearchPalette v-if="paletteOpen" />
</template>
