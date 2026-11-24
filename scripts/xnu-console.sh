#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-only
# On the Mac host, with the VM running and XNU loaded with CONSOLE_IN=/var/tmp/console-in: an interactive terminal on
# XNU's /dev/console. Output: the "darwin console:" lines of the captured serial log; input: each line typed here is
# appended to the console input file in the VM.
P=$(cd "$(dirname "$0")/.." && pwd); LOG=${LOG:-$P/../serial-cap.log}
tail -n 0 -F "$LOG" | tr -d '\r' | sed -un 's/^\[ *[0-9.]*\] fki: darwin console: //p' &
TP=$!; trap 'kill $TP 2>/dev/null' EXIT
while IFS= read -r line; do
  printf '%s\n' "$line" | bash "$P/scripts/vm.sh" 'cat >> /var/tmp/console-in'
done
