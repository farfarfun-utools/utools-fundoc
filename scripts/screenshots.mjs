// 生成 README 里的界面截图。
//
// 为什么要有这个脚本：README 里的图最容易过期 —— 改完界面没人记得重截一遍，而图和
// 实物对不上比没有图更糟。所以把它做成可重跑的：打版本标签时 CI 跑一遍，图真变了才
// 提交回仓库（见 .github/workflows/screenshots.yml）。
//
// 插件窗口本质就是一个 Chromium 页面，所以「起个静态服务器打开 utools/dist 再拍照」
// 拍到的就是真机上的样子。视口严格按 utools/plugin.json 里的 pluginSetting.height 来。
//
// 用法：
//   pnpm screenshots              # 先构建再截
//   pnpm screenshots --no-build   # 用现有 utools/dist（反复调版式时快得多）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch } from './cdp.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'utools/dist');
const OUT = path.join(ROOT, 'docs/screenshots');

// 时间冻在一个固定时刻。
//
// 不冻的话每跑一遍都会生成一批像素不同的图（倒计时、动态验证码这类随时间变的东西），
// CI 就会每次都提交一笔「截图变了」，而界面其实一个像素都没改。秒数取 07：
// 任何整分钟的 Unix 时间戳都能被 30 整除，所以 07 秒落在 30 秒周期的第 7 秒上，
// 离周期末尾还远，不会触发「最后 5 秒」那类临界态的版式。
const FROZEN_AT = Date.parse('2026-10-16T20:00:07+08:00');

const FREEZE_CLOCK = `(() => {
  const Real = Date;
  const fixed = ${FROZEN_AT};
  class Frozen extends Real {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  }
  Frozen.parse = Real.parse;
  Frozen.UTC = Real.UTC;
  globalThis.Date = Frozen;
})()`;

// 冻住时钟管不到 CSS 动画和过渡 —— 它们跟的是文档时间轴，不是 Date.now()。
// 所以还得把过渡关掉，拍到的才是终态而不是某一帧中间态。
// 跟时间有关的动画（比如倒计时圆环）由各自的 extraCss 钉到固定进度上。
const BASE_CSS = `
  /* 滚动条是浏览器预览的产物，uTools 窗口里没有。
     两条都要写：元素一旦设了标准属性 scrollbar-width，Chrome 就完全忽略
     ::-webkit-scrollbar 那套，只写 webkit 的那条对它不起作用。 */
  * { scrollbar-width: none !important }
  *::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important }
  *, *::before, *::after { transition: none !important; caret-color: transparent !important }
`;

/** 本轮要注入页面的样式，reload 之后也要重新贴一遍。 */
let pageCss = BASE_CSS;

/** 把样式贴进当前文档。 */
const injectCss = (session) =>
  session.evaluate(`(() => {
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(pageCss)};
    (document.head || document.documentElement).append(style);
    return true;
  })()`);

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 起一个只读静态服务器。端口交给系统分配，不会和别的东西撞。
 * @param root 根目录。
 * @returns 地址和 close()。
 */
