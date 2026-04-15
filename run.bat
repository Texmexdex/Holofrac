@echo off
call venv\Scripts\activate.bat
echo Starting HTTPS Server for WebXR...
python server.py
pause
