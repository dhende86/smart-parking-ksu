import sys, os
sys.path.insert(0, os.path.dirname(__file__))
os.chdir(os.path.dirname(__file__))
import uvicorn

if __name__ == "__main__":
    print("\n========================================")
    print("  KSU Parking Backend")
    print("  http://localhost:8000")
    print("  Press Ctrl+C to stop")
    print("========================================\n")
    uvicorn.run("api.main:app", host="0.0.0.0", port=8000, reload=True)
