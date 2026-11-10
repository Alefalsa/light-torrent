import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const appName = 'Light Torrent Safari';
const service = 'com.lighttorrent.safari.launcher';

export function safariManifest(manifest) {
  const { minimum_chrome_version, content_scripts, ...shared } = manifest;
  return {
    ...shared,
    permissions: ['nativeMessaging', 'scripting'],
    host_permissions: ['http://*/*', 'https://*/*'],
    background: { service_worker: 'safari-background.js' },
    browser_specific_settings: { safari: { strict_min_version: '18.4' } }
  };
}

function xml(value) {
  return value.replace(/[<>&"']/g, character => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
  })[character]);
}

export function launchAgent(app, log) {
  const executable = path.join(app, 'Contents', 'Library', 'LoginItems', 'Light Torrent Helper.app', 'Contents', 'MacOS', appName);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${service}</string>
<key>ProgramArguments</key><array><string>${xml(executable)}</string><string>--native-host</string></array>
<key>MachServices</key><dict><key>${service}</key><true/></dict>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
<key>ProcessType</key><string>Interactive</string>
</dict></plist>
`;
}

async function stopAgent(domain) {
  try {
    await execute('/bin/launchctl', ['print', `${domain}/${service}`]);
  } catch (error) {
    if (/Could not find service/.test(error.stderr || '')) return;
    throw error;
  }
  await execute('/bin/launchctl', ['bootout', `${domain}/${service}`]);
}

async function install() {
  if (process.platform !== 'darwin') throw new Error('Safari installation requires macOS.');
  await execute('/usr/bin/xcrun', ['--find', 'safari-web-extension-converter']);
  await access(path.join(root, 'node_modules', 'webtorrent', 'package.json'));
  const build = await mkdtemp(path.join(os.tmpdir(), 'light-torrent-safari-'));
  try {
    const extension = path.join(build, 'extension');
    await cp(path.join(root, 'extension'), extension, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
    await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(safariManifest(manifest), null, 2) + '\n');
    const generated = path.join(build, 'project');
    const converted = await execute('/usr/bin/xcrun', [
      'safari-web-extension-converter', extension, '--project-location', generated,
      '--app-name', appName, '--bundle-identifier', 'com.lighttorrent.safari',
      '--swift', '--macos-only', '--copy-resources', '--no-open', '--no-prompt'
    ]);
    process.stdout.write(converted.stdout);
    const project = path.join(generated, appName);
    const common = await readFile(new URL('Bridge.swift', import.meta.url), 'utf8');
    for (const [source, target] of [
      ['AppDelegate.swift', appName],
      ['SafariWebExtensionHandler.swift', `${appName} Extension`]
    ]) {
      const code = await readFile(new URL(source, import.meta.url), 'utf8');
      await writeFile(path.join(project, target, source), common + '\n' + code);
    }
    await writeFile(path.join(project, appName, 'ViewController.swift'), 'import Cocoa\n');
    let projectFile = path.join(project, `${appName}.xcodeproj`, 'project.xcproj');
    let projectSource;
    try {
      projectSource = await readFile(projectFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      projectFile = path.join(project, `${appName}.xcodeproj`, 'project.pbxproj');
      projectSource = await readFile(projectFile, 'utf8');
    }
    // Some converter versions derive the app identifier from its display name.
    await writeFile(projectFile, projectSource.replaceAll('com.lighttorrent.Light-Torrent-Safari', 'com.lighttorrent.safari'));
    console.log('Building the macOS Safari app...');
    const products = path.join(build, 'products');
    try {
      await execute('/usr/bin/xcodebuild', [
        '-project', path.join(project, `${appName}.xcodeproj`), '-scheme', appName,
        '-configuration', 'Release', '-derivedDataPath', path.join(build, 'derived'),
        `CONFIGURATION_BUILD_DIR=${products}`, 'CODE_SIGNING_ALLOWED=NO',
        'ENABLE_APP_SANDBOX=NO', 'SWIFT_DEFAULT_ACTOR_ISOLATION=nonisolated',
        'SWIFT_APPROACHABLE_CONCURRENCY=NO', 'MACOSX_DEPLOYMENT_TARGET=13.0', 'build'
      ], { maxBuffer: 8 * 1024 * 1024 });
    } catch (error) {
      throw new Error(`Safari build failed:\n${error.stdout || ''}\n${error.stderr || error.message}`, { cause: error });
    }
    const builtApp = path.join(products, `${appName}.app`);
    const info = path.join(builtApp, 'Contents', 'Info.plist');
    await execute('/usr/libexec/PlistBuddy', ['-c', 'Delete :NSMainStoryboardFile', info]);
    await execute('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier com.lighttorrent.safari', info]);
    const helper = path.join(builtApp, 'Contents', 'Library', 'LoginItems', 'Light Torrent Helper.app');
    await mkdir(path.join(helper, 'Contents', 'MacOS'), { recursive: true });
    await mkdir(path.join(helper, 'Contents', 'Resources'), { recursive: true });
    await cp(path.join(builtApp, 'Contents', 'MacOS', appName), path.join(helper, 'Contents', 'MacOS', appName));
    await writeFile(path.join(helper, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${service}</string>
<key>CFBundleExecutable</key><string>${appName}</string>
<key>CFBundleName</key><string>Light Torrent Helper</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
`);
    await writeFile(path.join(helper, 'Contents', 'Resources', 'NativeHost.json'),
      JSON.stringify({ node: process.execPath, root }) + '\n');
    const appex = path.join(builtApp, 'Contents', 'PlugIns', `${appName} Extension.appex`);
    await execute('/usr/bin/codesign', [
      '--force', '--sign', '-', '--entitlements', fileURLToPath(new URL('Extension.entitlements', import.meta.url)), appex
    ]);
    await execute('/usr/bin/codesign', ['--force', '--sign', '-', helper]);
    await execute('/usr/bin/codesign', ['--force', '--sign', '-', builtApp]);
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', builtApp]);
    const home = os.homedir();
    const applications = path.join(home, 'Applications');
    await mkdir(applications, { recursive: true });
    const installedApp = path.join(applications, `${appName}.app`);
    try {
      await access(installedApp);
      const existing = await execute('/usr/libexec/PlistBuddy',
        ['-c', 'Print :CFBundleIdentifier', path.join(installedApp, 'Contents', 'Info.plist')]);
      if (existing.stdout.trim() !== 'com.lighttorrent.safari') {
        throw new Error(`Refusing to overwrite an unrelated app at ${installedApp}.`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const domain = `gui/${process.getuid()}`;
    await stopAgent(domain);
    await rm(installedApp, { recursive: true, force: true });
    await cp(builtApp, installedApp, { recursive: true });
    const agents = path.join(home, 'Library', 'LaunchAgents');
    const logs = path.join(home, 'Library', 'Logs', 'Light Torrent');
    await mkdir(agents, { recursive: true });
    await mkdir(logs, { recursive: true, mode: 0o700 });
    const agent = path.join(agents, `${service}.plist`);
    await writeFile(agent, launchAgent(installedApp, path.join(logs, 'safari-helper.log')), { mode: 0o600 });
    await execute('/usr/bin/plutil', ['-lint', agent]);
    await execute('/bin/launchctl', ['bootstrap', domain, agent]);
    const checked = await execute(path.join(installedApp, 'Contents', 'MacOS', appName), ['--check-bridge'], { timeout: 20000 });
    process.stdout.write(checked.stdout);
    await execute('/usr/bin/pluginkit', ['-a', appex.replace(builtApp, installedApp)]);
    console.log(`Installed: ${installedApp}`);
    console.log('Open the installed app, enable Safari Settings > Developer > Allow unsigned extensions, then enable Light Torrent in Settings > Extensions and grant website access.');
    console.log('Reload existing website tabs after enabling or rebuilding the extension.');
  } finally {
    await rm(build, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
