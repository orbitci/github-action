const os = require('os');
const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

async function triggerJobEnd(binariesDir) {
  return new Promise((resolve, reject) => {
    const orbitPath = path.join(binariesDir, 'orbit');
    const orbit = spawn(orbitPath, ['event', 'job-end']);

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

async function showLogFileContents(logFile) {
  try {
    if (fs.existsSync(logFile)) {
      const contents = fs.readFileSync(logFile, 'utf8');
      core.debug('=== orbitd log contents ===');
      contents.split('\n').forEach(line => {
        if (line.trim()) {
          core.debug(line);
        }
      });
      core.debug('=== end orbitd log ===');
    } else {
      core.debug(`Log file not found: ${logFile}`);
    }
  } catch (error) {
    core.warning(`Failed to read log file: ${error.message}`);
  }
}

async function cleanup() {
  try {
    const orbitdPid = core.getState('orbitdPid');
    if (!orbitdPid) {
      core.warning('No Orbit daemon PID found');
    } else {
      core.debug(`Found Orbit daemon PID: ${orbitdPid}`);
    }

    const binariesDir = path.join(__dirname, '..', '..', 'bin');
    const logFile = core.getInput('log_file');
    
    // Send job-end event before stopping the daemon
    try {
      await triggerJobEnd(binariesDir);
      core.info('✨ Job end event sent successfully');
    } catch (error) {
      core.warning(`Failed to send job end event: ${error.message}`);
    }

    // First try to terminate gracefully
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

    core.info('✨ Orbit agent stopped successfully');

    // Show final log contents
    if (core.isDebug()) {
      core.debug('Final log contents after shutdown:');
      await showLogFileContents(logFile);
    }
  } catch (error) {
    core.setFailed(`Cleanup failed: ${error.message}`);
    process.exit(1);
  }
}

// Execute cleanup and handle any uncaught errors
cleanup().catch(error => {
  core.setFailed(`Uncaught error in cleanup: ${error.message}`);
  process.exit(1);
});