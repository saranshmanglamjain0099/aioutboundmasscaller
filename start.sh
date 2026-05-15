#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "=== OutboundAI Starting ==="

# In Docker/Coolify, env vars are injected by the runtime.
# .env file is NEVER the source of truth in production.
# Python's load_dotenv(override=False) handles local dev fallback.

echo "Configuration (from VPS environment):"
echo "   LIVEKIT_URL:    ${LIVEKIT_URL:-(not set)}"
echo "   GEMINI_MODEL:   ${GEMINI_MODEL:-gemini-3.1-flash-live-preview}"
echo "   SUPABASE_URL:   ${SUPABASE_URL:-(not set)}"
echo "   OUTBOUND_TRUNK: ${OUTBOUND_TRUNK_ID:-(not set)}"

# Validate critical env vars
if [ -z "$LIVEKIT_URL" ] || [ -z "$LIVEKIT_API_KEY" ] || [ -z "$LIVEKIT_API_SECRET" ]; then
    echo "WARNING: LiveKit credentials not set. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET."
fi
if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_KEY" ]; then
    echo "WARNING: Supabase credentials not set. Set SUPABASE_URL and SUPABASE_SERVICE_KEY."
fi
if [ -z "$GOOGLE_API_KEY" ]; then
    echo "WARNING: GOOGLE_API_KEY not set. Gemini AI will not work."
fi

# Coolify sets PORT env var — use it, or default to 8000
APP_PORT="${PORT:-8000}"
echo "Starting FastAPI server on port ${APP_PORT}..."
uvicorn server:app --host 0.0.0.0 --port "${APP_PORT}" &
SERVER_PID=$!

sleep 2

# Check if server started successfully
if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "ERROR: FastAPI server failed to start!"
    exit 1
fi

echo "Starting LiveKit agent worker..."
python agent.py start
EXIT_CODE=$?

kill $SERVER_PID 2>/dev/null || true
exit $EXIT_CODE
