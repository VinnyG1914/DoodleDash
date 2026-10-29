@echo off
rem Put your own pictures in the avatars\custom folder, then double-click this file.
cd /d "%~dp0"
python tools\build_avatars.py
echo.
echo Now upload the TeamQuiz folder to Netlify again so players see the new avatars.
pause
