@echo off
rem Bildschirm-Test (Prototyp): Bildschirme erkennen und Overlays darauf zeigen
cd /d "%~dp0"
node_modules\electron\dist\electron.exe scripts\screens-test
