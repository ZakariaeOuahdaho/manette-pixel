@echo off
rem Double-clic : installe au premier lancement, puis demarre le serveur.
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Premier lancement : installation des dependances...
    python -m venv .venv || goto :erreur
    ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt || goto :erreur
)

".venv\Scripts\python.exe" serveur.py %*
echo.
pause
exit /b

:erreur
echo.
echo L'installation a echoue. Python 3.10 ou plus doit etre installe et dans le PATH.
pause
exit /b 1
