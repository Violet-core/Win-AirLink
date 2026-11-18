@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   LAN Мессенджер
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден.
  echo.
  echo 1^) Скачайте: https://nodejs.org/
  echo 2^) Установите ^(Next, Next, Finish^)
  echo 3^) Запустите этот файл снова
  echo.
  pause
  exit /b 1
)

echo Запускаю сервер...
echo Браузер откроется сам.
echo НЕ ЗАКРЫВАЙТЕ это окно — пока оно открыто, сервер работает.
echo.
node server.js
pause