#!/bin/bash
set -euo pipefail
cd /app
# Match the official image's browser and Python runtime setup.
source /app/environment.sh
export TZ=Asia/Taipei
source "/app/env_$(uname -m)/bin/activate"
exec python3 /app/psyhot/run.py -job True -init True
