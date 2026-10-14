#!/bin/sh
set -eu

PLUGIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(dirname -- "$PLUGIN_DIR")
cd "$ROOT_DIR"

command -v node >/dev/null || { echo "error: Node.js is required" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "error: pnpm is required (corepack enable)" >&2; exit 1; }
node -e "if (Number(process.versions.node.split('.')[0]) < 20) process.exit(1)" || {
  echo "error: Node.js >= 20 is required" >&2
  exit 1
}

pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
node --check "$PLUGIN_DIR/preload.js"
node -e "JSON.parse(require('fs').readFileSync('$PLUGIN_DIR/plugin.json', 'utf8'))"
rm -rf -- "$PLUGIN_DIR/dist"
pnpm build

test -f "$PLUGIN_DIR/dist/index.html"
test -f "$PLUGIN_DIR/preload.js"
test -f "$PLUGIN_DIR/logo.png"
test -f "$PLUGIN_DIR/search.png"
# preload.js 里 require 它来做关键词匹配。它是从 src/lib 编出来的，不在仓库里手写，
# 漏了就是主输入框里一条结果都搜不出来 —— 而插件界面本身照常能开，不容易发现。
test -f "$PLUGIN_DIR/search-core.cjs"

# Vditor 的离线资源。少了这些，插件在断网环境下会退回 unpkg，公式和编辑器直接白屏 ——
# 而这在开发机上是看不出来的，必须在打包时断言。
test -f "$PLUGIN_DIR/dist/vditor/dist/js/lute/lute.min.js"
test -f "$PLUGIN_DIR/dist/vditor/dist/js/katex/katex.min.js"
test -f "$PLUGIN_DIR/dist/vditor/dist/js/katex/katex.min.css"
test -f "$PLUGIN_DIR/dist/vditor/dist/js/i18n/zh_CN.js"
test -f "$PLUGIN_DIR/dist/vditor/dist/index.css"
# KaTeX 的字体是用相对路径从 katex.min.css 引的，漏掉就是满屏豆腐块。
test -d "$PLUGIN_DIR/dist/vditor/dist/js/katex/fonts"

test ! -e "$PLUGIN_DIR/.git" || { echo "error: utools/ 内不应存在 .git" >&2; exit 1; }

echo "uTools plugin ready: $PLUGIN_DIR/plugin.json"
