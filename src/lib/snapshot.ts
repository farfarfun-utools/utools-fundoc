// 把一篇文档整篇渲染成一张 PNG（「复制为图片」「下载为图片」都走这里）。
//
// 做法是 SVG 的 `<foreignObject>`：把渲染好的 DOM 克隆进一张 SVG，连同样式表一起塞成
// data URL 喂给 `<img>`，再画到 canvas 上取 PNG。
//
// 为什么不引 html2canvas / html-to-image：那类库要把**每个元素**的 computed style 抄一遍
// 带进克隆体，长文档几千个节点，又慢又容易抄歪（伪元素、继承、简写属性都得自己还原）。
// 而这个插件的样式表就那么几张（Vditor 的 index.css、内容主题、KaTeX、本应用自己的），
// 整张塞进 SVG 里，渲染结果和屏幕上就是同一套 CSS 算出来的 —— 包括标题编号那条
// `::before`（lib/heading-number.ts）也不用特殊照顾。顺带也不用为一个按钮往三个依赖里
// 再加一个。
//
// 一条硬限制决定了下面每一步为什么长这样：**`<img>` 里的 SVG 不许加载任何外部资源**。
// 字体、图片必须全部换成 data URL，否则公式会按回退字体量尺寸（上下标全歪），图片直接空白。
import { renderOffscreen, type Offscreen } from './preview-render';

/** 离屏定位用的 class，见 style.css。 */
const OFFSCREEN_CLASS = 'fundoc-shot-root';
/** 纸面外观（宽度、留白、亮色底）用的 class。克隆体要留着它，所以和上面那个分开。 */
const PAGE_CLASS = 'fundoc-shot-page';

/** 值得内联进 SVG 的资源。 */
const INLINE_EXT = /\.(?:woff2|png|jpe?g|gif|webp|avif|svg|ico|bmp)(?:[?#]|$)/i;

/**
 * 画布上限。
 *
 * Chromium 实际是「单边 65535、总面积 2^28 像素」，这里按一半留余量 —— 超限的表现是
 * `toBlob` 悄悄给出 null 或者整张全透明，而不是抛异常，不值得贴着上限走。
 */
const MAX_CANVAS_SIDE = 16_384;
const MAX_CANVAS_AREA = 1 << 27;

/** 低于这个倍率就别出图了：缩到这么小的正文已经没法读。 */
const MIN_SCALE = 0.5;

/** 默认倍率。2 倍在高分屏上看着才不毛糙，也正好是微信/飞书里贴图的常见清晰度。 */
const DEFAULT_SCALE = 2;

/**
 * 挑一个既清晰又不撞画布上限的倍率。
 *
 * @param width 内容宽（CSS 像素）。
 * @param height 内容高（CSS 像素）。
 * @param preferred 想要的倍率。
 * @returns 实际可用的倍率；宽高非法时返回 0。
 */
export function pickScale(width: number, height: number, preferred = DEFAULT_SCALE): number {
  if (!(width > 0) || !(height > 0)) return 0;
  const bySide = Math.min(MAX_CANVAS_SIDE / width, MAX_CANVAS_SIDE / height);
  const byArea = Math.sqrt(MAX_CANVAS_AREA / (width * height));
  return Math.min(preferred, bySide, byArea);
}

/**
 * 把 CSS 里的 `url(...)` 解析成绝对地址。
 *
 * @param css CSS 文本。
 * @param baseUrl 这份 CSS 自己的地址，相对路径按它解析。
 * @returns 每个 `url()` 的原文和绝对地址；解析不出来的那些直接跳过。
 */
function cssUrls(css: string, baseUrl: string): Array<{ raw: string; absolute: string }> {
  const found: Array<{ raw: string; absolute: string }> = [];
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
    const raw = match[2].trim();
    // data: 已经是内联的；about: / 空值没什么可取。
    if (!raw || /^(?:data|about|blob):/i.test(raw)) continue;
    try {
      found.push({ raw, absolute: new URL(raw, baseUrl).href });
    } catch {
      // 不是合法 URL（CSS 里偶尔有模板残留），当它不存在。
    }
  }
  return found;
}

/**
 * 列出一份 CSS 里需要内联的资源。
 *
 * 只挑 woff2 和图片：`@font-face` 的 `src` 里 woff2 一律排在 woff / ttf 前面，而浏览器
 * 是**按声明的 format 静态挑第一个支持的**，所以后面那两个根本不会被取 —— 把它们也内联
 * 只会让 SVG 凭空大出两三倍（KaTeX 那 20 套字体 woff2 一共 296KB，三种格式加起来 1MB 多）。
 *
 * @param css CSS 文本。
 * @param baseUrl 这份 CSS 自己的地址。
 * @returns 去重后的绝对地址。
 */
export function cssUrlsToInline(css: string, baseUrl: string): string[] {
  const urls = cssUrls(css, baseUrl)
    .filter((item) => INLINE_EXT.test(item.absolute))
    .map((item) => item.absolute);
  return [...new Set(urls)];
}

/**
 * 把 CSS 里的 `url(...)` 换成 data URL。
 *
 * 换不到的一律改写成**绝对地址**而不是留着相对路径：相对路径在 SVG 里会按 SVG 自己的
 * 地址（一个 data URL）去解析，百分之百是坏链；绝对地址虽然同样加载不到，但万一哪天
 * 这段 CSS 被用在别处，行为还是对的。
 *
 * @param css CSS 文本。
 * @param baseUrl 这份 CSS 自己的地址。
 * @param inlined 绝对地址 → data URL。
 * @returns 改写后的 CSS。
 */
export function inlineCssUrls(
  css: string,
  baseUrl: string,
  inlined: Map<string, string>,
): string {
  let result = css;
  for (const { raw, absolute } of cssUrls(css, baseUrl)) {
    const replacement = inlined.get(absolute) ?? absolute;
    // 按原文整段替换，`url(` 前缀一起带上，免得把别处同名的字符串也换掉。
    result = result.split(`url(${raw})`).join(`url("${replacement}")`);
    result = result.split(`url('${raw}')`).join(`url("${replacement}")`);
    result = result.split(`url("${raw}")`).join(`url("${replacement}")`);
  }
  return result;
}

// ───────────────────────────── 浏览器侧 ─────────────────────────────

/** 已经内联好的样式表：地址 → CSS 文本。一次会话里样式表不会变，字体也就只取一次。 */
const styleCache = new Map<string, string>();
/** 已经转成 data URL 的资源。KaTeX 的字体全在这里，第二次出图就是纯内存操作了。 */
const resourceCache = new Map<string, string>();

/**
 * 取一个资源并转成 data URL。
 *
 * 失败只 `console.warn`：少一个字体或一张图顶多让这张 PNG 有瑕疵，不该把整次导出判死。
 * （也刻意不用 console.error —— e2e 把 console.error 当失败，而「某个可选资源 404」
 * 不是回归。）
 *
 * @param url 绝对地址。
 * @returns data URL；取不到返回 null。
 */
async function toDataUrl(url: string): Promise<string | null> {
  const cached = resourceCache.get(url);
  if (cached !== undefined) return cached;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('读取失败'));
      reader.readAsDataURL(blob);
    });
    resourceCache.set(url, dataUrl);
    return dataUrl;
  } catch (error) {
    console.warn('[fundoc] 图片快照取不到资源，这张图里它会缺失', url, error);
    return null;
  }
}

