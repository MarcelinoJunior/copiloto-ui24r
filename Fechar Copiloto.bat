@echo off
rem Desliga o Copiloto Ui24R.
title Fechando o Copiloto Ui24R
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\copiloto.ps1" fechar
if errorlevel 1 pause
timeout /t 2 >nul
