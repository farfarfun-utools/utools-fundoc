# FunDoc 设计文档

uTools Markdown 文档插件。左侧多层目录树，中间 Vditor 编辑器，右侧文档大纲，数据落 uTools
文档数据库并借其同步机制跨设备流转。

本文记录**为什么这么设计**，以及实现时必须绕开的坑。所有写进来的 API 事实都已对照
`utools-api-types@8.0.0`（2026-10-07）与 `vditor@4.0.0`（2026-08-30）的实际声明/源码核实，
行号均指 vditor npm 包内的源码路径。

---

## 1. 目标与非目标

**目标**

- 一个常驻 uTools 的 Markdown 写作与查阅工具，呼出即用，不开浏览器、不登录。
- 多层目录组织文档，像文件系统一样拖拽、嵌套、重命名。
- 完整 LaTeX 公式支持，且**完全离线**——uTools 插件没有网络保障，公式不能靠 CDN。
- 每篇文档可注册自己的 uTools 全局关键词，在主搜索框直达。
- 数据存 uTools 文档数据库，用户开启 uTools 数据同步后自动跨设备。

**非目标（v1 不做）**

- 不做协同编辑。uTools 的同步是最终一致的文档复制，不是 OT/CRDT 通道。
- 不做双向链接 / 图谱。先把文件系统 + 编辑器做扎实。
- 不做本地 `.md` 文件夹双向同步。数据源唯一是 uTools 数据库，避免两个真相打架。
  导入导出走显式操作。

---

## 2. 界面布局

```
┌──────────────┬───────────────────────────────────┬──────────────┐
│  文档树       │            Vditor                 │   文档大纲    │
│              │                                   │              │
│ ▾ 📁 笔记     │  # 线性代数                        │ 线性代数      │
│   ▾ 📁 数学   │                                   │  特征值       │
│     📄 线性代数│  设 $A \in \mathbb{R}^{n\times n}$ │   定义        │
│     📄 概率论  │                                   │   求法        │
│   📁 读书      │  ## 特征值                         │  奇异值分解   │
│ ▸ 📁 工作      │                                   │              │
│              │                                   │              │
│ [+ 新建]      │  [wysiwyg | ir | sv]              │              │
└──────────────┴───────────────────────────────────┴──────────────┘
   可折叠                                              可折叠
```

**右侧大纲的实现选择。** Vditor 原生支持 `outline: { enable: true, position: 'right' }`
（`IOutline`，见 `dist/types/index.d.ts:674`），零代码就能在编辑区右侧出目录，且三种编辑模式下
都生效。

**但实现时没有用它**，`outline` 传的是 `{ enable: false, position: 'right' }`，大纲由
`OutlinePane.vue` + `parseOutline()` 自己画。原因：

1. **原生大纲长在编辑器内部**，宽度跟着编辑区走，拿不到我们三栏布局里那条可拖拽的
   `.resizer`，也没法和左栏共用一套折叠状态与配色变量。
2. **它要等 DOM 渲染完才有结果**，而我们在「还没打开这篇文档」时就需要标题——标题兜底
   关键词（§5.1）、搜索命中标题（§5.4）都在编辑器之外。纯文本解析没有这个依赖，一份
   `parseOutline` 两处用。
3. 切换编辑模式要销毁重建 Vditor（§2 没有运行时切模式的 API），原生大纲会跟着闪一下；
   自己画的大纲挂在 `state.markdown` 上，不受重建影响。

代价是跳转要自己实现：`scrollToHeading(container, index)` 在 `.vditor-reset` 面板里按序号索引
到 `h1..h6`。挑面板的标准是**里面真有标题元素**，而不是「可见」：`sv` 的源码区是个 textarea，
它自己也带 `.vditor-reset` 且可见，但里面只有纯文本，按可见性挑就会选中它然后什么也不滚。

**三种编辑模式**是选择 Vditor 的核心理由，由工具栏 `edit-mode` 切换：

| 模式 | 说明 | 适用 |
|---|---|---|
| `wysiwyg` | 所见即所得富文本 | 日常记录 |
| `ir` | 即时渲染，类 Typora | 写公式最舒服，光标离开 `$$` 立刻渲染 |
| `sv` | 左右分屏，源码 + 预览 | 大屏精修、核对 Markdown 原文 |

> **上游缺陷，已自己接管**：`sv` 分屏的滚动同步原本是**单向**的——只在编辑区挂了 scroll
> 监听（`src/ts/sv/index.ts:41`），滚预览区不会带动编辑区。而且它按 `scrollHeight` 比例换算
> （`sv/index.ts:45-52`），分母用编辑区的 `scrollHeight`、分子乘 `preview.scrollHeight` 却没减
> `clientHeight`，文末会算过头；还塞了个 `textScrollTop / textHeight > 0.5` 的分段 hack，
> 跨过那个点预览会突然跳一下。
>
> 比例同步在公式文档上必然漂移，这是原理性的：源码里 `$$...$$` 占 3 行、渲染后可能占 150px，
> 而行内 `$\sum$` 渲染后高度几乎不变——源码行高到渲染高度的映射是非线性的。
>
> 换成了基于标题锚点的分段线性映射，并且是双向的。实现见 §6.4。

---

## 3. 数据模型

### 3.1 两个决定性约束

uTools 文档数据库是 PouchDB 风格的本地库，开启同步后复制到云端：

- **单个文档 `put` 不超过 1MB。** 超了直接失败。
- **附件 `postAttachment` 不超过 10MB，且只能创建、不能更新**（uTools v2.0 删掉了
  `putAttachment` / `removeAttachment`）。
- 每次 `put` 必须带最新 `_rev`，否则更新失败；`_rev` 的存在就是为了解决同步冲突。
- 每次更新要传**完整文档**，没有字段级更新。

同族项目 `utools-funchat` 的 `src/services/storage.ts` 里留了一句血泪注释：

> 文档库对单个文档的体积有上限，而 **put 失败是静默的**——真超了整段聊天记录会凭空消失。

