<script setup lang="ts">
// 中栏：标题栏 + Vditor。
//
// 这里同时充当应用顶栏（面板开关、设置入口都在这条上）—— uTools 的窗口不高，
// 再单独占一行 42px 不划算。
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { createEditor, type EditorHandle } from '../composables/useEditor';
import { useDocs } from '../composables/useDocs';

const emit = defineEmits<{ keyword: []; settings: [] }>();

const {
  state,
  activeMeta,
  activePath,
  dark,
  setMarkdown,
  flush,
  renameNode,
  notify,
  exportNode,
  printActive,
} = useDocs();

const hostEl = ref<HTMLElement | null>(null);
let editor: EditorHandle | null = null;

function build(): void {
  if (!hostEl.value) return;
  editor?.destroy();
  editor = createEditor(hostEl.value, state.settings, dark.value, state.markdown, {
    onInput: setMarkdown,
    onNotice: notify,
  });
}

onMounted(build);
onBeforeUnmount(() => {
  flush();
  editor?.destroy();
  editor = null;
});

// 正文被外部替换（切文档、同步覆盖）时回灌。盯 contentEpoch 而不是 markdown 本身：
// 后者在用户打字时也在变，会变成「输入 → 回灌 → 光标跳回开头」的回环。
watch(
  () => state.contentEpoch,
  () => editor?.setContent(state.markdown),
);

// 换编辑模式只能整个重建 —— Vditor 没有运行时切模式的 API。
watch(
  () => state.settings.mode,
  async () => {
    flush();
    await nextTick();
    build();
  },
);

watch(dark, (value) => editor?.applyTheme(value));

// 打印把 Vditor 的全局内容主题切成了亮色，这里重贴一次。
watch(
  () => state.themeEpoch,
  () => editor?.applyTheme(dark.value),
);

/** 大纲点击跳转。按标题序号定位，见 useEditor.scrollToHeading 的说明。 */
function scrollToHeading(index: number): void {
  editor?.scrollToHeading(index);
}
defineExpose({ scrollToHeading });

/**
 * 标题输入框提交。
 *
 * 用 `:value` 而不是 `v-model`：标题可能被「首个标题同步为文档名」从正文那边改掉，
 * 双向绑定会和那条路径打架。
 */
function commitTitle(event: Event): void {
  const input = event.target as HTMLInputElement;
  const meta = activeMeta.value;
  if (!meta) return;
  renameNode(meta.nodeId, input.value);
  // renameNode 会忽略空标题，这时绑定值没变、Vue 不会回填 DOM，输入框会一直空着。
  input.value = meta.name;
}

/** 正文体积，超过 800KB 时在状态位上提醒 —— 单条文档上限是 1MB。 */
function sizeLabel(bytes: number | undefined): string {
  if (!bytes) return '';
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(2)} MB`;
}
</script>

<template>
  <section class="pane pane-main">
    <div class="doc-head">
      <button
        class="icon-btn"
        :class="{ active: state.settings.treeVisible }"
        title="显示 / 隐藏文档树"
        @click="state.settings.treeVisible = !state.settings.treeVisible"
      >
        <Icon name="sidebar" />
      </button>

      <input
        v-if="activeMeta"
        class="doc-title"
        :value="activeMeta.name"
        placeholder="未命名文档"
        @change="commitTitle"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
      />
      <span v-else class="doc-title">FunDoc</span>

      <span v-if="activePath" class="doc-path" :title="activePath">{{ activePath }}</span>

      <span class="doc-state">
        <template v-if="!activeMeta">&nbsp;</template>
        <template v-else-if="state.dirty">未保存</template>
        <template v-else>{{ sizeLabel(activeMeta.bodySize) || '已保存' }}</template>
      </span>

      <button
        v-if="activeMeta"
        class="icon-btn"
        :class="{ active: activeMeta.keywordEnabled }"
        title="关键词设置"
        @click="emit('keyword')"
      >
        <Icon name="key" />
      </button>
      <button
        v-if="activeMeta"
        class="icon-btn"
        title="导出为 .md 文件（Ctrl+Shift+S）"
        @click="exportNode(state.activeNodeId)"
      >
        <Icon name="download" />
      </button>
      <button
        v-if="activeMeta"
        class="icon-btn"
        title="打印 / 导出 PDF（Ctrl+P）"
        @click="printActive()"
      >
        <Icon name="printer" />
      </button>
      <button class="icon-btn" title="设置" @click="emit('settings')">
        <Icon name="settings" />
      </button>
      <button
        class="icon-btn"
        :class="{ active: state.settings.outlineVisible }"
        title="显示 / 隐藏大纲"
        @click="state.settings.outlineVisible = !state.settings.outlineVisible"
      >
        <Icon name="list" />
      </button>
    </div>

    <!-- 编辑器常驻，没有打开文档时也不卸载：Vditor 构造一次要加载 lute.wasm 和 KaTeX，
         每次切文档都重建会有明显卡顿。空文档时只是内容为空。 -->
    <div v-show="activeMeta" ref="hostEl" class="editor-host" />

    <div v-if="!activeMeta" class="doc-blank">
      <Icon name="file" style="width: 32px; height: 32px; opacity: .4" />
      <p>左边选一篇文档，或者新建一篇</p>
    </div>
  </section>
</template>
