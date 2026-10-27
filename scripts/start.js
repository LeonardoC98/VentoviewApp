// Startet die App im Entwicklungsmodus.
// ELECTRON_RUN_AS_NODE wird entfernt, weil manche Umgebungen (z. B. Erweiterungen in VS Code) es setzen –
// dann würde Electron nur als Node laufen und die App nicht starten.
const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], {
  cwd: path.join(__dirname, '..'),
  env,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
