// 分屏模式（sv）的双向滚动同步。
//
// 换算规则见 lib/scroll-map.ts。这里负责两件 DOM 上的脏活：
//
// 1. **源码某一行在 textarea 里是第几像素**。textarea 没有任何 API 能回答这个问题，
//    所以用「镜像元素」：造一个样式和它完全一致的隐藏 div，把源码放进去，在每个标题行的
//    首字符上包一个 span，读 span.offsetTop。这是 textarea 光标定位的经典做法。
//    一次布局就能量出全部标题，比逐个标题量一遍快得多。
//
// 2. **停掉 Vditor 自己的同步**。它在 textarea 上也挂了 scroll 监听，做等比例换算。
//    监听是构造时挂的匿名函数，摘不掉；但它只是在 JS 里给 preview.scrollTop 赋值，
//    所以接管这个元素的 scrollTop 写入口就能把它整条路堵死，见 hijackScrollTop。
import { parseOutline } from './outline';
import { buildScrollMap, flipMap, mapScroll, type Anchor } from './scroll-map';

/** 镜像元素要照抄的样式。少一条就会错行 —— 字体和换行规则直接决定折行位置。 */
const MIRRORED_STYLES = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'textIndent',
  'wordSpacing',
  'whiteSpace',
  'overflowWrap',
  'wordBreak',
  'tabSize',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
] as const;

export type ScrollSync = {
  /** 源码或窗口尺寸变了，下次滚动前重新测量。 */
  invalidate(): void;
  destroy(): void;
};

/**
 * 造镜像元素。
 *
 * 宽度取 textarea 的 clientWidth（不含边框、也不含滚动条占位），配 `box-sizing: border-box`
 * 与同样的内边距，折行位置才和 textarea 一致。
 *
 * @param textarea 源 textarea。
 * @returns 已插入 document.body 的隐藏元素。
 */
function createMirror(textarea: HTMLTextAreaElement): HTMLDivElement {
  const mirror = document.createElement('div');
  const computed = getComputedStyle(textarea);
  for (const name of MIRRORED_STYLES) mirror.style[name] = computed[name];

  mirror.style.position = 'absolute';
  mirror.style.top = '0';
  mirror.style.left = '-99999px';
  mirror.style.visibility = 'hidden';
  mirror.style.boxSizing = 'border-box';
  mirror.style.border = '0';
  mirror.style.height = 'auto';
  mirror.style.overflow = 'hidden';
  // textarea 的默认折行就是这两条，computed 里取不到时兜底。
  if (!mirror.style.whiteSpace) mirror.style.whiteSpace = 'pre-wrap';
  if (!mirror.style.overflowWrap) mirror.style.overflowWrap = 'break-word';
  mirror.setAttribute('aria-hidden', 'true');

  document.body.append(mirror);
  return mirror;
}

/**
 * 量出若干源码行在 textarea 里的纵向像素位置。
 *
 * @param mirror 镜像元素。
 * @param textarea 源 textarea（取宽度）。
 * @param text 源码。
 * @param lines 要测的行号（0 起，需升序且不重复）。
 * @returns 与 lines 一一对应的像素偏移；行号越界的位置是 NaN。
 */
