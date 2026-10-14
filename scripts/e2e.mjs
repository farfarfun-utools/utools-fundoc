// 浏览器里的端到端检查。
//
// uTools 的插件窗口本质就是一个 Chromium 页面，所以「在浏览器里打开 dist 跑一遍」
// 能覆盖绝大多数真机问题 —— 而且是单测覆盖不到的那部分：Vditor 能不能从本地资源
// 起来、KaTeX 断网下渲不渲、快捷键有没有被编辑器吃掉、点导出到底有没有文件落下来。
//
// 刻意**不接进 build.sh**：打包不该依赖机器上装没装浏览器。这是开发期命令
// （`pnpm e2e`），没有浏览器时直接跳过并以 0 退出。
//
// 用法：
//   pnpm e2e              # 先构建再跑
//   pnpm e2e --no-build   # 用现有 utools/dist（反复调检查项时快得多）
//   pnpm e2e --headed     # 开着窗口跑，方便肉眼看
//   pnpm e2e --dump-sv    # 额外打印分屏模式的 DOM 结构（写滚动同步时要看）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch, waitFor } from './cdp.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'utools/dist');

const flags = new Set(process.argv.slice(2));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

/**
 * 起一个只读静态服务器。
 *
 * 不用 `vite preview`：那是另一个子进程，端口要从它的输出里抠，退出清理也更麻烦。
 * 这里四十行搞定，而且端口交给系统分配，不会和别的东西撞。
 *
 * @param root 根目录。
 * @returns 地址和 close()。
 */
async function serve(root) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const target = path.join(root, relative);

    // 目录穿越防护。本地脚本也照做 —— 这种判断漏掉一次就会变成习惯。
    if (!target.startsWith(root + path.sep) && target !== root) {
      response.writeHead(403).end('forbidden');
      return;
    }

    let file = target;
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) {
      response.writeHead(404).end('not found');
      return;
    }

    response.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(response);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ───────────────────────────── 检查项框架 ─────────────────────────────

/**
 * 大纲里的标题文本。
 *
 * 取 `.outline-text` 而不是整行的 textContent：开了标题编号之后行里还有个
 * `.outline-number`，整行取出来是「1.1 公式」，拿它和标题比永远不等。
 */
const OUTLINE_TEXTS =
  '[...document.querySelectorAll(".outline-row .outline-text")].map((el) => el.textContent.trim())';

const results = [];

/**
 * 跑一个检查项。抛异常算失败，继续跑后面的 —— 一次就看完全部问题。
 * @param name 检查项名字。
 * @param run 检查逻辑。
 */
async function check(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, message: error.message });
    console.log(`  ✗ ${name}\n      ${error.message.split('\n')[0]}`);
  }
}

