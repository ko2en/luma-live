@echo off
title LUMA Live
cd /d "%~dp0"

echo.
echo   ============================================
echo     LUMA Live  直播间  (本地版)
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NONODE

for /f "delims=v. tokens=1" %%A in ('node -v') do set "MAJOR=%%A"
if not defined MAJOR goto NONODE
if %MAJOR% LSS 18 goto OLDNODE

echo   [OK] Node.js 版本正常
node -v
echo.

echo   开播台   http://localhost:3000/studio
echo   观众页   http://localhost:3000/
echo.
echo   浏览器会在 2 秒后自动打开。
echo   关掉这个黑窗口 就等于 停止直播。
echo   首次运行如弹出防火墙提示，请勾选“专用网络”并允许。
echo.

start "" /min cmd /c "ping -n 3 127.0.0.1 >nul && start http://localhost:3000/studio"

node server.js

echo.
echo   [已停止] 服务已关闭，可以关掉本窗口了。
pause
exit /b 0

:NONODE
echo   [X] 没有找到 Node.js
echo.
echo       本项目需要 Node.js 18 以上版本。装一次，以后都不用再装。
echo       已经帮你打开下载页，请下载 LTS 版本，一路“下一步”即可。
echo.
start "" https://nodejs.org/zh-cn/download
pause
exit /b 1

:OLDNODE
echo   [X] Node.js 版本太旧，需要 18 以上
echo.
echo       当前版本：
node -v
echo.
echo       请到 https://nodejs.org/zh-cn/download 下载新版覆盖安装。
echo.
start "" https://nodejs.org/zh-cn/download
pause
exit /b 1