/**
 * 取一份样式表，并把里面引用的字体、图片内联进去。
 * @param href 样式表地址。
 * @returns CSS 文本；取不到返回空串。
 */
async function loadStyleSheet(href: string): Promise<string> {
  const cached = styleCache.get(href);
  if (cached !== undefined) return cached;

  let css = '';
  try {
    const response = await fetch(href);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    css = await response.text();
  } catch (error) {
    console.warn('[fundoc] 图片快照读不到样式表，这张图的样式会不全', href, error);
    styleCache.set(href, '');
    return '';
  }

  const urls = cssUrlsToInline(css, href);
  const resolved = await Promise.all(urls.map(toDataUrl));
  const inlined = new Map<string, string>();
  urls.forEach((url, index) => {
    const dataUrl = resolved[index];
    if (dataUrl) inlined.set(url, dataUrl);
  });

  const result = inlineCssUrls(css, href, inlined);
  styleCache.set(href, result);
  return result;
}

/**
 * 收集页面上全部样式，拼成一段能直接塞进 SVG 的 CSS。
 *
 * 按 DOM 顺序遍历 `<link rel=stylesheet>` 和 `<style>`，而不是读 `document.styleSheets`
 * 的 `cssRules` —— 后者对跨源样式表会抛 SecurityError，而且拿不到还没加载完的那几张
 * （Vditor 的 KaTeX / highlight.js 样式是渲染时才动态插进来的）。这里只读 href 自己 fetch，
 * 不碰 cssRules，所以两种情况都不受影响。
 *
 * @returns 拼好的 CSS。
 */
async function documentCss(): Promise<string> {
  const nodes = [...document.querySelectorAll<HTMLElement>('link[rel="stylesheet"], style')];
  const parts = await Promise.all(
    nodes.map((node) => {
      if (node instanceof HTMLLinkElement) return loadStyleSheet(node.href);
      return Promise.resolve(node.textContent ?? '');
    }),
  );
  return parts.filter(Boolean).join('\n');
}

/**
 * 把克隆体里的图片换成 data URL。
 *
 * 正文里的图是 blob URL（见 lib/asset.ts），而 blob 在 SVG 里属于外部资源，一律加载不到。
 *
 * @param root 克隆出来的根元素。
 */