function measureLines(
  mirror: HTMLDivElement,
  textarea: HTMLTextAreaElement,
  text: string,
  lines: number[],
): number[] {
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.textContent = '';

  // 行号 → 该行在整段文本里的起始下标。
  const starts: number[] = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1);

  // 总是把第 0 行也量上，它是下面扣半行距的基准。lines 里本来就有就不重复插。
  const wanted = lines[0] === 0 ? lines : [0, ...lines];

  const markers: Array<HTMLSpanElement | null> = [];
  let cursor = 0;
  for (const line of wanted) {
    const start = starts[line];
    if (start === undefined || start < cursor) {
      markers.push(null);
      continue;
    }
    mirror.append(document.createTextNode(text.slice(cursor, start)));
    const marker = document.createElement('span');
    // 包住行首那一个字符，而不是插一个空 span：空的行内元素在某些情况下量不到位置，
    // 而插入零宽字符又会改变文本、影响折行。标题行首一定是 `#`，拿它当锚点正好。
    marker.textContent = text.slice(start, start + 1) || '​';
    mirror.append(marker);
    markers.push(marker);
    cursor = start + 1;
  }
  mirror.append(document.createTextNode(text.slice(cursor)));

  const offsets = markers.map((marker) => (marker ? marker.offsetTop : Number.NaN));
  // offsetTop 量到的是**行内盒**的上沿，比行盒上沿低了半个行距（行高减去字体内容高度，
  // 再除以二）。而我们要的是「把这一行顶到可视区顶部时的 scrollTop」，也就是行盒上沿。
  // 第 0 行的行盒上沿正好等于上内边距，拿它反推出半行距，再统一扣掉。
  //
  // 只差一两像素，但它会被放大：首个标题那一段往往很陡（源码侧十来像素对预览侧近百像素，
  // 预览区上方还有工具条和内边距），差 1px 到了预览侧就是差七八像素。
  const padTop = parseFloat(mirror.style.paddingTop) || 0;
  const halfLeading = Number.isFinite(offsets[0]) ? offsets[0] - padTop : 0;
  const corrected = offsets.map((value) => value - halfLeading);

  return wanted === lines ? corrected : corrected.slice(1);
}

/**
 * 元素在滚动容器里的位置 —— 即「把它顶到容器顶部时容器的 scrollTop」。
 *
 * 用 getBoundingClientRect 而不是 offsetTop：预览区里的标题可能嵌在 blockquote 之类的
 * 定位祖先里，offsetTop 的基准就不是滚动容器了。
 *
 * @param element 目标元素。
 * @param container 滚动容器。
 * @returns 像素偏移。
 */
function offsetWithin(element: HTMLElement, container: HTMLElement): number {
  return (
    element.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop
  );
}

const maxScroll = (element: HTMLElement): number =>
  Math.max(0, element.scrollHeight - element.clientHeight);

/**
 * 接管一个元素的 scrollTop 写入口：读还是读真值，写一律吞掉，只留一个后门给自己用。
 *
 * 为什么要堵而不是「我后挂监听、把它的值盖掉」：盖得掉，但代价是**每次源码栏滚动都得跟着
 * 写一遍预览栏**，包括我们自己写进源码栏而回弹出来的那一次。而预览栏正在平滑滚动（点大纲
 * 跳转）或惯性滚动（触控板甩一下）时，这么一写就把滚动打断了 —— 点大纲只挪一两像素就停住。
 * 把对面的写入口堵死，两边就各自只有一个写者，不用再靠「谁最后写」来决胜。
 *
 * scrollIntoView 走的是内部滚动机制而不是这个 setter，所以大纲跳转照旧有效。
 *
 * @param element 目标元素。
 * @returns write 走原生 setter，restore 还原；拿不到原生描述符时返回 null。
 */
function hijackScrollTop(
  element: HTMLElement,
): { write(value: number): void; restore(): void } | null {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  const read = descriptor?.get;
  const write = descriptor?.set;
  if (!read || !write) return null;

  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => read.call(element),
    set: () => {
      // 故意什么都不做。
    },
  });

  return {
    write: (value) => write.call(element, value),
    // 删掉这个自有属性，原型上的访问器就又生效了。
    restore: () => void Reflect.deleteProperty(element, 'scrollTop'),
  };
}

/**
 * 给分屏模式装上双向滚动同步。
 *
 * @param container 编辑器根元素（Vditor 挂载的那个）。
 * @param getSource 取当前源码。每次重新测量时调用。
 * @returns 控制句柄；容器里没有分屏结构时返回 null。
 */
