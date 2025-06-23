# Orbit CI Github Action

A GitHub Action that sets up and manages Orbit CI agent in your GitHub Actions workflows.

## Usage

```yaml
- name: Setup Orbit agent
  uses: orbitci/github-action@main
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  with:
    orbitci_server_addr: api.us.orbit.ci
    orbitci_api_token: ${{ secrets.ORBITCI_API_TOKEN }}
    version: 'latest'
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
| `version` | The version of Orbit CI binaries to install | No | `latest` |

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GITHUB_TOKEN` | Auto-generated GitHub token for authentication | Yes |

## License

BSD 3-Clause License

