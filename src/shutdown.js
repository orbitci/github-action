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
    const pidFile = path.join(os.tmpdir(), 'orbitd.pid');
    const binariesDir = path.join(__dirname, '..', '..', 'bin');
    const logFile = core.getInput('log_file');
    
    // Show log file contents before cleanup
    await showLogFileContents(logFile);
    
    // Check if PID file exists
    if (!fs.existsSync(pidFile)) {
      core.info('No PID file found, orbitd may not be running');
      return;
    }

    // Read PID from file
    const pid = fs.readFileSync(pidFile, 'utf8').trim();
    core.debug(`Found orbitd PID: ${pid}`);

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
        process.kill(pid, 'SIGTERM');
        core.info(`Sent SIGTERM to process ${pid}`);
        
        // Give the process some time to shutdown gracefully
        const timeout = setTimeout(() => {
          try {
            // If process still exists, force kill it
            process.kill(pid, 'SIGKILL');
            core.info(`Process ${pid} force killed with SIGKILL`);
          } catch (error) {
            // Process might have already terminated
            core.debug(`Process ${pid} already terminated`);
          }
          resolve();
        }, 5000);

        // Check if process exits before timeout
        const checkInterval = setInterval(() => {
          try {
            // Try to send signal 0 to check if process exists
            process.kill(pid, 0);
          } catch (error) {
            // Process has terminated
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 500);

      } catch (error) {
        if (error.code === 'ESRCH') {
          core.info(`Process ${pid} already terminated`);
          resolve();
        } else {
          reject(error);
        }
      }
    });

    // Clean up PID file
    try {
      fs.unlinkSync(pidFile);
      core.info('✨ Orbit agent stopped successfully and PID file removed');
    } catch (error) {
      core.warning(`Failed to remove PID file: ${error.message}`);
    }

  } catch (error) {
    core.setFailed(`Cleanup failed: ${error.message}`);
    // Ensure the process exits with error
    process.exit(1);
  }
}

// Execute cleanup and handle any uncaught errors
cleanup().catch(error => {
  core.setFailed(`Uncaught error in cleanup: ${error.message}`);
  process.exit(1);
});