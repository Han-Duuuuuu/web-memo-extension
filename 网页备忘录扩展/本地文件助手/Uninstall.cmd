@echo off
chcp 65001 >nul
setlocal
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.webmemo.localfiles" /f
echo.
echo Local helper disconnected. Original files and link records are preserved.
echo Program and data folders are on the first available drive:
if exist "D:\" goto showD
if exist "E:\" goto showE
goto showC
:showD
echo   D:\网页备忘录助手
echo   D:\网页备忘录数据
goto done
:showE
echo   E:\网页备忘录助手
echo   E:\网页备忘录数据
goto done
:showC
echo   %LOCALAPPDATA%\WebMemoLocalFiles
:done
echo.
pause
