// Vditor 实例的生命周期管理。
//
// 离线化（cdn 指向插件内副本、主样式要自己挂）的细节在 lib/vditor.ts 里。
import Vditor from 'vditor';
import { assetUrl, storeAsset, toRenderable } from '../lib/asset';
import { installScrollSync, type ScrollSync } from '../lib/scroll-sync';
import { injectVditorStyle, vditorBase } from '../lib/vditor';
import type { EditorMode, Settings } from '../lib/types';

export type EditorHandle = {
  /** 以存库形态设置内容；会先转成渲染形态。 */
  setContent(markdown: string): void;
  /** 取当前内容（渲染形态，图片可能是 blob URL）。 */
  getContent(): string;
  /** 切换亮暗。 */
  applyTheme(dark: boolean): void;
  /** 滚动到第 n 个标题（n 与 parseOutline 的下标一致）。 */
  scrollToHeading(index: number): void;
  focus(): void;
  destroy(): void;
};

export type EditorCallbacks = {
  /** 内容变化。参数是渲染形态，调用方负责转存库形态。 */
  onInput(markdown: string): void;
  /** 需要给用户看的提示（图片太大、保存失败等）。 */
  onNotice(message: string): void;
};

/**
 * 创建一个 Vditor 实例。
 *
 * 换编辑模式必须整个重建 —— Vditor 没有运行时切模式的 API（公开方法只有 `getCurrentMode`）。
 * 调用方负责先取出内容、destroy、再用新 mode 调一次本函数。
 *
 * @param element 挂载容器。
 * @param settings 当前设置，决定模式、计数器等。
 * @param dark 当前是否暗色。由调用方算好传进来，这样系统主题切换能驱动重渲染。
 * @param initialMarkdown 初始内容（存库形态）。
 * @param callbacks 内容变化与提示回调。
 * @returns 操作句柄。
 */
export function createEditor(
  element: HTMLElement,
  settings: Settings,
  dark: boolean,
  initialMarkdown: string,
  callbacks: EditorCallbacks,
): EditorHandle {
  injectVditorStyle();

  const cdn = vditorBase();
  let suppressInput = false;
  let ready = false;
  /** 编辑器就绪前请求过的内容，就绪后补上。 */
  let queued: string | null = null;
  /** 分屏模式的滚动同步。其他模式下是 null。 */
  let scrollSync: ScrollSync | null = null;

  // 显式标注类型：下面 upload.handler 的闭包里要用到 vditor 自己，
  // 不标注的话 TS 会因为「初始化表达式引用了自身」把它推成 any（TS7022）。
  const vditor: Vditor = new Vditor(element, {
    cdn,
    value: toRenderable(initialMarkdown),
    mode: settings.mode,
    lang: 'zh_CN',
    height: '100%',
    // 关掉 localStorage 缓存：我们自己管保存，而且它按固定 key 存，
    // 多篇文档会互相覆盖 —— 切文档时读到的是上一篇的草稿。
    cache: { enable: false },
    theme: dark ? 'dark' : 'classic',
    icon: 'ant',
    // 自带大纲关掉，右栏用我们自己的 OutlinePane：样式能和左栏统一，
    // 而且 parseOutline 不依赖 DOM 渲染完成。
    outline: { enable: false, position: 'right' },
    counter: { enable: true, type: 'text' },
    toolbarConfig: { pin: true },
    toolbar: TOOLBAR,
    preview: {
      delay: 300,
      maxWidth: 1200,
      hljs: { enable: true, lineNumber: true, style: dark ? 'github-dark' : 'github' },
      math: {
        // KaTeX 而不是 MathJax：MathJax 的 tex-svg-full.js 单文件 6.5MB，
        // 而 KaTeX 全家桶（含 60 个字体文件）才 1.2MB，渲染还更快。
        engine: 'KaTeX',
        // 允许 $100 这种写法不被当成公式开头，少一类误渲染。
        inlineDigit: false,
      },
      theme: {
        current: dark ? 'dark' : 'light',
        path: `${cdn}/dist/css/content-theme`,
      },
    },
    upload: {
      // 自定义上传：图片存进 uTools 附件，正文里只留 fundoc-asset:// 引用。
      // 返回 null 表示「我已自己处理完」，返回字符串会被 Vditor 当成错误提示。
      handler: (files) => handleUpload(files, vditor, callbacks.onNotice),
    },
    after: () => {
      ready = true;
      // 在 after 里安装，而不是 createEditor 返回后：分屏的 textarea 和预览区都是
      // Vditor 构造过程中建的，只有这时候才查得到。
      if (settings.mode === 'sv') scrollSync = installScrollSync(element, () => vditor.getValue());
      if (queued !== null) {
        const pending = queued;
        queued = null;
        setContent(pending);
      }
    },
    input: (value) => {
      if (suppressInput) return;
      callbacks.onInput(value);
    },
  });

  function setContent(markdown: string): void {
    if (!ready) {
      // after 回调还没跑，setValue 会丢。记下来等就绪。
      queued = markdown;
      return;
    }
    suppressInput = true;
    // clearStack = true：撤销栈不能跨文档，否则在 B 文档里按 Ctrl+Z 会撤出 A 的内容。
    vditor.setValue(toRenderable(markdown), true);
    suppressInput = false;
    // setValue 不触发 input 事件，所以得手动作废测量 —— 否则切文档后还在用上一篇的锚点。
    scrollSync?.invalidate();
  }

  return {
    setContent,
    getContent: () => (ready ? vditor.getValue() : initialMarkdown),
    applyTheme: (isDarkNow) => {
      if (!ready) return;
      vditor.setTheme(
        isDarkNow ? 'dark' : 'classic',
        isDarkNow ? 'dark' : 'light',
        isDarkNow ? 'github-dark' : 'github',
        `${cdn}/dist/css/content-theme`,
      );
    },
    scrollToHeading: (index) => scrollToHeading(element, index),
    focus: () => ready && vditor.focus(),
    destroy: () => {
      ready = false;
      // 先摘监听再 destroy：Vditor 会把 DOM 整个拆掉，之后 mirror 就没人回收了。
      scrollSync?.destroy();
      scrollSync = null;
      vditor.destroy();
    },
  };
}

