#!/bin/bash

set -e

# Set this for core.getState() and core.saveState() to work
export GITHUB_STATE=$(mktemp)

# Set this for core.addPath() to work
export GITHUB_PATH=$(mktemp)

npm run prepare

export INPUT_ORBITCI_SERVER_ADDR="${ORBITCI_SERVER_ADDR:-api.nonprod.eu.orbit.ci}"
export INPUT_ORBITCI_API_TOKEN="${ORBITCI_API_TOKEN:-dummy-token}"
export INPUT_GITHUB_TOKEN="${GITHUB_PAT:-your-github-pat-here}"
export INPUT_VERSION="${VERSION:-latest}"

# Enable Github Actions debug logging
export RUNNER_DEBUG=1 

cleanup() {
  if [ -f "$GITHUB_STATE" ]; then
    rm -f "$GITHUB_STATE"
  fi

  if [ -f "$GITHUB_PATH" ]; then
    rm -f "$GITHUB_PATH"
  fi

  if [ -d "bin" ]; then
    rm -rf bin
  fi

  if [ -f "/var/log/orbitd.log" ]; then
    sudo rm -f "/var/log/orbitd.log"
  fi
}

# Register cleanup on script exit
trap cleanup EXIT

prepare_teardown() {
  # Get PID from state file
  if [ -f "$GITHUB_STATE" ]; then
    export STATE_orbitdPid=$(sed -n '2p' "$GITHUB_STATE")
    echo "Found Orbit daemon PID: $STATE_orbitdPid"
  fi

  # Add paths from GITHUB_PATH to system PATH
  if [ -f "$GITHUB_PATH" ]; then
    echo "Adding paths from GITHUB_PATH to PATH:"
    while IFS= read -r path_entry; do
      if [ -n "$path_entry" ]; then
        echo "  $path_entry"
        export PATH="$path_entry:$PATH"
      fi
    done < "$GITHUB_PATH"
  fi
}

if [ -z "$1" ]; then
  echo "Running full test cycle (setup -> wait -> teardown)"
  npm run orbit:setup
  echo "Waiting 5 seconds..."
  sleep 5
  prepare_teardown
  npm run orbit:teardown
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
    npm run orbit:teardown
    ;;
  *)
    echo "Invalid action: $1"
    echo "Usage: $0 <setup|teardown>"
    exit 1
    ;;
esac
