@echo off
echo Installing KSU Parking dependencies...
echo.
echo [1/2] Python backend...
cd /d %~dp0backend
pip install -r requirements.txt
echo.
echo [2/2] Node frontend...
cd /d %~dp0frontend
npm install
echo.
echo Done! Now double-click start.bat to run.
pause
