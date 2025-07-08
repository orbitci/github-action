const core = require('@actions/core');
const github = require('@actions/github');
const tc = require('@actions/tool-cache');
const { spawn, execSync } = require('child_process');
const { platform } = require('@actions/core');
const fs = require('fs');
const path = require('path');

const ORBITCI_ORG = "orbitci";
const ORBITCI_AGENT_REPO = "orbit-agent-releases";
const RUNNER_DIR = "/home/runner";
const LOG_REGEX = "Worker_*.log";

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

async function startOrbitd(pathToCLI, serverAddr, apiToken) {
  // Use absolute paths for sudo commands to work
  const orbitdPath = path.join(pathToCLI, 'orbitd');
  const orbitUsdtPath = path.join(pathToCLI, 'orbit-usdt');
  const logFile="/var/log/orbitd.log";

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for orbitd to start'));
    }, 5000);

    const orbitd = spawn('sudo', [
      '-E',
      orbitdPath,
      `-usdt-bin=${orbitUsdtPath}`,
      `-api-address=${serverAddr}`,
      `-api-token=${apiToken}`,
      '-bpf-loglevel=1',
      '-ci-provider=github',
      '-debug',
      `-logfile=${logFile}`
    ], {
      detached: true,
      stdio: 'ignore',
      shell: false,
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

async function startUsdtServer() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for USDT server to start'));
    }, 5000);

    const usdtServer = spawn('orbit-usdt', ['server', 'start'], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });

    usdtServer.on('error', (err) => {
      core.debug(`USDT server error: ${err.message}`);
      clearTimeout(timeout);
      reject(new Error(`Failed to start USDT server: ${err.message}`));
    });

    usdtServer.on('spawn', async () => {
      core.debug('USDT server spawned');
      clearTimeout(timeout);

      core.saveState('usdtServerPid', usdtServer.pid.toString());
      usdtServer.unref();  // Allows parent to exit independently

      // Wait additional 2 seconds for the process to be ready
      core.debug('Waiting 2 seconds for USDT server to be ready...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      core.debug('USDT server ready wait completed');

      resolve(usdtServer.pid.toString());
    });

    usdtServer.on('exit', (code, signal) => {
      core.debug(`USDT server exited with code ${code} and signal ${signal}`);
      clearTimeout(timeout);
      if (code !== null) {
        reject(new Error(`USDT server exited with code ${code}`));
      } else if (signal !== null) {
        reject(new Error(`USDT server was terminated by signal ${signal}`));
      }
    });
  });
}

async function triggerJobStart(jobId) {
  return new Promise((resolve, reject) => {
    const orbit = spawn('orbit-usdt', ['fire', 'job-start', '-job-id', jobId]);

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

// Extracts the jobDisplayName from the Runner.Worker's log file.
// The log file contains the job message JSON payload received by the worker
// Currently we have an awful regex to extract the value just to keep things
// fast. It might be better to parse as JSON and extract other metadata
// (e.g. needs dependency) from the message payload.
async function parseJobDisplayName() {
  const command = `find ${RUNNER_DIR} -name "${LOG_REGEX}" -type f 2>/dev/null \\
  -exec grep -h '"jobDisplayName":' {} \\; | \\
  sed -n 's/.*"jobDisplayName"[[:space:]]*:[[:space:]]*"\\([^"\\\\]*\\(\\\\.[^"\\\\]*\\)*\\)".*/\\1/p' | \\
  sed 's/\\\\"/"/g'`;

  try {
    const output = execSync(command, { encoding: 'utf8' }).trim();
    return output;
  } catch (error) {
    core.debug(`parseJobDisplayName command failed: ${error.message}`);
    throw error;
  }
}

async function getWorkflowRunJobs(octokit) {
  try {
    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;
    const runId = github.context.runId;

    const response = await octokit.rest.actions.listJobsForWorkflowRun({
      owner: owner,
      repo: repo,
      run_id: runId
    });
    return response.data.jobs;
  } catch (error) {
    core.debug(`Failed to get workflow run jobs: ${error.message}`);
    throw error;
  }
}

// Fetches all jobs for the workflow run and extracts the job id matching
// the currrently running job. This job id is the value returned by the
// Github REST API.
async function findJobIdByName(octokit, jobDisplayName) {
  try {
    const jobs = await getWorkflowRunJobs(octokit);

    for (const job of jobs) {
      // This check should handle matrix jobs and reusable workflows job
      // and account for the right job id
      if (job.name === jobDisplayName) {
        return job.id.toString();
      }
    }

    core.warning(`No job found with display name: ${jobDisplayName}`);
    return null;
  } catch (error) {
    core.debug(`Failed to find job ID by name: ${error.message}`);
    throw error;
  }
}

// Sets a new environment variable ORBITCI_JOB_ID which is the job id
// (value returned by the API and in webhook events payload).
// If the job id cannot be determined, the value of jobs.<job_id> is
// used as a fallback
async function setJobIDEnvvar(octokit) {
  let orbJobId = process.env.GITHUB_JOB; // fallback value
  try {
    const jobDisplayName = await parseJobDisplayName();
    if (jobDisplayName && jobDisplayName.length > 0) {
      const jobId = await findJobIdByName(octokit, jobDisplayName);
      if (jobId) {
        orbJobId = jobId;
      } else {
        core.warning('Could not find job ID for display name, using GITHUB_JOB as fallback');
      }
    } else {
      core.warning('parseJobDisplayName returned empty output, using GITHUB_JOB as fallback');
    }
  } catch (error) {
    core.warning(`Failed to get job ID: ${error.message}. Using GITHUB_JOB as fallback`);
  }
  // core.exportVariable sets the env var for the subsequent steps in the workflow
  core.exportVariable('ORBITCI_JOB_ID', orbJobId);

  // set env var for current step so that it is included for Orbit agent setep processes
  process.env.ORBITCI_JOB_ID = orbJobId;
}

async function run() {
  const apiToken = core.getInput('orbitci_api_token', { required: true });
  const serverAddr = core.getInput('orbitci_server_addr');
  const version = core.getInput('version');
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    core.setFailed("GITHUB_TOKEN is not set in the environment.");
    return;
  }

  const octokit = github.getOctokit(githubToken);

  await setJobIDEnvvar(octokit);
  core.debug(`environment variable ORBITCI_JOB_ID set to: ${process.env.ORBITCI_JOB_ID}`);

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

  const pid = await startOrbitd(pathToCLI, serverAddr, apiToken);
  core.info(`✅ Orbit CI agent started successfully (PID: ${pid})`);

  const usdtPid = await startUsdtServer();
  core.info(`✅ Orbit USDT server started successfully (PID: ${usdtPid})`);

  const jobId = process.env.GITHUB_JOB;
  if (!jobId) {
    throw new Error('GITHUB_JOB environment variable is required');
  }
  await triggerJobStart(jobId);
  core.info('✅ Job start event sent successfully');

  core.setOutput('version', releaseTag);
}

run().catch(error => {
  core.setFailed(error.message);
}); 