const TOOLBAR = [
  'emoji',
  'headings',
  'bold',
  'italic',
  'strike',
  '|',
  'list',
  'ordered-list',
  'check',
  '|',
  'quote',
  'code',
  'inline-code',
  'table',
  'link',
  'upload',
  '|',
  'undo',
  'redo',
  '|',
  'edit-mode',
  'both',
  'preview',
  'outdent',
  'indent',
  '|',
  'fullscreen',
];

/**
 * 把粘贴/选择的图片存成附件，并在光标处插入 Markdown。
 *
 * @returns null 表示已处理完；字符串是给 Vditor 显示的错误信息。
 */
function handleUpload(
  files: File[],
  vditor: Vditor,
  onNotice: (message: string) => void,
): Promise<null> {
  return (async () => {
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        onNotice(`暂不支持插入 ${file.name}，目前只能放图片`);
        continue;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const assetId = storeAsset(bytes, file.type);
        const alt = file.name.replace(/\.[^.]+$/, '') || 'image';
        // 插进去的是 blob URL（能立刻显示）；保存前 toStorable 会把它换回
        // fundoc-asset://，所以落库的永远是稳定引用。
        vditor.insertValue(`![${alt}](${assetUrl(assetId) ?? ''})`);
      } catch (error) {
        onNotice(error instanceof Error ? error.message : '图片插入失败');
      }
    }
    return null;
  })();
}

/**
 * 滚到第 index 个标题。
 *
 * 按**出现顺序下标**匹配，而不是按文本或 id：Vditor 不给标题加稳定 id，而正文里完全可以
 * 有两个同名标题。代码围栏里的 `# 注释` 在 DOM 里是 `<pre>` 而不是 `<h1>`，parseOutline
 * 也跳过了围栏，两边的序号因此是对齐的。
 *
 * @param container 编辑器容器。
 * @param index 标题序号。
 */
function scrollToHeading(container: HTMLElement, index: number): void {
  // 三种模式的正文容器 class 名不同，但都带 .vditor-reset。
  //
  // 挑的标准是「里面真有标题元素」，而不是「可见」：sv 模式的源码区是个 textarea，
  // 它自己也带 .vditor-reset 且是可见的，但里面只有纯文本，查 h1..h6 一个都查不到 ——
  // 按可见性挑就会选中它，然后什么也不滚。分屏时要滚的是右边的预览区。
  const panes = [...container.querySelectorAll<HTMLElement>('.vditor-reset')];
  const withHeadings = panes.filter((el) => el.querySelector('h1, h2, h3, h4, h5, h6'));
  const pane = withHeadings.find((el) => el.offsetParent !== null) ?? withHeadings[0];
  if (!pane) return;

  const headings = pane.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
  headings[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 供外部复用的编辑模式说明，设置面板和工具栏提示都用它。 */
export const MODE_LABELS: Record<EditorMode, string> = {
  wysiwyg: '所见即所得',
  ir: '即时渲染',
  sv: '分屏预览',
};
