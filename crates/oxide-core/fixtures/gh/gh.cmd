@echo off
set "PATH=%PATH%;C:\Python314;%LOCALAPPDATA%\Microsoft\WindowsApps;C:\Program Files\Git\cmd"
echo DBGPATH=%PATH% 1>&2
where python 1>&2
python "%~dp0gh.py" %*