async function inlineImages(root: HTMLElement): Promise<void> {
  const images = [...root.querySelectorAll('img')];
  await Promise.all(
    images.map(async (image) => {
      const src = image.getAttribute('src');
      if (!src || src.startsWith('data:')) return;
      const dataUrl = await toDataUrl(new URL(src, document.baseURI).href);
      // 取不到就留着原地址：SVG 里加载不到的引用只是画不出来，不会让整张图失败。
      if (dataUrl) image.setAttribute('src', dataUrl);
    }),
  );
}

export type Snapshot = { bytes: Uint8Array; width: number; height: number };

/**
 * 把一个已经渲染好的元素截成 PNG。
 *
 * @param element 要截的元素，必须已经在文档里（要量尺寸）。
 * @param options.scale 像素倍率；会按画布上限往下夹。
 * @returns PNG 字节和**像素**尺寸。
 * @throws 尺寸过大、SVG 解析失败或 canvas 导不出时抛出。
 */
export async function snapshotElement(
  element: HTMLElement,
  { scale: preferred = DEFAULT_SCALE }: { scale?: number } = {},
): Promise<Snapshot> {
  const box = element.getBoundingClientRect();
  const width = Math.ceil(box.width);
  // scrollHeight 而不是 box.height：容器没限高，但渲染后的内容（长表格、宽代码块）
  // 仍可能把自己撑出去。
  const height = Math.ceil(Math.max(element.scrollHeight, box.height));

  const scale = pickScale(width, height, preferred);
  if (scale < MIN_SCALE) {
    throw new Error(`这篇文档渲染出来有 ${width}×${height}，超出浏览器画布上限，没法截成一张图`);
  }

  const clone = element.cloneNode(true) as HTMLElement;
  // 离屏定位（position: fixed; left: -10000px）只对真实页面有意义，带进 SVG 会让内容
  // 整块跑到视野外 —— 画出来是一片空白。纸面外观由另一个 class 管着，留下。
  clone.classList.remove(OFFSCREEN_CLASS);
  await inlineImages(clone);

  const style = document.createElement('style');
  style.textContent = await documentCss();

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const foreign = document.createElementNS(SVG_NS, 'foreignObject');
  foreign.setAttribute('x', '0');
  foreign.setAttribute('y', '0');
  foreign.setAttribute('width', '100%');
  foreign.setAttribute('height', '100%');
  // 包一层 div：`<style>` 和内容都是 XHTML 元素，XMLSerializer 会自动给它们补上
  // xmlns，整段序列化出来就是合法的 XML（`<br>` 这类空元素也会写成自闭合）。
  const wrapper = document.createElement('div');
  wrapper.append(style, clone);
  foreign.append(wrapper);
  svg.append(foreign);

  // 用 encodeURIComponent 而不是 base64：正文里全是中文，base64 还得先过一遍 UTF-8 编码，
  // 而且编码后体积更大（样式表加字体本来就有一两 MB）。
  const markup = new XMLSerializer().serializeToString(svg);
  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

  const image = new Image();
  image.src = source;
  try {
    await image.decode();
  } catch (error) {
    throw new Error(`渲染成图片失败（浏览器解析不了这张 SVG）：${describe(error)}`);
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('拿不到 canvas 2d 上下文');

  // 先铺白底：PNG 默认透明，贴到聊天窗口的深色气泡里会变成「看不见的字」。
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.drawImage(image, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('canvas 导出 PNG 失败');

  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    width: canvas.width,
    height: canvas.height,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type SnapshotOutcome =
  | { ok: true; shot: Snapshot; mathTimedOut: boolean }
  | { ok: false; message: string };

/**
 * 渲染一篇文档并截成 PNG。
 *
 * @param markdown 正文，存库形态。
 * @param options.headingNumber 标题是否自动编号，跟界面上的设置保持一致。
 * @param options.scale 像素倍率。
 * @returns PNG 字节；失败时带一句能直接显示给用户的话。
 */
export async function snapshotMarkdown(
  markdown: string,
  { headingNumber = false, scale }: { headingNumber?: boolean; scale?: number } = {},
): Promise<SnapshotOutcome> {
  if (typeof document === 'undefined' || typeof HTMLCanvasElement === 'undefined') {
    return { ok: false, message: '当前环境不支持生成图片' };
  }

  let offscreen: Offscreen | null = null;
  try {
    offscreen = await renderOffscreen(markdown, {
      className: `${OFFSCREEN_CLASS} ${PAGE_CLASS}`,
      headingNumber,
    });
    const shot = await snapshotElement(offscreen.container, { scale });
    return { ok: true, shot, mathTimedOut: offscreen.mathTimedOut };
  } catch (error) {
    return { ok: false, message: describe(error) };
  } finally {
    offscreen?.dispose();
  }
}
