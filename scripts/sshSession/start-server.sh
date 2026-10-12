#!/bin/sh
# Backgrounds the IDE server, waits for it to print its listening port,
# writes the port atomically to a ready file. Run detached.
#
# Args: $1 = tools dir (prepended to PATH), $2 = start command,
#       $3 = log file, $4 = ready file
# Proxy env is inherited from the caller.

export PATH="$1:$PATH"
# nohup so the server survives when this script exits.
nohup sh -c "$2" > "$3" 2>&1 &

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