import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
process.env.JMS_DEV_MODE = '1';
// Keep watched output separate from release builds, including on Windows/Linux.
process.env.ELECTRON_ENTRY = join(root, 'out-dev/main/index.js');

if (process.platform === 'darwin') {
  const electron = require('electron');
  const source = resolve(dirname(electron), '../..');
  const cache = join(root, '.cache/desktop-dev');
  const name = 'JumpServer Desktop Dev';
  const bundle = join(cache, `${name}.app`);
  const stamp = join(cache, 'shell-version');
  const version = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url)))
    .update(electron).update(require('electron/package.json').version).update(process.arch).digest('hex');
  const executable = join(bundle, 'Contents/MacOS', name);
  const current = await readFile(stamp, 'utf8').catch(() => '');
  const { access } = await import('node:fs/promises');
  if (current !== version || !(await access(executable).then(() => true, () => false))) {
    await mkdir(cache, { recursive: true });
    const lock = join(cache, 'preparing');
    try { await mkdir(lock); }
    catch { throw new Error(`开发外壳正在准备；若上次准备被中断，请删除 ${lock} 后重试。`); }
    const temporary = join(cache, `${name}.building.app`);
    try {
      console.log('Preparing macOS development app (cached between runs)…');
      await rm(temporary, { recursive: true, force: true });
      // APFS copy-on-write clone: no changes to the installed Electron package.
      await run('/bin/cp', ['-cR', source, temporary]);
      const contents = join(temporary, 'Contents');
      const plist = join(contents, 'Info.plist');
      for (const [key, value] of Object.entries({ CFBundleDisplayName: name, CFBundleName: name,
        CFBundleExecutable: name, CFBundleIdentifier: 'org.jumpserver.community.desktop.dev' })) {
        await run('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
      }
      await run('/usr/bin/plutil', ['-insert', 'CFBundleURLTypes', '-json', JSON.stringify([
        { CFBundleURLName: 'JumpServer Development OAuth', CFBundleURLSchemes: ['jms'], CFBundleTypeRole: 'Editor' }
      ]), plist]);
      await run('/usr/bin/plutil', ['-remove', 'ElectronAsarIntegrity', plist]);
      await rename(join(contents, 'MacOS/Electron'), join(contents, 'MacOS', name));
      await rm(join(contents, 'Resources/default_app.asar'));
      const appDir = join(contents, 'Resources/app');
      await mkdir(appDir);
      await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'jumpserver-desktop-dev', version: '0.1.0', main: 'index.cjs' }));
      await writeFile(join(appDir, 'index.cjs'), `const { app, dialog } = require('electron');
const { pathToFileURL } = require('node:url');
process.env.JMS_DEV_MODE = '1';
if (!process.env.ELECTRON_RENDERER_URL) {
  app.whenReady().then(() => { dialog.showErrorBox('开发服务未启动', '请在项目目录运行 pnpm dev；开发外壳不单独启动，也不会接受未发起的 OAuth 回调。'); app.quit(); });
} else {
  app.setAppPath(${JSON.stringify(root)});
  import(pathToFileURL(${JSON.stringify(join(root, 'out-dev/main/index.js'))}).href).catch(error => { console.error(error); app.exit(1); });
}
`);
      await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', temporary]);
      await rm(bundle, { recursive: true, force: true });
      await rename(temporary, bundle);
      await writeFile(stamp, version);
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
  process.env.ELECTRON_EXEC_PATH = executable;
  console.log(`Development app: ${bundle}`);
}

// Run electron-vite's CLI in this process: its existing watcher owns Electron
// restarts and terminal signal handling, rather than adding another supervisor.
const cli = join(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js');
process.argv = [process.argv[0], cli, 'dev', '--watch', ...process.argv.slice(2)];
await import(pathToFileURL(cli).href);