async function serve(root) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const target = path.join(root, relative);
    if (!target.startsWith(root) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' });
    fs.createReadStream(target).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// ───────────────────────── 操作界面的几个小动作 ─────────────────────────
// 每个都返回 (session) => Promise，交给 shot.before 串起来。

/** 点一个选择器命中的元素。 */
const click = (selector) => (session) =>
  session.evaluate(`document.querySelector(${JSON.stringify(selector)})?.click(), true`);

/** 往输入框里填值并派发 input 事件，让 v-model 跟上。 */
const type = (selector, value) => (session) =>
  session.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    node.focus();
    node.value = ${JSON.stringify(value)};
    node.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

/** 重新加载页面，让下一张图从干净的初始界面开始。 */
const reload = async (session) => {
  await session.send('Page.reload');
  await session.waitForExpression('document.readyState === "complete"');
  await injectCss(session);
  await sleep(1200);
};

/** 依次执行若干个动作。 */
const steps = (...actions) => async (session) => {
  for (const action of actions) {
    await action(session);
    await sleep(350);
  }
};

/**
 * 跑一组截图。
 *
 * @param options.width/height 视口尺寸，对齐 plugin.json 的插件窗口。
 * @param options.scale 像素密度，2 出高清图。
 * @param options.seed 页面首次加载后执行的表达式，用来塞演示数据；执行完会 reload 一次。
 * @param options.extraCss 额外样式，用来把跟时间有关的动画钉到固定进度上，保证可重复。
 * @param options.shots `[{ name, before, wait }]`，before 负责把界面点到位。
 */
async function shoot({ width, height, scale = 2, seed, extraCss = '', shots }) {
  pageCss = BASE_CSS + extraCss;
  const server = await serve(DIST);
  const browser = await launch({ headless: true });
  const { session } = browser;
  const failures = [];
  session.on('Runtime.exceptionThrown', (event) => {
    failures.push(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text);
  });

  try {
    await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    // 冻时钟必须赶在页面脚本之前，所以走 addScriptToEvaluateOnNewDocument 而不是 evaluate。
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: FREEZE_CLOCK });
    await browser.navigate(server.origin);
    await session.waitForExpression('document.readyState === "complete"');

    if (seed) {
      await session.evaluate(seed);
      await session.send('Page.reload');
      await session.waitForExpression('document.readyState === "complete"');
    }
    await injectCss(session);
    await sleep(900);

    fs.mkdirSync(OUT, { recursive: true });
    for (const shot of shots) {
      if (shot.before) await shot.before(session);
      await sleep(shot.wait ?? 500);
      const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, `${shot.name}.png`), Buffer.from(data, 'base64'));
      console.log(`  ✓ docs/screenshots/${shot.name}.png`);
    }
  } finally {
    await browser.close();
    await server.close();
  }

  // 页面里的报错不让截图失败（图照样拍出来了），但要打出来，别让它悄悄烂掉。
  if (failures.length) console.warn('  页面抛错：', failures.slice(0, 5));
}

// 没有浏览器就跳过而不是失败：这是开发期的辅助命令，没装 Chrome 的机器不该因此卡住。
if (!findBrowser()) {
  console.warn('[截图] 找不到 Chromium 系浏览器，跳过');
  process.exit(0);
}

