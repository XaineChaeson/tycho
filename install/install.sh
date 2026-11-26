#!/usr/bin/env bash
# tycho 的安装脚本（Linux、macOS）。
#
#   curl -fsSL <地址>/install.sh | bash
#   bash install.sh --from <发布包文件或已解开的目录>     # 离线安装
#
# 不需要 root，不问问题，重复运行是安全的。以谁的身份运行，就装给谁、用谁的登录和密钥。
# 它只做两件事：把发布包解到 <程序目录>/versions 下，找到（或下载）一个发布包要求的
# Node；其余（版本目录、启动器、PATH）由发布包自己的 install-self 完成，升级时走的是
# 同一段代码。需要的最低 Node 版本不写在这里：它只在发布包的 package.json 里声明
# （engines.node），所以先解包、再找 Node。
#
# 可以用环境变量改的：
#   TYCHO_PREFIX          程序目录，默认 ~/.tycho/app
#   TYCHO_RELEASE_URL     发布包的下载地址
#   TYCHO_NODE_DIST_URL   从哪里下载 Node 的包（可以换成镜像）。镜像只提供包本身：
#                         包的校验值一律取自 nodejs.org，镜像换了包就装不上
#   TYCHO_NO_MODIFY_PATH  设了就不改 shell 的启动文件
#
# 测试用，平时不要设：
#   TYCHO_NODE_SUMS_URL   Node 校验文件（SHASUMS256.txt）的地址。设它等于换掉信任根：
#                         这个地址说哪个包是对的，装上的就是哪个包
set -euo pipefail

RELEASE_URL="${TYCHO_RELEASE_URL:-https://github.com/XaineChaeson/tycho/releases/latest/download/tycho.tar.gz}"
NODE_DIST_URL="${TYCHO_NODE_DIST_URL:-https://nodejs.org/dist/latest-v24.x}"
NODE_SUMS_URL="${TYCHO_NODE_SUMS_URL:-https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt}"
# 发布包要求的最低 Node 版本，解包后从它的 package.json 读出。
MIN_NODE=""

# 中途退出时要收拾掉的两处临时内容。
SCRATCH=""
STAGE=""
cleanup() {
  [ -z "$SCRATCH" ] || rm -rf "$SCRATCH"
  [ -z "$STAGE" ] || rm -rf "$STAGE" "$STAGE.tar.gz"
}
trap cleanup EXIT

fail() {
  echo "tycho 安装没有完成：$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "这台机器上没有 $1，请先装上它。"
}

# 解包之前看一遍包里有什么：每个成员都得是普通文件或目录，而且落在解包目录之内。
# 不靠 tar 自己拦：不同的 tar、不同的版本拦的不一样。
# $1 包所在的目录，$2 包在那里的名字，$3 给主人看的来源。
check_archive() {
  local names kinds bad
  names="$(cd "$1" && LC_ALL=C tar -tzf "$2" 2>/dev/null)" || fail "读不出 $3 里有什么：它不是 .tar.gz，或者已经损坏。"
  bad="$(printf '%s\n' "$names" | LC_ALL=C awk '!found && (/^\// || /^[A-Za-z]:/ || /\\/ || /(^|\/)\.\.(\/|$)/) { print; found = 1 }')" || true
  [ -z "$bad" ] || fail "$3 里有会落到解包目录之外的成员（$bad），没有解开它，什么都没装。"
  # 每行的第一个字符是成员的类型：- 普通文件，d 目录，l 符号链接，h 硬链接。
  kinds="$(cd "$1" && LC_ALL=C tar -tzvf "$2" 2>/dev/null)" || fail "读不出 $3 里有什么：它不是 .tar.gz，或者已经损坏。"
  bad="$(printf '%s\n' "$kinds" | LC_ALL=C awk '!found && !/^[-d]/ { print; found = 1 }')" || true
  [ -z "$bad" ] || fail "$3 里有不是普通文件或目录的成员（符号链接、硬链接或特殊文件：$bad），没有解开它，什么都没装。"
}

