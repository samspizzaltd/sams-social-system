@echo off
REM Sam's Autonomous Social Media System - Local Startup Script (Windows)
REM This script starts both backend and frontend servers

echo.
echo ╔════════════════════════════════════════════════════════╗
echo ║     Sam's Autonomous Social Media System               ║
echo ║     Local Development Server Startup                   ║
echo ╚════════════════════════════════════════════════════════╝
echo.

REM Check if Node is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo ✗ Node.js is not installed
    echo   Download from: https://nodejs.org
    pause
    exit /b 1
)

echo ✓ Node.js detected:
node --version

REM Check if PostgreSQL is running
psql --version >nul 2>&1
if errorlevel 1 (
    echo ✗ PostgreSQL is not installed or not in PATH
    echo   Download from: https://www.postgresql.org
    pause
    exit /b 1
)

echo ✓ PostgreSQL detected
echo.

REM Check if database exists
psql -d sams_social -c "SELECT version();" >nul 2>&1
if errorlevel 1 (
    echo ! Database not created yet
    echo   Run: createdb sams_social
    echo   Then: node backend\src\database\migrate.js
    echo.
    pause
    exit /b 1
)

echo ✓ Database 'sams_social' exists
echo.

REM Check if .env file exists
if not exist "backend\.env" (
    echo ! .env file not found
    echo   Creating from template...
    copy backend\.env.example backend\.env
    echo   ✓ Created backend\.env
    echo.
    echo   IMPORTANT: Edit backend\.env and add:
    echo   - CLAUDE_API_KEY (from https://console.anthropic.com)
    echo   - OWNER_EMAIL (your email)
    echo.
    echo   Then run this script again.
    pause
    exit /b 1
)

echo ✓ Configuration file found
echo.

REM Check if dependencies are installed
if not exist "backend\node_modules" (
    echo Installing backend dependencies...
    cd backend
    call npm install
    cd ..
    echo ✓ Backend dependencies installed
)

if not exist "frontend\node_modules" (
    echo Installing frontend dependencies...
    cd frontend
    call npm install
    cd ..
    echo ✓ Frontend dependencies installed
)

echo.
echo ════════════════════════════════════════════════════════
echo Starting servers...
echo ════════════════════════════════════════════════════════
echo.
echo Backend starting on: http://localhost:3000
echo Frontend starting on: http://localhost:5173
echo.
echo Press Ctrl+C to stop either server
echo.

REM Start backend in new window
start "Sam's Social - Backend" cmd /k "cd backend && npm start"

REM Give backend a moment to start
timeout /t 3 /nobreak

REM Start frontend in new window
start "Sam's Social - Frontend" cmd /k "cd frontend && npm run dev"

echo.
echo Servers started! Check the new windows above.
echo.
echo Login to dashboard:
echo - URL: http://localhost:5173
echo - Email: issam.salih@gmail.com
echo - Password: (any password - Phase 1 testing)
echo.
pause
