#!/bin/bash

set -e

# Set this for core.getState() and core.saveState() to work
export GITHUB_STATE=$(mktemp)

npm run prepare

export INPUT_API_TOKEN="${ORBIT_API_TOKEN:-dummy-token}"
export INPUT_GITHUB_TOKEN="${GITHUB_PAT:-your-github-pat-here}"

# Set optional inputs with defaults matching action.yml
export INPUT_VERSION="${VERSION:-latest}"
export INPUT_LOG_FILE="${LOG_FILE:-/var/log/orbitd.log}"
export INPUT_SERVER_ADDR="${SERVER_ADDR:-api.nonprod.eu.orbit.ci}"

# Enable Github Actions debug logging
export RUNNER_DEBUG=1 

cleanup() {
  if [ -f "$GITHUB_STATE" ]; then
    rm -f "$GITHUB_STATE"
  fi

  if [ -d "bin" ]; then
    rm -rf bin
  fi

  if [ -f "$INPUT_LOG_FILE" ]; then
    sudo rm -f "$INPUT_LOG_FILE"
  fi
}

# Register cleanup on script exit
trap cleanup EXIT

prepare_teardown() {
  if [ -f "$GITHUB_STATE" ]; then
    # Get PID from the second line of the state file between the state delimiters
    export STATE_orbitdPid=$(sed -n '2p' "$GITHUB_STATE")
    echo "Found Orbit daemon PID: $STATE_orbitdPid"
  fi
}

if [ -z "$1" ]; then
  echo "Running full test cycle (setup -> wait -> teardown)"
  npm run orbit:setup
  echo "Waiting 5 seconds..."
  sleep 5
  prepare_teardown
  npm run orbit:shutdown
  exit 0
fi

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
    prepare_teardown
    npm run orbit:shutdown
    ;;
  *)
    echo "Invalid action: $1"
    echo "Usage: $0 <setup|teardown>"
    exit 1
    ;;
esac
