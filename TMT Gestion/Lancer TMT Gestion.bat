@echo off
rem TMT Gestion - lance le serveur local puis ouvre l'application dans Edge
chcp 65001 >nul
title TMT Gestion - serveur (ne pas fermer)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto pasdenode
set OUVRIR=--ouvrir
if /i "%~1"=="/demarrage" set OUVRIR=
node --no-warnings "%~dp0serveur\server.js" %OUVRIR%
if errorlevel 1 pause
exit /b
:pasdenode
echo.
echo   Node.js n'est pas installe sur cet ordinateur.
echo   Installez la version LTS depuis https://nodejs.org puis relancez TMT Gestion.
echo   (voir LISEZMOI.txt, etape 1)
echo.
start "" "https://nodejs.org/fr/download"
pause
