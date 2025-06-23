#!/bin/bash
cd ~/tbl
# Run npm run. If it fails, the deployment won't be pushed.
npm run build && {
    firebase deploy --only hosting && {
        echo "TBL deployed to prod successfully!"
    }
}

