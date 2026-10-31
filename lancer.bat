@echo off
rem Double-clic : installe ce qui manque (Python, dependances), puis demarre le serveur.
rem Le pilote de manette et adb sont installes par serveur.py lui-meme au premier lancement.
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Manette Pixel

rem Lance depuis l'apercu d'un .zip, Windows travaille dans un dossier temporaire : rien ne marcherait.
echo "%~dp0" | find /i "\AppData\Local\Temp\" >nul && goto :depuis_zip

rem L'installation existante est-elle complete et a jour ?
if exist ".venv\Scripts\python.exe" (
    fc /b requirements.txt ".venv\requirements.txt" >nul 2>&1 || goto :installer
    ".venv\Scripts\python.exe" -c "import aiohttp, qrcode, importlib.util as u; assert u.find_spec('vgamepad')" >nul 2>&1 || goto :installer
    goto :lancer
)

:installer
call :trouver_python
if not defined PYTHON (
    echo Python n'est pas installe sur ce PC : installation automatique ^(1 a 2 min^)...
    where winget >nul 2>&1 || goto :sans_python
    winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements
    call :trouver_python
)
if not defined PYTHON goto :sans_python

echo Installation des composants ^(une seule fois, environ 1 min^)...
if exist .venv rmdir /s /q .venv
%PYTHON% -m venv .venv || goto :erreur_installation
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt || goto :erreur_installation
copy /y requirements.txt ".venv\requirements.txt" >nul
echo Installation terminee.

:lancer
".venv\Scripts\python.exe" serveur.py %*
echo.
echo Le serveur est arrete : la manette ne repond plus tant que lancer.bat n'est pas relance.
pause
exit /b


:trouver_python
rem Python 3.10 a 3.14 : les versions plus recentes n'ont pas toujours les paquets precompiles.
set "PYTHON="
for %%v in (3.13 3.12 3.11 3.10 3.14) do (
    if not defined PYTHON py -%%v -c "pass" >nul 2>&1 && set "PYTHON=py -%%v"
)
if not defined PYTHON python -c "import sys; sys.exit(not (3, 10) <= sys.version_info < (3, 15))" >nul 2>&1 && set "PYTHON=python"
rem Juste apres winget, le PATH de cette fenetre n'est pas a jour : on regarde a la main.
for %%v in (313 312 311 310 314) do (
    if not defined PYTHON if exist "%LOCALAPPDATA%\Programs\Python\Python%%v\python.exe" set "PYTHON="%LOCALAPPDATA%\Programs\Python\Python%%v\python.exe""
)
exit /b

:depuis_zip
echo Tu as lance lancer.bat depuis l'interieur du fichier .zip.
echo Fais d'abord un clic droit sur le .zip, puis "Extraire tout...",
echo et lance lancer.bat depuis le dossier extrait.
pause
exit /b 1

:sans_python
echo.
echo Python n'a pas pu etre installe automatiquement.
echo Installe Python 3.12 depuis https://www.python.org/downloads/
echo en cochant "Add python.exe to PATH", puis relance lancer.bat.
start "" https://www.python.org/downloads/
pause
exit /b 1

:erreur_installation
echo.
echo L'installation a echoue. Verifie que le PC a acces a Internet, puis relance lancer.bat.
echo Si ca recommence, supprime le dossier .venv et relance.
pause
exit /b 1
