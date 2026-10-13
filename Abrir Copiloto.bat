@echo off
rem Liga o Copiloto Ui24R e abre o painel no navegador.
title Abrindo o Copiloto Ui24R
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\copiloto.ps1" abrir
if errorlevel 1 pause
timeout /t 2 >nul
