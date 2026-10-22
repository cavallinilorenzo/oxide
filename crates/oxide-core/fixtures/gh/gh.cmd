@echo off
set "PATH=%PATH%;C:\Python314;%LOCALAPPDATA%\Microsoft\WindowsApps;C:\Program Files\Git\cmd"
python "%~dp0gh.py" %*
