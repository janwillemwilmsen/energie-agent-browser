#!/usr/bin/env node
// Helper script invoked by the server to start an agent-browser daemon
// for a given session. Spawns the connect command detached and exits.
// Args: <nativeBinPath> <sessionName> <cdpUrl> <logFilePath>
const { spawn } = require('child_process');
const fs = require('fs');

const [, , nativeBin, session, cdpUrl, logPath] = process.argv;
if (!nativeBin || !session || !cdpUrl || !logPath) {
  console.error('usage: launchConnect.cjs <nativeBin> <session> <cdpUrl> <logPath>');
  process.exit(2);
}

const fd = fs.openSync(logPath, 'a');
const child = spawn(nativeBin, ['--session', session, 'connect', cdpUrl], {
  shell: false,
  windowsHide: true,
  detached: true,
  stdio: ['ignore', fd, fd],
  env: process.env,
});
child.unref();
fs.closeSync(fd);
process.stdout.write(String(child.pid ?? ''));
process.exit(0);