这条对文档插件是生死线，§4.3 专门处理。

### 3.2 元数据与正文分离

**这是本设计最重要的一个决定。**

朴素方案是一篇文档一条库记录，字段里既有 `name`/`parentId` 也有 `content`。问题：画左侧目录树
需要遍历所有节点，而 `allDocs` 会把**整条文档**搬进渲染进程——100 篇各 50KB 的文章，开插件就是
5MB 数据过一次 IPC，只为读出 100 个名字。funchat 正是踩了这个，它的 `loadHistories` 不得不改走
异步并留下注释："同步版 allDocs 是阻塞式 IPC，几十个带图会话就是几 MB 数据一次性搬进渲染进程，
整个界面会卡在这里连加载动画都停住。"

FunDoc 从一开始就拆开：

| `_id` 前缀 | 内容 | 典型体积 | 读取时机 |
|---|---|---|---|
| `meta@<nodeId>` | 节点元数据：名称、类型、父节点、排序、关键词配置、时间戳 | ~200B | **启动时全量读** |
| `body@<nodeId>` | Markdown 正文 | 数 KB ~ 1MB | 打开某篇时**按需读** |
| `asset@<assetId>` | 图片等二进制附件（`postAttachment`） | ≤10MB | 渲染时按需读 |
| `fundoc.settings` | 全局设置（走 `dbStorage`，单条足够） | ~1KB | 启动时读 |

启动只 `allDocs('meta@')`，几百个节点也就几十 KB，树瞬间出来。正文点开才取。

副作用好处：改标题、拖动位置、开关关键词，写的都是那条 200B 的 `meta@`，**不碰正文**。
同步时传输量小、冲突面小。

### 3.3 目录树：邻接表，不是路径即 ID

两种存法：

**(A) 路径即 `_id`**：`meta@/笔记/数学/线性代数`。目录隐含在路径里，不需要目录节点。
**(B) 稳定 ID + `parentId` 邻接表**：`meta@<nanoid>`，字段里记 `parentId`。目录也是节点。

选 **(B)**，三个理由：

1. **重命名/移动目录是 O(1)。** 方案 A 下 `_id` 不可变，重命名一个目录等于删掉并重建它下面
   所有子孙文档——几十篇文章的 `_id` 全变，同步到另一台机器就是几十条删除 + 几十条新增，中间
   任何一步失败都留下半棵残树。方案 B 只改那一条 `meta@` 的 `name` 或 `parentId`。
2. **关键词注册需要稳定标识。** 动态功能的 `code` 要绑定文档（§5）。路径一变 `code` 就失效，
   用户注册的关键词会莫名消失。
3. **同步冲突面最小。** 改一个字段只触碰一条文档，`_rev` 冲突概率最低。

代价：树结构要在内存里从 `parentId` 组装（O(n)，几百节点无感），且要防御**环**与**孤儿**
——同步可能让 A 的父亲是 B、B 的父亲是 A（两台机器各拖了一次）。装树时做一次检测，
环上节点和找不到父亲的节点一律挂到根下，并在界面上提示"已修复 N 个异常节点"。
绝不能让一个环把渲染打成死循环。

### 3.4 `meta@` 文档结构

```ts
type NodeMeta = {
  _id: string              // `meta@${nodeId}`
  _rev?: string
  nodeId: string           // nanoid，稳定不变
  type: 'dir' | 'doc'
  name: string             // 目录名 / 文档标题
  parentId: string | null  // null = 根节点
  order: number            // 同级排序，稀疏整数，插入时取相邻中值
  createdAt: number
  updatedAt: number

  // 仅 type === 'doc'
  keywordEnabled?: boolean // 关键词开关
  keywords?: string[]      // 自定义关键词；为空且开关开 → 用 name 兜底（§5）
  headingCache?: string[]  // 大纲缓存，供"未打开文档也能搜标题"用，可选
  bodySize?: number        // 正文字节数，给容量预警用（§4.3）
}
```

`order` 用**稀疏整数**（初始 1000、2000、3000…），拖拽插入时取前后中值，避免每次拖动都重写
整个同级列表的 `order`——那又会变成"动一下、写十条文档"的同步噪声。中值挤到相邻时才做一次
局部重排。

---

## 4. 存储与同步

### 4.1 写入：`_rev` 冲突重试

直接沿用 funchat 验证过的模式（`src/services/storage.ts`）：`put` 失败时取回当前 `_rev`
重试一次。`_rev` 过期说明同一条文档在别处被写过——取回最新版本号重试，让本次改动生效，
而不是把失败咽下去。

另外两条同族项目已经踩实的纪律：

- **传进 `db.put` 的必须是纯数据。** Vue 的响应式 Proxy 过不了 Electron 的结构化克隆，
  `put` 会失败。funchat 专门有个 `clonePlain`，FunDoc 照做。
- **写之前量体积。** 见 §4.3。

### 4.2 外部同步：`onDbPull` 必须监听

`utools.onDbPull(callback: (docs: DbDoc[]) => void)` 在"插件数据通过 uTools 同步机制从其他设备
更新到当前设备"时触发，回调拿到的是**本次同步过来的文档列表**。

funchat 的 CHANGELOG 把不监听的后果写得很清楚：

> **从未注册 `onDbPull`。** uTools 会在设备间同步插件文档，不监听的话另一台机器上新增的好友和
> 话题要重启插件才看得见，接着写同一份文档还会直接撞 `_rev` 冲突。

FunDoc 的处理按变更类型分流：

| 同步进来的文档 | 动作 |
|---|---|
| 任意 `meta@` | 重建目录树；调和动态关键词（§5.3） |
| `body@<非当前文档>` | 无动作（下次打开自然读到新内容） |
| `body@<当前正在编辑的文档>` | **冲突，见下** |

**正在编辑的文档被远端改掉**是唯一需要用户介入的情况，绝不能静默覆盖：

