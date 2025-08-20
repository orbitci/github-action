# Orbit CI Github Action

A GitHub Action that sets up and manages Orbit CI agent in your GitHub Actions workflows.

## Usage

```yaml
- name: Setup Orbit agent
  uses: orbitci/github-action@v0
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  with:
    orbitci_server_addr: api.us.orbit.ci
    orbitci_api_token: ${{ secrets.ORBITCI_API_TOKEN }}
    env_allowlist: ${{ vars.ORBITCI_ENV_ALLOWLIST }} # Centrally managed Organization var (recommended)
```

## Permission

This action needs permission to the Actions API. The following permission must be set 
in the caller's workflow file - 

```yaml
permissions:
  actions: read
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `orbitci_server_addr` | The address of the Orbit CI server to connect to | No | `api.us.orbit.ci` (US site) |
| `orbitci_api_token` | The API token used to publish events to Orbit CI | Yes | - |
| `version` | The version of Orbit CI binaries to install | No | latest stable |
| `env_allowlist` | Comma-separated list of user-defined environment variables to capture and include in telemetry. Each env var name must begin with `ORBITCI_USER_`. E.g. `ORBITCI_USER_CI_STAGE,ORBITCI_USER_PIPELINE_VERSION` | No | "" |

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GITHUB_TOKEN` | Auto-generated GitHub token for authentication | Yes |

## License

BSD 3-Clause License

