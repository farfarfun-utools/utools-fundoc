// Vditor 静态资源的位置。编辑器和打印预览都要用，所以单独放一份。
//
// `cdn` 必须指向插件内的副本：Vditor 默认从 unpkg 拉 lute.min.js / katex / 图标，断网直接白屏。
// 注意它拼路径时**硬编码了 `/dist/`** 这一段（见 scripts/sync-vditor.mjs），
// 所以要给到 `vditor` 这一层，而不是 `vditor/dist`。

/** Vditor 资源根目录的绝对地址。它会在后面接上 `/dist/...`。 */
export function vditorBase(): string {
  // 用 baseURI 而不是写死相对路径：开发时文档在 http://localhost:5173/，
  // 真机上在插件目录下，两边都要能解析。
  return new URL('vditor', document.baseURI).href;
}

let styleInjected = false;

/**
 * 挂载 Vditor 主样式，只做一次。
 *
 * `dist/index.css` **不在 JS bundle 里**，而 Vditor 自己只在「导出 PDF/HTML」的 iframe 里
 * 注入它，主界面不管 —— 必须由我们挂。走 public 副本而不是 `import 'vditor/dist/index.css'`：
 * 后者会让 Vite 把 CSS 里引用的 images/ 另哈希一份，和 public 下的副本重复，白占几 MB。
 */
export function injectVditorStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `${vditorBase()}/dist/index.css`;
  document.head.append(link);
}