/**
 * 断言。
 * @param condition 条件。
 * @param message 失败时的说明。
 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.log('没找到 Chromium 系浏览器，跳过浏览器检查。');
    console.log('装一个之后再跑，或者用 CHROME_PATH 指定路径。');
    return 0;
  }

  if (!flags.has('--no-build')) {
    console.log('构建 utools/dist …');
    const build = spawnSync('pnpm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('构建失败');
  }
  assert(fs.existsSync(path.join(DIST, 'index.html')), '没有 utools/dist/index.html，先跑 pnpm build');

  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'fundoc-e2e-dl-'));
  const site = await serve(DIST);
  console.log(`浏览器：${browser}\n服务：${site.origin}\n`);

  const { session, navigate, close } = await launch({
    url: site.origin,
    binary: browser,
    headless: !flags.has('--headed'),
    downloadPath: downloads,
  });

  // ── 收集页面侧的坏消息 ──
  const consoleErrors = [];
  const exceptions = [];
  const requests = [];

  session.on('Runtime.consoleAPICalled', (event) => {
    if (event.type !== 'error') return;
    consoleErrors.push(event.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' '));
  });
  session.on('Runtime.exceptionThrown', (event) => {
    const detail = event.exceptionDetails;
    exceptions.push(detail.exception?.description ?? detail.text);
  });
  session.on('Network.requestWillBeSent', (event) => requests.push(event.request.url));
  session.on('Network.loadingFailed', (event) =>
    consoleErrors.push(`请求失败：${event.errorText}`),
  );

  // 监听都挂好了才真正打开页面，这样一个请求都不会漏。
  await navigate();

  try {
    console.log('检查：');

    await check('应用能启动，三栏都在', async () => {
      await session.waitForExpression('!!document.querySelector(".shell-body")');
      assert(await session.evaluate('!!document.querySelector(".pane-tree")'), '没有文档树');
      assert(await session.evaluate('!!document.querySelector(".pane-main")'), '没有编辑区');
      assert(await session.evaluate('!!document.querySelector(".pane-outline")'), '没有大纲栏');
    });

    await check('首次进入会生成欢迎文档', async () => {
      const name = await session.waitForExpression(
        'document.querySelector(".tree-name")?.textContent',
      );
      assert(name === '欢迎使用 FunDoc', `树上第一项是「${name}」`);
      const title = await session.evaluate('document.querySelector(".doc-title")?.value');
      assert(title === '欢迎使用 FunDoc', `标题栏是「${title}」`);
    });

    await check('Vditor 从本地资源起来了', async () => {
      await session.waitForExpression('!!document.querySelector(".vditor-toolbar")');
      const text = await session.evaluate('document.querySelector(".vditor")?.innerText ?? ""');
      assert(text.includes('欢迎使用 FunDoc'), '编辑器里没有正文');
    });

    await check('KaTeX 公式渲染出来了', async () => {
      // .katex 是 KaTeX 渲染成功才有的容器；只要有一个就说明脚本、CSS、字体都到位了。
      const count = await session.waitForExpression('document.querySelectorAll(".katex").length');
      assert(count >= 2, `只渲染出 ${count} 个公式（行内 + 块级至少两个）`);
    });

    await check('代码高亮生效', async () => {
      const count = await session.waitForExpression(
        'document.querySelectorAll(".vditor .hljs, .vditor code.language-python").length',
      );
      assert(count >= 1, '没找到高亮后的代码块');
    });

    await check('大纲列出了正文标题', async () => {
      const texts = await session.waitForExpression(OUTLINE_TEXTS);
      assert(texts.length >= 4, `大纲只有 ${texts.length} 条`);
      assert(texts.includes('公式'), `大纲里没有「公式」：${texts.join(' / ')}`);
    });

    await check('标题自动编号：大纲和正文都标上了', async () => {
      // 欢迎文档是 # / ## / ## / ## 四个标题。
      const numbers = await session.evaluate(
        '[...document.querySelectorAll(".outline-number")].map((el) => el.textContent.trim())',
      );
      assert(
        JSON.stringify(numbers) === JSON.stringify(['1', '1.1', '1.2', '1.3']),
        `大纲编号是 ${JSON.stringify(numbers)}`,
      );

      const attrs = await session.evaluate(`
        [...document.querySelectorAll('.vditor-reset h1, .vditor-reset h2')]
          .map((el) => el.getAttribute('data-fundoc-number'))
      `);
      assert(
        JSON.stringify(attrs) === JSON.stringify(['1', '1.1', '1.2', '1.3']),
        `正文标题上的编号是 ${JSON.stringify(attrs)}`,
      );
      // 数字必须是 CSS 生成的，不能是真塞进去的文本节点 —— 后者会被 getValue() 带进正文。
      // ir 模式的标题里本来就有 Vditor 自己的 `## ` 标记文本（平时用 CSS 藏着），
      // 去掉那段之后剩下的必须正好是标题，不能多出任何数字。
      const text = await session.evaluate(
        'document.querySelector(".vditor-reset h2")?.textContent.trim()',
      );
      assert(
        text?.replace(/^#{1,6}\s*/, '') === '公式',
        `标题里多了东西：「${text}」`,
      );
      // 属性在、CSS 规则没匹配上，屏幕上就什么都看不见。问浏览器 ::before 算出来是什么，
      // 这是唯一能证明「用户真的看到了编号」的判据。
      const generated = await session.evaluate(
        'getComputedStyle(document.querySelector(".vditor-reset h2"), "::before").content',
      );
      assert(generated.includes('1.1'), `::before 没画出编号：${generated}`);
    });

    await check('全部资源都来自本地，没有回落 CDN', () => {
      const remote = requests.filter((url) => !url.startsWith(site.origin) && !url.startsWith('data:') && !url.startsWith('blob:'));
      assert(remote.length === 0, `有外部请求：${remote.slice(0, 5).join(', ')}`);
      // 顺带确认 Vditor 的那几个裸文件真的被请求了 —— 否则「没有外部请求」可能只是
      // 因为编辑器压根没去加载它们。
      const expected = ['lute.min.js', 'katex.min.js', 'zh_CN.js'];
      for (const name of expected) {
        assert(requests.some((url) => url.includes(name)), `没有请求 ${name}`);
      }
    });

    await check('Ctrl+Shift+P 打开搜索面板', async () => {
      await pressCtrl(session, 'P', { shift: true });
      await session.waitForExpression('!!document.querySelector(".sp-panel")');
    });

    await check('搜索能命中正文（标题里没有的词）', async () => {
      await type(session, '.sp-input', 'KaTeX');
      const hits = await session.waitForExpression(
        '[...document.querySelectorAll(".sp-item")].length',
      );
      assert(hits >= 1, '搜不到正文里的 KaTeX');
      const snippet = await session.evaluate(
        'document.querySelector(".sp-item-snippet")?.textContent ?? ""',
      );
      assert(snippet.includes('KaTeX'), `片段里没有命中词：「${snippet}」`);
      const marked = await session.evaluate(
        'document.querySelector(".sp-item-snippet mark")?.textContent',
      );
      assert(marked?.toLowerCase() === 'katex', `高亮的是「${marked}」`);
    });

    await check('点结果能打开文档，Esc 能关面板', async () => {
      await session.evaluate('document.querySelector(".sp-item").click()');
      await session.waitForExpression('!document.querySelector(".sp-panel")');
      const title = await session.evaluate('document.querySelector(".doc-title")?.value');
      assert(title === '欢迎使用 FunDoc', `打开的是「${title}」`);

      await pressCtrl(session, 'P', { shift: true });
      await session.waitForExpression('!!document.querySelector(".sp-panel")');
      await session.evaluate(
        'document.querySelector(".sp-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))',
      );
      await session.waitForExpression('!document.querySelector(".sp-panel")');
    });

    await check('导出真的落下一个 .md 文件', async () => {
      await session.evaluate('document.querySelector(\'.doc-head .icon-btn[title^="导出"]\').click()');
      const file = await waitFor(
        () => fs.readdirSync(downloads).find((name) => name.endsWith('.md')),
        { label: '下载的 .md', timeout: 20_000 },
      );
      assert(file === '欢迎使用 FunDoc.md', `文件名是「${file}」`);
      const text = fs.readFileSync(path.join(downloads, file), 'utf8');
      assert(text.startsWith('# 欢迎使用 FunDoc'), '导出的内容不对');
      assert(text.includes('\\frac{-b \\pm'), '公式被改写了');
    });

    await check('编号没有混进 Markdown 源码', async () => {
      // 正文里的数字是 CSS 生成内容，但 ir / wysiwyg 模式下 getValue() 是让 lute 从 DOM
      // 反解出 Markdown 的 —— 万一它把我们贴在标题上的 data-fundoc-number 一起带出来，
      // 用户的正文就被污染了，而且是存进数据库的那份。所以真去改一次标题（最有可能出事的
      // 就是带属性的那个元素），让内容走一遍 getValue，再导出来看到底存了什么。
      await session.evaluate(`
        (() => {
          const editable = document.querySelector('.vditor-ir .vditor-reset');
          const heading = editable.querySelector('h1');
          editable.focus();
          const range = document.createRange();
          range.selectNodeContents(heading);
          range.collapse(false);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          return true;
        })()
      `);
      await session.send('Input.insertText', { text: ' 自测' });
      // 改完才算真跑过 getValue。标题同步会把文档名也改成这个，下面按新名字等文件。
      await session.waitForExpression(
        'document.querySelector(".doc-title")?.value === "欢迎使用 FunDoc 自测"',
      );

      await session.evaluate('document.querySelector(\'.doc-head .icon-btn[title^="导出"]\').click()');
      const file = await waitFor(
        () => fs.readdirSync(downloads).find((name) => name.includes('自测')),
        { label: '改动后导出的 .md', timeout: 20_000 },
      );
      const text = fs.readFileSync(path.join(downloads, file), 'utf8');
      assert(text.startsWith('# 欢迎使用 FunDoc 自测'), `导出的开头是「${text.slice(0, 40)}」`);
      assert(!text.includes('data-fundoc-number'), '编号属性被 lute 反解进了 Markdown');
      assert(!text.includes('<h1'), '标题变成了 HTML，不再是 ATX 写法');
      assert(text.includes('\n## 公式'), '其他标题的写法被改动了');
    });

    await check('打印前把公式等渲染完了', async () => {
      // window.print 在无头浏览器里会直接返回，用它当钩子抓打印容器的内容。
      await session.evaluate(`
        window.__printed = null;
        window.print = () => {
          const root = document.querySelector('.fundoc-print-root');
          window.__printed = root ? root.innerHTML : '';
        };
        true
      `);
      await session.evaluate('document.querySelector(\'.doc-head .icon-btn[title^="打印"]\').click()');
      const html = await session.waitForExpression('window.__printed', { timeout: 20_000 });

      assert(html.includes('katex'), '打印内容里没有渲染好的公式');
      assert(html.includes('data-math'), '公式还没渲染完就触发了打印');
      assert(html.includes('欢迎使用 FunDoc'), '打印内容里没有正文');
      // 屏幕上有章节号，印出来的 PDF 里也得有。
      assert(html.includes('data-fundoc-number="1.1"'), '打印内容里的标题没有编号');
      // 打印容器事后要清掉，不然它会一直挂在 body 上。
      await session.waitForExpression('!document.querySelector(".fundoc-print-root")');
      assert(
        await session.evaluate('!document.documentElement.classList.contains("fundoc-printing")'),
        '打印后 fundoc-printing 标记没摘掉',
      );
    });

    await check('Ctrl+Shift+M 能切到分屏模式', async () => {
      await pressCtrl(session, 'M', { shift: true });
      await session.waitForExpression('!!document.querySelector(".vditor-sv")');
      assert(
        await session.evaluate('!!document.querySelector(".vditor-preview")'),
        '分屏模式没有预览栏',
      );
      // 切模式会整个重建编辑器，重建后公式要照样渲染。
      const count = await session.waitForExpression(
        'document.querySelectorAll(".vditor-preview .katex").length',
      );
      assert(count >= 2, `预览栏里只有 ${count} 个公式`);
    });

    // 分屏滚动同步的几项检查共用一篇专门构造的文档，见 svDoc() 的说明。
    let svInfo = null;

    await check('分屏同步：换上长文档后两栏都能滚', async () => {
      await setSvSource(session, svDoc());
      svInfo = await measureSplitPane(session);

      assert(svInfo.editorMax > 200, `源码栏滚不动（max=${svInfo.editorMax}）`);
      assert(svInfo.previewMax > 200, `预览栏滚不动（max=${svInfo.previewMax}）`);
      assert(svInfo.headingLines.length === 4, `源码里有 ${svInfo.headingLines.length} 个标题`);
      assert(
        svInfo.rendered.length === 4,
        `预览里有 ${svInfo.rendered.length} 个标题：${svInfo.rendered.map((h) => h.text).join(' / ')}`,
      );
      // 后面用「行号 × 行高」算源码侧的预期位置，前提是没有一行折行。
      // 不自测这一条，折了行就会得到一个「看起来通过了但其实在量别的东西」的结果。
      const expected = svInfo.lineCount * svInfo.lineHeight;
      assert(
        Math.abs(svInfo.contentHeight - expected) < svInfo.lineHeight,
        `源码栏折行了：内容高 ${svInfo.contentHeight}，${svInfo.lineCount} 行 × ${svInfo.lineHeight} = ${expected}`,
      );
    });

    await check('分屏同步：源码滚到标题行，预览里的同名标题也到顶', async () => {
      const targets = anchors(svInfo);
      // 每个标题都要对齐，而不是只挑一个 —— 偏差是会累积的，只验一个点验不出来。
      for (const target of targets) {
        const top = await scrollTo(session, 'textarea.vditor-sv', target.sourceTop);
        assert(
          Math.abs(top.preview - target.previewTop) <= 2,
          `源码滚到第 ${target.line} 行时预览栏停在 ${Math.round(top.preview)}，` +
            `而标题「${target.text}」在 ${Math.round(target.previewTop)}`,
        );
      }
      // 如果这篇文档的源码/渲染高度恰好成比例，上面的断言就区分不出「按标题对齐」和
      // 「等比例换算」——那这项检查其实什么也没证明。宁可让它失败也不留空检查。
      const spread = Math.max(...targets.map((t) => Math.abs(t.vditorWould - t.previewTop)));
      assert(spread > 16, `这篇文档区分不出两种算法，最大差 ${Math.round(spread)}px`);
    });

    await check('分屏同步：滚预览栏能回带源码，且往返位置一致', async () => {
      // 取最靠后的那个锚点：越往后越能看出误差有没有累积。
      const target = anchors(svInfo).at(-1);
      // 这里必须用真的滚轮事件：预览栏的 scrollTop 写入口被我们接管了（见
      // lib/scroll-sync.ts 的 hijackScrollTop），赋值会被吞掉。反正用户也是这么滚的。
      const back = await wheelTo(session, '.vditor-preview', target.previewTop);
      assert(
        Math.abs(back.preview - target.previewTop) <= 1,
        `预览栏没滚到位：停在 ${Math.round(back.preview)}，要的是 ${Math.round(target.previewTop)}`,
      );
      assert(
        Math.abs(back.editor - target.sourceTop) <= 1.5 * svInfo.lineHeight,
        `源码栏停在 ${Math.round(back.editor)}，标题「${target.text}」在第 ${target.line} 行（约 ${Math.round(target.sourceTop)}）`,
      );
      // 反向映射必须是正向的逆，否则两栏会在来回同步里越走越偏。
      const again = await scrollTo(session, 'textarea.vditor-sv', back.editor);
      assert(
        Math.abs(again.preview - target.previewTop) <= 1,
        `往返一圈偏了：${Math.round(target.previewTop)} → ${Math.round(back.editor)} → ${Math.round(again.preview)}`,
      );
    });

    await check('分屏模式下点大纲能滚到对应标题', async () => {
      // 先回到顶部，这样「滚了」本身也是检查的一部分。
      await scrollTo(session, 'textarea.vditor-sv', 0);
      const texts = await session.evaluate(OUTLINE_TEXTS);
      const index = texts.indexOf('Sync C');
      assert(index >= 0, `大纲里没有 Sync C：${texts.join(' / ')}`);

      await session.evaluate(`document.querySelectorAll(".outline-row")[${index}].click(); true`);
      // scrollIntoView 用的是平滑滚动：先等它动起来（否则会量到还没启动的 0），再等停稳。
      await session.waitForExpression(
        'document.querySelector(".vditor-preview").scrollTop > 0',
        { timeout: 5000 },
      );
      const top = await settle(session, '.vditor-preview');
      const expected = svInfo.rendered[index].top;
      assert(Math.abs(top - expected) <= 4, `预览栏停在 ${top}，Sync C 在 ${expected}`);
    });

    if (flags.has('--dump-sv') && svInfo) {
      console.log('\n分屏测量：', JSON.stringify({ ...svInfo, anchors: anchors(svInfo) }, null, 2));
      // 扫一遍映射曲线。断言失败时光看一个点看不出是整体偏移还是某一段算错了，
      // 把折点扫出来一眼就知道。
      const curve = [];
      for (let value = 0; value <= svInfo.editorMax; value += 54) {
        const pos = await scrollTo(session, 'textarea.vditor-sv', value);
        curve.push([Math.round(pos.editor), Math.round(pos.preview)]);
      }
      console.log('同步曲线（源码 → 预览）：', JSON.stringify(curve));
    }

    await check('页面没有 JS 异常和 console.error', () => {
      assert(exceptions.length === 0, `有未捕获异常：\n${exceptions.join('\n')}`);
      assert(consoleErrors.length === 0, `有 console.error：\n${consoleErrors.join('\n')}`);
    });

    if (flags.has('--dump-sv')) await dumpSplitPane(session);
  } finally {
    await close();
    await site.close();
    fs.rmSync(downloads, { recursive: true, force: true });
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  return failed.length ? 1 : 0;
}

