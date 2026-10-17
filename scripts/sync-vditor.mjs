// 把 node_modules/vditor/dist 里我们真正用到的那部分拷到 public/vditor/dist。
//
// 为什么需要这一步：Vditor 的静态资源（Markdown 引擎 lute、KaTeX、代码高亮、图标、i18n）
// 不是 import 进来的，而是运行期按 `options.cdn` 拼出 URL 去 <script>/<link> 加载的。
// 默认指向公网 CDN，而 uTools 插件没有网络保障 —— 公式不能靠 CDN。
//
// 两个必须守住的细节：
//
// 1. 目标路径必须保留 `dist/` 这一层。Vditor 源码里的拼法是写死的
//    `${options.cdn}/dist/js/lute/lute.min.js`（vditor@4 的 src/ts/markdown/previewRender.ts:61），
//    所以设 cdn:'./vditor' 时文件得落在 public/vditor/dist/ 下。漏掉这层的表现是公式不渲染、
//    图标变方块，而控制台里 404 的路径看着「多了一截 dist」，很容易误判成 Vditor 的 bug。
//
// 2. 不要手工拷。手工拷会在升级 Vditor 时悄悄留下上一版的残留资源，而 KaTeX 的 CSS 与
//    fonts/ 版本错配的表现是「公式渲染出来了但字形是方块」，极难排查。这里每次都先清空。
import { cp, mkdir, readFile, rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'node_modules', 'vditor', 'dist');
const TARGET = join(ROOT, 'public', 'vditor', 'dist');
// 代码块配色表在这里，剥 highlight.js 的样式时要照它留文件。
const EDITOR_SOURCE = join(ROOT, 'src', 'composables', 'useEditor.ts');

// vditor@4.0.0 的 dist/ 整个 24MB，绝大部分是我们用不到的渲染器。
// 白名单而不是黑名单：上游新增目录时默认不进包，而不是默默把体积顶上去。
const KEEP = [
  // —— 必须有 ——
  'index.css',        //  28KB  编辑器样式
  'method.min.js',    //        预览/导出等独立方法，Vditor 自己会按 cdn 路径加载
  'css',              //  28KB  内容主题（content-theme）
  'images',           // 116KB  emoji 等内置图片
  'js/lute',          // 3.6MB  Markdown 引擎（Go 编译产物），少了它什么都不渲染
  'js/katex',         // 1.5MB  公式引擎，含 fonts/ 与 mhchem（化学式）
                      //        → pruneKatexFonts 剥掉 woff/ttf 后 0.6MB
  'js/highlight.js',  // 2.1MB  代码块高亮
                      //        → pruneHljsStyles 剥掉用不到的主题后 1.1MB
  'js/icons',         //  72KB  工具栏图标
  // —— 按需 ——
  //
  // 这一组都是「写文档偶尔要画张图」的渲染器。放进来不等于每次都加载 ——
  // Vditor 的各个 render 函数先 querySelector 对应的 `.language-xxx`，一个都没有就
  // 直接返回，脚本是正文里真出现了那种围栏才去取的。所以代价只是插件包大了 2.3MB，
  // 不影响打开速度。
  'js/mermaid',       // 3.5MB  ```mermaid    流程图 / 时序图 / 甘特图
  'js/echarts',       // 1.0MB  ```echarts    图表，吃 ECharts 的 option JSON
  'js/markmap',       // 840KB  ```mindmap    脑图，拿缩进列表当大纲
  'js/abcjs',         // 360KB  ```abc        五线谱，ABC 记谱法
  'js/flowchart.js',  // 128KB  ```flowchart  流程图，flowchart.js 那套语法
];

// i18n 整目录只有 56KB，但没必要把十几种语言都打进去。
const KEEP_I18N = ['zh_CN.js', 'en_US.js'];

// 明确砍掉的（省 9.6MB），列在这里是为了让「为什么没有它」有据可查：
//   js/mathjax 6.5MB  —— 与 KaTeX 二选一。KaTeX 已覆盖绝大多数写作需求，且 Vditor 自带
//                        mhchem 补上了化学式。代价是复杂 \begin{align} 嵌套和自定义
//                        \newcommand 体系不如 MathJax，详见 docs/design.md §6.2。
//   js/graphviz 2.0MB —— 上面那一组里唯一没要的：它是 Emscripten 编译的 Graphviz，一个人
//                        顶上三个渲染器的体积，而 DOT 图能画的东西 mermaid 基本都能画。
//   js/smiles-drawer 252KB（化学结构式）、js/wavedrom 92KB（数字时序波形）、
//   js/plantuml 36KB（要连 plantuml.com 的公网服务渲染，离线插件里用不了）
//                     —— 都太专了，写文档的人几乎碰不到。

/**
 * 剥掉 KaTeX 字体里 woff2 之外的格式。
 *
 * KaTeX 的每条 @font-face 都把 woff2 / woff / ttf 三份一起列进 src，而浏览器只会取
 * 第一个它支持的格式。插件跑在 uTools 的 Chromium 132 里，woff2 必中，后两份
 * （woff 336KB + ttf 540KB）一次都不会被请求 —— 876KB 的死重量。
 *
 * funchat 的 vite.config.ts 里对它打包进来的那份 KaTeX 做过同一件事（见那边的
 * dropLegacyKatexFonts），但这边的 KaTeX 是运行期按 cdn 路径取的裸文件、根本不过
 * 打包器，所以得在同步这一步剥。
 *
 * 不用改 CSS：src 里留着指向已删文件的 url() 也没关系，浏览器认下第一个支持的格式
 * 就不会再去看后面的。反过来说，万一哪天 woff2 这一支没了，剥掉 fallback 就是真的
 * 把字形删了 —— 所以下面按「每个要删的文件都必须有同名 woff2 兜着」来验收。
 */
