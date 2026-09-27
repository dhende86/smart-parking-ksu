# Smart Parking KSU

**Regional winner and national finalist, Bank of America Code-a-Thon 2026.**

Real time parking lot occupancy for Kennesaw State. Point it at a camera feed and it shows which spots are open or taken, live, using YOLOv8 object detection and ByteTrack tracking.

<!-- Demo GIF: record the dashboard with spots turning red/green, save as docs/demo.gif, then uncomment:
![Smart Parking dashboard demo](docs/demo.gif)
-->

## How it works

```
Camera feed (RTSP / IP camera / YouTube)
        │
        ▼
YOLOv8 vehicle detection  ──►  ByteTrack IDs (cars keep the same ID across frames)
        │
        ▼
Spot matching: car box vs. spot polygon overlap
        │   a spot only flips after 3 frames in a row agree (no flicker)
        ▼
FastAPI backend  ──►  Server Sent Events (/stream)  ──►  React dashboard
```

- **Detection:** YOLOv8 finds cars, motorcycles, buses and trucks in each frame.
- **Tracking:** ByteTrack gives each car a stable ID, wrapped in a permanent ID so a car that is hidden for a few frames keeps its spot.
- **Multi frame confirmation:** a spot changes status only after 3 consecutive frames agree, and a taken spot is released only after the car has been gone for a set time.
- **Live updates:** the backend pushes occupancy changes over Server Sent Events, so the dashboard updates without refreshing. The annotated video is streamed as MJPEG.
- **Polygon editor:** draw each parking spot once on a still frame; coordinates are stored normalized, so they work at any video resolution.

## Stack

- **Backend:** Python, FastAPI, OpenCV, YOLOv8 (Ultralytics), ByteTrack
- **Frontend:** React + Vite
- **Video:** RTSP, IP cameras, and YouTube URLs

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