- 本地无未保存改动 → 直接刷新编辑器内容，提示"此文档已同步更新"。
- 本地有未保存改动 → **不动编辑器**，弹提示条："此文档在其他设备被修改"，给两个按钮：
  「保留我的」（以本地为准，带新 `_rev` 覆盖写）/「存为副本」（本地另存为新节点，编辑器切到远端版本）。

默认行为永远是保住用户正在打的字。

### 4.3 1MB 上限：拦住，别静默丢

写 `body@` 之前先量：

```
bytes = TextEncoder().encode(JSON.stringify(doc)).length
```

超 1MB 直接抛出用户看得懂的错误，不进 `put`。参照 funotp 的 `writeStorage` 已有措辞风格，
给出当前体积和超限原因。

正文真有可能撞线吗？纯文字 1MB 约等于 50 万汉字，单篇写不到。**真正的撞线来源是图片**
——一张截图 base64 内联就是几十万字符。所以：

**图片一律不内联，走附件。** 粘贴/拖入图片时：

1. `utools.db.postAttachment('asset@' + nanoid(), buffer, mime)` 存成独立附件文档（≤10MB）。
2. 正文里只写 `![](fundoc-asset://<assetId>)`。
3. 渲染前把 `fundoc-asset://` 换成 `URL.createObjectURL(blob)`，blob 来自
   `db.getAttachment(assetId)` + `db.getAttachmentType(assetId)`。

这样正文永远是纯文本，1MB 等于 50 万字，实际碰不到。

**附件不可更新**（API 层面只能创建）这点正好契合：图片是不变内容，编辑图片等于换一张新的，
生成新 `assetId` 即可。代价是删文档时要连带清理它引用的附件，否则库里会堆垃圾。
删除流程：解析正文里所有 `fundoc-asset://`，逐个 `db.remove`。另提供设置项「清理无引用附件」
做兜底扫描。

### 4.4 浏览器预览兜底

`pnpm dev` 在浏览器里跑时没有 `window.utools`。沿用同族做法：存储层统一走一个 host 抽象，
uTools 内用真 `db` / `dbStorage`，浏览器里退回 `localStorage` 垫片。

funchat 的 `src/services/utools.ts` 留了个警告值得照抄：垫片的键名**不要**和 `dbStorage` 的
业务前缀拼出同一个键，否则 `db` 与 `dbStorage` 会互相覆盖，"测试就会在生产不存在的路径上通过"。

同样照抄它用 `Pick<typeof utools, ...>` 从官方声明里取接口的做法，**不要**写
`var utools: any` 或 `Record<string, any>`。funchat 的 CHANGELOG 记了这个教训：一句
`var utools: any` 盖掉官方类型声明后，`setExpendHeight`（8.0 已改名 `setExpandHeight`）
这种拼写错误无人校对，可选调用把"接口不存在"咽下去，功能静默失效很久没人发现。

---

## 5. 关键词：注册 uTools 全局搜索入口

### 5.1 需求规则

每篇文档有一个**开关**和一个**可填多个词**的输入区：

- 开关**关** → 不注册，已注册的要移除。
- 开关**开** + 填了词 → 用这些词注册。
- 开关**开** + 没填词 → **用文档标题当关键词**。

### 5.2 API 与映射

| API | 签名 | 用途 |
|---|---|---|
| `utools.setFeature(feature)` | `(feature: Feature) => void` | 注册/更新；`code` 已存在则更新 |
| `utools.removeFeature(code)` | `(code: string) => boolean` | 移除 |
| `utools.getFeatures(codes?)` | `(codes?: string[]) => Feature[]` | 读当前已注册的动态功能 |

`Feature` 的形状（`utools-api-types@8.0.0`）：`code` 必填唯一，`cmds: Array<string | Cmd>`
——纯字符串就是"功能指令"，正是我们要的关键词。

映射：

```ts
utools.setFeature({
  code: `doc/${nodeId}`,                      // 绑稳定 nodeId，标题改了也不失效
  explain: `打开文档：${pathOf(nodeId)}`,       // 用完整路径区分同名文档
  icon: 'logo.png',
  cmds: keywords.length ? keywords : [name],  // 没填词 → 标题兜底
})
```

进入时路由（`onPluginEnter`，`action` 含 `code` / `type` / `payload` / `from`）：
`action.code` 以 `doc/` 开头 → 取出 `nodeId`，直接打开那篇文档。

### 5.3 坑：动态功能是**本机状态**，不随数据库同步

**这是整个关键词特性最容易出错的地方。**

关键词的**配置**存在 `meta@` 里，会跟着 uTools 同步到其他设备。但 `setFeature` 注册的是
**当前这台机器上 uTools 客户端的本地状态**，它不在我们的文档库里，不会被同步。

后果：在 A 机器给文章配了关键词，同步到 B 机器后，B 的 `meta@` 里有配置，但 B 的 uTools
**没注册过这个 feature**——主搜索框打关键词什么也搜不到，而界面上开关是打开的。用户会认为坏了。

所以必须有一次**调和（reconcile）**：以数据库为准，把本机已注册的动态功能集合对齐到期望集合。

```
期望集合 = { `doc/${n.nodeId}` : n ∈ meta@, n.type==='doc', n.keywordEnabled, cmds 非空 }
实际集合 = utools.getFeatures().map(f => f.code).filter(c => c.startsWith('doc/'))

对 期望 \ 实际        → setFeature
对 实际 \ 期望        → removeFeature
对 两者都有且 cmds 变了 → setFeature（覆盖更新）
```

**调和时机**：① 插件启动读完 `meta@` 之后；② 每次 `onDbPull` 带来 `meta@` 变更之后；
③ 用户在界面上改开关或词之后（可只增量处理那一条）。

### 5.4 其他边界

- **`cmds` 不能为空。** 开关开、没填词、标题又是空的（新建未命名）→ 不注册，并在界面上标明
  "需要先填标题或关键词"。不要注册一个 `cmds: ['']`。