# 发布包声明的最低 Node 版本：package.json 里 engines.node 的 ">=24.3.0" 这一类。
required_node() {
  local found
  found="$(sed -n 's/^.*"node"[[:space:]]*:[[:space:]]*">=[[:space:]]*\([0-9][0-9.]*\)".*$/\1/p' "$1/package.json" | head -n 1)" || true
  [[ "$found" =~ ^[0-9]+(\.[0-9]+)?(\.[0-9]+)?$ ]] || return 1
  printf '%s\n' "$found"
}

# 版本 $1 是不是不低于 $2。两者都是“主.次.修订”，缺的段按 0。
at_least() {
  local have="${1%%-*}" h1 h2 h3 n1 n2 n3 rest
  case "$have" in '' | *[!0-9.]*) return 1 ;; esac
  IFS=. read -r h1 h2 h3 rest <<<"$have"
  IFS=. read -r n1 n2 n3 rest <<<"$2"
  h1="${h1:-0}" h2="${h2:-0}" h3="${h3:-0}" n1="${n1:-0}" n2="${n2:-0}" n3="${n3:-0}"
  if [ "$h1" -ne "$n1" ]; then [ "$h1" -gt "$n1" ]; return; fi
  if [ "$h2" -ne "$n2" ]; then [ "$h2" -gt "$n2" ]; return; fi
  [ "$h3" -ge "$n3" ]
}

# 这个 node 够不够新。够的话输出它的绝对路径。
qualified_node() {
  local candidate="$1" have
  have="$("$candidate" -p 'process.versions.node' 2>/dev/null)" || return 1
  at_least "$have" "$MIN_NODE" || return 1
  "$candidate" -p 'process.execPath'
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    fail "这台机器上没有 sha256sum 也没有 shasum，没法校验下载的 Node。请先自己装好 Node $MIN_NODE 或更新的版本。"
  fi
}

# 把官方的 Node 下载到 <程序目录>/node，校验通过、版本也够才留下。
download_node() {
  local prefix="$1" os arch sums line sha name actual fresh
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "不认识的系统 $(uname -s)。请先自己装好 Node $MIN_NODE 或更新的版本。" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "Node 官方没有给 $(uname -m) 的现成发行版。请先自己装好 Node $MIN_NODE 或更新的版本。" ;;
  esac
  # 官方发行版是给 glibc 编的。
  if [ "$os" = linux ] && [ -n "$(ls /lib/ld-musl-* 2>/dev/null)" ]; then
    fail "这是 musl 系统（比如 Alpine），Node 官方的发行版在这里跑不了。请先用系统的包管理器装好 Node $MIN_NODE 或更新的版本。"
  fi
  need curl
  echo "没有找到 Node $MIN_NODE 或更新的版本，下载一份放到 $prefix/node（只给 tycho 用）。"
  # 哪个包是对的，只听官方的；镜像只管把包送来。
  sums="$(curl -fsSL "$NODE_SUMS_URL")" || fail "下载 $NODE_SUMS_URL 没成功。"
  line="$(printf '%s\n' "$sums" | grep -E "^[0-9a-f]{64} +node-v[0-9.]+-$os-$arch\.tar\.gz\$" | head -n 1)" || true
  [ -n "$line" ] || fail "$NODE_SUMS_URL 里没有给 $os-$arch 的包。"
  sha="${line%% *}"
  name="${line##* }"
  SCRATCH="$(mktemp -d "$prefix/.node-download-XXXXXX")"
  curl -fsSL -o "$SCRATCH/$name" "$NODE_DIST_URL/$name" || fail "下载 $NODE_DIST_URL/$name 没成功。"
  actual="$(sha256_of "$SCRATCH/$name")"
  [ "$actual" = "$sha" ] || fail "下载的 $name 校验不过（官方给的是 $sha，实际 $actual），没有安装它。"
  (cd "$SCRATCH" && tar -xzf "$name") || fail "解不开下载的 $name。"
  fresh="$SCRATCH/${name%.tar.gz}/bin/node"
  qualified_node "$fresh" >/dev/null || fail "下载到的 $name 低于 tycho 要求的 Node $MIN_NODE，或者在这台机器上运行不了，没有安装它。"
  mkdir -p "$prefix/node/bin"
  cp "$fresh" "$prefix/node/bin/.node.$$"
  chmod 755 "$prefix/node/bin/.node.$$"
  mv -f "$prefix/node/bin/.node.$$" "$prefix/node/bin/node"
}

