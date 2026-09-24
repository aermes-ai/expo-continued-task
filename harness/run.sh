#!/bin/bash
# Drives ContinuedTask.swift's REAL code through submit → launch → expiry / end against a fake
# BackgroundTasks (Stubs.swift), on a booted iOS simulator (the rule under test: never "Failed").
#
# The iOS 26 lines need Xcode 26 to compile and a device to run; here the file is rewritten so
# they build on any Xcode: `import BackgroundTasks` dropped for the stubs, `#if compiler(>=6.2)`
# and `#available(iOS 26.0, *)` made true. Nothing else about the file changes.
#
#   harness/run.sh [simulator-udid]   (default: the first booted one)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ios="$here/../ios"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
sed -e 's/^import BackgroundTasks$//' \
    -e 's/#if compiler(>=6.2)/#if true/' \
    -e 's/if #available(iOS 26.0, \*), /if /' \
    -e 's/if #available(iOS 26.0, \*) {/if true {/' \
    "$ios/ContinuedTask.swift" > "$out/ContinuedTask.swift"
# A private module cache: a shared one races any xcodebuild running alongside.
xcrun --sdk iphonesimulator swiftc -target arm64-apple-ios17.0-simulator \
  -module-cache-path "$out/mc" -o "$out/harness" \
  "$here/main.swift" "$here/Stubs.swift" "$out/ContinuedTask.swift" \
  "$ios/ContinuedTaskConfig.swift" "$ios/DebugLog.swift" "$ios/DebugLogLifecycle.swift"
udid="${1:-$(xcrun simctl list devices booted | grep -Eo '[0-9A-F-]{36}' | head -1)}"
[ -n "$udid" ] || { echo "no booted simulator" >&2; exit 2; }
xcrun simctl spawn "$udid" "$out/harness"