- **关键词撞车。** 两篇文章用同一个词是允许的，uTools 会把两条都列在搜索结果里，靠 `explain`
  里的完整路径区分——这也是 `explain` 必须写路径而不是标题的原因。
- **删除文档必须 `removeFeature`。** 否则 uTools 里留下一个指向已删节点的死关键词，点进去
  是空白。删除流程：`removeFeature` → 删 `asset@` → 删 `body@` → 删 `meta@`。
  顺序是刻意的：先摘掉入口，再拆内容，中途失败也不会留下"能搜到但打不开"的入口。
- **关键词数量。** 官方声明未给出上限，但动态功能会进用户的 uTools 全局搜索空间。几百篇文章
  全开关键词会污染搜索体验，所以**默认关**，由用户逐篇开启。

---

## 6. Vditor 集成与离线化

### 6.1 `cdn` 选项的真实拼接规则

Vditor 的静态资源（Markdown 引擎 lute、KaTeX、代码高亮、图标、i18n）默认从公网 CDN 拉。
uTools 插件必须全部本地化，靠 `options.cdn`。

**关键事实：Vditor 恒定按 `${options.cdn}/dist/...` 拼路径**，`/dist` 这一段是硬编码在源码里的：

```
${options.cdn}/dist/js/lute/lute.min.js        ← src/ts/markdown/previewRender.ts:61
${options.cdn}/dist/js/katex/katex.min.js
${options.cdn}/dist/js/katex/katex.min.css
${options.cdn}/dist/js/katex/mhchem.min.js
${options.cdn}/dist/js/i18n/${lang}.js
${options.cdn}/dist/index.css
${options.cdn}/dist/method.min.js
${options.cdn}/dist/css/content-theme/...
${options.cdn}/dist/images/emoji/...
```

所以本地副本**必须保留 `dist/` 这一层**。设 `cdn: './vditor'`，文件就要落在
`public/vditor/dist/js/katex/...`。漏掉 `dist` 这一层是最容易犯的错，表现为公式不渲染、
图标变方块，而且控制台 404 的路径看起来"多了一截 dist"让人以为是 Vditor 的 bug。

### 6.2 裁剪清单

`vditor@4.0.0` 的 `dist/` 整个 **24MB**，塞满了我们用不到的渲染器。按实际目录体积裁剪：

**必须打包（约 7.5MB）**

| 目录 | 体积 | 为什么 |
|---|---|---|
| `js/lute` | 3.6MB | Markdown 引擎，Go 编译产物，Vditor 的核心，少了什么都不渲染 |
| `js/highlight.js` | 2.1MB | 代码块高亮 |
| `js/katex` | 1.5MB | **公式引擎**，含 `fonts/`、`mhchem.min.js`（化学式） |
| `images` | 116KB | emoji 等内置图片 |
| `js/icons` | 72KB | 工具栏图标 |
| `js/i18n` | 56KB | 只留 `zh_CN.js`（+ `en_US.js` 以防万一） |
| `css` | 28KB | 内容主题 |

**按需（v1 建议保留 mermaid）**

| 目录 | 体积 | 判断 |
|---|---|---|
| `js/mermaid` | 3.5MB | 流程图/时序图，文档类高频，**留** |
| `js/echarts` | 1.0MB | 表格转图表，低频，v1 砍 |

**明确砍掉（省 11.9MB）**

`js/mathjax` 6.5MB、`js/graphviz` 2.0MB、`js/markmap` 840KB、`js/abcjs` 360KB、
`js/smiles-drawer` 252KB、`js/flowchart.js` 128KB、`js/wavedrom` 92KB、`js/plantuml` 36KB。

砍 MathJax 是个权衡：它和 KaTeX 二选一（Vditor 的 `preview.math.engine` 支持切换），
但它一个人就 6.5MB，而 KaTeX 1.5MB 已覆盖绝大多数写作需求，且 Vditor 自带 `mhchem` 扩展
补上了化学式。**代价要说清**：KaTeX 对部分 LaTeX 宏（复杂的 `\begin{align}` 嵌套、
自定义 `\newcommand` 体系）支持不如 MathJax。设置里留一个「公式引擎」开关，选 MathJax 时
提示需要联网——或者等真有人要再把 6.5MB 加回来。

裁剪用构建脚本从 `node_modules/vditor/dist` 白名单拷贝到 `public/vditor/dist`，**不要手工拷**
——手工拷会在升级 Vditor 时悄悄留下旧版资源，而 KaTeX 的 CSS 和 fonts 版本错配表现为公式
"渲染出来但字形是方块"，极难排查。脚本放 `scripts/sync-vditor.mjs`，在 `build.sh` 里调用。

最终插件体积约 11MB。对比：uTools 插件没有体积硬限制，而这 11MB 全是本地资源，换来的是
断网也能渲染公式——对文档类插件是正确的取舍。

### 6.3 Vditor 关键配置

```ts
new Vditor(el, {
  cdn: './vditor',                    // §6.1，对应 public/vditor/dist/
  lang: 'zh_CN',
  mode: 'ir',                         // 默认即时渲染，公式体验最好
  outline: { enable: false, position: 'right' },  // §2：大纲自己画，不用原生
  preview: {
    math: { engine: 'KaTeX', inlineDigit: false },
    theme: { current: isDark ? 'dark' : 'light' },
  },
  toolbar: [ /* 按需裁剪，去掉上传、录音等用不到的 */ ],
  cache: { enable: false },           // 见下
  after: () => { /* 填入正文 */ },
})
```

**必须关掉 `cache`。** Vditor 默认把编辑内容缓存进 `localStorage`，而我们的真相在 uTools
数据库里。两套缓存并存会在"切换文档"时把上一篇的内容带进下一篇——这是 Vditor 集成最常见的
数据串台事故。我们自己负责持久化（§7）。

**切换文档不要销毁重建编辑器。** `new Vditor()` 要加载 lute 等资源，每次切文档都重建会有明显
白屏。用 `vditor.setValue(markdown)` 换内容，编辑器实例全程只有一个。

