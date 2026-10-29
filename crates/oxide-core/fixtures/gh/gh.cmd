@echo off
rem Tests append the runner's PATH, which already has Python. Only when it doesn't, add the usual
rem locations. Never expand %PATH% otherwise: cargo puts many build directories on it in tests and
rem cmd.exe silently expands a value over about 8191 characters to nothing.
where python >nul 2>nul && goto run
set "PATH=%PATH%;C:\Python314;%LOCALAPPDATA%\Microsoft\WindowsApps;C:\Program Files\Git\cmd"
:run
python "%~dp0gh.py" %*
