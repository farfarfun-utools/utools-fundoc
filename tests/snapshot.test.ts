// 图片快照里的纯计算部分。
//
// 真正出图的那段（foreignObject → canvas）要浏览器才跑得起来，由 scripts/e2e.mjs 验；
// 这里钉的是两件「错了只会在成品上体现成瑕疵」的事：倍率别撞画布上限，CSS 里的字体
// 地址要真的被换成 data URL —— 换漏一个，SVG 里就加载不到字体，公式的上下标全是歪的，
// 而出图本身不会报任何错。
import { describe, expect, it } from 'vitest';
import { cssUrlsToInline, inlineCssUrls, pickScale } from '../src/lib/snapshot';

describe('pickScale', () => {
  it('小图直接给默认的 2 倍', () => {
    expect(pickScale(800, 1200)).toBe(2);
  });

  it('尺寸非法时返回 0，让调用方拦住（0 宽的 canvas 导出来是空的）', () => {
    expect(pickScale(0, 1200)).toBe(0);
    expect(pickScale(800, 0)).toBe(0);
    expect(pickScale(800, -1)).toBe(0);
    expect(pickScale(Number.NaN, 100)).toBe(0);
  });

  it('长文按面积上限往下夹，夹完不超过 2^27 像素', () => {
    const width = 800;
    const height = 120_000; // 两三百页的长文
    const scale = pickScale(width, height);

    expect(scale).toBeLessThan(2);
    expect(width * scale * height * scale).toBeLessThanOrEqual(1 << 27);
  });

  it('单边上限也会生效：又窄又长的文档按边长夹', () => {
    const scale = pickScale(400, 40_000);

    expect(40_000 * scale).toBeLessThanOrEqual(16_384);
  });

  it('要的倍率比上限小就原样给（不会自作主张放大）', () => {
    expect(pickScale(800, 1200, 1)).toBe(1);
  });
});

describe('cssUrlsToInline', () => {
  const base = 'https://app/vditor/dist/css/content-theme/light.css';

  it('相对地址按样式表自己的地址解析，而不是按页面地址', () => {
    const css = '@font-face { src: url(../../js/katex/fonts/KaTeX_Main-Regular.woff2) }';

    expect(cssUrlsToInline(css, base)).toEqual([
      'https://app/vditor/dist/js/katex/fonts/KaTeX_Main-Regular.woff2',
    ]);
  });

  it('只挑 woff2：同一个 @font-face 里的 woff / ttf 浏览器根本不会取', () => {
    const css = `@font-face {
      src: url(fonts/A.woff2) format('woff2'),
           url(fonts/A.woff) format('woff'),
           url(fonts/A.ttf) format('truetype');
    }`;

    expect(cssUrlsToInline(css, base)).toEqual(['https://app/vditor/dist/css/content-theme/fonts/A.woff2']);
  });

  it('图片要挑（正文里的图、背景图都靠它）', () => {
    const css = '.a { background: url("img/bg.png") } .b { background: url(i/x.svg) }';

    expect(cssUrlsToInline(css, base)).toEqual([
      'https://app/vditor/dist/css/content-theme/img/bg.png',
      'https://app/vditor/dist/css/content-theme/i/x.svg',
    ]);
  });

  it('data: / blob: / about: 一律跳过 —— 前者已经内联，后两者取不到也没意义', () => {
    const css = `.a { background: url(data:image/png;base64,AAAA) }
      .b { background: url(blob:https://app/1234) }
      .c { background: url(about:blank) }`;

    expect(cssUrlsToInline(css, base)).toEqual([]);
  });

  it('重复引用只取一次（KaTeX 的字体在同一张表里出现多次）', () => {
    const css = '.a { src: url(f/A.woff2) } .b { src: url("f/A.woff2") }';

    expect(cssUrlsToInline(css, base)).toHaveLength(1);
  });

  it('非法 URL 不抛异常，当它不存在', () => {
    expect(cssUrlsToInline('.a { background: url(:::) }', base)).toEqual([]);
  });
});

describe('inlineCssUrls', () => {
  const base = 'https://app/css/a.css';

  it('三种引号写法都换得掉', () => {
    const css = `.a{background:url(i/x.png)}.b{background:url('i/x.png')}.c{background:url("i/x.png")}`;
    const inlined = new Map([['https://app/css/i/x.png', 'data:image/png;base64,AAAA']]);

    const result = inlineCssUrls(css, base, inlined);

    expect(result).not.toContain('i/x.png');
    expect([...result.matchAll(/data:image\/png;base64,AAAA/g)]).toHaveLength(3);
  });

  it('换不到的改写成绝对地址，而不是留着相对路径', () => {
    // SVG 自己的地址是个 data URL，相对路径在里面解析出来百分之百是坏链。
    const result = inlineCssUrls('.a{background:url(i/x.png)}', base, new Map());

    expect(result).toContain('url("https://app/css/i/x.png")');
  });

  it('同一份 CSS 里一部分有 data URL 一部分没有时各走各的', () => {
    const css = '.a{src:url(f/A.woff2)}.b{src:url(f/B.woff2)}';
    const inlined = new Map([['https://app/css/f/A.woff2', 'data:font/woff2;base64,BBBB']]);

    const result = inlineCssUrls(css, base, inlined);

    expect(result).toContain('url("data:font/woff2;base64,BBBB")');
    expect(result).toContain('url("https://app/css/f/B.woff2")');
  });

  it('不碰 url() 以外的同名字符串', () => {
    const css = '.a{content:"i/x.png"}.b{background:url(i/x.png)}';
    const inlined = new Map([['https://app/css/i/x.png', 'data:image/png;base64,AAAA']]);

    expect(inlineCssUrls(css, base, inlined)).toContain('content:"i/x.png"');
  });

  it('没有 url() 的 CSS 原样返回', () => {
    expect(inlineCssUrls('.a{color:red}', base, new Map())).toBe('.a{color:red}');
  });
});
