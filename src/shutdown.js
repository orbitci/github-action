const os = require('os');
const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function cleanup() {
  try {
    const pidFile = path.join(os.tmpdir(), 'orbitd.pid');
    
    // Check if PID file exists
    if (!fs.existsSync(pidFile)) {
      core.info('No PID file found, orbitd may not be running');
      return;
    }

    // Read PID from file
    const pid = fs.readFileSync(pidFile, 'utf8').trim();
    core.debug(`Found orbitd PID: ${pid}`);

    // Send SIGTERM to the process group
    const sudo = spawn('sudo', ['kill', '-TERM', `-${pid}`]);
    
    // Wait for the kill command to complete
    await new Promise((resolve, reject) => {
      sudo.on('exit', (code) => {
        if (code === 0) {
          core.info('🛑 Orbit agent stopped successfully');
          // Clean up PID file
          fs.unlinkSync(pidFile);
          resolve();
        } else {
          reject(new Error(`Failed to stop orbitd process (exit code: ${code})`));
        }
      });
      
      sudo.on('error', (err) => {
        reject(new Error(`Failed to execute kill command: ${err.message}`));
      });
    });

  } catch (error) {
    core.setFailed(`Cleanup failed: ${error.message}`);
  }
}

cleanup(); 