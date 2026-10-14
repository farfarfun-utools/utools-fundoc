// 分屏滚动同步的映射计算。
//
// Vditor 自带的分屏同步是**按总高度等比例**换算的（见 node_modules/vditor 里 Editor.bindEvent
// 的 scroll 监听），而 Markdown 源码和渲染结果的高度根本不成比例：
//
//   - `$$ … $$` 三行源码渲染成一大块公式；
//   - 一行 `![](…)` 渲染成几百像素高的图；
//   - 代码围栏的 ``` 两行在渲染结果里不占高度。
//
// 结果是文档越往后，两边偏得越多 —— 看公式那一节时预览栏已经滚到代码那一节了。
// 它还有个 `scrollTop / clientHeight > 0.5` 的分段，跨过那个点时预览会突然跳一下。
//
// 这里换成**按标题锚点分段线性插值**：每个标题在源码侧和预览侧各有一个确定的像素位置，
// 把这些位置配成对，段内再按比例算。标题之间仍然可能偏，但偏差被限制在一节之内，
// 不会累积。
//
// 这个文件只做数学，不碰 DOM —— 真正麻烦的是「源码某一行在 textarea 里是第几像素」，
// 那部分在 lib/scroll-sync.ts 里测量。

/** 一对锚点：源码侧 `from` 像素处对应预览侧 `to` 像素处。 */
export type Anchor = { from: number; to: number };

/**
 * 把测出来的锚点整理成可插值的映射。
 *
 * 会补上首尾两对（0↔0 和 两侧最大滚动量↔彼此），并丢掉不单调的点 —— 测量偶尔会给出
 * 乱序结果（比如标题在源码里靠后、在预览里靠前，多半是源码标题数和渲染标题数没对齐），
 * 留着会让插值在那一段反向走。
 *
 * @param anchors 原始锚点，按源码位置升序给出最好，但不强制。
 * @param fromMax 源码侧最大滚动量（scrollHeight - clientHeight）。
 * @param toMax 预览侧最大滚动量。
 * @returns 严格单调递增的锚点序列，至少两个元素。
 */
export function buildScrollMap(anchors: Anchor[], fromMax: number, toMax: number): Anchor[] {
  const top = { from: 0, to: 0 };
  // 两边都滚不动时映射退化成「永远在顶部」，调用方照样能用，不必特判。
  const bottom = { from: Math.max(0, fromMax), to: Math.max(0, toMax) };

  const sorted = [...anchors]
    .filter((anchor) => Number.isFinite(anchor.from) && Number.isFinite(anchor.to))
    // 落在首尾之外的锚点没有意义：映射只在 [0, max] 区间上用。
    .filter((anchor) => anchor.from > 0 && anchor.to > 0)
    .filter((anchor) => anchor.from < bottom.from && anchor.to < bottom.to)
    .sort((left, right) => left.from - right.from);

  const result: Anchor[] = [top];
  for (const anchor of sorted) {
    const last = result[result.length - 1];
    // 严格递增才收：相等会让插值除以 0，倒退会让滚动方向反掉。
    if (anchor.from > last.from && anchor.to > last.to) result.push(anchor);
  }
  if (bottom.from > top.from && bottom.to > top.to) result.push(bottom);
  else if (result.length === 1) result.push(bottom);

  return result;
}

/**
 * 按映射换算滚动位置。
 *
 * @param map buildScrollMap 的结果。
 * @param value 源码侧滚动位置。
 * @returns 预览侧滚动位置，已夹到映射两端之间。
 */
export function mapScroll(map: Anchor[], value: number): number {
  if (!map.length) return 0;
  const first = map[0];
  const last = map[map.length - 1];
  if (value <= first.from) return first.to;
  if (value >= last.from) return last.to;

  // 锚点个数就是标题个数，几十个量级，线性扫比二分查找更简单也够快。
  for (let index = 1; index < map.length; index += 1) {
    const end = map[index];
    if (value > end.from) continue;
    const start = map[index - 1];
    const span = end.from - start.from;
    // buildScrollMap 保证了严格递增，这里不会除以 0。
    const ratio = (value - start.from) / span;
    return start.to + ratio * (end.to - start.to);
  }
  return last.to;
}

/**
 * 反转映射，用于「拖预览栏带动源码」。
 * @param map 正向映射。
 * @returns from / to 互换后的映射。
 */
export function flipMap(map: Anchor[]): Anchor[] {
  return map.map((anchor) => ({ from: anchor.to, to: anchor.from }));
}
