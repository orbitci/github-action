#!/bin/bash

# Exit on error
set -e

# Build the action
npm run prepare

# Set required inputs
export INPUT_API_TOKEN="${ORBIT_API_TOKEN:-dummy-token}"
export INPUT_GITHUB_TOKEN="${GITHUB_PAT:-your-github-pat-here}"
export INPUT_VERSION="${VERSION:-latest}"

# Enable debug logging
export RUNNER_DEBUG=1

# Run the action
npm run local 