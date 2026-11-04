@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   需求发版管理 v2 - 拉取最新代码
echo ============================================
echo.
git pull --ff-only
if errorlevel 1 goto failed
echo.
echo 更新完成。若上面显示 server.js 有改动，请关掉服务窗口、重跑 start-server.bat，再刷新页面。
goto end

:failed
echo.
echo 拉取失败，常见原因：
echo   1. 还没登录 GitHub —— 私有仓库必须登录。按提示在浏览器里登录后，再运行一次本脚本。
echo   2. 本地有未提交的改动 —— 先 git stash 或提交，再更新。
echo   3. 没装 git —— 先安装 Git for Windows 并确保 git 在 PATH 里。

:end
echo.
pause
