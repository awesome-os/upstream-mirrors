#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
# On the Mac host: create a pty for `tart run --serial-path`, write its name to argv[1] and append
# everything the guest writes to its console to argv[2]. Output survives a guest hang.
import os, sys, tty
m, s = os.openpty()
tty.setraw(s)
with open(sys.argv[1], "w") as f:
    f.write(os.ttyname(s))
out = open(sys.argv[2], "ab", 0)
while True:
    try:
        d = os.read(m, 65536)
    except OSError:
        break
    if not d:
        break
    out.write(d)
