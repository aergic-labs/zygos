#!/bin/sh
# Backgrounds the IDE server, waits for it to print its listening port,
# writes the port atomically to a ready file. Run detached.
#
# Args: $1 = tools dir (prepended to PATH for this script's own commands),
#       $2 = start command, $3 = log file, $4 = ready file
# Proxy env is inherited from the caller.

# nohup so the server survives when this script exits. Launched before the
# PATH prepend below so the server inherits the caller's PATH, not our
# busybox polyfill: busybox applets shadow system coreutils in the server
# and the terminals/tasks it parents (zygos issue #5: BusyBox `readlink`
# lacks `-e` and clobbers coreutils `readlink -e`).
nohup sh -c "$2" > "$3" 2>&1 &

# Prepend the tools dir for this script's own commands (grep, tail, sleep,
# mv) in the poll loop below.
export PATH="$1:$PATH"

i=0
while [ "$i" -lt 60 ]; do
  line=$(grep 'Extension host agent listening on' "$3" 2>/dev/null | tail -1)
  if [ -n "$line" ]; then
    port=${line##* }
    if [ -n "$port" ]; then
      tmp="$4.tmp"
      echo "$port" > "$tmp" && mv "$tmp" "$4"
      exit 0
    fi
  fi
  sleep 1
  i=$((i + 1))
done
exit 1