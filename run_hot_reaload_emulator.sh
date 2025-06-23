#!/bin/bash
cd ~/tbl

# Start the React development server in the background
npm start &

# Store the process ID of the npm start process
NPM_START_PID=$!

# Give the development server a moment to start (adjust as needed)
sleep 5  # sec

# Start the Firebase emulators with the development configuration
firebase emulators:start --only hosting --config firebase.development.json

# When the emulators are stopped (e.g., with Ctrl+C),
# the script will continue here.
# Kill the background npm start process
kill $NPM_START_PID

echo "Development server and emulators stopped."
