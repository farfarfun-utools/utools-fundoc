// 打印 / 导出 PDF。
//
// 走浏览器自带的打印（`window.print()` → 目标选「另存为 PDF」），而不是 Vditor 的
// `exportPDF()`：后者把内容塞进一个 iframe，然后**硬等 3600ms**（见 node_modules/vditor
// 里的 exportPDF 实现）再触发打印。公式多的文档等不够就印出一堆原始 LaTeX，
// 短文档又白等三秒半。这里改成「等到真的渲染完」—— 判据是 DOM，不是秒表，
// 具体见 lib/preview-render.ts。
import { settleWithin } from './deadline';
import { renderOffscreen, type Offscreen } from './preview-render';

/** 打印容器的 class。style.css 里的 @media print 靠它决定印什么。 */
const PRINT_CLASS = 'fundoc-print-root';
/** 挂在 <html> 上的标记，打印期间用来隐藏整个应用界面。 */
const PRINTING_CLASS = 'fundoc-printing';

/**
 * 等「刷进一帧」的期限。
 *
 * `requestAnimationFrame` 在文档不可见时**根本不回调** —— uTools 退插件默认是转后台，
 * 点了打印再切走就会卡在这一行上：对话框不出来、提示也没有，而且编辑器主题永远不会恢复
 * （themeEpoch 要等这个 Promise 落地才递增，暗色下编辑器就留在亮色内容主题上）。
 * 一帧是 16ms 的事，这个数只是「等不到就别等了」。
 */
const FRAME_TIMEOUT = 1_000;

export type PrintOutcome = { ok: true; mathTimedOut: boolean } | { ok: false; message: string };

/**
 * 渲染一篇文档并唤起打印对话框。
 *
 * 渲染一律按亮色主题走（理由见 renderOffscreen），所以调用方在这个 Promise 落地后要
 * 重新应用一次编辑器主题（`EditorHandle.applyTheme`）。
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

  const originalTitle = document.title;
  let offscreen: Offscreen | null = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    offscreen?.dispose();
    document.documentElement.classList.remove(PRINTING_CLASS);
    document.title = originalTitle;
  };

  try {
    offscreen = await renderOffscreen(markdown, { className: PRINT_CLASS, headingNumber });

    document.title = title;
    document.documentElement.classList.add(PRINTING_CLASS);
    // 让浏览器先把上面这些改动刷进一帧，否则个别内核会印出改动前的画面。
    // 带期限：页面在后台时 rAF 不回调（见 FRAME_TIMEOUT）。等不到就照样往下打印 ——
    // 最坏情况是版面差一帧，比永远不出对话框好。
    await settleWithin(
      new Promise<boolean>((resolve) => requestAnimationFrame(() => resolve(true))),
      FRAME_TIMEOUT,
      false,
      '刷新打印版面',
    );

    // afterprint 和「print() 返回」两条路都接上：Chromium 里 print() 会阻塞到
    // 对话框关闭，但这不是规范保证的行为。cleanup 做成幂等的，两边都调没问题。
    window.addEventListener('afterprint', cleanup, { once: true });
    window.print();
    cleanup();

    return { ok: true, mathTimedOut: offscreen.mathTimedOut };
  } catch (error) {
    cleanup();
    return { ok: false, message: error instanceof Error ? error.message : '打印失败' };
  }
}
