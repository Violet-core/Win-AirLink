@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   Win-AirLink
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

:: Проверяем, установлены ли библиотеки (папка node_modules)
if not exist "node_modules\" (
    echo Первый запуск: установка необходимых компонентов...
    echo Это займет несколько секунд (требуется интернет).
    echo.
    call npm.cmd install
    if errorlevel 1 (
        echo.
        echo ОШИБКА: Не удалось установить компоненты.
        echo Проверьте подключение к интернету и запустите start.bat снова.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo Компоненты успешно установлены!
    echo.
)

echo Запускаю сервер...
echo Браузер откроется сам.
echo НЕ ЗАКРЫВАЙТЕ это окно — пока оно открыто, сервер работает.
echo.
node server.js
pause