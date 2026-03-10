@echo off
node -v >nul 2>&1
if %errorlevel% equ 0 (
    echo Starting local server at http://localhost:8082 (Node.js)
    echo Press Ctrl+C to stop
    call node server.js
    goto :eof
)

echo Node.js not found. Starting PowerShell server from server.ps1...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Server failed to start.
)
pause
