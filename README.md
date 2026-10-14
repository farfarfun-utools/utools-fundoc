# utools-fundoc

uTools Markdown 文档插件 — 多层目录组织文稿，三种编辑模式随时切换，LaTeX 公式完全离线渲染，
数据存在 uTools 数据库里跟着你的设备走。

呼出 uTools，敲一个 `fundoc`，光标就在文档里。左边是目录树，中间是编辑器，右边是当前文章的大纲。

## 特性

- **多层目录**：像文件系统一样嵌套、拖拽、重命名。目录和文档都是稳定 ID 的节点，重命名或移动
  一个目录只写一条记录，不会把下面几十篇文章的标识全换掉。
- **三种编辑模式**：所见即所得（`wysiwyg`）、即时渲染（`ir`，类 Typora，写公式最舒服）、
  左右分屏（`sv`，源码对照预览）。工具栏一键切换，单屏双屏随你。
- **分屏按标题对齐滚动**：分屏模式下两栏**按标题锚点分段对齐**，而不是按总高度等比例 ——
  公式和图片让源码与渲染的高度不成比例，等比例滚到后面会差出整整一节。两栏都能拖，互相跟随。
- **LaTeX 公式离线渲染**：KaTeX 引擎与字体全部打进插件，**断网照样渲染**，另带 `mhchem`
  化学式扩展。行内 `$...$`、块级 `$$...$$` 都支持，且 `$100` 这类写法不会被误判成公式。
- **代码高亮与图表**：highlight.js 代码高亮，Mermaid 流程图 / 时序图 / 甘特图，同样全本地。
- **右侧大纲**：按标题层级生成当前文章目录，点击跳转，长文不迷路。
- **标题自动编号**：大纲和正文里的标题自动标上 `1` / `1.1` / `1.2` 这样的章节号，打印的 PDF 里
  也有。编号只画在屏幕上，**不写进 Markdown**，导出的 `.md` 还是你写的原样；跳级（`#` 直接到
  `###`）按嵌套层数算，得到 `1.1` 而不是 `1.0.1`。不想要就在设置里关掉。
- **自定义关键词**：每篇文档可以开一个开关并填若干关键词，注册成 uTools 的全局搜索入口 ——
  在主搜索框敲「线性代数」直达那篇笔记。开了开关但没填词，就用文章标题当关键词。
- **主搜索框直搜**：不进插件界面，在 uTools 输入框里直接搜标题与关键词，选中直达那篇文档。
- **全文搜索面板**：`Ctrl/⌘ + Shift + P` 调出，连**正文**一起搜，命中处高亮并给出上下文片段，
  上下键选、回车开。
- **拖进来就是导入**：把一批 `.md` / `.markdown` 文件丢给 uTools，选「导入到 FunDoc」，
  文件名成为文档名，正文原样入库。
- **导出与打印**：单篇导出 `.md`、整个目录或全部文档导出为保持层级的 zip；`Ctrl/⌘ + P`
  走系统打印对话框存 PDF —— 等公式和字体真渲染完才弹窗，不会印出半截公式。
- **一键复制为图片**：把整篇文档渲染成一张 PNG 直接丢进剪贴板，公式、代码高亮、章节编号
  原样带着，贴进微信/飞书就能发。顶栏的下载按钮是个下拉，图片 / Markdown / PDF 任选。
  字体和图片全部内联进图里，**断网也出得来**。
- **键盘优先**：新建、保存、导出、打印、折叠左右栏、切编辑模式都有快捷键，且刻意绕开了
  Vditor 自己的那二十来个组合键。全表在设置面板里列着。
- **跨设备同步**：文档存在 uTools 文档数据库，开启 uTools 数据同步后自动流转到你的其他设备；
  别的设备上的改动会实时反映到当前界面，不用重启插件。
- **图片走附件**：粘贴截图不会把 base64 塞进正文，而是存成独立附件，正文永远是干净的纯文本。

## 安装

