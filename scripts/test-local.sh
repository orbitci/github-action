#!/bin/bash

set -e

if [ -z "$1" ]; then
  echo "Error: Action argument is required"
  echo "Usage: $0 <setup|teardown>"
  exit 1
fi

npm run prepare

export INPUT_API_TOKEN="${ORBIT_API_TOKEN:-dummy-token}"
export INPUT_GITHUB_TOKEN="${GITHUB_PAT:-your-github-pat-here}"

# Set optional inputs with defaults matching action.yml
export INPUT_VERSION="${VERSION:-latest}"
export INPUT_LOG_FILE="${LOG_FILE:-/var/log/orbitd.log}"
export INPUT_SERVER_ADDR="${SERVER_ADDR:-api.nonprod.eu.orbit.ci}"

# Enable Github Actions debug logging
export RUNNER_DEBUG=1

case $1 in
  setup)
    echo "Running setup..."
    if [ -f "$INPUT_LOG_FILE" ]; then
      echo "Removing existing log file: $INPUT_LOG_FILE"
      sudo rm -f "$INPUT_LOG_FILE"
    fi
    npm run orbit:setup
    ;;
  teardown)
    echo "Running teardown..."
    npm run orbit:shutdown
    ;;
  *)
    echo "Invalid action: $1"
    echo "Usage: $0 <setup|teardown>"
    exit 1
    ;;
esac