**`inlineDigit: true`** 让 `$100` 这种不被误判成公式起始符——纯文档场景里写价格、数字远比写
行内公式频繁。

### 6.4 `sv` 分屏滚动同步

替掉 §2 里那段上游实现，分三块：`lib/scroll-map.ts` 只做数学，`lib/scroll-sync.ts` 碰 DOM，
`useEditor.ts` 在 `after()` 回调里安装（分屏的 textarea 和预览区都是构造过程中建的，早于此
查不到）、`destroy()` 里摘掉。

**映射**：每个标题在源码侧和预览侧各有一个确定像素位置，配成锚点对，首尾补 `0↔0` 与
「两侧最大滚动量」，段内线性插值。不单调的锚点要丢掉（源码标题数和渲染标题数对不齐时会出现），
留着会让那一段滚动方向反掉。反向映射是正向的 `from`/`to` 互换，**是精确逆**——这样两栏来回
同步不会越走越偏。

**「源码第 n 行在第几像素」**：textarea 没有任何 API 能回答，用镜像元素量——造一个样式完全
一致的隐藏 div，把源码放进去，在每个标题行的首字符上包一个 `span`，读 `offsetTop`，一次布局
量出全部标题。两个坑：

- 少抄一条样式就会错行，字体和折行规则直接决定折行位置（`MIRRORED_STYLES`）。
- `offsetTop` 量到的是**行内盒**上沿，比行盒上沿低半个行距。只差一两像素，但首个标题那一段
  很陡（源码侧十来像素 ↔ 预览侧近百像素，预览区上方还有工具条和内边距），到预览侧就是七八
  像素的偏移。拿第 0 行反推出半行距再统一扣掉。

**接管 `preview.scrollTop`**：Vditor 那段 scroll 监听是构造时挂的匿名函数，摘不掉。它只是在
JS 里给 `preview.scrollTop` 赋值，所以在这个元素实例上盖一个空 setter 就能把它整条路堵死
（`hijackScrollTop`，`destroy()` 时还原）。

为什么不靠「我后挂监听、把它的值盖掉」——盖得掉，但代价是每次源码栏滚动都得跟着写一遍预览栏，
包括我们自己写进源码栏而回弹出来的那次；而预览栏正在平滑滚动（点大纲跳转）或惯性滚动时，这么
一写就把滚动打断了，表现是**点大纲只挪一两像素就停住**。堵死之后两边各自只有一个写者。
`scrollIntoView` 走的是内部滚动机制而不是这个 setter，所以大纲跳转照旧有效。

**回声**：写对面的 `scrollTop` 会让对面也派发 scroll 事件。按「每次程序性写入记一次账，对面
的下一个 scroll 事件拿它抵掉」来挡，不用带时限的锁——scroll 事件在「更新渲染」里派发，而
`requestAnimationFrame` 回调排在同一轮的 scroll 事件之后，等回声那一帧到来时锁早解开了。
记账时先读后写再比对：值没变（或被夹在两端）时浏览器根本不派发事件，记下的账会留着把之后
某一次真实滚动吃掉。

对齐效果在 `pnpm e2e` 里逐个标题断言（§11），并且会顺带确认这篇测试文档真能把「按标题对齐」
和「等比例换算」区分开——否则那条断言什么也没证明。

---

## 7. 保存策略

Markdown 编辑是高频输入，不能每个按键都写库（每次 `put` 都是一次 IPC + 整文档重写 + 一条
同步变更）。

- **防抖自动保存**：停止输入 **800ms** 后写 `body@`。
- **强制落盘时机**：切换文档、`onPluginOut`、`pagehide`、窗口失焦。
  funchat 的教训："uTools 退出插件默认是转后台，**不触发 `pagehide`**，流式回复途中退出整轮
  问答就丢了。"所以 `onPluginOut` 和 `pagehide` **两个都要注册**。
- **标题变更**：正文第一个 `# 一级标题` 变化时同步更新 `meta@.name`（可在设置里关掉）。
  注意这会连带触发关键词重注册（§5.3），因为标题可能正被用作关键词。
- **`updatedAt`** 每次保存刷新，用于文档树按时间排序和「最近编辑」。

写 `meta@` 和写 `body@` 是两条独立的 `put`。先写 `body@` 再写 `meta@`：万一中间失败，
"正文已存但元数据时间戳旧"远好于"元数据说更新了但正文没落盘"。

---

## 8. 搜索、导出与快捷键

### 8.1 搜索：一份实现，两个入口

`lib/search.ts` 同时被应用内的搜索面板（`Ctrl/⌘+Shift+P`）和 `preload.js` 的 `onMainPush`
（uTools 主搜索框直搜）使用。preload 是 CommonJS、跑在 Node 侧，没法 import TS 模块，所以构建
时由 `vite.preload.config.ts` 把它单独打成 `utools/search-core.cjs`。**约束：这个文件不能有任何
运行时 import**，它得是自包含的。`build.sh` 里专门断言这个产物存在 —— 漏了的话插件界面
照常能开，只有主输入框一条结果都搜不出来，很难发现。

两边共用而不是各写一份，是因为两份打分逻辑的排序迟早不一致：用户在主搜索框和插件里搜同一个词
得到不同顺序，只会当成 bug。

**分档**：标题 > 关键词 > 正文，且前缀命中优于包含命中（打前几个字时想要的几乎总是标题以此
开头的那篇）。正文分值刻意压到 10，**低于任何标题/关键词档位** —— 这条性质让一个关键优化成立：
第一轮只看标题和关键词，凑够 limit 条就**一次正文都不读**。主输入框每敲一个键都要重搜一遍，
没有这个短路就是每次按键全库读正文。多个词之间是 AND，总分是各词最佳分之和。

正文搜索要求查询至少 2 个字符：单字几乎每篇都命中，结果全是噪音，代价还是把全库正文读一遍。
标题和关键词不受这条限制。

