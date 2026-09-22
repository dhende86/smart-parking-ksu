#!/bin/bash
ROOT="$(cd "$(dirname "$0")" && pwd)"
echo "Starting KSU Parking System..."
cd "$ROOT/backend" && python run.py &
sleep 3
cd "$ROOT/frontend" && npm run dev &
echo ""
echo "Open http://localhost:5173"
echo "Debug: http://localhost:5173/debug"
wait
