# 开发计划

## 导出与导入的往返（进行中）

### 现状

导入导出这两头都已经有了，缺的是**两头能不能接上**：

| 能力 | 现状 |
| --- | --- |
| 导入 `.md` / `.markdown` | 有（`plugin.json` 的 `fundoc-import` 走 uTools `files` 特性，拖文件进来即可） |
| 单篇导出 `.md` | 有 |
| 整个目录 / 全部文档导出为保持层级的 zip | 有（`lib/export.ts` + `lib/zip.ts`） |
| 打印 / 导出 PDF、导出图片 | 有（`lib/print.ts`、`lib/snapshot.ts`） |
| **导出的包能原样导回来** | **不能** |
| 全量 JSON 备份 / WebDav 备份 | 没有（靠 uTools 自带的数据同步） |

zip 里只有正文和目录层级，而关键词配置、同级排序、创建时间、`nodeId` 都存在 `meta@` 里 ——
导出再导入会把这些一并丢掉。README 里「卸载插件会一并删除，重要内容请先导出」这句话因此只兑现了一半：
内容带得走，用法带不走。

### 进行中

`src/lib/manifest.ts`（尚未提交）已经定义好导出包里的清单 `fundoc.json`：格式版本 1、
`ManifestNode`（nodeId / type / name / path / order / 时间戳 / 关键词）、序列化与解析。
`src/lib/export.ts` 已在生成 `manifestNodes`，`ExportPlan` 多了必填的 `manifest` 字段。

两条已经定下来的取舍（见 manifest.ts 顶部注释）：清单是附加信息而非必需品，缺失/损坏/版本更高都退回
「按目录结构导入」；对账靠 `path`，不靠顺序、也不把 id 编进文件名。

### 剩余清单

1. **导入侧读清单。** 按 `path` 和包里的文件对账；`nodeId` 只在库里没被占用时复用，让还原后的关键词入口
   接着生效；对不上的条目跳过，清单里没有的文件照常导入。
2. **`tests/export-sink.test.ts` 跟上 `ExportPlan` 的新字段。** 现在类型不过（`manifest` 必填），
   `pnpm typecheck` 是红的 —— 本仓刚补的 ci.yml 会在 PR 上直接拦住。
3. **往返的 e2e 用例。** 导出 zip → 清库 → 导入 → 关键词入口仍然生效、排序和时间戳一致。
   `scripts/e2e.mjs` 里已有导出落盘和导入的分镜可以接着用。
4. **README 更新。** 往返闭合之后，「重要内容请先导出」才算真的是一条可行的建议。

### 之后再议

**全量 JSON 备份 / WebDav 备份。** funlink 和 funotp 都有整套（本地 JSON 备份还原 + WebDav），
fundoc 目前只靠 uTools 的数据同步。等第 1~3 条落地后再看：带清单的 zip 已经能完整往返的话，
再加一套平行的备份格式只是多一份要维护的代码路径。
