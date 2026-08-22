#!/bin/bash
# Sam's Autonomous Social Media System - Local Startup Script (Mac/Linux)
# This script starts both backend and frontend servers

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║     Sam's Autonomous Social Media System               ║"
echo "║     Local Development Server Startup                   ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# Check if Node is installed
if ! command -v node &> /dev/null; then
    echo "✗ Node.js is not installed"
    echo "  Download from: https://nodejs.org"
    exit 1
fi

echo "✓ Node.js detected:"
node --version

# Check if PostgreSQL is installed
if ! command -v psql &> /dev/null; then
    echo "✗ PostgreSQL is not installed"
    echo "  Install: brew install postgresql (Mac) or apt-get install postgresql (Linux)"
    exit 1
fi

echo "✓ PostgreSQL detected"
echo ""

# Check if database exists
if ! psql -d sams_social -c "SELECT version();" > /dev/null 2>&1; then
    echo "! Database not created yet"
    echo "  Run: createdb sams_social"
    echo "  Then: node backend/src/database/migrate.js"
    echo ""
    exit 1
fi

echo "✓ Database 'sams_social' exists"
echo ""

# Check if .env file exists
if [ ! -f "backend/.env" ]; then
    echo "! .env file not found"
    echo "  Creating from template..."
    cp backend/.env.example backend/.env
    echo "  ✓ Created backend/.env"
    echo ""
    echo "  IMPORTANT: Edit backend/.env and add:"
    echo "  - CLAUDE_API_KEY (from https://console.anthropic.com)"
    echo "  - OWNER_EMAIL (your email)"
    echo ""
    echo "  Then run this script again."
    exit 1
fi

echo "✓ Configuration file found"
echo ""

# Check if dependencies are installed
if [ ! -d "backend/node_modules" ]; then
    echo "Installing backend dependencies..."
    cd backend
    npm install
    cd ..
    echo "✓ Backend dependencies installed"
fi

if [ ! -d "frontend/node_modules" ]; then
    echo "Installing frontend dependencies..."
    cd frontend
    npm install
    cd ..
    echo "✓ Frontend dependencies installed"
fi

echo ""
echo "════════════════════════════════════════════════════════"
echo "Starting servers..."
echo "════════════════════════════════════════════════════════"
echo ""
echo "Backend starting on: http://localhost:3000"
echo "Frontend starting on: http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop"
echo ""

# Start backend in background
cd backend
npm start &
BACKEND_PID=$!
cd ..

# Give backend a moment to start
sleep 3

# Start frontend
cd frontend
npm run dev
cd ..

# If we get here, frontend exited. Kill backend too.
kill $BACKEND_PID
