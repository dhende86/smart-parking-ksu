#!/bin/bash
echo "Installing KSU Parking dependencies..."
echo ""
echo "[1/2] Python backend..."
cd "$(dirname "$0")/backend"
pip install -r requirements.txt
echo ""
echo "[2/2] Node frontend..."
cd "../frontend"
npm install
echo ""
echo "Done! Run: bash start.sh"
