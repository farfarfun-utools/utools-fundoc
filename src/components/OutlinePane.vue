<script setup lang="ts">
// 右栏：当前文档的内部目录（大纲）。
//
// 数据来自 parseOutline 对 Markdown 源码的解析，不依赖编辑器渲染完 DOM ——
// 所以切到一篇长文档时大纲是立刻出来的，不用等 Vditor 渲染。
import { useDocs } from '../composables/useDocs';

const emit = defineEmits<{ jump: [index: number] }>();

const { outline } = useDocs();

/** 一级标题顶格，往下每级缩进 12px，最深 6 级。 */
function indent(level: number): string {
  return `${(level - 1) * 12 + 12}px`;
}
</script>

<template>
  <aside class="pane pane-outline">
    <div class="pane-head">
      <span class="pane-head-title">大纲</span>
      <span v-if="outline.length" class="doc-state">{{ outline.length }}</span>
    </div>

    <div class="pane-scroll">
      <p v-if="!outline.length" class="tree-empty">用 # 写几个标题，这里就会出现大纲</p>

      <button
        v-for="(item, index) in outline"
        :key="`${item.line}-${item.text}`"
        class="outline-row"
        :class="`level-${item.level}`"
        :style="{ paddingLeft: indent(item.level) }"
        :title="item.text"
        @click="emit('jump', index)"
      >
        <span>{{ item.text }}</span>
      </button>
    </div>
  </aside>
</template>