export function installScrollSync(
  container: HTMLElement,
  getSource: () => string,
): ScrollSync | null {
  const editor = container.querySelector<HTMLTextAreaElement>('textarea.vditor-sv');
  const preview = container.querySelector<HTMLElement>('.vditor-preview');
  if (!editor || !preview) return null;

  const mirror = createMirror(editor);
  const hijack = hijackScrollTop(preview);
  let forward: Anchor[] = [];
  let backward: Anchor[] = [];
  let dirty = true;

  // 写成箭头函数常量而不是 function 声明：函数声明会被提升，TS 认为它可能在上面那句
  // 空值检查之前就被调用，于是 editor / preview 在函数体里又变回可空，到处都要再判一次。
  const rebuild = (): void => {
    dirty = false;
    const source = getSource();
    const headings = parseOutline(source);
    const rendered = [...preview.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')];
    // 两侧标题数不一致时只配到短的那一边。多出来的是解析和渲染的分歧（HTML 里手写的
    // <h2>、setext 标题等），硬配会把整段映射对错位。
    const count = Math.min(headings.length, rendered.length);

    const offsets = measureLines(
      mirror,
      editor,
      source,
      headings.slice(0, count).map((item) => item.line),
    );
    const anchors: Anchor[] = [];
    for (let index = 0; index < count; index += 1) {
      const from = offsets[index];
      if (!Number.isFinite(from)) continue;
      anchors.push({ from, to: offsetWithin(rendered[index], preview) });
    }

    forward = buildScrollMap(anchors, maxScroll(editor), maxScroll(preview));
    backward = flipMap(forward);
  };

  // 写对面的 scrollTop 会让对面也派发 scroll 事件，再同步回来就成了回声。
  //
  // 这里按「每次程序性写入记一次账，对面的下一个 scroll 事件拿它抵掉」来挡，而不是上一把
  // 带时限的锁。带时限的锁在这儿是不够的：scroll 事件是在「更新渲染」里派发的，而
  // requestAnimationFrame 回调排在同一轮的 scroll 事件之后 —— 等回声那一帧到来时锁早
  // 解开了。记账则不依赖任何时序假设。
  const pending = new WeakMap<HTMLElement, number>();

  /**
   * 程序性地滚动某一栏，并为随之而来的 scroll 事件记账。
   *
   * 先读后写再比对，而不是直接记一笔：值没变（或被夹在两端）时浏览器根本不派发事件，
   * 记下的账会一直留着，把之后某一次真实滚动吃掉。
   *
   * @param target 要滚的元素。
   * @param value 目标位置。
   */
  const write = (target: HTMLElement, value: number): void => {
    const before = target.scrollTop;
    if (target === preview && hijack) hijack.write(value);
    else target.scrollTop = value;
    if (target.scrollTop === before) return;
    pending.set(target, (pending.get(target) ?? 0) + 1);
  };

  /**
   * 把 source 的滚动位置映射到 target。
   * @param pickMap 取映射的回调。必须是回调而不是数组：rebuild 之后 forward/backward
   *   是两个新数组，提前取好的引用会是旧的。
   */
  function sync(source: HTMLElement, target: HTMLElement, pickMap: () => Anchor[]): void {
    const echo = pending.get(source) ?? 0;
    if (echo > 0) {
      pending.set(source, echo - 1);
      return;
    }
    if (dirty) rebuild();
    write(target, mapScroll(pickMap(), source.scrollTop));
  }

  const onEditorScroll = () => sync(editor, preview, () => forward);
  const onPreviewScroll = () => sync(preview, editor, () => backward);
  // 打字会同时改变源码高度和（300ms 后）预览高度，两边的测量都得作废。
  const onInput = () => void (dirty = true);

  editor.addEventListener('scroll', onEditorScroll, { passive: true });
  preview.addEventListener('scroll', onPreviewScroll, { passive: true });
  editor.addEventListener('input', onInput);

  // 预览重渲染是异步的（options.preview.delay），所以不能只在 input 时作废。
  const mutation = new MutationObserver(() => void (dirty = true));
  mutation.observe(preview, { childList: true, subtree: true });

  // 栏宽拖动、窗口缩放都会改变折行，镜像的宽度也得跟着重测。
  const resize = new ResizeObserver(() => void (dirty = true));
  resize.observe(editor);
  resize.observe(preview);

  return {
    invalidate: () => void (dirty = true),
    destroy: () => {
      editor.removeEventListener('scroll', onEditorScroll);
      preview.removeEventListener('scroll', onPreviewScroll);
      editor.removeEventListener('input', onInput);
      mutation.disconnect();
      resize.disconnect();
      mirror.remove();
      hijack?.restore();
    },
  };
}
