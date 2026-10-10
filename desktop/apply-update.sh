#!/bin/sh
# Quiet AI update hand-over (macOS). Started by updater.js from a temporary folder.
# Waits for Quiet AI to quit, swaps the app bundle for the new one, then reopens it.
# Arguments: <pid> <new Quiet AI.app> <installed Quiet AI.app> <log file>
pid="$1"; new="$2"; target="$3"; log="$4"
note(){ printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S)" "$1" >> "$log" 2>/dev/null; }
note "Update: waiting for Quiet AI ($pid) to quit."
i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 120 ]; do sleep 0.5; i=$((i+1)); done
sleep 1
old="$target.previous"
rm -rf "$old"
if mv "$target" "$old" && mv "$new" "$target"; then
  xattr -dr com.apple.quarantine "$target" 2>/dev/null
  rm -rf "$old"
  note "Update: app replaced."
else
  note "Update failed: could not replace $target."
  [ -d "$target" ] || mv "$old" "$target"
fi
open "$target"
sleep 5
rm -rf "$(dirname "$(dirname "$new")")"
