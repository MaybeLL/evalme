#!/bin/sh
set -eu
# Select an existing runtime without changing shell configuration or default Node.
if [ "${1-}" = "--source" ]; then
  [ "$#" -eq 2 ] || { echo 'Usage: install.sh [--source /absolute/repository-or-package]' >&2; exit 2; }
  evalme_source=$2
else
  [ "$#" -eq 0 ] || { echo 'Usage: install.sh [--source /absolute/repository-or-package]' >&2; exit 2; }
  evalme_source=
fi
evalme_node=${EVALME_NODE:-node}
command -v "$evalme_node" >/dev/null 2>&1 || { echo '请先安装 Node 22.16+ 或 24.x；已有运行时可用 EVALME_NODE 指定绝对路径。' >&2; exit 2; }
"$evalme_node" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(!((a===22&&b>=16)||a===24)){console.error("需要 Node 22.16+（22.x）或 24.x；不会自动修改默认 Node。");process.exit(2)}'
if [ -n "$evalme_source" ]; then
  if [ -f "$evalme_source/mvp/scripts/install.mjs" ]; then evalme_source="$evalme_source/mvp"; fi
  exec "$evalme_node" "$evalme_source/scripts/install.mjs" --source "$evalme_source"
fi
command -v curl >/dev/null 2>&1 || { echo '需要 curl。' >&2; exit 2; }
evalme_download=$(mktemp -d)
trap 'rm -r "$evalme_download"' EXIT HUP INT TERM
curl --fail --location --connect-timeout 15 --max-time 120 --silent --show-error \
  https://codeload.github.com/MaybeLL/evalme/tar.gz/refs/heads/main -o "$evalme_download/source.tgz"
tar -xzf "$evalme_download/source.tgz" -C "$evalme_download"
"$evalme_node" "$evalme_download/evalme-main/mvp/scripts/install.mjs" --source "$evalme_download/evalme-main/mvp"
