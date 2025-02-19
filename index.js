const core = require('@actions/core');
const github = require('@actions/github');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ORBIT_ORG = "orbitci";
const ORBIT_AGENT_REPO = "orbit-ebpf";

async function downloadFile(url, destPath, token) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const options = {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/octet-stream',
        'User-Agent': 'GitHub-Action'
      }
    };
    
    https.get(url, options, response => {
      if (response.statusCode === 302) {
        // Handle GitHub's redirect for release assets
        https.get(response.headers.location, response => {
          response.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
        }).on('error', err => {
          fs.unlink(destPath, () => reject(err));
        });
      } else {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }
    }).on('error', err => {
      fs.unlink(destPath, () => reject(err));
    });
  });
}

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
      const assetPath = path.join(binariesDir, asset.name);
      core.debug(`Downloading ${asset.name}...`);
      await downloadFile(asset.browser_download_url, assetPath, githubToken);
      
      // Make binary executable on Unix-like systems
      if (process.platform !== 'win32') {
        fs.chmodSync(assetPath, '755');
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