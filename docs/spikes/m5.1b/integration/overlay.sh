#!/bin/bash
# Copies the spike overlay (stored as *.txt so the project typecheck ignores it) into src/ (install) or removes it again (remove).
# The two embedder variants are generated from the committed src/lib/semantic/embedder.ts
# with only its `new Worker(...)` line replaced:
#   source:  new Worker(/* turbopackIgnore: true */ opts.workerUrl!, ...)  (Node loads worker.ts itself)
#   bundled: new Worker(new URL("./worker.ts", import.meta.url), ...)      (Turbopack bundles the worker)
# Refuses to overwrite an existing file; remove deletes only the overlay's own paths.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
copied="src/instrumentation.ts src/app/api/spike-embed/route.ts src/lib/semantic/spike-host.ts"
generated="src/lib/semantic/spike-embedder-source.ts src/lib/semantic/spike-embedder-bundled.ts src/lib/semantic/spike-process-embedder.ts"
line='    const worker = new Worker(opts.workerUrl ?? new URL("./worker.ts", import.meta.url), { workerData });'
case "${1:-}" in
  install)
    for f in $copied $generated; do [ ! -e "$f" ] || { echo "exists: $f" >&2; exit 1; }; done
    [ "$(grep -cxF "$line" src/lib/semantic/embedder.ts)" = 1 ] || { echo "embedder.ts Worker line changed" >&2; exit 1; }
    for f in $copied; do mkdir -p "$(dirname "$f")"; cp "docs/spikes/m5.1b/integration/overlay/$f.txt" "$f"; done
    awk -v l="$line" '$0 == l { print "    const worker = new Worker(/* turbopackIgnore: true */ opts.workerUrl!, { workerData });"; next } { print }' \
      src/lib/semantic/embedder.ts > src/lib/semantic/spike-embedder-source.ts
    awk -v l="$line" '$0 == l { print "    const worker = new Worker(new URL(\"./worker.ts\", import.meta.url), { workerData });"; next } { print }' \
      src/lib/semantic/embedder.ts > src/lib/semantic/spike-embedder-bundled.ts
    # The child-process client (shutdown comparison), with its imports pointed at src/lib/semantic.
    sed 's|"../../../../src/lib/semantic/|"./|' docs/spikes/m5.1b/shutdown/process-embedder.ts > src/lib/semantic/spike-process-embedder.ts
    echo "installed" ;;
  remove)
    for f in $copied $generated; do rm -f "$f"; done
    rmdir src/app/api/spike-embed 2>/dev/null || true
    echo "removed" ;;
  *) echo "usage: overlay.sh install|remove" >&2; exit 2 ;;
esac
