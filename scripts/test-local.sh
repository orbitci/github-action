#!/bin/bash

# Exit on error
set -e

# Build the action
npm run prepare

# Set required inputs
export INPUT_API_TOKEN="${ORBIT_API_TOKEN:-dummy-token}"
export INPUT_GITHUB_TOKEN="${GITHUB_PAT:-your-github-pat-here}"

# Set optional inputs with defaults matching action.yml
export INPUT_VERSION="${VERSION:-latest}"
export INPUT_LOG_FILE="${LOG_FILE:-/var/log/orbitd.log}"
export INPUT_SERVER_ADDR="${SERVER_ADDR:-api.nonprod.eu.orbit.ci}"

# Enable debug logging
export RUNNER_DEBUG=1

# Run the action
npm run orbit:setup
