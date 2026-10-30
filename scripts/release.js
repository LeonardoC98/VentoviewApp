// Neue Version veröffentlichen: fragt nach Versionsnummer und Notizen, der Rest läuft von selbst –
// Version in package.json setzen, Setup bauen, GitHub-Release mit Setup + latest.yml anlegen (darüber holen sich
// installierte Apps das Update) und den Download-Knopf der Webseite (VentoviewWeb/app.json) nachziehen.
// Start: „Neue Version veröffentlichen.bat“ (Doppelklick) oder `node scripts/release.js`.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { execSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const WEB_APP_JSON = path.join(ROOT, '..', 'VentoviewWeb', 'app.json');
const REPO = 'LeonardoC98/VentoviewApp';

const run = (cmd, opts = {}) => execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
const quiet = (cmd) => spawnSync(cmd, { cwd: ROOT, shell: true, encoding: 'utf8' });

// Datei so schreiben, dass Zeilenenden (CRLF/LF) erhalten bleiben
function setVersion(file, version) {
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, fallback = '') => (await rl.question(fallback ? `${q} [${fallback}]: ` : `${q}: `)).trim() || fallback;

  // GitHub-CLI angemeldet?
  if (quiet('gh auth status').status !== 0) {
    console.log('\nDie GitHub-CLI ist nicht angemeldet. Einmal „gh auth login“ ausführen und dann noch mal starten.');
    rl.close();
    return;
  }

  const current = JSON.parse(fs.readFileSync(PKG, 'utf8')).version;
  const [a, b, c] = current.split('.').map(Number);
  const released = quiet(`gh release view v${current} -R ${REPO}`).status === 0;
  // Ist die aktuelle Version schon veröffentlicht, die nächste vorschlagen – sonst diese
  const suggestion = released ? `${a}.${b}.${c + 1}` : current;

  console.log(`\nAktuelle Version: ${current}${released ? ' (schon veröffentlicht)' : ' (noch nicht veröffentlicht)'}`);
  const version = await ask('Neue Versionsnummer', suggestion);
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.log('Bitte im Format 1.2.3 eingeben.');
    rl.close();
    return;
  }
  if (quiet(`gh release view v${version} -R ${REPO}`).status === 0) {
    console.log(`Version ${version} gibt es auf GitHub schon. Bitte eine höhere Nummer nehmen.`);
    rl.close();
    return;
  }
  const notes = await ask('Was ist neu? (eine Zeile)', 'Verbesserungen und Fehlerbehebungen');

  const setup = path.join(ROOT, 'dist', `Ventoview-Setup-${version}.exe`);
  let build = true;
  if (fs.existsSync(setup) && version === current) {
    build = /^j/i.test(await ask('Das Setup gibt es schon. Trotzdem neu bauen? (j/n)', 'n'));
  }
  const push = /^j/i.test(await ask('Code danach auch auf GitHub sichern (git commit + push)? (j/n)', 'n'));
  rl.close();

  console.log(`\n1/4  Version ${version} eintragen …`);
  setVersion(PKG, version);

  if (build) {
    console.log('2/4  Setup bauen (dauert ein paar Minuten) …');
    run('npm.cmd run dist', { shell: true });
  } else {
    console.log('2/4  Setup ist schon gebaut – übersprungen.');
  }
  for (const file of [setup, `${setup}.blockmap`, path.join(ROOT, 'dist', 'latest.yml')]) {
    if (!fs.existsSync(file)) throw new Error(`Datei fehlt: ${file}`);
  }

  console.log('3/4  GitHub-Release anlegen und hochladen …');
  const files = [`dist/Ventoview-Setup-${version}.exe`, `dist/Ventoview-Setup-${version}.exe.blockmap`, 'dist/latest.yml'];
  const result = spawnSync('gh', ['release', 'create', `v${version}`, ...files, '-R', REPO, '--title', `Ventoview ${version}`, '--notes', notes],
    { cwd: ROOT, stdio: 'inherit', shell: false });
  if (result.status !== 0) throw new Error('Das Release konnte nicht angelegt werden (siehe Meldung oben).');

  console.log('4/4  Download-Knopf der Webseite auf die neue Version stellen …');
  if (fs.existsSync(WEB_APP_JSON)) setVersion(WEB_APP_JSON, version);
  else console.log(`     ${WEB_APP_JSON} nicht gefunden – dort bitte die Version von Hand eintragen.`);

  if (push) {
    console.log('\nCode sichern …');
    for (const dir of [ROOT, path.join(ROOT, '..', 'VentoviewWeb')]) {
      if (!fs.existsSync(path.join(dir, '.git'))) continue;
      run('git add -A', { cwd: dir });
      if (quiet(`git -C "${dir}" diff --cached --quiet`).status !== 0) run(`git commit -m "Version ${version}: ${notes.replace(/"/g, "'")}"`, { cwd: dir });
      run('git push', { cwd: dir });
    }
  }

  console.log(`\nFertig! Ventoview ${version} ist veröffentlicht.`);
  console.log('Installierte Apps finden das Update von selbst, der Download auf der Webseite zeigt auf das neue Setup.');
}

main().catch((err) => {
  console.error(`\nAbgebrochen: ${err.message}`);
  process.exitCode = 1;
});
