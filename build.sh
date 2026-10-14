#!/bin/sh
# FunDoc 的唯一构建入口（同族约定：脚本放仓库根，不在 utools/ 里再放一份）。
#
# 同族项目里曾经两边各放一份，utools/ 下那份随时间失修 —— funchat 的
# utools/build.sh 至今把 PLUGIN_DIR 算成 utools/utools，根本跑不起来。
# 构建脚本只留一个，不给失修留地方。
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR="$ROOT_DIR/utools"          # 打包目录，不含 .git
cd "$ROOT_DIR"

command -v node >/dev/null || { echo "error: Node.js is required" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "error: pnpm is required (corepack enable)" >&2; exit 1; }

node -e "if (Number(process.versions.node.split('.')[0]) < 20) process.exit(1)" || {
  echo "error: Node.js >= 20 is required" >&2
  exit 1
}

# 版本只卡下限，不卡死某一个版本：本机已有的新 pnpm 可以直接用，不必为本项目再装一个。
# 但低于 12 必须拦住 —— lockfile 用的是 pnpm 12 的格式，旧版本读不了。
PNPM_VERSION=$(pnpm --version)
PNPM_MAJOR=${PNPM_VERSION%%.*}
if ! [ "$PNPM_MAJOR" -ge 12 ] 2>/dev/null; then
  echo "error: pnpm >= 12 is required, found $PNPM_VERSION" >&2
  echo "       run: corepack enable  (then pnpm follows package.json#packageManager)" >&2
  exit 1
fi

echo "=== install dependencies ==="
pnpm install --frozen-lockfile

echo "=== lint & typecheck ==="
# 用 lint:check 而不是 lint：后者带 --fix，会在构建过程中改动工作区的源码。
# 构建应当只读源码。
pnpm lint:check
pnpm typecheck

echo "=== test source ==="
pnpm test
node --check "$PLUGIN_DIR/preload.js"
node -e "JSON.parse(require('fs').readFileSync('$PLUGIN_DIR/plugin.json', 'utf8'))"

echo "=== build Vue application ==="
rm -rf -- "$PLUGIN_DIR/dist"
pnpm build

echo "=== verify artifacts ==="
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
