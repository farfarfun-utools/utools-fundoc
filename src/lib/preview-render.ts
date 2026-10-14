// 离屏渲染一篇文档：打印和「复制 / 下载为图片」共用这一份。
//
// 两条路要的东西一模一样 —— 一律按亮色主题渲染、等公式真渲染完、把标题编号贴上去。
// 这段原来只长在 print.ts 里，加图片导出时如果原样抄一份，结果就是「打印这边修过的坑
// 在图片那边还在」，所以先抽出来。
//
// 不用 Vditor 的 `preview()` 返回的 Promise 当完成信号：它只 await 了 lute/i18n/图标三个
// 脚本，之后的 mathRender、highlightRender 都是发射后不管的（previewRender.ts 里没有
// await），Promise 落地时公式往往还没渲染。判据得是 DOM，不是秒表。
import Vditor from 'vditor';
import { toRenderable } from './asset';
import { applyHeadingNumbers } from './heading-number';
import { injectVditorStyle, vditorBase } from './vditor';

/** 等公式渲染完的最长时间。超了就照用 —— 卡住不出结果比出一张有瑕疵的图更糟。 */
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

export type Offscreen = {
  /** 渲染好的容器，已经挂在 body 上（在视野外）。 */
  container: HTMLElement;
  /** 公式是不是等超时了。超时要提示用户，图/PDF 里可能留着原始 LaTeX。 */
  mathTimedOut: boolean;
  /** 收掉容器。幂等。 */
  dispose(): void;
};

/**
 * 把 Markdown 渲染到一个离屏容器里。
 *
 * 刻意**一律按亮色主题**渲染：纸上和分享出去的图片都是亮底场景，深色底既费墨又难读。
 * 代价是 Vditor 的 `setContentTheme` 会把全局那个 content-theme `<link>` 一起切成亮色，
 * 所以调用方拿到结果后要让编辑器重贴一次主题（`EditorHandle.applyTheme`）。
 *
 * @param markdown 正文，存库形态（图片是 `fundoc-asset://`）。
 * @param options.className 容器的 class，决定它怎么离屏、多宽（见 style.css）。
 * @param options.headingNumber 标题是否自动编号，跟界面上的设置保持一致。
 * @returns 渲染好的容器；失败时抛出，容器已经收干净。
 */
export async function renderOffscreen(
  markdown: string,
  { className, headingNumber = false }: { className: string; headingNumber?: boolean },
): Promise<Offscreen> {
  injectVditorStyle();

  const container = document.createElement('div');
  container.className = className;
  document.body.append(container);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    container.remove();
  };

  try {
    const cdn = vditorBase();
    await Vditor.preview(container as HTMLDivElement, toRenderable(markdown), {
      cdn,
      mode: 'light',
      lang: 'zh_CN',
      // 锚点图标在纸上和图片里都是噪音。
      anchor: 0,
      // 行号在 PDF 和图片里都有用（方便对着讲），所以保留。
      hljs: { enable: true, lineNumber: true, style: 'github' },
      math: { engine: 'KaTeX', inlineDigit: false },
      theme: { current: 'light', path: `${cdn}/dist/css/content-theme` },
      icon: 'ant',
    });

    // 编号贴在渲染完的 DOM 上（`::before` 生成内容既会打印也会进图片），正文源码仍然不含数字。
    applyHeadingNumbers(container, headingNumber);

    const mathDone = await waitForMath(container);
    // 字体没加载完就出图，KaTeX 的字形会按回退字体量尺寸，公式的上下标全是歪的。
    await document.fonts?.ready;

    return { container, mathTimedOut: !mathDone, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