需要 [Node.js](https://nodejs.org) ≥ 20 与 [pnpm](https://pnpm.io) ≥ 12（`corepack enable` 即可，
版本跟着 `package.json#packageManager` 走）。

```bash
git clone https://github.com/farfarfun-utools/utools-fundoc.git
cd utools-fundoc
sh build.sh
```

仓库根的 `build.sh` 是**唯一**构建入口。它依次跑 ESLint（只检查，不改源码）、类型检查、
单测、清单与 `preload.js` 语法校验，再同步裁剪 Vditor 静态资源并打包界面，最后逐个断言
插件运行所需的文件都在 `utools/` 下（包括 KaTeX 字体和搜索内核 —— 少了它们插件照常能开，
只是公式变豆腐块、主搜索框搜不出东西）。任一步失败就停下，不会产出半成品。

在 uTools 中打开「插件应用市场 → 开发者工具 → 新建项目」，选择 `utools/plugin.json` 导入即可。

## 开发

```bash
pnpm install
pnpm run sync:vditor   # 从 node_modules 白名单同步 Vditor 资源到 public/vditor/dist
pnpm run dev           # 浏览器预览，数据落在 localStorage
pnpm test              # vitest
pnpm e2e               # 真浏览器里跑一遍（见下），没装 Chromium 会跳过
pnpm typecheck
pnpm lint
sh build.sh            # 校验并产出 utools/dist/
```

浏览器预览模式下没有 `window.utools`，存储层会自动退回 `localStorage` 垫片，但 uTools
数据同步、动态关键词这类能力只在真机里有效，相关功能需要导入 uTools 开发者工具调试。

### 浏览器端到端检查

uTools 的插件窗口本质就是个 Chromium 页面，所以大部分「只在真机上才会炸」的问题都能在浏览器里
验出来：Vditor 能不能从本地资源起来、断网时公式还渲不渲、快捷键有没有被编辑器吃掉、点导出到底
有没有文件落下来、分屏两栏滚动对不对得上。

```bash
pnpm e2e               # 先构建再跑
pnpm e2e --no-build    # 用现有 utools/dist，反复调检查项时快得多
pnpm e2e --headed      # 开着窗口跑
pnpm e2e --dump-sv     # 额外打印分屏的 DOM 结构与滚动映射曲线
```

用的是机器上现成的 Chromium（或 `CHROME_PATH` 指定的），直接走 DevTools 协议，不额外装
Puppeteer 那一套几百兆的依赖。它**不接进 `build.sh`** —— 打包不该依赖机器上装没装浏览器。

### 关键词怎么用

打开任意文档，在标题栏点关键词图标：

1. 打开「注册为 uTools 关键词」开关。
2. 想自己指定入口词就逐个填（支持多个）；**留空就用文章标题**。
3. 回到 uTools 主搜索框，敲这个词就能直达本篇。

同一个词被多篇文章占用是允许的，uTools 会把它们都列出来，用完整路径区分。关键词默认是关的 ——
几百篇文章全开会污染你的 uTools 全局搜索。

## 数据与同步

- 文档存放在 uTools 的文档数据库里，**卸载插件会一并删除**，重要内容请先导出。
- **多端同步是 uTools 的会员功能。** 非会员的数据只留在本机，这不是插件的问题。开启同步后，
  文档会随 uTools 账号同步到云端并下发到你登录的其他设备。
- 同一篇文档在两台设备上同时编辑时，插件不会静默覆盖你正在打的字：检测到远端改动会提示，
  由你选择「保留我的」或「存为副本」。
- uTools 单条数据库文档上限 1MB。图片走附件存储（单个上限 10MB），所以正文实际写不到上限；
  真要撞线插件会明确报错而不是悄悄丢内容。
- 插件自身不请求任何第三方服务，公式、代码高亮、图表渲染全部用打包进来的本地资源。

## 结构

```
utools/                     uTools 清单、预加载脚本、图标与构建脚本
public/vditor/dist/         裁剪后的 Vditor 离线资源（由脚本同步，不手工维护）
scripts/sync-vditor.mjs     Vditor 资源白名单裁剪
scripts/cdp.mjs             极简 DevTools 协议客户端（零依赖）
scripts/e2e.mjs             浏览器端到端检查
src/lib/host.ts             uTools / 浏览器 host 抽象
src/lib/storage.ts          meta@ / body@ / asset@ 读写，_rev 冲突重试，体积拦截
src/lib/tree.ts             邻接表装树、环与孤儿检测、拖拽排序
src/lib/keyword.ts          动态关键词与本机已注册功能的调和
src/lib/asset.ts            图片附件存取
src/lib/outline.ts          标题解析（大纲、标题兜底关键词、搜索共用一份）
src/lib/heading-number.ts   标题自动编号：纯计算 + 贴到渲染好的 DOM 上，不动源码
src/lib/search.ts           标题 / 关键词 / 正文搜索与排序（主输入框与面板共用）
src/lib/highlight.ts        命中片段切分，供高亮渲染
src/lib/export.ts           导出计划：单篇 / 目录 / 全部，文件名去重
src/lib/export-sink.ts      把计划真正落盘：真机走保存对话框，浏览器走下载
src/lib/zip.ts              最小 zip 打包（store 模式，无依赖）
src/lib/deadline.ts         给可能永远不返回的等待加期限（出图 / 打印那条路全靠它兜）
src/lib/preview-render.ts   离屏渲染一篇文档，打印与出图共用（亮色、等公式与字体就绪）
src/lib/print.ts            打印 / 存 PDF：管打印对话框与善后
src/lib/snapshot.ts         整篇转 PNG：样式与字体内联进 SVG，再画进 canvas
src/lib/scroll-map.ts       分屏滚动的锚点分段映射（纯计算）
src/lib/scroll-sync.ts      分屏滚动同步：镜像测量源码行位置、接管预览栏滚动
src/composables/useDocs.ts  全局状态与所有数据库写入，组件只读不写
src/composables/useEditor.ts Vditor 生命周期与离线资源注入
src/composables/useSearch.ts 搜索面板状态与正文读取缓存
src/composables/useShortcuts.ts 应用级快捷键表（设置面板直接渲染它）
src/components/             Vue 组件（文档树 / 编辑器 / 大纲 / 搜索 / 关键词 / 设置）
style.css                   全局样式与明暗主题变量
tests/                      vitest：装树、关键词、大纲、存储、附件、搜索、导出、出图、zip、滚动映射、超时
docs/design.md              设计文档：数据模型、同步策略、离线化与已知陷阱
```

设计取舍、踩过的坑和后续计划都在 [docs/design.md](docs/design.md)。动手改代码前建议先读它 ——
尤其是「元数据与正文分离」「动态功能不随数据库同步」「Vditor 的 `cdn` 恒定拼 `/dist`」这三节，
都是会让人白花半天的地方。

## 致谢

编辑器内核是 [Vditor](https://github.com/Vanessa219/vditor)（MIT）—— 它的三模式设计是本项目
选择它的直接原因。公式渲染来自 [KaTeX](https://github.com/KaTeX/KaTeX)（MIT）。

---

## 关于 farfarfun

[farfarfun](https://github.com/farfarfun) 是一个专注于实用工具库的开源组织，
涵盖云存储、数据处理、AI、多媒体与开发工具链等方向。

- 🏠 组织主页：<https://github.com/farfarfun>
- 📧 联系：farfarfun@qq.com

本项目基于 [MIT](LICENSE) 协议开源。
