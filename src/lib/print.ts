// 打印 / 导出 PDF。
//
// 走浏览器自带的打印（`window.print()` → 目标选「另存为 PDF」），而不是 Vditor 的
// `exportPDF()`：后者把内容塞进一个 iframe，然后**硬等 3600ms**（见 node_modules/vditor
// 里的 exportPDF 实现）再触发打印。公式多的文档等不够就印出一堆原始 LaTeX，
// 短文档又白等三秒半。这里改成「等到真的渲染完」—— 判据是 DOM，不是秒表。
//
// 不用 Vditor 的 `preview()` 的 Promise 作为完成信号：它只 await 了 lute/i18n/图标三个脚本，
// 之后的 mathRender、highlightRender 都是发射后不管的（previewRender.ts 里没有 await），
// 所以 Promise 落地时公式往往还没渲染。
import Vditor from 'vditor';
import { toRenderable } from './asset';
import { applyHeadingNumbers } from './heading-number';
import { injectVditorStyle, vditorBase } from './vditor';

/** 打印容器的 class。style.css 里的 @media print 靠它决定印什么。 */
const PRINT_CLASS = 'fundoc-print-root';
/** 挂在 <html> 上的标记，打印期间用来隐藏整个应用界面。 */
const PRINTING_CLASS = 'fundoc-printing';

/** 等公式渲染完的最长时间。超了就照印 —— 卡住不印比印错更糟。 */
const MATH_TIMEOUT = 10_000;
const POLL_INTERVAL = 50;

/**
 * 等容器里的公式都渲染完。
 *
 * 判据是 KaTeX 渲染后会给每个 `.language-math` 挂上 `data-math` 属性（mathRender.ts），
 * 失败的公式也会挂 —— 所以这个条件不会因为某条公式写错而永远不满足。
 *
 * @param container 预览容器。
 * @param timeout 上限毫秒。
 * @returns 是不是真的全渲染完了（false 表示超时后放弃等待）。
 */
async function waitForMath(container: HTMLElement, timeout = MATH_TIMEOUT): Promise<boolean> {
  const deadline = Date.now() + timeout;
  const pending = () =>
    [...container.querySelectorAll('.language-math')].filter((el) => !el.getAttribute('data-math'));

  while (pending().length) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
  return true;
}

export type PrintOutcome = { ok: true; mathTimedOut: boolean } | { ok: false; message: string };

/**
 * 渲染一篇文档并唤起打印对话框。
 *
 * 刻意**一律按亮色主题**渲染：深色底在纸上既费墨又难读，而 PDF 的使用场景就是打印和分发。
 * 代价是 Vditor 的 `setContentTheme` 会把全局的 content-theme 链接切成亮色，
 * 所以调用方在这个 Promise 落地后要重新应用一次编辑器主题（`EditorHandle.applyTheme`）。
 *
 * @param title 文档标题。会临时设成 `document.title` —— 浏览器拿它当 PDF 的默认文件名。
 * @param markdown 正文，存库形态（图片是 `fundoc-asset://`）。
 * @param options.headingNumber 标题是否自动编号，跟界面上的设置保持一致。
 * @returns 是否成功，以及公式是否等超时了（超时要提示用户）。
 */
export async function printDocument(
  title: string,
  markdown: string,
  { headingNumber = false }: { headingNumber?: boolean } = {},
): Promise<PrintOutcome> {
  if (typeof window === 'undefined' || typeof window.print !== 'function') {
    return { ok: false, message: '当前环境不支持打印' };
  }

  injectVditorStyle();

  const container = document.createElement('div');
  container.className = PRINT_CLASS;
  document.body.append(container);

  const originalTitle = document.title;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    container.remove();
    document.documentElement.classList.remove(PRINTING_CLASS);
    document.title = originalTitle;
  };

  try {
    const cdn = vditorBase();
    await Vditor.preview(container as HTMLDivElement, toRenderable(markdown), {
      cdn,
      mode: 'light',
      lang: 'zh_CN',
      // 锚点图标在纸上是噪音。
      anchor: 0,
      // 行号在 PDF 里有用（方便对着讲），所以保留。
      hljs: { enable: true, lineNumber: true, style: 'github' },
      math: { engine: 'KaTeX', inlineDigit: false },
      theme: { current: 'light', path: `${cdn}/dist/css/content-theme` },
      icon: 'ant',
    });

    // 编号贴在渲染完的 DOM 上（`::before` 生成内容是会打印的），正文源码仍然不含数字。
    applyHeadingNumbers(container, headingNumber);

    const mathDone = await waitForMath(container);
    // 字体没加载完就打印，KaTeX 的字形会按回退字体量尺寸，公式的上下标全是歪的。
    await document.fonts?.ready;

    document.title = title;
    document.documentElement.classList.add(PRINTING_CLASS);
    // 让浏览器先把上面这些改动刷进一帧，否则个别内核会印出改动前的画面。
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    // afterprint 和「print() 返回」两条路都接上：Chromium 里 print() 会阻塞到
    // 对话框关闭，但这不是规范保证的行为。cleanup 做成幂等的，两边都调没问题。
    window.addEventListener('afterprint', cleanup, { once: true });
    window.print();
    cleanup();

    return { ok: true, mathTimedOut: !mathDone };
  } catch (error) {
    cleanup();
    return { ok: false, message: error instanceof Error ? error.message : '打印失败' };
  }
}
