const core = require('@actions/core');
const github = require('@actions/github');
const tc = require('@actions/tool-cache');
const { spawn } = require('child_process');
const { platform } = require('@actions/core');
const fs = require('fs');
const path = require('path');

const ORBITCI_ORG = "orbitci";
const ORBITCI_AGENT_REPO = "orbit-ebpf";

async function downloadRelease(octokit, version) {
  let releaseTag = version;
  if (version === 'latest') {
    core.debug('Fetching latest release tag ...');
    const latestRelease = await octokit.rest.repos.getLatestRelease({
      owner: ORBITCI_ORG,
      repo: ORBITCI_AGENT_REPO
    });
    releaseTag = latestRelease.data.tag_name;
    core.debug(`Latest release tag: ${releaseTag}`);
  }

  core.debug(`Fetching release: ${releaseTag}`);
  const release = await octokit.rest.repos.getReleaseByTag({
    owner: ORBITCI_ORG,
    repo: ORBITCI_AGENT_REPO,
    tag: releaseTag
  });

  return { release, releaseTag };
}

async function setupBinaries(release, githubToken, octokit) {
  const version = release.data.tag_name;
  const assetName = `orbit-${version}-github-${platform.platform}-${platform.arch}.tar.gz`;
  
  core.debug(`Looking for asset: ${assetName}`);
  
  const asset = release.data.assets.find(a => a.name === assetName);
  if (!asset) {
    throw new Error(`Required asset not found: ${assetName}`);
  }

  core.debug(`Processing ${assetName}...`);
  
  const assetData = await octokit.rest.repos.getReleaseAsset({
    owner: ORBITCI_ORG,
    repo: ORBITCI_AGENT_REPO,
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
  
  const pathToCLI = await tc.extractTar(downloadPath, undefined, ['xz', '--strip-components=1']);
  core.debug(`Orbit CLI path: ${pathToCLI}`);

  // Make all files in bin directory executable
  const files = fs.readdirSync(pathToCLI);
  for (const file of files) {
    const filePath = path.join(pathToCLI, file);
    fs.chmodSync(filePath, '755');
  }

  return pathToCLI;
}

async function startOrbitd(pathToCLI, serverAddr) {
  // Use absolute paths for sudo commands to work
  const orbitdPath = path.join(pathToCLI, 'orbitd');
  const orbitPath = path.join(pathToCLI, 'orbit');

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for orbitd to start'));
    }, 5000);

    const orbitd = spawn('sudo', [
      '-E',
      orbitdPath,
      `-client-bin-path=${orbitPath}`,
      `-server-addr=${serverAddr}`,
      '-log-level=1',
      '-debug',
      `-log-file=/var/log/orbitd.log`
    ], {
      detached: true,
      stdio: 'ignore',
      shell: false
    });

    orbitd.on('error', (err) => {
      core.debug(`orbitd error: ${err.message}`);
      clearTimeout(timeout);
      reject(new Error(`Failed to start orbitd: ${err.message}`));
    });

    orbitd.on('spawn', async () => {
      core.debug('orbitd spawned');
      clearTimeout(timeout);
      
      core.saveState('orbitdPid', orbitd.pid.toString());
      orbitd.unref();  // Allows parent to exit independently
      
      // Wait additional 5 seconds for the process to be ready
      core.debug('Waiting 5 seconds for orbitd to be ready...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      core.debug('Ready wait completed');
        
      resolve(orbitd.pid.toString());
    });

    orbitd.on('exit', (code, signal) => {
      core.debug(`orbitd exited with code ${code} and signal ${signal}`);
      clearTimeout(timeout);
      if (code !== null) {
        reject(new Error(`orbitd exited with code ${code}. Check ${logFile} for errors`));
      } else if (signal !== null) {
        reject(new Error(`orbitd was terminated by signal ${signal}`));
      }
    });
  });
}

async function triggerJobStart() {
  return new Promise((resolve, reject) => {
    const orbit = spawn('orbit', ['event', 'job-start']);

    let output = '';
    orbit.stdout.on('data', (data) => {
      output += data.toString();
    });

    orbit.stderr.on('data', (data) => {
      core.debug(`orbit command stderr: ${data}`);
    });

    orbit.on('exit', (code) => {
      if (code === 0) {
        core.debug(`orbit command output: ${output.trim()}`);
        resolve();
      } else {
        reject(new Error(`orbit command failed with exit code ${code}`));
      }
    });

    orbit.on('error', (err) => {
      reject(new Error(`Failed to execute orbit command: ${err.message}`));
    });
  });
}

async function run() {
  try {
    const apiToken = core.getInput('orbitci_api_token', { required: true });
    const serverAddr = core.getInput('orbitci_server_addr');
    const version = core.getInput('version');
    const githubToken = core.getInput('github_token', { required: true });

    // TODO: Set env variables for server address
    core.exportVariable('ORBITCI_API_TOKEN', apiToken);
    
    const octokit = github.getOctokit(githubToken);

    const supportedPlatforms = ['linux'];
    if (!supportedPlatforms.includes(platform.platform)) {
      throw new Error(`Platform ${platform.platform} is not supported. Currently, this action only supports: ${supportedPlatforms.join(', ')}`);
    }

    const supportedArchs = ['x64', 'arm64'];
    if (!supportedArchs.includes(platform.arch)) {
      throw new Error(`Architecture ${platform.arch} is not supported. Currently, this action only supports: ${supportedArchs.join(', ')}`);
    }
    
    const { release, releaseTag } = await downloadRelease(octokit, version);
    core.info(`📦 Downloaded Orbit CI binaries version: ${releaseTag}`);
    
    const pathToCLI = await setupBinaries(release, githubToken, octokit);
    core.addPath(pathToCLI);
    
    const pid = await startOrbitd(pathToCLI, serverAddr);
    core.info(`✅ Orbit CI agent started successfully (PID: ${pid})`);

    // Run orbit event command
    await triggerJobStart();
    core.info('✅ Job start event sent successfully');

    core.setOutput('version', releaseTag);
  } catch (error) {
    core.setFailed(error.message);
  }
}

run(); 