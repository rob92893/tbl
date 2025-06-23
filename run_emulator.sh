#!/bin/bash
cd ~/tbl
# Run npm run. If it fails, the emulator won't be run.
npm run build && {
    firebase emulators:start --only hosting
}