async function pruneKatexFonts() {
  const fonts = join(TARGET, 'js', 'katex', 'fonts');
  const entries = await readdir(fonts);
  const woff2 = new Set(
    entries.filter((name) => name.endsWith('.woff2')).map((name) => name.slice(0, -'.woff2'.length)),
  );

  let removed = 0;
  for (const name of entries) {
    const match = name.match(/^(.+)\.(woff|ttf)$/);
    if (!match) continue;
    if (!woff2.has(match[1])) {
      console.error(`error: ${name} 没有对应的 woff2，剥掉它会让这套字形彻底消失`);
      process.exit(1);
    }
    await rm(join(fonts, name));
    removed += 1;
  }

  // 上游哪天改成只发 woff2，这里会一个都删不到 —— 那是好事，但得让人知道，
  // 否则下次有人看到「省了 0 字节」会以为这段代码失效了。
  console.log(`katex 字体：剥掉 ${removed} 份 woff/ttf，留下 ${woff2.size} 份 woff2`);
}

/**
 * 只留下代码块配色表真正用到的 highlight.js 样式。
 *
 * Vditor 自带 76 个主题 + base16/ 整套，共 1.1MB，而设置面板里只提供 7 种配色
 * （useEditor.ts 的 CODE_THEMES），最多用到 10 个文件。
 *
 * 名单从 CODE_THEMES 现场解析，不在这儿抄一份：抄一份的失败方式是「设置里加了个新
 * 配色，样式文件没进包」，而 Vditor 取不到样式表时既不报错也不回退，表现是代码块变
 * 成无配色的纯文本 —— 没人会把它联想到构建脚本。解析不到就直接停下，见下面的断言。
 */
async function pruneHljsStyles() {
  const source = await readFile(EDITOR_SOURCE, 'utf8');
  const table = source.match(/export const CODE_THEMES[\s\S]*?\n\];/);
  if (!table) {
    console.error(`error: ${EDITOR_SOURCE} 里找不到 CODE_THEMES，解析不出要留哪些样式`);
    process.exit(1);
  }

  const wanted = new Set([...table[0].matchAll(/\b(?:light|dark):\s*'([\w.-]+)'/g)].map((m) => m[1]));
  // github 是 Vditor 的兜底：给它一个不认识的主题名，它既不报错也不提示，静默回退到
  // github。所以这个文件必须在包里，哪怕哪天设置面板不再提供 GitHub 这一项。
  wanted.add('github');
  if (wanted.size < 2) {
    console.error(`error: 从 CODE_THEMES 只解析出 ${wanted.size} 个样式名，正则大概对不上了`);
    process.exit(1);
  }

  const styles = join(TARGET, 'js', 'highlight.js', 'styles');
  const keep = new Set([...wanted].map((name) => `${name}.min.css`));
  const missing = [...keep].filter((file) => !existsSync(join(styles, file)));
  if (missing.length) {
    console.error(`error: CODE_THEMES 要的样式文件不在 vditor 里：${missing.join(', ')}`);
    process.exit(1);
  }

  // 剩下的全删，包括 base16/ 那个子目录（716KB，一个都没引用）。
  for (const entry of await readdir(styles, { withFileTypes: true })) {
    if (keep.has(entry.name)) continue;
    await rm(join(styles, entry.name), { recursive: true });
  }

  console.log(`highlight.js 样式：留下 ${keep.size} 个（${[...wanted].sort().join(', ')}）`);
}

async function directorySize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? await directorySize(full) : (await stat(full)).size;
  }
  return total;
}

async function main() {
  if (!existsSync(SOURCE)) {
    console.error(`error: 找不到 ${SOURCE}，先跑 pnpm install`);
    process.exit(1);
  }

  await rm(TARGET, { recursive: true, force: true });
  await mkdir(TARGET, { recursive: true });

  const missing = [];
  for (const item of KEEP) {
    const from = join(SOURCE, item);
    if (!existsSync(from)) {
      missing.push(item);
      continue;
    }
    const to = join(TARGET, item);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true });
  }

  // 按结果验收，而不是「拷过就算成功」：上游重命名或挪动目录时，白名单会静默少拷一项，
  // 而缺 lute 的表现是编辑器整个空白、缺 katex 是公式变纯文本 —— 都要到真机才发现。
  // 宁可在构建时就停下。
  if (missing.length) {
    console.error(`error: vditor 的这些资源不存在，上游目录结构可能变了：${missing.join(', ')}`);
    process.exit(1);
  }

  const i18nFrom = join(SOURCE, 'js', 'i18n');
  const i18nTo = join(TARGET, 'js', 'i18n');
  await mkdir(i18nTo, { recursive: true });
  for (const lang of KEEP_I18N) {
    if (!existsSync(join(i18nFrom, lang))) {
      console.error(`error: vditor 缺少语言包 ${lang}`);
      process.exit(1);
    }
    await cp(join(i18nFrom, lang), join(i18nTo, lang));
  }

  // KaTeX 的字体是 CSS 里按相对路径引的，少了 fonts/ 公式会渲染成方块 —— 单独确认一次。
  if (!existsSync(join(TARGET, 'js', 'katex', 'fonts'))) {
    console.error('error: katex/fonts 没拷进来，公式字形会变方块');
    process.exit(1);
  }

  // 白名单是按目录给的，目录里还有一部分永远不会被请求 —— 再剥一层。
  await pruneKatexFonts();
  await pruneHljsStyles();

  const bytes = await directorySize(TARGET);
  console.log(`vditor 离线资源已同步：${TARGET} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
