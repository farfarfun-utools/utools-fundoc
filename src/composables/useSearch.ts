// 应用内搜索面板的状态。
//
// 模块级单例：快捷键（App）、左栏按钮都要能把它打开，和 useDocs 一个路子。
//
// 打分和排序全部来自 lib/search.ts —— 和 uTools 主搜索框是同一份实现，
// 两处搜同一个词得到的顺序必然一致。
import { computed, ref, watch } from 'vue';
import { host } from '../lib/host';
import { createBodyReader, searchDocs, type SearchHit } from '../lib/search';
import { useDocs } from './useDocs';

/** 面板里一次最多列这么多条。比主搜索框的 8 条宽裕些 —— 这里有滚动空间。 */
const LIMIT = 20;

const bodyReader = createBodyReader(host.db);

const open = ref(false);
const query = ref('');
/** 当前高亮的结果下标。 */
const cursor = ref(0);

const { state, openNode } = useDocs();

const results = computed<SearchHit[]>(() => {
  if (!open.value) return [];
  const metaById = new Map(state.metas.map((meta) => [meta.nodeId, meta]));
  const readBody = bodyReader.forQuery(query.value, metaById);

  return searchDocs(state.metas, query.value, {
    limit: LIMIT,
    bodyOf:
      readBody &&
      ((nodeId) =>
        // 正在编辑的那篇要用内存里的版本：改动可能还没落盘，用库里的旧正文搜，
        // 刚写下的句子反而搜不到 —— 而那恰恰是最可能被搜的内容。
        nodeId === state.activeNodeId ? state.markdown : readBody(nodeId)),
  });
});

// 改了查询词就回到第一条。不重置的话，上一次停在第 7 条的高亮会落在新结果里
// 某个毫不相干的位置上，回车直接打开错的文档。
watch(query, () => {
  cursor.value = 0;
});

function openPalette(): void {
  open.value = true;
  query.value = '';
  cursor.value = 0;
}

function closePalette(): void {
  open.value = false;
  query.value = '';
}

/** 上下移动高亮。到头循环，省得用户卡在边界上反复按。 */
function move(delta: number): void {
  const total = results.value.length;
  if (!total) return;
  cursor.value = (cursor.value + delta + total) % total;
}

/** 打开当前高亮的结果。 */
async function choose(index = cursor.value): Promise<void> {
  const hit = results.value[index];
  if (!hit) return;
  closePalette();
  await openNode(hit.nodeId);
}

export function useSearch() {
  return { open, query, cursor, results, openPalette, closePalette, move, choose };
}