main() {
  local from="" prefix node=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --from)
        [ $# -ge 2 ] || fail "--from 后面要跟发布包文件或已解开的目录。"
        from="$2"
        shift 2
        ;;
      -h | --help)
        echo "用法：bash install.sh [--from <发布包文件或已解开的目录>]"
        echo "环境变量：TYCHO_PREFIX（程序目录，默认 ~/.tycho/app）、TYCHO_RELEASE_URL、TYCHO_NODE_DIST_URL、TYCHO_NO_MODIFY_PATH"
        exit 0
        ;;
      *) fail "不认识的参数：$1（只有 --from <发布包文件或已解开的目录>）。" ;;
    esac
  done

  # Bootstrap runs before Node exists, so it must reject test defaults itself.
  if { [ -n "${NODE_TEST_CONTEXT:-}" ] || [ -n "${TYCHO_TEST_GUARD:-}" ]; } && [ -z "${TYCHO_PREFIX:-}" ]; then
    fail "测试里没有设 TYCHO_PREFIX：不能使用主目录下的默认程序目录。"
  fi
  prefix="${TYCHO_PREFIX:-$HOME/.tycho/app}"
  need tar
  mkdir -p "$prefix/versions"
  prefix="$(cd "$prefix" && pwd)"

  # 名字里带上这个脚本的进程号：别的安装在清理时，认得出这份暂存区的主人还活着。
  STAGE="$(mktemp -d "$prefix/versions/.staging-$$-XXXXXX")"
  if [ -n "$from" ] && [ -d "$from" ]; then
    cp -R "$from"/. "$STAGE"/
  else
    if [ -z "$from" ]; then
      need curl
      echo "正在下载 $RELEASE_URL"
      curl -fsSL -o "$STAGE.tar.gz" "$RELEASE_URL" || fail "下载 $RELEASE_URL 没成功。"
      from="$RELEASE_URL"
    elif [ -f "$from" ]; then
      cp "$from" "$STAGE.tar.gz"
    else
      fail "找不到 $from。"
    fi
    # 用相对 versions 目录的名字：tar 会把带冒号的路径当成远程主机上的文件。
    check_archive "$prefix/versions" "${STAGE##*/}.tar.gz" "$from"
    (cd "$prefix/versions" && tar -xzf "${STAGE##*/}.tar.gz" -C "${STAGE##*/}") || fail "解不开 $from。"
  fi
  if [ ! -f "$STAGE/cli/main.ts" ] || [ ! -f "$STAGE/package.json" ]; then
    fail "$from 不是 tycho 的发布包。"
  fi
  MIN_NODE="$(required_node "$STAGE")" || fail "$from 的 package.json 里读不出它要求的 Node 版本（engines.node 应是 \">=24.3.0\" 这样的写法）。"

  # 先用 PATH 里的，其次是上次自己下载的那一份，都不行才下载。
  if command -v node >/dev/null 2>&1; then
    node="$(qualified_node "$(command -v node)")" || node=""
  fi
  if [ -z "$node" ] && [ -x "$prefix/node/bin/node" ]; then
    node="$(qualified_node "$prefix/node/bin/node")" || node=""
  fi
  if [ -z "$node" ]; then
    download_node "$prefix"
    node="$(qualified_node "$prefix/node/bin/node")" || fail "下载的 Node 在这台机器上运行不了。"
  fi

  "$node" "$STAGE/cli/main.ts" install-self --prefix "$prefix" --node "$node"
}

main "$@"
