const core = require('@actions/core');
const github = require('@actions/github');
const tc = require('@actions/tool-cache');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const { platform } = require('@actions/core');

const ORBIT_ORG = "orbitci";
const ORBIT_AGENT_REPO = "orbit-ebpf";

async function downloadRelease(octokit, version) {
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

  return { release, releaseTag };
}

async function setupBinaries(release, githubToken, octokit) {
  // Check platform
  const supportedPlatforms = ['linux'];
  if (!supportedPlatforms.includes(platform.platform)) {
    throw new Error(`Platform ${platform.platform} is not supported. Currently, this action only supports: ${supportedPlatforms.join(', ')}`);
  }

  // Check architecture
  const supportedArchs = ['x64', 'arm64'];
  if (!supportedArchs.includes(platform.arch)) {
    throw new Error(`Architecture ${platform.arch} is not supported. Currently, this action only supports: ${supportedArchs.join(', ')}`);
  }

  const binariesDir = path.join(__dirname, '..', '..', 'bin');
  fs.mkdirSync(binariesDir, { recursive: true });
  
  const version = release.data.tag_name;
  
  const expectedAssets = [
    `orbit-${version}-${platform.platform}-${platform.arch}.tar.gz`,
    `orbitd-${version}-${platform.platform}-${platform.arch}.tar.gz`
  ];
  
  core.debug(`Looking for assets: ${expectedAssets.join(', ')}`);
  
  for (const assetName of expectedAssets) {
    const asset = release.data.assets.find(a => a.name === assetName);
    if (!asset) {
      throw new Error(`Required asset not found: ${assetName}`);
    }

    core.debug(`Processing ${assetName}...`);
    
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
  }

  // Make all files in bin directory executable
  const files = fs.readdirSync(binariesDir);
  for (const file of files) {
    const filePath = path.join(binariesDir, file);
    fs.chmodSync(filePath, '755');
  }

  return binariesDir;
}

async function startOrbitd(binariesDir, apiToken, logFile, serverAddr) {
  const orbitdPath = path.join(binariesDir, 'orbitd');
  const orbitPath = path.join(binariesDir, 'orbit');

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
      `-log-file=${logFile}`
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

async function triggerJobStart(binariesDir) {
  return new Promise((resolve, reject) => {
    const orbitPath = path.join(binariesDir, 'orbit');
    const orbit = spawn(orbitPath, ['event', 'job-start']);

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
    const version = core.getInput('version');
    const apiToken = core.getInput('api_token', { required: true });
    const githubToken = core.getInput('github_token', { required: true });
    const logFile = core.getInput('log_file');
    const serverAddr = core.getInput('server_addr');

    core.exportVariable('ORBITCI_API_TOKEN', apiToken);
    
    const octokit = github.getOctokit(githubToken);
    
    const { release, releaseTag } = await downloadRelease(octokit, version);
    core.info(`Using Orbit agent version: ${releaseTag}`);
    
    const binariesDir = await setupBinaries(release, githubToken, octokit);
    core.addPath(binariesDir);
    
    const pid = await startOrbitd(binariesDir, apiToken, logFile, serverAddr);
    core.info(`✨ Orbit agent started successfully (PID: ${pid})`);

    // Run orbit event command
    await triggerJobStart(binariesDir);
    core.info('✨ Job start event sent successfully');

    core.setOutput('version', releaseTag);
    core.setOutput('binary_path', binariesDir);
  } catch (error) {
    core.setFailed(error.message);
  }
}

run(); 