/**
 * 按一个带 Ctrl 的组合键。
 *
 * 走 CDP 的 Input 域而不是在页面里 dispatchEvent：合成事件绕不开「Vditor 会不会
 * 先把这个键吃掉」这个问题，而那恰恰是要验的东西。
 *
 * @param session CDP 会话。
 * @param key 主键，大写字母。
 * @param options.shift 是否同时按 Shift。
 */
async function pressCtrl(session, key, { shift = false } = {}) {
  // modifiers 是位掩码：Alt=1, Ctrl=2, Meta=4, Shift=8。
  const modifiers = 2 | (shift ? 8 : 0);
  const common = {
    modifiers,
    key: shift ? key.toUpperCase() : key.toLowerCase(),
    code: `Key${key.toUpperCase()}`,
    windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
  };
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}

/**
 * 往输入框里填值并触发 input 事件（Vue 的 v-model 听的是它）。
 * @param session CDP 会话。
 * @param selector 输入框选择器。
 * @param value 要填的值。
 */
async function type(session, selector, value) {
  await session.evaluate(`
    (() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
}

// ───────────────────────────── 分屏同步的辅助 ─────────────────────────────

/**
 * 给分屏检查用的文档。
 *
 * 三条要求：
 *
 *   1. **每行都短**，在四百来像素宽的源码栏里不会折行。这样源码侧「第 n 行在第几像素」
 *      就是 `padding + n × 行高`，测试不必把 lib/scroll-sync.ts 的镜像测量重写一遍 ——
 *      自己算一遍再去对，等于拿同一份逻辑验同一份逻辑。
 *   2. **各节的源码/渲染高度比明显不同**：块级公式的三行源码渲染成一块，紧挨着的几十行
 *      空行分段的短段落渲染后每段还带外边距。这样等比例换算和按标题对齐会给出不同结果，
 *      检查才有区分力。
 *   3. 标题文字 ASCII 且互不相同，便于在断言里指名道姓。
 *
 * @returns Markdown 源码。
 */
function svDoc() {
  const filler = (prefix, count, blank = false) =>
    Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join(blank ? '\n\n' : '\n');

  return [
    '# Sync A',
    filler('a', 12),
    '## Sync B',
    // 这一块是「源码高、渲染矮」的那一节：16 行源码渲染成一个矩阵。
    '$$',
    String.raw`\begin{matrix}`,
    String.raw`1 & 2 \\`,
    String.raw`3 & 4 \\`,
    String.raw`5 & 6 \\`,
    String.raw`7 & 8 \\`,
    String.raw`9 & 10 \\`,
    String.raw`11 & 12 \\`,
    String.raw`13 & 14 \\`,
    '15 & 16',
    String.raw`\end{matrix}`,
    '$$',
    filler('b', 6),
    '## Sync C',
    // 这一节相反：空行分段，渲染后每段都比源码行高。
    filler('c', 12, true),
    '## Sync D',
    filler('d', 12),
    '',
  ].join('\n');
}

/**
 * 换掉分屏源码栏的内容。
 *
 * 直接写 textarea.value 再派发 input —— Vditor 的 sv 模式就是听这个事件重渲染预览的，
 * 比逐字符敲快几十倍，而要验的滚动同步也不关心内容是怎么进去的。
 *
 * @param session CDP 会话。
 * @param text Markdown 源码。
 */
async function setSvSource(session, text) {
  await session.evaluate(`
    (() => {
      const editor = document.querySelector('textarea.vditor-sv');
      editor.value = ${JSON.stringify(text)};
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  // 预览是防抖渲染的（options.preview.delay），公式还要再异步排一次版。
  //
  // 等的是「最后一个标题出现了」而不是标题个数 —— 换上来之前那篇欢迎文档恰好也是 4 个
  // 标题，按个数等会立刻通过，然后量到的全是上一篇的位置。
  await session.waitForExpression(
    '[...document.querySelectorAll(".vditor-preview h1, .vditor-preview h2")].map((el) => el.textContent.trim()).join() === "Sync A,Sync B,Sync C,Sync D"',
  );
  await session.waitForExpression('document.querySelectorAll(".vditor-preview .katex").length >= 1');
  await session.evaluate('document.fonts.ready.then(() => true)');
}

/**
 * 量一遍分屏两侧的尺寸、标题行号和渲染位置。
 *
 * @param session CDP 会话。
 * @returns 测量结果。
 */
function measureSplitPane(session) {
  return session.evaluate(`
    (() => {
      const editor = document.querySelector('textarea.vditor-sv');
      const preview = document.querySelector('.vditor-preview');
      const style = getComputedStyle(editor);
      const padTop = parseFloat(style.paddingTop);
      const padBottom = parseFloat(style.paddingBottom);
      const lines = editor.value.split('\\n');
      const base = preview.getBoundingClientRect().top - preview.scrollTop;
      return {
        lineHeight: parseFloat(style.lineHeight),
        padTop,
        lineCount: lines.length,
        contentHeight: editor.scrollHeight - padTop - padBottom,
        editorScrollHeight: editor.scrollHeight,
        editorClient: editor.clientHeight,
        editorMax: Math.max(0, editor.scrollHeight - editor.clientHeight),
        previewScrollHeight: preview.scrollHeight,
        previewMax: Math.max(0, preview.scrollHeight - preview.clientHeight),
        // Vditor 自己的换算要减掉这个内联 padding，照抄它的取法。
        inlinePadBottom: parseFloat(editor.style.paddingBottom || '0'),
        headingLines: lines
          .map((text, line) => ({ text, line }))
          .filter((item) => /^#{1,6} /.test(item.text))
          .map((item) => ({ line: item.line, text: item.text.replace(/^#+ /, '') })),
        rendered: [...preview.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((el) => ({
          text: el.textContent.trim(),
          top: el.getBoundingClientRect().top - base,
        })),
      };
    })()
  `);
}

/**
 * 算出可以用来断言的标题锚点。
 *
 * 只要两侧都还在可滚范围内的：超出范围的标题永远到不了顶（浏览器会把 scrollTop 夹住），
 * 拿它断言只会得到假失败。
 *
 * @param info measureSplitPane 的结果。
 * @returns 锚点数组，按文档顺序，每个都带上 Vditor 原算法会给出的位置。
 */
function anchors(info) {
  const candidates = info.headingLines
    .map((heading, index) => ({
      text: heading.text,
      line: heading.line,
      sourceTop: info.padTop + heading.line * info.lineHeight,
      previewTop: info.rendered[index]?.top ?? Number.NaN,
    }))
    .filter((item) => item.sourceTop > 0 && item.sourceTop < info.editorMax)
    .filter((item) => item.previewTop > 0 && item.previewTop < info.previewMax);

  if (!candidates.length) throw new Error('没有两侧都可滚到的标题，文档太短或预览没渲染出来');

  // 照抄 Vditor sv 的 scroll 监听（node_modules/vditor/dist/index.js 里那段），
  // 用来确认这篇文档真能把两种算法区分开。
  const height = info.editorClient;
  const scrollHeight = info.editorScrollHeight - info.inlinePadBottom;
  return candidates.map((item) => {
    const raw =
      item.sourceTop / height > 0.5
        ? ((item.sourceTop + height) * info.previewScrollHeight) / scrollHeight - height
        : (item.sourceTop * info.previewScrollHeight) / scrollHeight;
    return { ...item, vditorWould: Math.min(Math.max(raw, 0), info.previewMax) };
  });
}

/**
 * 滚到指定位置，等两侧都停稳后把位置读回来。
 *
 * @param session CDP 会话。
 * @param selector 要滚的元素。
 * @param value 目标 scrollTop。
 * @returns 两侧最终的 scrollTop。
 */
async function scrollTo(session, selector, value) {
  await session.evaluate(`
    (() => {
      document.querySelector(${JSON.stringify(selector)}).scrollTop = ${value};
      return true;
    })()
  `);
  await settle(session, selector);
  return session.evaluate(`
    (() => ({
      editor: document.querySelector('textarea.vditor-sv').scrollTop,
      preview: document.querySelector('.vditor-preview').scrollTop,
    }))()
  `);
}

/**
 * 用真的滚轮事件把某一栏滚到指定位置。
 *
 * deltaY 直接给「还差多少像素」：Chromium 对合成的滚轮事件是按像素精确处理的，一次就能
 * 到位；平滑滚动的过程由 settle 等干净。
 *
 * @param session CDP 会话。
 * @param selector 要滚的元素。
 * @param value 目标 scrollTop。
 * @returns 两侧最终的 scrollTop。
 */
async function wheelTo(session, selector, value) {
  const spot = await session.evaluate(`
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      const box = element.getBoundingClientRect();
      return {
        x: Math.round(box.left + box.width / 2),
        y: Math.round(box.top + box.height / 2),
        delta: ${value} - element.scrollTop,
      };
    })()
  `);
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: spot.x,
    y: spot.y,
    deltaX: 0,
    deltaY: spot.delta,
    pointerType: 'mouse',
  });
  await settle(session, selector);
  return session.evaluate(`
    (() => ({
      editor: document.querySelector('textarea.vditor-sv').scrollTop,
      preview: document.querySelector('.vditor-preview').scrollTop,
    }))()
  `);
}

/**
 * 等某个元素的滚动位置连着两次读数一致。
 *
 * 平滑滚动和同步回写都是跨帧的，读一次就断言会抓到半路上的值。
 *
 * @param session CDP 会话。
 * @param selector 元素。
 * @returns 稳定后的 scrollTop。
 */
async function settle(session, selector) {
  const read = `document.querySelector(${JSON.stringify(selector)}).scrollTop`;
  let previous = Number.NaN;
  return waitFor(
    async () => {
      const current = await session.evaluate(read);
      const stable = current === previous;
      previous = current;
      // 0 也是合法的停稳位置，所以返回的是对象而不是数字本身。
      return stable ? { value: current } : null;
    },
    { label: `${selector} 停稳`, interval: 60, timeout: 5000 },
  ).then((result) => result.value);
}

/**
 * 打印分屏模式的 DOM 结构。
 *
 * 写滚动同步要先知道「哪个元素才是滚动容器」—— Vditor 的分屏有编辑区和预览区两层
 * 包装，猜错了就是绑了个永远不滚的元素。
 *
 * @param session CDP 会话。
 */
async function dumpSplitPane(session) {
  const info = await session.evaluate(`
    (() => {
      const describe = (el) => el && ({
        tag: el.tagName.toLowerCase(),
        class: el.className,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollable: el.scrollHeight > el.clientHeight,
      });
      const sv = document.querySelector('.vditor-sv');
      const preview = document.querySelector('.vditor-preview');
      return {
        sv: describe(sv),
        svParent: describe(sv?.parentElement),
        preview: describe(preview),
        previewChild: describe(preview?.firstElementChild),
        headings: [...document.querySelectorAll('.vditor-preview h1, .vditor-preview h2')].map(
          (el) => ({ tag: el.tagName, text: el.textContent.trim(), top: Math.round(el.offsetTop) }),
        ),
      };
    })()
  `);
  console.log('\n分屏模式 DOM：');
  console.log(JSON.stringify(info, null, 2));
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
