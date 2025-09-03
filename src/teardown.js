const core = require('@actions/core');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

async function stopUsdtServer() {
  return new Promise((resolve, reject) => {
    // First check if the PID file exists
    if (!fs.existsSync('/tmp/orbit/orbit_usdt.pid')) {
      core.debug('USDT server PID file not found, server may not be running');
      resolve();
      return;
    }

    const usdtServer = spawn('orbit-usdt', ['server', 'stop']);

    let output = '';
    usdtServer.stdout.on('data', (data) => {
      output += data.toString();
    });

    usdtServer.stderr.on('data', (data) => {
      core.debug(`USDT server stop stderr: ${data}`);
    });

    usdtServer.on('exit', (code) => {
      if (code === 0) {
        core.debug(`USDT server stop output: ${output.trim()}`);
        // Verify the PID file is removed
        setTimeout(() => {
          if (!fs.existsSync('/tmp/orbit/orbit_usdt.pid')) {
            core.debug('USDT server PID file removed, server stopped successfully');
            resolve();
          } else {
            reject(new Error('PID file still exists after stop command'));
          }
        }, 1000);
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    usdtServer.on('error', (err) => {
      reject(err);
    });
  });
}

async function triggerJobEnd(jobId, serverAddr, apiToken) {
  return new Promise((resolve, reject) => {
    const orbit = spawn('orbit-usdt', [
      'fire', 
      'job-end', 
      `-job-id=${jobId}`,
      `-api-address=${serverAddr}`,
      `-api-token=${apiToken}`,
    ]);

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

async function printLogFileContents(logFile) {
  try {
    if (fs.existsSync(logFile)) {
      core.startGroup('📄 Orbit CI agent logs');
      const contents = fs.readFileSync(logFile, 'utf8');
      contents.split('\n').forEach(line => {
        if (line.trim()) {
          core.debug(line);
        }
      });
      core.endGroup();
    } else {
      core.debug(`Log file not found: ${logFile}`);
    }
  } catch (error) {
    core.warning(`Failed to read log file: ${error.message}`);
  }
}

async function run() {
  const serverAddr = core.getInput('orbitci_server_addr');
  const apiToken = core.getInput('orbitci_api_token');

  const logFile = "/var/log/orbitd.log";

  // Send job-end event before stopping the daemon
  try {
    const jobId = process.env.GITHUB_JOB;
    if (!jobId) {
      throw new Error('GITHUB_JOB environment variable is required');
    }
    await triggerJobEnd(jobId, serverAddr, apiToken);
    core.info('✅ Job end event sent successfully');
  } catch (error) {
    core.warning(`Failed to send job end event: ${error.message}`);
  }

  // Stop USDT server
  try {
    await stopUsdtServer();
    core.info('✅ USDT server stopped successfully');
  } catch (error) {
    core.warning(`Failed to stop USDT server: ${error.message}`);
  }

  // Stop agent
  const orbitdPid = core.getState('orbitdPid');
  if (!orbitdPid) {
    core.warning('No Orbit CI daemon PID found, skipping process termination');
  } else {
    core.debug(`Found Orbit CI daemon PID: ${orbitdPid}`);
    await new Promise((resolve, reject) => {
      try {
        process.kill(orbitdPid, 'SIGTERM');
        core.info(`Sent SIGTERM to process ${orbitdPid}`);

        // Give the process some time to shutdown gracefully
        const timeout = setTimeout(() => {
          try {
            // If process still exists, force kill it
            process.kill(orbitdPid, 'SIGKILL');
            core.info(`Process ${orbitdPid} force killed with SIGKILL`);
          } catch (error) {
            // Process might have already terminated
            core.debug(`Process ${orbitdPid} already terminated`);
          }
          resolve();
        }, 5000);

        // Check if process exits before timeout
        const checkInterval = setInterval(() => {
          try {
            // Try to send signal 0 to check if process exists
            process.kill(orbitdPid, 0);
          } catch (error) {
            // Process has terminated
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 500);

      } catch (error) {
        if (error.code === 'ESRCH') {
          core.info(`Process ${orbitdPid} already terminated`);
          resolve();
        } else {
          reject(error);
        }
      }
    });
    core.info('✅ Orbit agent stopped successfully');
  }

  if (core.isDebug()) {
    await printLogFileContents(logFile);
  }
}

run().catch(error => {
  core.warning(`Failed to teardown Orbit CI agent: ${error.message}`);
}); 

