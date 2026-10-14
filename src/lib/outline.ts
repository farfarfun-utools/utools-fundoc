// 从 Markdown 源码解析标题，供右侧大纲和「标题同步为文档名」用。
//
// 刻意不借 Vditor 的 outlineRender：那个要等编辑器渲染完 DOM 才有结果，而我们在「还没打开
// 这篇文档」时就需要标题（标题兜底关键词、搜索命中标题）。纯文本解析没有这个依赖。
import type { OutlineItem } from './types';

const ATX = /^(#{1,6})\s+(.*)$/;
// 围栏可以是 ``` 或 ~~~，且允许前导空格与更长的围栏。
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * 解析 Markdown 里的各级标题。
 *
 * 会跳过代码围栏内的内容 —— 否则 Shell 示例里的 `# 注释` 会被当成一级标题塞进大纲，
 * 这是手写解析最常见的错。
 *
 * @param markdown Markdown 源码。
 * @returns 按出现顺序排列的标题列表。
 */
export function parseOutline(markdown: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  let fence: string | null = null;

  markdown.split('\n').forEach((raw, line) => {
    const fenceMatch = FENCE.exec(raw);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      // 同种符号才闭合：``` 开的块不该被 ~~~ 关掉。
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      return;
    }
    if (fence !== null) return;

    const match = ATX.exec(raw);
    if (!match) return;
    // 去掉可选的收尾 #（`## 标题 ##` 是合法 ATX 写法）。
    // `^` 这一支是为了 `## ##` —— 收尾序列就是全部内容时这是个空标题，不是标题叫「##」。
    // 收尾序列前面必须是空白或行首，所以 `# C#` 的 `C#` 不会被咬掉。
    const text = match[2].replace(/(^|\s+)#+\s*$/, '').trim();
    if (!text) return;
    items.push({ level: match[1].length, text, line });
  });

  return items;
}

/**
 * 取正文里第一个标题的文本，用于把标题同步成文档名。
 * @param markdown Markdown 源码。
 * @returns 第一个标题的文本；没有标题时返回空串。
 */
export function firstHeading(markdown: string): string {
  return parseOutline(markdown)[0]?.text ?? '';
}
