# KSU Parking System

Real-time parking lot occupancy tracker built for KSU. Point it at a camera feed and it shows you which spots are open or taken using YOLOv8 object detection.

## Stack

- **Backend:** Python, FastAPI, OpenCV, YOLOv8
- **Frontend:** React + Vite
- **Video:** supports RTSP, IP cameras, and YouTube URLs

## Setup

**Requires:** Python 3.10+ and Node.js 18+

```bash
# install dependencies
bash install.sh   # or install.bat on Windows

# run
bash start.sh     # or start.bat on Windows
```

Then open http://localhost:5173

## How to use

1. Go to `/editor`, upload a still frame from your camera
2. Draw polygons over each parking spot and save
3. Back on the dashboard, paste your stream URL and hit Start
4. Spots turn red when taken and green when open

## Pages

| URL | What it is |
|---|---|
| `localhost:5173` | Live dashboard |
| `localhost:5173/editor` | Polygon editor |
| `localhost:5173/debug` | Backend log viewer |
| `localhost:8000/docs` | API docs |