if (!process.argv.includes('--no-build')) {
  const built = spawnSync('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

// ───────────────────────────── 演示数据 ─────────────────────────────
// 文档内容都是为截图编的。

const LINALG = `# 特征值与特征向量

## 定义

设 $A$ 是 $n \\times n$ 实矩阵。若存在非零向量 $v$ 和标量 $\\lambda$ 使得

$$A v = \\lambda v$$

就称 $\\lambda$ 是 $A$ 的**特征值**，$v$ 是它对应的**特征向量**。

## 怎么求

1. 解特征方程 $\\det(A - \\lambda I) = 0$，得到全部 $\\lambda$；
2. 对每个 $\\lambda$ 解齐次方程组 $(A - \\lambda I)\\,v = 0$，解空间就是特征子空间。

## 一个例子

$$A = \\begin{pmatrix} 2 & 1 \\\\ 1 & 2 \\end{pmatrix}
\\quad\\Longrightarrow\\quad
\\lambda_1 = 3,\\; v_1 = \\begin{pmatrix} 1 \\\\ 1 \\end{pmatrix},\\quad
\\lambda_2 = 1,\\; v_2 = \\begin{pmatrix} 1 \\\\ -1 \\end{pmatrix}$$

## 用 NumPy 验证一下

\`\`\`python
import numpy as np

A = np.array([[2, 1], [1, 2]])
values, vectors = np.linalg.eig(A)
print(values)    # [3. 1.]
print(vectors)   # 每一列是一个特征向量
\`\`\`

> 对称矩阵的特征值一定是实数，不同特征值的特征向量还互相正交 —— 谱定理保证的。
`;

const QUICKSORT = `# 快速排序的三种分区写法

Lomuto 好写，Hoare 快一点，三路分区在大量重复元素时明显更稳。

\`\`\`python
def lomuto(a, lo, hi):
    pivot, i = a[hi], lo
    for j in range(lo, hi):
        if a[j] < pivot:
            a[i], a[j] = a[j], a[i]
            i += 1
    a[i], a[hi] = a[hi], a[i]
    return i
\`\`\`

平均 $O(n \\log n)$，最坏 $O(n^2)$。
`;

const WEEKLY = `# 2026-W42 周报

## 本周完成

- [x] FunDoc 分屏滚动按标题对齐，修掉长文滚到后面差一整节的问题
- [x] KaTeX 字体打进插件，断网也能渲染
- [ ] 导出 zip 时保持目录层级

## 下周计划

把大纲的标题自动编号补到打印的 PDF 里。
`;

const RELEASE = `# 插件发布清单

| 步骤 | 命令 | 说明 |
| --- | --- | --- |
| 校验 | \`sh build.sh\` | lint、类型检查、单测、清单校验一条龙 |
| 产物 | \`utools/dist\` | 确认 KaTeX 字体和搜索内核都在 |
| 上架 | uTools 开发者工具 | 导入 \`utools/plugin.json\` |
`;

const SCRATCH = `# 随手记

- 周三下午两点和设计对一下图标
- \`Ctrl/⌘ + Shift + P\` 可以连正文一起搜
`;

const NODES = [
  { id: 'n-study', type: 'dir', name: '学习笔记', parent: null, order: 100 },
  { id: 'n-linalg', type: 'doc', name: '线性代数 · 特征值', parent: 'n-study', order: 100, body: LINALG, keyword: true },
  { id: 'n-quick', type: 'doc', name: '快速排序', parent: 'n-study', order: 200, body: QUICKSORT },
  { id: 'n-work', type: 'dir', name: '工作', parent: null, order: 200 },
  { id: 'n-weekly', type: 'doc', name: '2026-W42 周报', parent: 'n-work', order: 100, body: WEEKLY },
  { id: 'n-release', type: 'doc', name: '插件发布清单', parent: 'n-work', order: 200, body: RELEASE },
  { id: 'n-scratch', type: 'doc', name: '随手记', parent: null, order: 300, body: SCRATCH },
];

function database() {
  const now = Date.parse('2026-10-15T10:00:00+08:00');
  const docs = {};
  for (const node of NODES) {
    docs[`meta@${node.id}`] = {
      _id: `meta@${node.id}`,
      _rev: '1-shim',
      nodeId: node.id,
      type: node.type,
      name: node.name,
      parentId: node.parent,
      order: node.order,
      createdAt: now,
      updatedAt: now,
      keywordEnabled: Boolean(node.keyword),
      keywords: [],
      bodySize: node.body ? new TextEncoder().encode(node.body).length : 0,
    };
    if (node.body) {
      docs[`body@${node.id}`] = {
        _id: `body@${node.id}`,
        _rev: '1-shim',
        nodeId: node.id,
        markdown: node.body,
        updatedAt: now,
      };
    }
  }
  return docs;
}

const seedFor = ({ theme = 'light', mode = 'ir' } = {}) => `
  localStorage.setItem('fundoc.shim.db', ${JSON.stringify(JSON.stringify(database()))});
  localStorage.setItem('fundoc.shim.kv', JSON.stringify({
    'fundoc.settings': {
      mode: ${JSON.stringify(mode)},
      theme: ${JSON.stringify(theme)},
      codeTheme: 'follow',
      syncTitleFromHeading: true,
      headingNumber: true,
      autoSaveDelay: 800,
      outlineVisible: true,
      treeVisible: true,
    },
    'fundoc.ui.expanded': ['n-study', 'n-work'],
  }));
  true;
`;

// 视口对齐 utools/plugin.json 的 pluginSetting.height。
const VIEWPORT = { width: 800, height: 600 };

await shoot({
  ...VIEWPORT,
  seed: seedFor(),
  shots: [
    { name: 'editor', wait: 2200 },
    // 「插件」同时命中一篇标题和一篇正文，正好把标题匹配、正文片段两种结果都拍进去。
    { name: 'search', before: steps(click('[title="搜索文档（Ctrl+Shift+P）"]'), type('.sp-input', '插件')), wait: 900 },
    { name: 'settings', before: steps(click('.sp-mask'), click('[title="设置"]')), wait: 900 },
  ],
});

// 编辑模式是存在设置里的，与其去点 Vditor 自己的工具栏，不如换一份设置重开一次。
await shoot({ ...VIEWPORT, seed: seedFor({ mode: 'sv' }), shots: [{ name: 'split', wait: 2200 }] });

await shoot({ ...VIEWPORT, seed: seedFor({ theme: 'dark' }), shots: [{ name: 'dark', wait: 2200 }] });
