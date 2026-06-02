#!/bin/zsh
set -e

cd "$(dirname "$0")"

PORT="${GEMSYNC_MANAGER_PORT:-5188}"
mkdir -p logs

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Run setup-mac.command first, or install Node 20+."
  read "?Press Enter to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing app dependencies..."
  npm install
fi

echo "Starting DeckSync..."
GEMSYNC_MANAGER_PORT="$PORT" npm start > logs/manager.out.log 2> logs/manager.err.log &
SERVER_PID=$!

echo "Waiting for DeckSync to open..."
FOUND_PORT=""
for attempt in {1..80}; do
  for candidate in $(seq "$PORT" "$(($PORT + 99))"); do
    if curl -fsS "http://127.0.0.1:${candidate}/api/state" >/dev/null 2>&1; then
      FOUND_PORT="$candidate"
      break
    fi
  done
  if [ -n "$FOUND_PORT" ]; then
    break
  fi
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    echo "DeckSync failed to start. See logs/manager.err.log."
    read "?Press Enter to close..."
    exit 1
  fi
  sleep 0.25
done

if [ -z "$FOUND_PORT" ]; then
  echo "DeckSync started, but the page did not answer in time. Try http://127.0.0.1:${PORT}"
else
  open "http://127.0.0.1:${FOUND_PORT}"
  echo "DeckSync is running at http://127.0.0.1:${FOUND_PORT}"
fi

echo "Keep this Terminal window open while using DeckSync."
wait "$SERVER_PID"
