<script setup lang="ts">
// 应用内搜索面板：标题、关键词、正文全文。
//
// 和 uTools 主搜索框共用 lib/search.ts 的打分，所以两处的排序一致。
import { nextTick, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import { useSearch } from '../composables/useSearch';
import { segmentMatches } from '../lib/highlight';

const { query, cursor, results, closePalette, move, choose } = useSearch();

const inputEl = ref<HTMLInputElement | null>(null);
/** 结果列表容器，用来把高亮项滚进视野。 */
const listEl = ref<HTMLElement | null>(null);

onMounted(async () => {
  await nextTick();
  inputEl.value?.focus();
});

/** 键盘移动后把高亮项滚进视野 —— 否则按到第十几条时高亮已经在可视区外面了。 */
async function moveAndReveal(delta: number): Promise<void> {
  move(delta);
  await nextTick();
  listEl.value?.querySelector('.sp-item.active')?.scrollIntoView({ block: 'nearest' });
}
</script>

<template>
  <div class="sp-mask" @click.self="closePalette">
    <div class="sp-panel" @keydown.esc.prevent="closePalette">
      <div class="sp-input-row">
        <Icon name="search" class="sp-input-icon" />
        <input
          ref="inputEl"
          v-model="query"
          class="sp-input"
          placeholder="搜索标题、关键词、正文…"
          spellcheck="false"
          @keydown.down.prevent="moveAndReveal(1)"
          @keydown.up.prevent="moveAndReveal(-1)"
          @keydown.enter.prevent="choose()"
        />
        <kbd class="sp-hint">Esc</kbd>
      </div>

      <div ref="listEl" class="sp-list">
        <p v-if="!query.trim()" class="sp-tip">输入关键字开始搜索。正文全文要两个字以上。</p>
        <p v-else-if="!results.length" class="sp-tip">没有匹配的文档</p>

        <button
          v-for="(hit, index) in results"
          :key="hit.nodeId"
          class="sp-item"
          :class="{ active: index === cursor }"
          @click="choose(index)"
          @mousemove="cursor = index"
        >
          <span class="sp-item-main">
            <span class="sp-item-name">
              <template v-for="(seg, i) in segmentMatches(hit.name, query)" :key="i">
                <mark v-if="seg.hit">{{ seg.text }}</mark>
                <template v-else>{{ seg.text }}</template>
              </template>
            </span>
            <span v-if="hit.field === 'keyword'" class="sp-tag">关键词</span>
          </span>

          <span class="sp-item-path">{{ hit.path }}</span>

          <!-- 正文命中才显示片段：用户得看见自己搜的词出现在哪儿，
               否则一条「标题完全不相关」的结果没法理解。 -->
          <span v-if="hit.snippet" class="sp-item-snippet">
            <template v-for="(seg, i) in segmentMatches(hit.snippet, query)" :key="i">
              <mark v-if="seg.hit">{{ seg.text }}</mark>
              <template v-else>{{ seg.text }}</template>
            </template>
          </span>
        </button>
      </div>
    </div>
  </div>
</template>
