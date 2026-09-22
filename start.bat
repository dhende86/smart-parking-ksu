@echo off
echo Starting KSU Parking System...
start "Backend" cmd /k "cd /d %~dp0backend && python run.py"
timeout /t 3 /nobreak >nul
start "Frontend" cmd /k "cd /d %~dp0frontend && npm run dev"
echo.
echo Open http://localhost:5173 in your browser
echo Debug console: http://localhost:5173/debug
pause
