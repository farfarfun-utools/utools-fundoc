// 把文本按命中词切成「高亮 / 不高亮」的片段。
//
// 返回片段数组而不是拼好的 HTML 字符串：搜索结果里有文档标题和正文片段，都是用户内容，
// 拼 HTML 再 v-html 渲染等于给自己开一个 XSS 入口 —— 一篇标题叫 `<img onerror=...>`
// 的文档就能执行脚本。片段数组交给模板按文本节点渲染，没有这个问题。
import { tokenize } from './search';

export type Segment = { text: string; hit: boolean };

/**
 * 按查询词切分文本。
 *
 * @param text 原文。
 * @param query 查询串（空白分隔多个词）。
 * @returns 按原文顺序排列的片段；没有任何命中时是单个 `hit: false` 片段。
 */
export function segmentMatches(text: string, query: string): Segment[] {
  const words = tokenize(query);
  if (!text || !words.length) return [{ text, hit: false }];

  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const word of words) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(word, from);
      if (at < 0) break;
      ranges.push([at, at + word.length]);
      from = at + word.length;
    }
  }
  if (!ranges.length) return [{ text, hit: false }];

  // 多个词的命中区间会重叠（搜「数学 学」时「数学」里的「学」也命中），
  // 不合并就会切出嵌套片段，渲染成两层高亮。
  ranges.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [ranges[0]];
  for (const [start, end] of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  const segments: Segment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), hit: false });
    segments.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}
