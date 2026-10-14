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
import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'node_modules', 'vditor', 'dist');
const TARGET = join(ROOT, 'public', 'vditor', 'dist');

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
  'js/highlight.js',  // 2.1MB  代码块高亮
  'js/icons',         //  72KB  工具栏图标
  // —— 按需 ——
  'js/mermaid',       // 3.5MB  流程图/时序图，文档类高频，保留
];

// i18n 整目录只有 56KB，但没必要把十几种语言都打进去。
const KEEP_I18N = ['zh_CN.js', 'en_US.js'];

// 明确砍掉的（省 11.9MB），列在这里是为了让「为什么没有它」有据可查：
//   js/mathjax 6.5MB  —— 与 KaTeX 二选一。KaTeX 已覆盖绝大多数写作需求，且 Vditor 自带
//                        mhchem 补上了化学式。代价是复杂 \begin{align} 嵌套和自定义
//                        \newcommand 体系不如 MathJax，详见 docs/design.md §6.2。
//   js/graphviz 2.0MB, js/echarts 1.0MB, js/markmap 840KB, js/abcjs 360KB,
//   js/smiles-drawer 252KB, js/flowchart.js 128KB, js/wavedrom 92KB, js/plantuml 36KB

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

  const bytes = await directorySize(TARGET);
  console.log(`vditor 离线资源已同步：${TARGET} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
