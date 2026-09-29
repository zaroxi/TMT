@echo off
rem Mot de passe oublie : donne un nouveau mot de passe a un compte (sur l'ordinateur principal)
chcp 65001 >nul
title TMT Gestion - mot de passe oublie
cd /d "%~dp0"
node --no-warnings "%~dp0serveur\server.js" --mot-de-passe-oublie
pause
