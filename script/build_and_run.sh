#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
status=$(node src/cli.mjs status)
printf '%s' "$status" | node --input-type=module -e '
let text=""; for await (const chunk of process.stdin) text+=chunk;
if(JSON.parse(text).isRecording) { console.error("Stop or cancel the active recording before rebuilding."); process.exit(1); }
'
node src/cli.mjs quit
sleep 1
node src/cli.mjs shutdown-broker
sleep 1
npm run build
npm run install:app
case "${1:-run}" in
  run|--verify) node src/cli.mjs doctor ;;
  --debug) lldb -- '/Applications/Record Replay.app/Contents/MacOS/RecordReplay' --endpoint-file "${RECORD_REPLAY_HOME:-$HOME/.local/share/record-replay}/endpoint.json" ;;
  --logs|--telemetry)
    node src/cli.mjs doctor
    /usr/bin/log stream --info --style compact --predicate 'process == "RecordReplay"'
    ;;
  *) echo 'Usage: build_and_run.sh [--verify|--debug|--logs|--telemetry]' >&2; exit 2 ;;
esac
