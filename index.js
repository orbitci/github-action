const core = require('@actions/core');
const github = require('@actions/github');
const tc = require('@actions/tool-cache');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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
  const binariesDir = path.join(__dirname, '..', 'bin');
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

  return binariesDir;
}

async function startOrbitd(binariesDir, apiToken, logFile, serverAddr) {
  if (process.platform === 'win32') {
    throw new Error('Windows is not supported');
  }

  const orbitdPath = path.join(binariesDir, 'orbitd');
  const orbitPath = path.join(binariesDir, 'orbit');
  const pidFile = path.join(__dirname, '..', 'orbitd.pid');

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for orbitd to start'));
    }, 10000);

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
      stdio: 'ignore', // Ignore all stdio since orbitd handles its own logging
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
      try {
        await fs.promises.writeFile(pidFile, orbitd.pid.toString());
        orbitd.unref();  // Allows parent to exit independently
        resolve(orbitd.pid.toString());
      } catch (err) {
        reject(new Error(`Failed to write PID file: ${err.message}`));
      }
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

    core.setOutput('version', releaseTag);
    core.setOutput('binary_path', binariesDir);
    core.setOutput('pid', pid);
  } catch (error) {
    core.setFailed(error.message);
  }
}

run(); 