`bodyOf` 做成回调而不是传一个 Map，调用方自己决定缓存策略。缓存靠 `meta.updatedAt` 失效 ——
保存文档时元数据一定跟着写，这个值变了就说明正文可能变了；超过条数上限整个清掉，不值得为这点
事背一套 LRU。**正在编辑的那篇用内存里的 `state.markdown`**，不用库里的：刚写下的句子还没落盘，
而那恰恰是最可能被搜的内容。

### 8.2 导出：算什么与怎么写分开

`export.ts` 只**算**要写哪些文件，`export-sink.ts` 才碰副作用。这么分是因为两条落地路径差别
很大（真机有 fs，能写成真的目录结构；浏览器只能下载，一次一个文件），而「中文文件名在 Windows
上变成乱码」「两篇同名文档互相覆盖」这类问题恰恰全在计算这一侧，分开之后它们都能被单测覆盖。

- **遍历走 `buildTree`，不自己按 `parentId` 过滤。** 同步事故造出的环（A→B→A）里两个节点的
  `parentId` 都不是 null，按 `parentId` 递归一个都遍历不到 —— 导出悄悄丢文档，正是备份最不能
  出的错。`buildTree` 已经把它们修回根下（§3.3），直接复用那份结果。
- **文件名必须唯一，文档名不必。** 两篇都叫「周报」在我们的模型里完全合法，但写成文件就互相
  覆盖，而且是静默的。每一层独立去重，重名的加 ` (2)`。另外：Windows 保留设备名（`CON` 等）
  前面补下划线而不是整段换掉（用户还能认出是哪篇）；结尾的点和空格要去掉，否则 Windows 会悄悄
  吃掉它们，`a.` 和 `a` 变成同一个文件；单段限 80 字（多数文件系统限 255 **字节**，汉字 3 字节）。
- **图片统一落在导出根下的 `assets/`**，正文里的 `fundoc-asset://<id>` 按文档所在层级改写成
  `../../assets/x.png`。已经丢失的附件**保留原样**而不是换成空链接 —— 导出文件里留下可见痕迹，
  比悄悄变成一个坏图标更容易排查；同时在计划里回报 `missingAssets`，界面要提示。
- **落地**：真机弹原生对话框（单篇走保存对话框，多文件走选目录 + preload 写盘，路径拼接交给
  有 `path` 的 preload 侧）；浏览器单篇直接下载 `.md`，多文件自己打 zip。zip 里所有东西都套在
  `rootName/` 下，不套的话用户在下载目录解压会把十几个 `.md` 散到当前目录；空目录也写进去 ——
  那是用户自己建的结构，丢掉是信息损失。
- **分流看 `host.native`，不看「对话框返回了 undefined」。** 垫片里的对话框永远返回 undefined，
  和「用户点了取消」长得一模一样，混在一起会把浏览器预览里的导出变成静默失败。
- zip 自己写（`zip.ts`，store 模式不压缩）：引 JSZip 是 300KB 依赖换 60 行代码，而 Markdown
  的体量下 deflate 省的那点空间不值一个新依赖，store 本来就是 zip 标准的一部分。

### 8.3 打印 / 存 PDF：判据是 DOM，不是秒表

走浏览器自带的 `window.print()`（目标选「另存为 PDF」），**不用 Vditor 的 `exportPDF()`** ——
后者把内容塞进 iframe 然后硬等 3600ms 再打印，公式多的文档等不够就印出一堆原始 LaTeX，短文档
又白等三秒半。

也不能拿 `Vditor.preview()` 的 Promise 当完成信号：它只 await 了 lute / i18n / 图标三个脚本，
之后的 `mathRender`、`highlightRender` 都是发射后不管的（`previewRender.ts` 里没有 await），
Promise 落地时公式往往还没渲染。

改成等 DOM：KaTeX 渲染后会给每个 `.language-math` 挂上 `data-math` 属性，**写错的公式也会挂**，
所以这个条件不会因为某条公式有语法错而永远不满足。上限 10 秒，超了照印并提示 —— 卡住不印比印错
更糟。之后还要 `await document.fonts.ready`：字体没加载完就打印，KaTeX 会按回退字体量尺寸，
公式的上下标全是歪的。

打印一律按**亮色**主题渲染（深色底在纸上费墨又难读）。代价是 Vditor 的 `setContentTheme` 会把
全局的 content-theme 链接也切成亮色，所以调用方在 Promise 落地后要重新应用一次编辑器主题。

### 8.4 快捷键：先避开 Vditor 的二十来个

整套键位是**绕开 Vditor 之后选出来的**。它自己占了
`⌘' ⌘; ⌘B ⌘D ⌘E ⌘G ⌘H ⌘I ⌘J ⌘K ⌘L ⌘M ⌘O ⌘P ⌘U ⌘Y ⌘Z` 和 `⇧⌘B ⇧⌘E ⇧⌘H ⇧⌘I ⇧⌘O`
（`grep -oE 'hotkey: "[^"]+"' node_modules/vditor/dist/index.js | sort -u`）。所以「⌘P 快速打开」
「⌘O 打开文件」「⌘M 切模式」这类常规选择全部不可用，抢过来会让加粗、链接、撤销失效，那是更大的
损失。带 ⇧ 的组合里除上面五个之外都是空的，本应用的功能键于是基本都落在 ⇧⌘ 上。

唯一刻意抢的是 **⌘P**：焦点不在编辑器里时它会触发浏览器打印整个三栏界面，印出来是一张没用的
截图；而「按 ⌘P 想打印正在看的文档」是绝大多数人的预期。代价是 Vditor 的预览切换只能点工具栏
按钮 —— 它有按钮。

两处实现细节：监听挂在 **window 的捕获阶段**（Vditor 的监听挂在编辑器元素上、冒泡阶段才轮到
它），命中后 `stopPropagation`，否则同一个键会被处理两次；`event.isComposing` 期间一律不抢键，
中文输入时按下的键属于候选框。键位表 `SHORTCUTS` 放在模块级，设置面板直接把它渲染成速查表，
而不是顺手再装一遍监听。

