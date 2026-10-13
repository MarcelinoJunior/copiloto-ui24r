@echo off
rem Cria os atalhos "Abrir Copiloto" e "Fechar Copiloto" (com icone) na area de trabalho.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\copiloto.ps1" atalhos
pause
