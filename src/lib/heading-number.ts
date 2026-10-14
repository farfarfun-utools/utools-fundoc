// 标题自动编号。
//
// 编号只存在于**显示层**：大纲里是一个独立的 span，正文里是 CSS 生成内容（`::before`
// 读 data-fundoc-number）。Markdown 源码一个字都不改 —— 真写进正文的话，调整章节顺序、
// 升降标题级别之后全得重排，而正文是用户的数据，插件一旦动手就得负责永远排对。
// 代价是导出的 `.md` 里没有数字，这是对的：别的编辑器打开自己会编。

/**
 * 按标题层级序列算出编号。
 *
 * 规则是**按嵌套深度**，不是按 `#` 的个数：
 * - 整篇从 `##` 开头也从 `1` 起编（写在 uTools 文档里的笔记常常没有一级标题）；
 * - `#` 直接跳到 `###` 算一层嵌套，给 `1.1` 而不是 `1.0.1`；
 * - 层级变浅时回到对应深度**接着往下数**：`#` / `###` / `##` 是 `1` / `1.1` / `1.2`，
 *   后面那个 `##` 和前面的 `###` 都算一级标题的子节点（这种混搭本来就不规范，
 *   当成同级处理是唯一不会产生重号的读法）。
 *
 * @param levels 标题层级，按文档顺序，取值 1..6。
 * @returns 与入参一一对应的编号文本，形如 `1.2.1`。
 */
export function numberHeadings(levels: number[]): string[] {
  /** 各深度上的计数器，`depth[i]` 是第 i 层的层级，`counters[i]` 是它数到几。 */
  const depths: number[] = [];
  const counters: number[] = [];

  return levels.map((level) => {
    // 这一级该落在哪个深度：比它浅的那段前缀有多长。
    let depth = 0;
    while (depth < depths.length && depths[depth] < level) depth += 1;

    if (depth < depths.length) {
      // 该深度已经有人了 —— 不管对方是不是同一个 `#` 个数，都算它的下一个兄弟。
      counters[depth] += 1;
      depths[depth] = level;
      depths.length = depth + 1;
      counters.length = depth + 1;
    } else {
      depths.push(level);
      counters.push(1);
    }

    return counters.join('.');
  });
}

/** 正文里承载编号的属性名。style.css 里的 `::before` 读它。 */
export const NUMBER_ATTR = 'data-fundoc-number';

/**
 * 给一棵渲染好的正文 DOM 标注编号。
 *
 * 编号是从 **DOM 里的标题** 现算的，不是把 parseOutline 的结果按下标贴过来：预览区可能
 * 出现源码解析器看不见的标题（粘进来的 setext 写法、手写的 `<h2>`），按下标贴会从那里
 * 开始整体错位，现算则至少这一栏自己是连续的。
 *
 * @param root 编辑器宿主或预览容器；自身是 `.vditor-reset` 时就按它算。
 * @param enabled 关掉时负责把已经贴上的属性摘干净。
 */
export function applyHeadingNumbers(root: HTMLElement, enabled: boolean): void {
  // 三种模式的正文容器 class 名不同，但都带 .vditor-reset；sv 模式的源码 textarea
  // 也带这个 class，不过里面查不到标题元素，循环到它自然什么也不做。
  const panes = root.classList.contains('vditor-reset')
    ? [root]
    : [...root.querySelectorAll<HTMLElement>('.vditor-reset')];

  for (const pane of panes) {
    const headings = [...pane.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')];
    if (!enabled) {
      for (const heading of headings) heading.removeAttribute(NUMBER_ATTR);
      continue;
    }

    const numbers = numberHeadings(headings.map((heading) => Number(heading.tagName[1])));
    headings.forEach((heading, index) => {
      // 值没变就不写。打字时这个函数每帧都可能跑一次，而属性写入会让浏览器重算样式。
      if (heading.getAttribute(NUMBER_ATTR) !== numbers[index]) {
        heading.setAttribute(NUMBER_ATTR, numbers[index]);
      }
    });
  }
}
