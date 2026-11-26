#!/bin/sh
# Stands in for a CLI that is running but no longer reads its input, where there is a
# POSIX shell; fake-claude-no-stdin.ps1 is the same part on Windows.
#
# FAKE_CLAUDE_CLOSED      file created once stdin is closed
# FAKE_CLAUDE_READ_FIRST  take one line before closing, so that a turn is in progress
if [ -n "$FAKE_CLAUDE_READ_FIRST" ]; then read -r _line; fi
exec 0<&-
: > "$FAKE_CLAUDE_CLOSED"
# A child, as a real CLI has: it carries the marker only in the environment it inherited.
while :; do sleep 60; done
