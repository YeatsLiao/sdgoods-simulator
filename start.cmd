@echo off
python "%~dp0server\serve.py" %*
if errorlevel 1 pause
