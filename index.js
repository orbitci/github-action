const core = require('@actions/core');
const github = require('@actions/github');
const tc = require('@actions/tool-cache');
const fs = require('fs');
const path = require('path');

const ORBIT_ORG = "orbitci";
const ORBIT_AGENT_REPO = "orbit-ebpf";

async function run() {
  try {
    const version = core.getInput('version');
    const apiToken = core.getInput('api_token', { required: true });
    const githubToken = core.getInput('github_token', { required: true });
    
    const octokit = github.getOctokit(githubToken);
    
    let releaseTag = version;
    if (version === 'latest') {
      core.debug('Fetching latest release tag ...');
      const latestRelease = await octokit.rest.repos.getLatestRelease({
        owner: ORBIT_ORG,
        repo: ORBIT_AGENT_REPO
      });
      releaseTag = latestRelease.data.tag_name;
      core.debug(`Latest release tag: ${releaseTag}`);
    }

    core.debug(`Fetching release: ${releaseTag}`);
    const release = await octokit.rest.repos.getReleaseByTag({
      owner: ORBIT_ORG,
      repo: ORBIT_AGENT_REPO,
      tag: releaseTag
    });
    
    const binariesDir = path.join(process.cwd(), 'bin');
    fs.mkdirSync(binariesDir, { recursive: true });
    
    core.debug(`Downloading assets to ${binariesDir}`);
    for (const asset of release.data.assets) {
      if (asset.name.startsWith('orbit') && asset.name.endsWith('.tar.gz')) {
        core.debug(`Processing ${asset.name}...`);
        
        // Get the asset download URL
        const assetData = await octokit.rest.repos.getReleaseAsset({
          owner: ORBIT_ORG,
          repo: ORBIT_AGENT_REPO,
          asset_id: asset.id,
          headers: {
            Accept: 'application/octet-stream'
          }
        });
        
        const downloadPath = await tc.downloadTool(
          assetData.url,
          undefined,
          `token ${githubToken}`,
          {
            'Accept': 'application/octet-stream'
          }
        );
        
        await tc.extractTar(downloadPath, binariesDir, ['xz', '--strip-components=1']);
        
        // Make all files in bin directory executable on Unix-like systems
        if (process.platform !== 'win32') {
          const files = fs.readdirSync(binariesDir);
          for (const file of files) {
            const filePath = path.join(binariesDir, file);
            fs.chmodSync(filePath, '755');
          }
        }
      }
    }
    
    core.addPath(binariesDir);
    
    core.setOutput('version', releaseTag);
    core.setOutput('binary_path', binariesDir);
    
  } catch (error) {
    core.setFailed(error.message);
  }
}

run(); 