---

## 9. 目录结构

对齐同族项目（`utools-funotp` / `utools-funchat`）的约定：

```
build.sh                 唯一构建入口（同族约定：放仓库根，utools/ 里不再放第二份）
utools/                  uTools 清单、预加载脚本、图标
  plugin.json
  preload.js
  logo.png
  search.png
  search-core.cjs        ← 由 vite.preload.config.ts 从 src/lib/search.ts 打出，不进版本管理
  dist/                  ← vite 产物，不进版本管理
public/
  vditor/dist/           ← 由 scripts/sync-vditor.mjs 从 node_modules 白名单同步
scripts/
  sync-vditor.mjs        Vditor 资源裁剪同步
  cdp.mjs                极简 DevTools 协议客户端（零依赖，见 §11）
  e2e.mjs                浏览器端到端检查
src/
  lib/
    host.ts              uTools / 浏览器 host 抽象（db、dbStorage、feature）
    plain-clone.ts       脱响应式，过结构化克隆
    storage.ts           meta@ / body@ / asset@ 读写，_rev 冲突重试，体积拦截
    tree.ts              邻接表装树、环与孤儿检测、order 稀疏排序
    keyword.ts           动态功能调和（§5.3）
    asset.ts             图片附件存取、fundoc-asset:// 协议转换
    outline.ts           标题解析（给大纲、标题兜底关键词、搜索用）
    search.ts            标题 / 关键词 / 正文搜索与排序（主输入框与面板共用一份）
    highlight.ts         命中片段切分，供高亮渲染
    export.ts            导出计划：单篇 / 目录 / 全部，文件名去重
    export-sink.ts       把计划落盘：真机走保存对话框，浏览器走下载
    zip.ts               最小 zip 打包（store 模式，无依赖）
    print.ts             打印 / 存 PDF：离屏渲染、等公式与字体就绪
    scroll-map.ts        分屏滚动的锚点分段映射（纯计算，§6.4）
    scroll-sync.ts       分屏滚动同步：镜像测量源码行位置、接管预览栏滚动
  composables/
    useDocs.ts           全局响应式状态 + 所有数据库写入 + onPluginEnter / onDbPull 路由
    useEditor.ts         Vditor 生命周期、离线资源注入、模式切换重建
    useSearch.ts         搜索面板状态与正文读取缓存
    useShortcuts.ts      应用级快捷键表（设置面板直接渲染它）
  components/
    icons.ts             SVG path 表（`<script setup>` 里不能写 export，只能单独放）
    Icon.vue             按名字渲染 SVG
    DocTree.vue          左栏：多层目录树，拖拽、右键菜单、就地重命名
    EditorPane.vue       中栏：Vditor 容器，兼作顶栏（标题、面板开关、设置入口）
    OutlinePane.vue      右栏：大纲（自己画，见 §2）
    KeywordDialog.vue    关键词开关 + 多词输入 + 生效预览
    SearchPalette.vue    全文搜索面板（命中高亮、上下键选、回车开）
    SettingsDialog.vue   模式、主题、自动保存、无引用图片清理、快捷键表
  App.vue                三栏骨架、可拖拽分栏、冲突横幅、主题落到 data-theme
  main.ts
style.css                全局样式与主题变量（同族约定：放根目录，由 main.ts 引入）
tests/                   vitest：装树 / 关键词 / 大纲 / 存储 / 附件 / 搜索 / 导出 / zip / 滚动映射
docs/design.md           本文
```

**状态收口在 `useDocs.ts`。** 组件只读 `state`、只调它导出的函数，不直接碰 `host.db`。
正文的回填走一个显式的 `contentEpoch` 计数器（`setMarkdownExternal()` 递增），而不是
watch `state.markdown`——后者会和编辑器自己的 `input` 回调互相喂数据，表现为打字时
光标被反复弹回开头。只有「切换文档、同步覆盖、冲突处理」这三件事才递增 epoch。

---

## 10. `plugin.json` 要点

静态功能入口（动态关键词是在此之上追加的）：

```json
{
  "pluginName": "FunDoc 文档",
  "main": "dist/index.html",
  "preload": "preload.js",
  "features": [
    { "code": "fundoc", "cmds": ["FunDoc", "文档", "笔记", "markdown", "md"] },
    { "code": "fundoc-search",
      "cmds": [{ "type": "over", "label": "搜索文档", "minLength": 2, "maxLength": 40 }],
      "mainPush": true },
    { "code": "fundoc-import",
      "cmds": [{ "type": "files", "label": "导入到 FunDoc", "fileType": "file",
                 "match": "/\\.(md|markdown)$/i" }] }
  ]
}
```

- `fundoc-search` + `mainPush`：在 uTools 主搜索框直接搜标题与关键词并推结果，不进插件界面
  （funotp 的 `search-otp` 是同一套路）。`minLength: 2` 是为了别让一个字母就触发全库扫描。
- `fundoc-import`：拖一批 `.md` 文件到 uTools 就能导入。
- `mainPush` 选中结果后要打开哪一篇，没法直接传——`MainPushResult` 只有 `icon/text/title`
  三个字段，`PluginEnterAction.option` 也只回传 `text`。所以 `preload.js` 在 `onSelect` 里把
  nodeId 连同时间戳写进 `dbStorage`（键 `fundoc.pending-open`），界面进来时用
  `bridge.takePendingOpen()` 取走。**带 30 秒 TTL**：`dbStorage` 是会跨设备同步的，
  一个过期值留在那里会让另一台机器一进插件就莫名跳到某篇文档。
- 动态关键词的 `code` 统一用 `doc/` 前缀，与上面这些静态 code 不冲突——调和时靠这个前缀
  筛出"属于我们管理的"动态功能（§5.3），绝不能误删用户其他来源的 feature。

---

## 11. 浏览器端到端检查

