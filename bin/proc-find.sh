#!/bin/bash
# 在 /proc 里精确找进程。
# 坑：这个容器里 Node 进程的 /proc/<pid>/comm 报的是 "MainThread"（不是 node），
#     所以不能用 comm 判断；也不能只用 cmdline 匹配 —— 脚本自己的 cmdline 里也有同样的字符串，
#     会把自己 kill 掉（实测踩过）。用 /proc/<pid>/exe 指向的可执行文件来判定，最可靠。
# 用法: proc-find.sh node "server/src/index.ts"
want_exe="$1"; want_cmd="$2"
for d in /proc/[0-9]*; do
  pid="${d#/proc/}"
  [ "$pid" = "$$" ] && continue
  exe=$(readlink -f "$d/exe" 2>/dev/null) || continue
  case "$exe" in */"$want_exe") ;; *) continue ;; esac
  [ -r "$d/cmdline" ] || continue
  cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)
  case "$cmd" in *"$want_cmd"*) echo "$pid" ;; esac
done