单测覆盖得了纯函数（装树、搜索排序、导出计划、滚动映射），覆盖不了「Vditor 到底起来了没有」
「快捷键有没有被编辑器吃掉」「点导出到底有没有文件落下来」。而**uTools 的插件窗口本质就是个
Chromium 页面**，所以这些都能在浏览器里验，不必每次都导进开发者工具手点。`pnpm e2e` 做的就是
这件事：起一个静态服务器喂 `utools/dist`，拉起浏览器，跑 18 条断言。

```bash
pnpm e2e              # 先构建再跑
pnpm e2e --no-build   # 用现有产物，反复调检查项时快得多
pnpm e2e --headed     # 开着窗口看
pnpm e2e --dump-sv    # 额外打印分屏的 DOM 结构与滚动映射曲线
```

**不用 Puppeteer / Playwright。** 它们各带一份几百 MB 的浏览器下载，而这里只要「开个页面、
跑几句 JS、看有没有报错」。Node 22 自带全局 WebSocket 和 fetch，CDP 就是 JSON over WebSocket，
`scripts/cdp.mjs` 三百行以内解决，浏览器也用机器上现成的（或 `CHROME_PATH`），找不到就跳过 ——
这是开发期辅助，不该让没装浏览器的环境连测试都跑不起来。同理它**不接进 `build.sh`**：打包不该
依赖机器上装没装浏览器。

几个踩过的坑：

- **页面地址不写在命令行上。** 那样页面在我们连上之前就开始加载，`Network.enable` 之前发出的
  请求全收不到，「有没有回落 CDN」这条会时灵时不灵。统一先开 `about:blank`，各域 enable 完、
  监听都挂好了，再 `Page.navigate` 过去。
- **沙箱**：容器和开了 userns 限制的发行版（Ubuntu 23.10+）里 Chromium 起不来沙箱。只在
  stderr 确认是这个原因时才补 `--no-sandbox` 重试，不默认带上 —— 加载的虽然只是本机上我们
  自己的产物，关沙箱毕竟是降安全边界的事，得有明确理由。
- **断言要能失败。** 分屏那组最容易写成废断言：等「页面上有 4 个标题」时欢迎文档恰好也有 4 个，
  于是等待瞬间通过、量到的全是上一篇文档。改成等标题文本拼起来等于 `Sync A,Sync B,Sync C,Sync D`。
  另外还显式断言了两件事：测试文档没有折行（否则「第 n 行在第几像素」这个前提就不成立），以及
  按标题对齐和按比例换算在这篇文档上相差 16px 以上（否则对齐断言什么都没证明）。
- **预览栏的 `scrollTop` 写不动是设计使然**（§6.4 接管了它），所以测试里改用真实的
  `mouseWheel` 事件滚它，这也更接近用户路径。
- **每一处等待都要有上限。** 浏览器偶尔会在启动中途卡住：调试端口已经写出来、target 也列得
  出来，但那条 CDP WebSocket 既不 `open` 也不 `error`。那是全脚本唯一没设上限的等待，于是整个
  命令挂死（实测十分钟还在等）。现在它 15 秒超时，并且连接失败时负责把浏览器进程和临时 profile
  收掉 —— 调用方拿不到 `close()`，没别人能收。

---

## 12. 已知风险与后续

| 项 | 状态 |
|---|---|
| `sv` 分屏滚动同步单向且比例漂移（Vditor 上游） | ✅ 已自己接管：标题锚点分段映射 + 双向（§6.4），并堵掉上游那段监听 |
| KaTeX 宏覆盖不如 MathJax | v1 用 KaTeX + mhchem。设置里留引擎开关，选 MathJax 需联网或加回 6.5MB |
| 正文超 1MB | 图片走附件后实际碰不到；仍要拦截并报错，绝不静默丢。真需要再做 `body@<id>#N` 分片 |
| 附件不可更新、删除需手动清理 | 删文档时按正文引用清理 + 设置里提供无引用附件扫描 |
| 同步产生目录环 / 孤儿 | 装树时检测，异常节点挂根并提示 |
| 动态功能不随库同步 | 启动与 `onDbPull` 后调和（§5.3） |
| uTools 多端同步是会员功能 | 非会员数据只在本机。README 里要讲清，别让用户以为插件坏了 |
| 协同编辑 | 非目标。同一文档并发编辑按 §4.2 的"保留我的/存为副本"兜底 |

**里程碑**

1. ✅ **M1 骨架**：工程脚手架对齐同族约定（vite / eslint / tsconfig / build.sh / plugin.json）+
   Vditor 离线化跑通（公式能渲染）+ host 抽象与浏览器垫片。
2. ✅ **M2 数据层**：`meta@` / `body@` 读写、`_rev` 重试、体积拦截、装树与环检测、单测。
3. ✅ **M3 三栏界面**：文档树（拖拽、右键、嵌套）+ 编辑器 + 右侧大纲 + 防抖保存与强制落盘。
4. ✅ **M4 关键词**：开关 + 多词输入 + 标题兜底 + 调和 + `onPluginEnter` 路由。
5. ✅ **M5 同步与附件**：`onDbPull` 分流与冲突 UI、图片附件、`mainPush` 搜索。
6. ✅ **M6 打磨**：导出（单篇 `.md` / 一个目录 / 全库；真机写成目录树，浏览器打 zip）、
   打印存 PDF、应用级快捷键、正文全文搜索面板、`sv` 滚动同步按标题锚点重做（§6.4）。
   明暗主题与设置页已随 M3 落地。

**M1–M6 全部落地。** 交互在浏览器里用 `pnpm e2e` 过了 18 条断言（§11）—— 插件窗口就是
Chromium 页面，这覆盖了绝大多数真机行为。剩下**只有真机才能验**的是那几件依赖 uTools 自身
能力的：跨设备同步与 `onDbPull`、动态关键词注册、主搜索框 `mainPush`、拖文件导入、
`utools.showSaveDialog` 保存路径。这些在浏览器里走的是垫片分支，逻辑有单测，但端到端
需要导入 uTools 开发者工具实测。
