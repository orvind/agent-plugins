#!/usr/bin/env node
// Launcher for the Orvind Exporter's command-line driver
// (GameplayRecorder.Editor.HeadlessRecording). It finds the Unity Editor for a project, starts a
// job (rehearse, record, approve, discard, complete), waits for it and prints one JSON result.
// No dependencies; Node 18 or newer.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const DRIVER = 'GameplayRecorder.Editor.HeadlessRecording';
const PACKAGE_NAME = 'com.gameplay.recorder';
const JOBS_FOLDER = '.orvind_agent';
const EXPECTED_STATES = new Set(['finalized', 'rehearsed', 'awaiting-review', 'awaiting-agent', 'discarded', 'status', 'checked']);
const POLL_MS = 500;

// The recorder package ships with this skill, one tarball per Unity version (packages/index.json lists them).
// package-sources.json can name a download for a Unity version that is not bundled; ffmpeg-sources.json names
// the FFmpeg builds to download for a machine that has none. All three are data next to the skill.
const SKILL_FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED_PACKAGES_FOLDER = path.join(SKILL_FOLDER, 'packages');
const PACKAGE_SOURCES_FILE = path.join(SKILL_FOLDER, 'package-sources.json');
const FFMPEG_SOURCES_FILE = path.join(SKILL_FOLDER, 'ffmpeg-sources.json');
const MAX_PACKAGE_BYTES = 600 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

const USAGE = `Orvind Exporter launcher

  preflight --project <dir> [--scene <Assets/...unity>]
  rehearse  --project <dir> --scene <Assets/...unity> [--script <file.json>] [--duration <s>] [--size <WxH>] [--seed <n>]
            [--fps <n>] [--frame-interval <s>] [--frame-size <px>] [--keep-save] [--watch]
  record    --project <dir> --scene <Assets/...unity> --script <file.json> [--duration <s>] [--size <WxH>] [--seed <n>]
            [--fps <n>] [--csharp attached|all|exclude|metadata] [--no-review] [--frame-interval <s>] [--frame-size <px>]
            [--keep-save] [--watch]
  record    --project <dir> --scene <Assets/...unity> --interactive [--max-duration <s>] [--size <WxH>] [--fps <n>] [--csharp ...]
  open      --job <dir>                      open the preview video of a job that awaits review in the user's video
                                             player (only when the user asked for it)
  approve   --job <dir>                      continue a reviewed recording to the script hand-off
  discard   --job <dir> --confirm            delete a reviewed recording the user rejected
  check     --job <dir>                      validate the script documents without finishing (run it as often as needed)
  complete  --job <dir>                      validate the script documents and finalize the session
  status    --job <dir>                      current state of a job (does not start Unity)
  wait      --job <dir> [--timeout <s>]      wait for a detached job
  help                                       this text
  cancel    --job <dir>                      stop the Unity process of a job
  jobs      --project <dir>                  list the jobs of this project and the state each one is in
  pending   --project <dir> [--set-aside]    report (or set aside) an unfinished export that blocks new recordings (starts Unity)
  clean     --project <dir>                  delete the job folders of rehearsals (logs and frames; never a recording)
  install   --project <dir> [--package <folder or .tgz> | --url <https url> --sha256 <checksum>]
                                             add the recorder package to the project manifest; without --package or
                                             --url it installs the build this plugin carries for the project's Unity version
  uninstall --project <dir>                  remove the recorder package again, when this launcher installed it
  install-ffmpeg [--force]                   download FFmpeg for this machine when none is found (the recorder needs
                                             it for the video's audio on macOS and Linux)
  update                                     install the current version of this plugin when a newer one is published
                                             (preflight, rehearse and record refuse to work with an outdated one)

Common options: --unity <path to the Unity executable>, --output <dir> (default <project>/ExportedData/GameplayRecording),
--detach (return at once; use wait/status), --timeout <s>, --on-pending fail|setaside.
--size defaults to the project's orientation (preflight: suggestedSize). --fps is the video frame rate (default 30); a
rehearsal and a scripted recording both run the game at exactly that rate, so they behave the same.
--csharp chooses which C# sources the recording exports for the gameplay brief: attached (default: the scripts on the
objects seen during the recording and the project scripts those use), all (every script of the project), exclude (none)
or metadata. --no-review skips the review gate. --seed fixes UnityEngine.Random.
A rehearsal or scripted recording puts the game's saved data (PlayerPrefs and its persistent data folder) back the way it
was before the run, so every run starts from the same state and the user's own progress is untouched; --keep-save
leaves what the run saved. A recording the user plays (--interactive) always keeps what they saved.
A rehearsal and a scripted recording run in the background: the game's sound is not sent to the speakers, and on macOS
the Editor's Game view window is invisible and takes no clicks. The recording is the same, and the video keeps its audio.
--watch shows the window and plays the sound (to watch the script play).
Every command prints one JSON object. "ok": false means the command did not do what was asked.`;

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

const FLAGS = new Set(['interactive', 'no-review', 'confirm', 'detach', 'set-aside', 'keep-save', 'watch', 'force', 'help']);

export function parseArgs(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      options._.push(token);
      continue;
    }

    const name = token.slice(2);
    if (FLAGS.has(name)) {
      options[name] = true;
      continue;
    }

    if (i + 1 >= argv.length) {
      throw new UsageError(`--${name} needs a value.`);
    }

    options[name] = argv[++i];
  }

  return options;
}

class UsageError extends Error {}

function required(options, name) {
  if (options[name] === undefined || options[name] === '') {
    throw new UsageError(`--${name} is required.`);
  }

  return options[name];
}

export function parseSize(text) {
  const match = /^(\d{2,5})[xX](\d{2,5})$/.exec(String(text || ''));
  if (!match) {
    throw new UsageError('--size must look like 1280x720.');
  }

  return { width: Number(match[1]), height: Number(match[2]) };
}

function numberOption(options, name, fallback) {
  if (options[name] === undefined) {
    return fallback;
  }

  const value = Number(options[name]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError(`--${name} must be a positive number.`);
  }

  return value;
}

// ---------------------------------------------------------------------------------------------
// Project inspection
// ---------------------------------------------------------------------------------------------

function resolveProject(options) {
  const project = path.resolve(required(options, 'project'));
  if (!fs.existsSync(path.join(project, 'Assets')) || !fs.existsSync(path.join(project, 'ProjectSettings'))) {
    throw new UsageError(`Not a Unity project (no Assets and ProjectSettings folders): ${project}`);
  }

  return project;
}

export function readUnityVersion(project) {
  try {
    const text = fs.readFileSync(path.join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8');
    const match = /m_EditorVersion:\s*(\S+)/.exec(text);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function hubInstallRoots() {
  const roots = [];
  const home = os.homedir();
  if (process.platform === 'darwin') {
    roots.push('/Applications/Unity/Hub/Editor');
    roots.push(readSecondaryInstallPath(path.join(home, 'Library', 'Application Support', 'UnityHub', 'secondaryInstallPath.json')));
  } else if (process.platform === 'win32') {
    roots.push('C:\\Program Files\\Unity\\Hub\\Editor');
    roots.push(readSecondaryInstallPath(path.join(process.env.APPDATA || '', 'UnityHub', 'secondaryInstallPath.json')));
  } else {
    roots.push(path.join(home, 'Unity', 'Hub', 'Editor'));
    roots.push(readSecondaryInstallPath(path.join(home, '.config', 'UnityHub', 'secondaryInstallPath.json')));
  }

  return roots.filter(Boolean);
}

function readSecondaryInstallPath(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function editorExecutable(root, version) {
  if (process.platform === 'darwin') {
    return path.join(root, version, 'Unity.app', 'Contents', 'MacOS', 'Unity');
  }

  if (process.platform === 'win32') {
    return path.join(root, version, 'Editor', 'Unity.exe');
  }

  return path.join(root, version, 'Editor', 'Unity');
}

/** The Unity executable for the project's Editor version: --unity, UNITY_EDITOR, then the Hub install folders. */
export function findUnity(version, override) {
  const explicit = override || process.env.UNITY_EDITOR;
  if (explicit) {
    return fs.existsSync(explicit) ? { path: explicit, source: override ? '--unity' : 'UNITY_EDITOR' } : { path: null, tried: [explicit] };
  }

  const tried = [];
  for (const root of hubInstallRoots()) {
    const candidate = editorExecutable(root, version || '');
    tried.push(candidate);
    if (version && fs.existsSync(candidate)) {
      return { path: candidate, source: 'Unity Hub' };
    }
  }

  return { path: null, tried };
}

/** Reads one "key: value" scalar from a Unity YAML settings file. */
export function readYamlScalar(text, key) {
  const match = new RegExp(`^\\s*${key}:\\s*(.*)$`, 'm').exec(text);
  return match ? match[1].trim() : null;
}

/**
 * A render size for unattended runs: portrait when the project is locked to portrait, landscape
 * otherwise. Orientation values: 0 portrait, 1 portrait upside down, 2 and 3 landscape, 4 auto-rotation.
 */
export function suggestSize(settingsText) {
  const orientation = Number(readYamlScalar(settingsText, 'defaultScreenOrientation'));
  const allow = (name) => readYamlScalar(settingsText, name) === '1';
  const portrait =
    orientation === 0 || orientation === 1 ||
    (orientation === 4 &&
      (allow('allowedAutorotateToPortrait') || allow('allowedAutorotateToPortraitUpsideDown')) &&
      !allow('allowedAutorotateToLandscapeRight') && !allow('allowedAutorotateToLandscapeLeft'));
  return portrait ? { width: 720, height: 1280, orientation: 'portrait' } : { width: 1280, height: 720, orientation: 'landscape' };
}

const INPUT_HANDLING = { 0: 'legacy Input Manager', 1: 'Input System', 2: 'both' };

function listFiles(root, extension, limit, skip) {
  const found = [];
  const stack = [root];
  while (stack.length > 0 && found.length < limit) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !(skip && skip(entry.name))) {
          stack.push(full);
        }
      } else if (entry.name.endsWith(extension)) {
        found.push(full);
        if (found.length >= limit) {
          break;
        }
      }
    }
  }

  return found;
}

const LEGACY_KEY_PATTERN = /\bInput\.(GetKey|GetKeyDown|GetKeyUp|GetAxis|GetAxisRaw|GetButton|GetButtonDown|GetButtonUp)\s*\(/;
const LEGACY_POINTER_PATTERN = /\bInput\.(GetMouseButton|GetMouseButtonDown|GetMouseButtonUp|mousePosition|touchCount|GetTouch|touches)\b/;
const INPUT_SYSTEM_PATTERN = /\b(Keyboard|Mouse|Touchscreen|Pointer|Gamepad)\.current\b|\bInputAction\b|\bPlayerInput\b|EnhancedTouch/;

/** Which input APIs the game's own scripts read (Editor and test folders are ignored). */
export function scanInputUsage(project) {
  const usage = { legacyKeysOrAxes: [], legacyPointer: [], inputSystem: [], scriptsScanned: 0 };
  const scripts = listFiles(path.join(project, 'Assets'), '.cs', 4000, (name) => name === 'Editor' || name === 'Tests' || name === 'Plugins');
  for (const file of scripts) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    usage.scriptsScanned++;
    const relative = path.relative(project, file).split(path.sep).join('/');
    if (LEGACY_KEY_PATTERN.test(text)) usage.legacyKeysOrAxes.push(relative);
    if (LEGACY_POINTER_PATTERN.test(text)) usage.legacyPointer.push(relative);
    if (INPUT_SYSTEM_PATTERN.test(text)) usage.inputSystem.push(relative);
  }

  for (const key of ['legacyKeysOrAxes', 'legacyPointer', 'inputSystem']) {
    usage[key] = usage[key].slice(0, 25);
  }

  return usage;
}

function readBuildScenes(project) {
  try {
    const text = fs.readFileSync(path.join(project, 'ProjectSettings', 'EditorBuildSettings.asset'), 'utf8');
    const scenes = [];
    const pattern = /-\s*enabled:\s*(\d)\s*\n\s*path:\s*(.+)/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      scenes.push({ path: match[2].trim(), enabled: match[1] === '1' });
    }

    return scenes;
  } catch {
    return [];
  }
}

/** guid -> project-relative path of every script and prefab under Assets (from their .meta files). */
function buildGuidMap(project) {
  const map = new Map();
  for (const meta of listFiles(path.join(project, 'Assets'), '.meta', 40000)) {
    if (!meta.endsWith('.cs.meta') && !meta.endsWith('.prefab.meta')) {
      continue;
    }

    let head;
    try {
      head = fs.readFileSync(meta, 'utf8').slice(0, 400);
    } catch {
      continue;
    }

    const match = /guid:\s*([0-9a-f]{32})/.exec(head);
    if (match) {
      map.set(match[1], path.relative(project, meta.slice(0, -'.meta'.length)).split(path.sep).join('/'));
    }
  }

  return map;
}

function isTemplateScript(file) {
  return file.includes('/TutorialInfo/') || file.includes('/Editor/');
}

/**
 * What a scene file refers to, read from its YAML without starting Unity: how many objects and
 * canvases it has and which of the project's scripts sit on its objects or on prefabs it
 * references (two levels deep). Scenes saved in binary form cannot be read this way.
 */
export function digestScene(project, scene, guidMap) {
  let text;
  try {
    text = fs.readFileSync(path.join(project, scene), 'utf8');
  } catch {
    return null;
  }

  if (!text.startsWith('%YAML')) {
    return { scene, readable: false };
  }

  const scripts = new Set();
  const prefabs = new Set();
  const visit = (content, depth) => {
    for (const match of content.matchAll(/guid:\s*([0-9a-f]{32})/g)) {
      const target = guidMap.get(match[1]);
      if (!target) {
        continue;
      }

      if (target.endsWith('.cs')) {
        scripts.add(target);
      } else if (target.endsWith('.prefab') && !prefabs.has(target)) {
        prefabs.add(target);
        if (depth < 2) {
          try {
            visit(fs.readFileSync(path.join(project, target), 'utf8'), depth + 1);
          } catch {
            // An unreadable prefab is skipped.
          }
        }
      }
    }
  };
  visit(text, 0);

  return {
    scene,
    readable: true,
    gameObjects: (text.match(/^--- !u!1 &/gm) || []).length,
    canvases: (text.match(/^--- !u!223 &/gm) || []).length,
    prefabsReferenced: prefabs.size,
    scripts: [...scripts].filter((file) => !isTemplateScript(file)).sort().slice(0, 60),
  };
}

function readRecorderPackage(project) {
  const embedded = path.join(project, 'Packages', PACKAGE_NAME);
  let manifestEntry = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(project, 'Packages', 'manifest.json'), 'utf8'));
    manifestEntry = manifest.dependencies ? manifest.dependencies[PACKAGE_NAME] || null : null;
  } catch {
    manifestEntry = null;
  }

  let root = null;
  if (fs.existsSync(embedded)) {
    root = embedded;
  } else if (manifestEntry && manifestEntry.startsWith('file:') && !manifestEntry.endsWith('.tgz')) {
    root = path.resolve(project, 'Packages', manifestEntry.slice('file:'.length));
  }

  let version = null;
  if (root) {
    try {
      version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || null;
    } catch {
      version = null;
    }
  } else if (manifestEntry && manifestEntry.startsWith('file:') && manifestEntry.endsWith('.tgz')) {
    const described = readTarballManifest(path.resolve(project, 'Packages', manifestEntry.slice('file:'.length)));
    version = described ? described.version || null : null;
  }

  // A manifest line that points at a folder or tarball which is gone: Unity cannot resolve the project's
  // packages at all then, so nothing can run until the line is replaced.
  let missing = null;
  if (!fs.existsSync(embedded) && manifestEntry && manifestEntry.startsWith('file:')) {
    const target = path.resolve(project, 'Packages', manifestEntry.slice('file:'.length));
    if (!fs.existsSync(target)) {
      missing = target;
    }
  }

  const described = {
    installed: Boolean(root || manifestEntry) && !missing,
    source: fs.existsSync(embedded) ? 'embedded in Packages/' : manifestEntry,
    version,
  };
  if (missing) {
    described.missing = missing;
  }

  return described;
}

/**
 * The installed package. For a project without it: the build this plugin carries for its Unity version
 * (`bundled`), or else a download (`download`). For a project that has another build than the plugin carries:
 * `updateAvailable`.
 */
function describeRecorderPackage(project, unityVersion) {
  const described = readRecorderPackage(project);
  const bundled = findBundledPackage(unityVersion);
  if (!described.installed) {
    described.bundled = bundled ? { packageVersion: bundled.packageVersion, bytes: bundled.bytes, unity: bundled.unity } : null;
    const source = bundled ? null : findPackageSource(unityVersion);
    described.download = source ? { url: source.url, packageVersion: source.packageVersion, bytes: source.bytes, unity: source.unity } : null;
  } else if (bundled && typeof described.source === 'string') {
    // A package this launcher installed is named after its checksum.
    const installed = /com\.gameplay\.recorder-([0-9a-f]{16})\.tgz$/.exec(described.source);
    if (installed && installed[1] !== bundled.sha256.slice(0, 16)) {
      described.updateAvailable = { packageVersion: bundled.packageVersion };
    }
  }

  return described;
}

function describeDownload(download) {
  const parts = [];
  if (download.packageVersion) parts.push(`version ${download.packageVersion}`);
  if (download.ffmpegVersion) parts.push(`FFmpeg ${download.ffmpegVersion}`);
  if (download.bytes) parts.push(`${Math.round(download.bytes / 1e6)} MB`);
  try {
    parts.push(`from ${new URL(download.url).hostname}`);
  } catch {
    // The host is a convenience for the question to the user.
  }

  return parts.join(', ');
}

/**
 * The package build this plugin carries for a Unity version: "6000.4.9f1" takes the entry for "6000",
 * "2022.3.62f2" the one for "2022.3". Null when there is none or its file is missing.
 */
export function findBundledPackage(unityVersion, folder = BUNDLED_PACKAGES_FOLDER) {
  const index = readJson(path.join(folder, 'index.json'));
  const packages = index && Array.isArray(index.packages) ? index.packages : [];
  const version = String(unityVersion || '');
  const match = packages
    .filter((entry) => entry && entry.file && entry.sha256 && typeof entry.unity === 'string' && entry.unity.length > 0 &&
      (version === entry.unity || version.startsWith(`${entry.unity}.`)))
    .sort((a, b) => b.unity.length - a.unity.length)[0];
  if (!match) {
    return null;
  }

  const file = path.join(folder, path.basename(match.file));
  return fs.existsSync(file)
    ? { unity: match.unity, file, sha256: String(match.sha256).toLowerCase(), packageVersion: match.packageVersion || null, bytes: match.bytes || null }
    : null;
}

/**
 * Copies the plugin's package tarball into the store and returns { file, copied }. A project's manifest
 * points at the copy, not at the plugin folder, which moves or changes when the plugin is updated.
 */
export function storeBundledPackage(bundled, store = packageStore()) {
  if (sha256OfFile(bundled.file) !== bundled.sha256) {
    throw new Error(`The package file in the plugin does not match its index (${bundled.file}). Reinstall the plugin.`);
  }

  fs.mkdirSync(store, { recursive: true });
  const target = path.join(store, `${PACKAGE_NAME}-${bundled.sha256.slice(0, 16)}.tgz`);
  if (fs.existsSync(target) && sha256OfFile(target) === bundled.sha256) {
    return { file: target, copied: false, bytes: fs.statSync(target).size };
  }

  const partial = `${target}.${process.pid}.part`;
  try {
    fs.copyFileSync(bundled.file, partial);
    fs.renameSync(partial, target);
  } finally {
    fs.rmSync(partial, { force: true });
  }

  return { file: target, copied: true, bytes: fs.statSync(target).size };
}

/**
 * Where downloaded packages are kept. A project's manifest points at the file, so this is not a cache
 * that may be emptied: ORVIND_PACKAGE_DIR, or .orvind/packages in the home folder.
 */
export function packageStore(env = process.env, home = os.homedir()) {
  return env.ORVIND_PACKAGE_DIR ? path.resolve(env.ORVIND_PACKAGE_DIR) : path.join(home, '.orvind', 'packages');
}

/**
 * The download known for a Unity version: "6000.4.9f1" takes the entry for "6000", "2022.3.62f2" the one
 * for "2022.3". The longest matching entry wins. Null when none is configured.
 */
export function findPackageSource(unityVersion, file = PACKAGE_SOURCES_FILE) {
  const table = readJson(file);
  const sources = table && Array.isArray(table.sources) ? table.sources : [];
  const version = String(unityVersion || '');
  const match = sources
    .filter((source) => source && source.url && source.sha256 && typeof source.unity === 'string' && source.unity.length > 0 &&
      (version === source.unity || version.startsWith(`${source.unity}.`)))
    .sort((a, b) => b.unity.length - a.unity.length)[0];
  return match
    ? { unity: match.unity, url: match.url, sha256: String(match.sha256).toLowerCase(), packageVersion: match.packageVersion || null, bytes: match.bytes || null }
    : null;
}

function sha256OfFile(file) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let read;
    while ((read = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(handle);
  }

  return hash.digest('hex');
}

function isAllowedDownloadUrl(url) {
  // Plain http only for a server on this machine (tests).
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return url.protocol === 'https:' || (url.protocol === 'http:' && local);
}

/**
 * Downloads a URL to a file and returns the number of bytes. The file exists afterwards only when its SHA-256
 * is the expected one, so a wrong or tampered download is never used.
 */
async function downloadVerified(url, sha256, target) {
  const expected = String(sha256 || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new UsageError('The SHA-256 checksum must be 64 hexadecimal characters.');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`Not a URL: ${url}`);
  }

  if (!isAllowedDownloadUrl(parsed)) {
    throw new UsageError('Files are only downloaded over https.');
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.${process.pid}.part`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(parsed, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`The download failed: HTTP ${response.status} ${response.statusText}`.trim());
    }

    if (response.url && !isAllowedDownloadUrl(new URL(response.url))) {
      throw new Error('The download was redirected away from https.');
    }

    const hash = crypto.createHash('sha256');
    const handle = fs.openSync(partial, 'w');
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > MAX_PACKAGE_BYTES) {
          throw new Error(`The download is larger than ${MAX_PACKAGE_BYTES / (1024 * 1024)} MB; that is not the expected file.`);
        }

        hash.update(chunk);
        fs.writeSync(handle, chunk);
      }
    } finally {
      fs.closeSync(handle);
    }

    const actual = hash.digest('hex');
    if (actual !== expected) {
      throw new Error(`The downloaded file is not the expected one (SHA-256 ${actual}, expected ${expected}). Nothing was installed.`);
    }

    fs.renameSync(partial, target);
    return bytes;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`The download did not finish within ${DOWNLOAD_TIMEOUT_MS / 60000} minutes.`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
    fs.rmSync(partial, { force: true });
  }
}

/**
 * Downloads a package tarball into the store and returns { file, downloaded, bytes }. A file that is already
 * in the store with the expected checksum is not downloaded again.
 */
export async function downloadPackage(url, sha256, store = packageStore()) {
  const expected = String(sha256 || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new UsageError('The SHA-256 checksum must be 64 hexadecimal characters.');
  }

  const target = path.join(store, `${PACKAGE_NAME}-${expected.slice(0, 16)}.tgz`);
  if (fs.existsSync(target) && sha256OfFile(target) === expected) {
    return { file: target, downloaded: false, bytes: fs.statSync(target).size };
  }

  const bytes = await downloadVerified(url, expected, target);
  return { file: target, downloaded: true, bytes };
}

/** The package.json inside a package tarball; null when tar is missing or the file is not such a tarball. */
export function readTarballManifest(file) {
  const result = spawnSync('tar', ['-xOzf', file, 'package/package.json'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0 || !result.stdout) {
    return null;
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function unityProcesses() {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('powershell', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"name='Unity.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"],
        { encoding: 'utf8' });
      return String(result.stdout || '').split(/\r?\n/).filter(Boolean).map((line) => {
        const tab = line.indexOf('\t');
        return { pid: Number(line.slice(0, tab)), command: line.slice(tab + 1) };
      });
    }

    const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return String(result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const space = line.indexOf(' ');
      return { pid: Number(line.slice(0, space)), command: line.slice(space + 1) };
    }).filter((entry) => /\/Unity(\s|$)|Unity\.app\/Contents\/MacOS\/Unity/.test(entry.command));
  } catch {
    return [];
  }
}

/** The Unity Editor process that has the project open, if any (a project can only be open in one Editor). */
export function findEditorWithProject(project) {
  const wanted = path.resolve(project).toLowerCase();
  for (const entry of unityProcesses()) {
    const command = entry.command.toLowerCase();
    const index = command.indexOf('-projectpath');
    if (index < 0) {
      continue;
    }

    const rest = command.slice(index + '-projectpath'.length).trim().replace(/^"/, '');
    if (rest.startsWith(wanted) && /^("|\s|$|\/\s|\/$)/.test(rest.slice(wanted.length))) {
      return entry.pid;
    }
  }

  return null;
}

function inspectProject(project, options) {
  const version = readUnityVersion(project);
  const unity = findUnity(version, options.unity);
  let settingsText = '';
  try {
    settingsText = fs.readFileSync(path.join(project, 'ProjectSettings', 'ProjectSettings.asset'), 'utf8');
  } catch {
    settingsText = '';
  }

  const handler = Number(readYamlScalar(settingsText, 'activeInputHandler'));
  const usage = scanInputUsage(project);
  const size = suggestSize(settingsText);
  const allScenes = listFiles(path.join(project, 'Assets'), '.unity', 200)
    .map((file) => path.relative(project, file).split(path.sep).join('/'))
    .filter((scene) => !isLeftoverScene(scene)).sort();

  // The build settings may spell a path with another case than the file has; the file's spelling is used everywhere.
  const buildScenes = readBuildScenes(project)
    .map((scene) => ({ ...scene, path: canonicalScenePath(scene.path, allScenes) || scene.path }));
  const openPid = findEditorWithProject(project);
  const legacyAvailable = handler === 0 || handler === 2;
  const inputSystemAvailable = handler === 1 || handler === 2;

  const automation = {
    pointer: 'supported (taps, drags, UI clicks)',
    keyboard: inputSystemAvailable
      ? (usage.legacyKeysOrAxes.length > 0
        ? 'partly: Input System keys can be injected, but these scripts read keys or axes through the legacy Input Manager, which cannot be injected'
        : 'supported through the Input System')
      : 'NOT supported: the project uses only the legacy Input Manager, whose keyboard keys and axes cannot be injected',
    gamepad: inputSystemAvailable ? 'supported through the Input System' : 'not supported (legacy Input Manager only)',
    pointerMode: inputSystemAvailable
      ? 'In the input script use "pointer": "touch" when the game reads Touchscreen or EnhancedTouch only; otherwise leave it out (mouse).'
      : 'Pointer steps are delivered as simulated touches (also seen as mouse button 0).',
  };

  const guidMap = buildGuidMap(project);
  const gameScripts = [...guidMap.values()].filter((file) => file.endsWith('.cs') && !isTemplateScript(file));
  const startScenePath = (buildScenes.find((scene) => scene.enabled) || {}).path || allScenes[0] || null;
  const startSceneDigest = startScenePath ? digestScene(project, startScenePath, guidMap) : null;
  // The scenes the game moves through (enabled build scenes), plus the one named with --scene.
  const digestTargets = buildScenes.filter((scene) => scene.enabled).map((scene) => scene.path).slice(0, 12);
  if (options.scene && !digestTargets.includes(options.scene.replace(/\\/g, '/'))) {
    digestTargets.push(options.scene.replace(/\\/g, '/'));
  }

  const sceneDigests = digestTargets.map((scene) => digestScene(project, scene, guidMap)).filter(Boolean);
  const warnings = [];
  if (gameScripts.length === 0) {
    warnings.push('The project has no gameplay scripts (nothing outside Editor and tutorial template folders). ' +
      'There may be nothing to play: check the scenes before recording anything.');
  }

  if (startSceneDigest && startSceneDigest.readable && startSceneDigest.scripts.length === 0 && startSceneDigest.canvases === 0) {
    // The game may live in a scene that is not in the build settings: look, and name the candidates.
    const others = allScenes.filter((scene) => scene !== startScenePath).slice(0, 40)
      .map((scene) => digestScene(project, scene, guidMap))
      .filter((digest) => digest && digest.readable && (digest.scripts.length > 0 || digest.canvases > 0));
    if (others.length > 0) {
      for (const digest of others.slice(0, 5)) {
        if (!sceneDigests.some((known) => known.scene === digest.scene)) {
          sceneDigests.push(digest);
        }
      }

      warnings.push(`The start scene (${startScenePath}) has no scripted objects and no UI, but ${others.length === 1 ? 'this scene has' : 'these scenes have'}: ` +
        `${others.slice(0, 5).map((digest) => `${digest.scene} (${digest.scripts.length} script(s))`).join(', ')}. ` +
        'Record from the scene that holds the game (pass it as --scene) and tell the user which one you chose.');
    } else {
      warnings.push(`The start scene (${startScenePath}) has no scripted objects and no UI, and no other scene has any. ` +
        'There is nothing to play: do not record, tell the user what you found.');
    }
  }

  const needsHuman = [];
  if (!inputSystemAvailable && usage.legacyKeysOrAxes.length > 0) {
    needsHuman.push('The game reads keyboard keys or axes through the legacy Input Manager; a script cannot press those. ' +
      'If gameplay depends on them, record with --interactive (a person plays).');
  }

  return {
    project,
    unityVersion: version,
    unity: unity.path,
    unityNotFound: unity.path ? undefined : `No Unity ${version} install was found (looked in: ${(unity.tried || []).join(', ')}). Pass --unity <path>.`,
    projectOpenInEditorPid: openPid,
    recorderPackage: describeRecorderPackage(project, version),
    ffmpeg: findFfmpeg(project) || { path: null },
    inputHandling: INPUT_HANDLING[handler] || 'unknown',
    legacyInputAvailable: legacyAvailable,
    inputSystemAvailable,
    inputUsage: usage,
    automation,
    needsHuman,
    warnings,
    gameScriptCount: gameScripts.length,
    sceneDigests,
    companyName: readYamlScalar(settingsText, 'companyName'),
    productName: readYamlScalar(settingsText, 'productName'),
    saveData: describeSaveData(readYamlScalar(settingsText, 'companyName'), readYamlScalar(settingsText, 'productName')),
    suggestedSize: `${size.width}x${size.height}`,
    orientation: size.orientation,
    buildScenes,
    startScene: startScenePath,
    scenes: allScenes,
    outputRoot: outputRoot(project, options),
    scriptsFolder: path.join(outputRoot(project, options), JOBS_FOLDER, 'scripts'),
  };
}

/** Scenes Unity itself leaves behind (test runner, crash recovery); never part of a game. */
function isLeftoverScene(scene) {
  const name = scene.split('/').pop();
  return name.startsWith('InitTestScene') || scene.startsWith('Assets/_Recovery/');
}

/** The scene path as the project spells it (the file system may ignore case; Unity's scene list does not). */
export function canonicalScenePath(scene, scenes) {
  const wanted = String(scene || '').replace(/\\/g, '/');
  return scenes.find((candidate) => candidate === wanted) ||
    scenes.find((candidate) => candidate.toLowerCase() === wanted.toLowerCase()) || null;
}

function outputRoot(project, options) {
  return path.resolve(options.output || path.join(project, 'ExportedData', 'GameplayRecording'));
}

// ---------------------------------------------------------------------------------------------
// The game's saved data
// ---------------------------------------------------------------------------------------------

const SAVE_LIMIT_BYTES = 256 * 1024 * 1024;
const SAVE_LIMIT_FILES = 20000;
const EMPTY_PLIST = /<dict\s*\/>|<dict>\s*<\/dict>/;

/**
 * Where a game played in the Editor keeps its PlayerPrefs and its persistent data on this
 * machine. Both are keyed by company and product name, so a copy of a project shares them with
 * the original, and whatever an automated run saves would otherwise become the user's progress.
 */
export function saveLocations(companyName, productName, platform = process.platform, home = os.homedir(), env = process.env) {
  if (!companyName || !productName) {
    return null;
  }

  if (platform === 'darwin') {
    const domain = `unity.${companyName}.${productName}`;
    return {
      prefs: { kind: 'plist', domain },
      files: path.join(home, 'Library', 'Application Support', companyName, productName),
    };
  }

  if (platform === 'win32') {
    return {
      prefs: { kind: 'registry', key: `HKCU\\Software\\Unity\\UnityEditor\\${companyName}\\${productName}` },
      files: path.join(env.USERPROFILE || home, 'AppData', 'LocalLow', companyName, productName),
    };
  }

  // Linux keeps the prefs file inside the persistent data folder.
  return { prefs: { kind: 'in-files' }, files: path.join(home, '.config', 'unity3d', companyName, productName) };
}

function describeSaveData(companyName, productName) {
  const locations = saveLocations(companyName, productName);
  if (!locations) {
    return { protected: false, note: 'The project has no company or product name, so its saved data cannot be located.' };
  }

  return {
    protected: true,
    playerPrefs: locations.prefs.domain || locations.prefs.key || 'inside the persistent data folder',
    persistentDataPath: locations.files,
    note: 'Rehearsals and scripted recordings put both back as they were before the run (--keep-save turns that off).',
  };
}

/** relative path -> "size:md5" of every regular file below root (symbolic links are not followed). */
export function digestTree(root) {
  if (!fs.existsSync(root)) {
    return { exists: false, files: {} };
  }

  const files = {};
  let bytes = 0;
  let count = 0;
  const stack = [''];
  while (stack.length > 0) {
    const relative = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      let size;
      let hash;
      try {
        const data = fs.readFileSync(path.join(root, child));
        size = data.length;
        hash = crypto.createHash('md5').update(data).digest('hex');
      } catch {
        continue;
      }

      bytes += size;
      count += 1;
      if (bytes > SAVE_LIMIT_BYTES || count > SAVE_LIMIT_FILES) {
        return { exists: true, tooLarge: true, files: {} };
      }

      files[child] = `${size}:${hash}`;
    }
  }

  return { exists: true, files };
}

/** What differs between two digests: [{ file, change: added | removed | changed }], sorted by file. */
export function diffDigests(before, after) {
  const changes = [];
  for (const [file, value] of Object.entries(after.files)) {
    if (!(file in before.files)) {
      changes.push({ file, change: 'added' });
    } else if (before.files[file] !== value) {
      changes.push({ file, change: 'changed' });
    }
  }

  for (const file of Object.keys(before.files)) {
    if (!(file in after.files)) {
      changes.push({ file, change: 'removed' });
    }
  }

  return changes.sort((a, b) => a.file.localeCompare(b.file));
}

/** Writes the PlayerPrefs to a file that can be compared and imported again; true when there are none. */
function exportPrefs(prefs, file) {
  if (prefs.kind === 'plist') {
    // A domain that does not exist exports as an empty dictionary, the same as one without keys.
    const result = spawnSync('defaults', ['export', prefs.domain, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) {
      throw new Error(`defaults export failed: ${String(result.stderr || '').trim()}`);
    }

    const text = String(result.stdout || '');
    fs.writeFileSync(file, text);
    return EMPTY_PLIST.test(text);
  }

  if (prefs.kind === 'registry') {
    fs.rmSync(file, { force: true });
    const result = spawnSync('reg', ['export', prefs.key, file, '/y'], { encoding: 'utf8' });
    return result.status !== 0 || !fs.existsSync(file);
  }

  return true;
}

function sameFileContent(first, second) {
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0));
  return read(first).equals(read(second));
}

// Keys the engine writes on every start (session counters, window placement); not the game's.
const ENGINE_PREFS_KEY = /^(unity\.|unity_connect\.|UnityGraphicsQuality|Screenmanager |UnitySelectMonitor)/;

/** key -> value text of an exported PlayerPrefs file (an XML property list, or a Windows .reg export). */
export function readPrefsKeys(file) {
  const keys = {};
  if (!fs.existsSync(file)) {
    return keys;
  }

  const data = fs.readFileSync(file);
  if (file.endsWith('.reg')) {
    const lines = (data[0] === 0xff && data[1] === 0xfe ? data.toString('utf16le') : data.toString('utf8')).split(/\r?\n/);
    let current = null;
    for (const line of lines) {
      const match = /^"(.+?)(?:_h\d+)?"=(.*)$/.exec(line);
      if (match) {
        current = match[1];
        keys[current] = match[2];
      } else if (current && /^\s+[0-9a-f,\\ ]+$/i.test(line)) {
        // A long value continues on the next lines.
        keys[current] += line.trim();
      } else {
        current = null;
      }
    }

    return keys;
  }

  const pattern = /<key>([\s\S]*?)<\/key>\s*(?:<(\w+)>([\s\S]*?)<\/\2>|<(\w+)\/>)/g;
  let match;
  while ((match = pattern.exec(data.toString('utf8'))) !== null) {
    keys[match[1]] = match[2] ? `${match[2]}:${match[3]}` : match[4];
  }

  return keys;
}

/** The game's own PlayerPrefs keys whose value differs between two exports. */
export function changedPrefsKeys(beforeFile, afterFile) {
  const before = readPrefsKeys(beforeFile);
  const after = readPrefsKeys(afterFile);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => before[key] !== after[key] && !ENGINE_PREFS_KEY.test(key))
    .sort();
}

function importPrefs(prefs, file, empty) {
  if (prefs.kind === 'plist') {
    // Import merges, so the keys the run added have to go first.
    spawnSync('defaults', ['delete', prefs.domain], { encoding: 'utf8' });
    if (!empty) {
      const result = spawnSync('defaults', ['import', prefs.domain, file], { encoding: 'utf8' });
      if (result.status !== 0) {
        throw new Error(`defaults import failed: ${String(result.stderr || '').trim()}`);
      }
    }
  } else if (prefs.kind === 'registry') {
    spawnSync('reg', ['delete', prefs.key, '/f'], { encoding: 'utf8' });
    if (!empty) {
      const result = spawnSync('reg', ['import', file], { encoding: 'utf8' });
      if (result.status !== 0) {
        throw new Error(`reg import failed: ${String(result.stderr || '').trim()}`);
      }
    }
  }
}

/**
 * Copies the game's saved data into the job folder before an automated run. Returns the record
 * that restoreSave needs; nothing outside the job folder is written.
 */
export function backupSave(jobDirectory, locations) {
  const directory = path.join(jobDirectory, 'save_before');
  fs.mkdirSync(directory, { recursive: true });
  const prefsFile = path.join(directory, locations.prefs.kind === 'registry' ? 'prefs.reg' : 'prefs.plist');
  const prefsEmpty = exportPrefs(locations.prefs, prefsFile);
  const digest = digestTree(locations.files);
  if (digest.exists && !digest.tooLarge) {
    fs.cpSync(locations.files, path.join(directory, 'files'), { recursive: true, preserveTimestamps: true });
  }

  return {
    locations,
    directory,
    takenAt: new Date().toISOString(),
    prefsFile,
    prefsEmpty,
    files: digest,
    restored: false,
  };
}

/**
 * Puts the saved data back the way backupSave found it. What the run saved is kept in the job
 * folder (save_after) and the user's copy is only replaced by the backup of itself, so nothing
 * is lost either way. Returns what the run had changed.
 */
export function restoreSave(save) {
  const outcome = { restored: true, playerPrefsChanged: [], filesChanged: [] };
  const after = path.join(path.dirname(save.directory), 'save_after');
  fs.mkdirSync(after, { recursive: true });

  const prefsNow = path.join(after, path.basename(save.prefsFile));
  exportPrefs(save.locations.prefs, prefsNow);
  if (!sameFileContent(prefsNow, save.prefsFile)) {
    // Everything goes back, the engine's own session counters included; only the game's keys are reported.
    outcome.playerPrefsChanged = changedPrefsKeys(save.prefsFile, prefsNow).slice(0, 40);
    importPrefs(save.locations.prefs, save.prefsFile, save.prefsEmpty);
  }

  if (save.files.tooLarge) {
    outcome.filesNote = 'The persistent data folder is too large to protect; it was left as the run saved it.';
  } else {
    const now = digestTree(save.locations.files);
    const changes = now.tooLarge ? [{ file: '(many new files)', change: 'added' }] : diffDigests(save.files, now);
    if (changes.length > 0) {
      outcome.filesChanged = changes.slice(0, 40);
      if (now.exists) {
        moveDirectory(save.locations.files, path.join(after, 'files'));
      }

      if (save.files.exists) {
        fs.cpSync(path.join(save.directory, 'files'), save.locations.files, { recursive: true, preserveTimestamps: true });
      }
    }
  }

  outcome.note = outcome.playerPrefsChanged.length > 0 || outcome.filesChanged.length > 0
    ? 'The game saved progress during the run (the listed PlayerPrefs keys and files). It was put back as it was before, ' +
      'so the next run starts from the same state; what the run saved is in the job folder (save_after).'
    : 'The game saved nothing during the run.';
  return outcome;
}

function moveDirectory(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw error;
    }

    // Another volume: copy first, and only then remove the original.
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// The project's own files
// ---------------------------------------------------------------------------------------------

/** Content hashes of the project settings and package manifests: what a run must leave unchanged. */
export function fingerprintProject(project) {
  const fingerprint = {};
  const add = (relative) => {
    try {
      fingerprint[relative] = crypto.createHash('md5').update(fs.readFileSync(path.join(project, relative))).digest('hex');
    } catch {
      // A file that is not there has no fingerprint.
    }
  };

  try {
    for (const name of fs.readdirSync(path.join(project, 'ProjectSettings')).sort()) {
      if (name.endsWith('.asset') || name.endsWith('.json') || name.endsWith('.txt')) {
        add(`ProjectSettings/${name}`);
      }
    }
  } catch {
    // No settings folder: nothing to compare.
  }

  add('Packages/manifest.json');
  add('Packages/packages-lock.json');
  return fingerprint;
}

export function changedProjectFiles(before, after) {
  const names = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...names].filter((name) => (before || {})[name] !== (after || {})[name]).sort();
}

// ---------------------------------------------------------------------------------------------
// The recorded video
// ---------------------------------------------------------------------------------------------

/** Duration, size and frame rate of a video, read from what ffmpeg prints about it. */
export function parseVideoInfo(text) {
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const video = /Stream #\d+:\d+.*Video:.*?\b(\d{2,5})x(\d{2,5})\b/.exec(text);
  const fps = /Stream #\d+:\d+.*Video:.*?([\d.]+)\s*fps/.exec(text);
  if (!duration || !video) {
    return null;
  }

  return {
    durationSeconds: Math.round(((Number(duration[1]) * 3600) + (Number(duration[2]) * 60) + Number(duration[3])) * 100) / 100,
    width: Number(video[1]),
    height: Number(video[2]),
    fps: fps ? Number(fps[1]) : null,
    hasAudio: /Stream #\d+:\d+.*Audio:/.test(text),
  };
}

function probeVideo(ffmpeg, video) {
  try {
    const result = spawnSync(ffmpeg, ['-hide_banner', '-i', video], { encoding: 'utf8' });
    return parseVideoInfo(String(result.stderr || ''));
  } catch {
    return null;
  }
}

/** The ffmpeg that ships with the recorder package this project uses; null when it cannot be found. */
export function findBundledFfmpeg(project, platform = process.platform, arch = process.arch) {
  const override = process.env.GAMEPLAY_RECORDER_FFMPEG;
  if (override && fs.existsSync(override)) {
    return override;
  }

  const roots = [path.join(project, 'Packages', PACKAGE_NAME)];
  const manifest = readJson(path.join(project, 'Packages', 'manifest.json'));
  const entry = manifest && manifest.dependencies ? manifest.dependencies[PACKAGE_NAME] : null;
  if (typeof entry === 'string' && entry.startsWith('file:') && !entry.endsWith('.tgz')) {
    roots.push(path.resolve(project, 'Packages', entry.slice('file:'.length)));
  }

  try {
    for (const name of fs.readdirSync(path.join(project, 'Library', 'PackageCache'))) {
      if (name === PACKAGE_NAME || name.startsWith(`${PACKAGE_NAME}@`)) {
        roots.push(path.join(project, 'Library', 'PackageCache', name));
      }
    }
  } catch {
    // No package cache: the package is embedded or referenced by path.
  }

  const builds = platform === 'darwin'
    ? [['macos', arch === 'arm64' ? 'arm64' : 'x64', 'ffmpeg'], ['macos', 'x64', 'ffmpeg']]
    : platform === 'win32' ? [['windows', 'x64', 'ffmpeg.exe']] : [];
  for (const root of roots) {
    for (const build of builds) {
      const candidate = path.join(root, 'ThirdParty', 'ffmpeg', 'bin', ...build);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

/**
 * Where FFmpeg may already be on this machine, in the order the recorder itself looks (FfmpegLocations in the
 * package): the copy this launcher keeps for the user, PATH, then the folders package managers install into.
 */
export function installedFfmpegCandidates(env = process.env, home = os.homedir(), platform = process.platform) {
  const windows = platform === 'win32';
  const join = windows ? path.win32.join : path.posix.join;
  const executable = windows ? 'ffmpeg.exe' : 'ffmpeg';
  const folders = [env.ORVIND_FFMPEG_DIR || join(home, '.orvind', 'ffmpeg')];
  for (const folder of String(env.PATH || env.Path || '').split(windows ? ';' : ':')) {
    folders.push(folder.trim().replace(/^"|"$/g, ''));
  }

  if (windows) {
    folders.push(
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : '',
      env.ProgramData ? join(env.ProgramData, 'chocolatey', 'bin') : '',
      join(home, 'scoop', 'shims'),
      env.ProgramFiles ? join(env.ProgramFiles, 'ffmpeg', 'bin') : '');
  } else {
    folders.push('/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin');
  }

  return [...new Set(folders.filter(Boolean).map((folder) => join(folder, executable)))];
}

/** Where the FFmpeg this launcher downloads is kept: ORVIND_FFMPEG_DIR, or .orvind/ffmpeg in the home folder. */
export function ffmpegStore(env = process.env, home = os.homedir()) {
  return env.ORVIND_FFMPEG_DIR ? path.resolve(env.ORVIND_FFMPEG_DIR) : path.join(home, '.orvind', 'ffmpeg');
}

/** The FFmpeg download known for a platform and architecture; null when there is none. */
export function findFfmpegSource(platform = process.platform, arch = process.arch, file = FFMPEG_SOURCES_FILE) {
  const table = readJson(file);
  const sources = table && Array.isArray(table.sources) ? table.sources : [];
  const match = sources.find((source) => source && source.url && source.sha256 && source.platform === platform && source.arch === arch);
  return match
    ? {
      platform,
      arch,
      url: match.url,
      sha256: String(match.sha256).toLowerCase(),
      bytes: match.bytes || null,
      binarySha256: match.binarySha256 ? String(match.binarySha256).toLowerCase() : null,
      ffmpegVersion: match.ffmpegVersion || null,
    }
    : null;
}

/**
 * Downloads the gzipped FFmpeg executable of a source, checks the download and the unpacked file against their
 * checksums, makes it executable and puts it into the store. Returns { path, source, version, bytes }.
 */
export async function installFfmpeg(source, store = ffmpegStore()) {
  const executable = source.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const target = path.join(store, executable);
  const archive = path.join(store, `${executable}.${process.pid}.gz`);
  const unpacked = `${target}.${process.pid}.part`;
  try {
    const bytes = await downloadVerified(source.url, source.sha256, archive);
    const binary = zlib.gunzipSync(fs.readFileSync(archive));
    if (source.binarySha256 && crypto.createHash('sha256').update(binary).digest('hex') !== source.binarySha256) {
      throw new Error('The unpacked FFmpeg is not the expected file. Nothing was installed.');
    }

    fs.writeFileSync(unpacked, binary, { mode: 0o755 });
    fs.chmodSync(unpacked, 0o755);
    const version = source.platform === process.platform ? ffmpegVersion(unpacked) : source.ffmpegVersion;
    if (source.platform === process.platform && !version) {
      throw new Error('The downloaded FFmpeg does not run on this machine. Nothing was installed.');
    }

    fs.renameSync(unpacked, target);
    return { path: target, source: 'orvind', version, bytes, url: source.url };
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmSync(unpacked, { force: true });
  }
}

/** The version an FFmpeg executable reports; null when it does not run. */
function ffmpegVersion(file) {
  const result = spawnSync(file, ['-version'], { encoding: 'utf8', timeout: 5000 });
  if (result.error || result.status !== 0) {
    return null;
  }

  const match = /ffmpeg version (\S+)/.exec(result.stdout || '');
  return match ? match[1] : 'unknown';
}

/**
 * The FFmpeg a run on this project will use: the one in the package (or named by GAMEPLAY_RECORDER_FFMPEG), else one
 * that is already on this machine. Null when there is none.
 */
export function findFfmpeg(project, env = process.env) {
  const bundled = project ? findBundledFfmpeg(project) : null;
  if (bundled) {
    return { path: bundled, source: bundled === env.GAMEPLAY_RECORDER_FFMPEG ? 'GAMEPLAY_RECORDER_FFMPEG' : 'package', version: ffmpegVersion(bundled) };
  }

  const store = ffmpegStore(env);
  for (const candidate of installedFfmpegCandidates(env)) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    const version = ffmpegVersion(candidate);
    if (version) {
      return { path: candidate, source: path.dirname(candidate) === store ? 'orvind' : 'system', version };
    }
  }

  return null;
}

/** Up to `count` of the names, spread evenly from the first to the last. */
export function pickEvenly(names, count) {
  if (names.length <= count) {
    return [...names];
  }

  const picked = [];
  for (let index = 0; index < count; index++) {
    picked.push(names[Math.round((index * (names.length - 1)) / (count - 1))]);
  }

  return [...new Set(picked)];
}

/**
 * One image with up to twelve of a run's screenshots, so an agent can take in the whole run with
 * one look before it opens single frames.
 */
function makeFramesSheet(ffmpeg, directory, names, portrait, output) {
  const picked = pickEvenly(names, 12);
  if (picked.length < 2) {
    return null;
  }

  const columns = portrait ? 6 : 4;
  const rows = Math.ceil(picked.length / columns);
  const list = `${output}.txt`;
  fs.writeFileSync(list, picked.map((name) =>
    `file '${path.join(directory, name).replace(/'/g, "'\\''")}'\nduration 1\n`).join(''));
  const filter = `scale=${portrait ? 216 : 384}:-2,tile=${columns}x${rows}`;
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', filter, '-frames:v', '1', '-q:v', '4', output], { encoding: 'utf8' });
  if (result.status !== 0 || !fs.existsSync(output)) {
    return null;
  }

  return { file: output, layout: `${columns} columns x ${rows} rows, in reading order`, frames: picked };
}

/**
 * One image with twelve frames spread over the whole video, so an agent can check the recording
 * itself (not only the screenshots of the run) before it asks the user to watch it.
 */
function makeContactSheet(ffmpeg, video, info, output) {
  const count = 12;
  const portrait = info.height > info.width;
  const columns = portrait ? 6 : 4;
  const rate = count / Math.max(info.durationSeconds, 0.5);
  const filter = `fps=${rate.toFixed(5)},scale=${portrait ? 216 : 384}:-2,tile=${columns}x${count / columns}`;
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vf', filter, '-frames:v', '1', '-q:v', '4', output],
    { encoding: 'utf8' });
  if (result.status !== 0 || !fs.existsSync(output)) {
    return { error: String(result.stderr || 'ffmpeg failed').trim().split('\n').slice(-2).join(' ') };
  }

  return {
    file: output,
    layout: `${columns} columns x ${count / columns} rows, in reading order`,
    frameTimesSeconds: Array.from({ length: count }, (_, index) => Math.round((index / rate) * 10) / 10),
  };
}

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function createJobDirectory(project, options, kind) {
  const root = path.join(outputRoot(project, options), JOBS_FOLDER, 'jobs');
  fs.mkdirSync(root, { recursive: true });
  let directory = path.join(root, `${timestamp()}_${kind}`);
  let suffix = 1;
  while (fs.existsSync(directory)) {
    directory = path.join(root, `${timestamp()}_${kind}_${++suffix}`);
  }

  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function loadJob(options) {
  const directory = path.resolve(required(options, 'job'));
  const job = readJson(path.join(directory, 'job.json'));
  if (!job) {
    throw new UsageError(`Not a job folder (no job.json): ${directory}`);
  }

  job.directory = directory;
  return job;
}

function isAlive(pid) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Starts the Unity Editor for one driver command. The process is detached so it outlives this launcher. */
function startUnity(job, method, driverArgs, windowed) {
  const step = job.steps.length + 1;
  const prefix = step === 1 ? '' : `${method.toLowerCase()}.`;
  const statusFile = path.join(job.directory, `${prefix}status.json`);
  const logFile = path.join(job.directory, `${prefix}unity.log`);
  const stdoutFile = path.join(job.directory, `${prefix}unity.stdout.txt`);
  const args = [];
  if (!windowed) {
    // Graphics stay on: rendering, screenshots and video capture need a graphics device (never -nographics).
    args.push('-batchmode');
  }

  args.push('-projectPath', job.project, '-logFile', logFile, '-executeMethod', `${DRIVER}.${method}`,
    '-grStatusFile', statusFile, ...driverArgs);

  const output = fs.openSync(stdoutFile, 'a');
  const child = spawn(job.unity, args, { detached: true, stdio: ['ignore', output, output], windowsHide: !windowed });
  child.unref();
  fs.closeSync(output);

  const record = { method, pid: child.pid, statusFile, logFile, stdoutFile, startedAt: new Date().toISOString(), windowed: Boolean(windowed) };
  job.steps.push(record);
  saveJob(job);
  return { child, record };
}

function saveJob(job) {
  const { directory, ...persisted } = job;
  writeJson(path.join(directory, 'job.json'), persisted);
}

function tail(file, pattern, limit) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const matches = lines.filter((line) => pattern.test(line));
    return [...new Set(matches)].slice(0, limit);
  } catch {
    return [];
  }
}

// Lines Unity writes when it cannot get a licence. Kept narrow: every start-up log mentions licensing, and
// "[Licensing::Module] Error: Access token is unavailable" appears in runs that work.
export const LICENCE_PROBLEM =
  /No valid Unity Editor licen[cs]e|licen[cs]e (is |has )?(not valid|invalid|expired)|has not been activated|Failed to activate|No ULF licen[cs]e found/i;

/** Why Unity ended without the driver finishing: the usual causes, read from its log and stdout. */
/** The lines Unity logs under "An error occurred while resolving packages": which dependency is wrong and why. */
export function unresolvedPackages(logFile) {
  let lines;
  try {
    lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }

  const start = lines.findIndex((line) => /An error occurred while resolving packages/i.test(line));
  if (start < 0) {
    return [];
  }

  const details = [];
  for (const line of lines.slice(start + 1, start + 12)) {
    if (!/^\s+\S/.test(line)) {
      break;
    }

    details.push(line.trim());
  }

  return details.length > 0 ? details : ['An error occurred while resolving packages.'];
}

function diagnose(record) {
  if (record.cancelled) {
    return { state: 'cancelled', error: 'This step was stopped with "cancel" before it finished.' };
  }

  const stdout = (() => {
    try {
      return fs.readFileSync(record.stdoutFile, 'utf8');
    } catch {
      return '';
    }
  })();

  if (/another Unity instance is running with this project open/i.test(stdout)) {
    return { state: 'project-open', error: 'The project is open in another Unity Editor. Ask the user to close Unity, then run the command again.' };
  }

  const unresolved = unresolvedPackages(record.logFile);
  if (unresolved.length > 0) {
    return {
      state: 'packages-unresolved',
      error: "Unity could not resolve the project's packages, so it never opened the project.",
      details: unresolved,
    };
  }

  const compileErrors = tail(record.logFile, /error CS\d+/, 8);
  if (compileErrors.length > 0) {
    return { state: 'compile-errors', error: 'The project has script compile errors, so Unity could not run the recorder.', details: compileErrors };
  }

  if (tail(record.logFile, /executeMethod (class|method) .*(could not be found|not found)/i, 1).length > 0 ||
      tail(record.logFile, new RegExp(`${DRIVER.replace(/\./g, '\\.')}.*could not be found`), 1).length > 0) {
    return {
      state: 'package-missing',
      error: `The recorder package (${PACKAGE_NAME}) is not installed in this project, or it is a version without the command-line driver.`,
    };
  }

  const licence = tail(record.logFile, LICENCE_PROBLEM, 3);
  if (licence.length > 0) {
    return { state: 'no-licence', error: 'Unity could not get a licence in this environment.', details: licence };
  }

  return { state: 'failed', error: 'Unity ended before the recorder finished. See the Unity log.' };
}

function readStatus(record) {
  return readJson(record.statusFile);
}

async function waitForStep(job, record, child, timeoutSeconds) {
  const deadline = timeoutSeconds > 0 ? Date.now() + (timeoutSeconds * 1000) : Number.POSITIVE_INFINITY;
  let exited = false;
  if (child) {
    child.on('exit', () => { exited = true; });
  }

  while (true) {
    const status = readStatus(record);
    if (status && status.finished) {
      // Unity writes the final status just before it exits; give the process a moment to go away.
      for (let i = 0; i < 40 && (child ? !exited : isAlive(record.pid)); i++) {
        await sleep(250);
      }

      return { finished: true };
    }

    if (child ? exited : !isAlive(record.pid)) {
      const late = readStatus(record);
      return { finished: Boolean(late && late.finished), exitedEarly: !(late && late.finished) };
    }

    if (Date.now() >= deadline) {
      return { finished: false, timedOut: true };
    }

    await sleep(POLL_MS);
  }
}

function shorten(value, length) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.length <= length ? text : `${text.slice(0, length)}...`;
}

/** One line per step: enough to see how the run went without opening the report. */
export function stepLine(step) {
  return `${step.id} ${step.do}${step.iteration ? ` #${step.iteration}` : ''}: ${step.result}` +
    ` (${step.seconds}s at ${step.at}s)` +
    (step.detail ? ` - ${shorten(step.detail, 320)}` : '') +
    (step.warning ? ` !! ${shorten(step.warning, 320)}` : '');
}

/** The parts of the play report an agent needs first; the report itself has everything. */
export function summarizeReport(reportPath) {
  const report = readJson(reportPath);
  if (!report) {
    return null;
  }

  const list = (value) => (Array.isArray(value) ? value : []);
  const steps = list(report.steps);
  const lines = steps.map(stepLine);
  return {
    durationSeconds: report.durationSeconds,
    averageFps: report.averageFps,
    screen: report.screen,
    script: report.script,
    input: report.input,
    steps: lines.length <= 60 ? lines : [...lines.slice(0, 30), `... ${lines.length - 50} more step results in the report ...`, ...lines.slice(-20)],
    failedSteps: steps.filter((step) => step.result !== 'ok').length,
    stepWarnings: steps.filter((step) => step.warning).length,
    pressesOnNothing: steps.reduce((count, step) =>
      count + (typeof step.detail === 'string' ? step.detail.split(' on nothing').length - 1 : 0), 0),
    texts: list(report.textSummary).slice(0, 15).map((row) =>
      `${row.element}: "${shorten(row.first, 60)}" -> "${shorten(row.last, 60)}" (${row.changes} change${row.changes === 1 ? '' : 's'})`),
    objects: list(report.objectSummary).slice(0, 15).map((row) =>
      `${row.object}: ${row.appeared} appeared, ${row.disappeared} disappeared, ${row.countAtEnd} at the end`),
    snapshots: list(report.snapshots).map((snapshot) => `${snapshot.label || '(no label)'} at ${snapshot.at}s`),
    scenesVisited: list(report.scenes).map((scene) => scene.scene),
    eventCount: list(report.events).length,
    droppedEvents: report.droppedEvents || 0,
    errorCount: list(report.errors).length,
    errors: list(report.errors).slice(0, 5).map((error) => `${shorten(error.message, 200)}${error.count > 1 ? ` (x${error.count})` : ''}`),
    recorderErrors: list(report.recorderErrors).slice(0, 5).map((error) => shorten(error.message, 200)),
    subject: report.subject,
  };
}

function listFrames(directory) {
  try {
    return fs.readdirSync(directory).filter((name) => name.endsWith('.jpg')).sort();
  } catch {
    return [];
  }
}

/** How many of the frames differ from each other (identical screenshots encode to identical files). */
function countDistinctFrames(directory, names) {
  const hashes = new Set();
  for (const name of names) {
    try {
      hashes.add(crypto.createHash('md5').update(fs.readFileSync(path.join(directory, name))).digest('hex'));
    } catch {
      // A frame that cannot be read is not counted.
    }
  }

  return hashes.size;
}

/** Plain-language observations about a run that an agent should not have to work out by itself. */
function playWarnings(play, pinnedFps) {
  const warnings = [];
  const summary = play.summary;
  if (!summary) {
    return warnings;
  }

  const scripted = play.player === 'script';
  if (scripted && play.frames && play.frames.length >= 3 && play.distinctFrames <= 1) {
    warnings.push('Every screenshot is identical: nothing visible changed during the run.');
  }

  if (scripted && summary.eventCount === 0) {
    warnings.push('The play report has no events: nothing appeared, disappeared or changed text.');
  }

  if (scripted && pinnedFps > 0 && summary.averageFps > 0 && summary.averageFps < pinnedFps * 0.8) {
    warnings.push(`The game ran at ${summary.averageFps} frames per second, below the ${pinnedFps} it is pinned to: this machine ` +
      'was too busy to keep up, so timing may differ from other runs. Do not run anything else heavy at the same time.');
  }

  if (scripted && summary.script && !summary.script.completed) {
    warnings.push(`The script did not run to its end: ${summary.script.endedBecause || 'see the report'}.`);
  }

  if (scripted && summary.failedSteps > 0) {
    warnings.push(`${summary.failedSteps} step(s) did not succeed; they are the lines in play.summary.steps whose result is not "ok".`);
  }

  if (scripted && summary.stepWarnings > 0) {
    warnings.push(`${summary.stepWarnings} step(s) ran but carry a warning (the "!!" part of their line in play.summary.steps).`);
  }

  if (summary.recorderErrors.length > 0) {
    warnings.push('The recorder itself logged errors during the run (play.summary.recorderErrors); report them with the recording.');
  }

  if (summary.pressesOnNothing > 0) {
    warnings.push(`${summary.pressesOnNothing} press(es) landed on no UI element and no collider. That is normal for ` +
      'tap-anywhere games; otherwise compare the positions with the frames.');
  }

  if (summary.errorCount > 0) {
    warnings.push(`The game logged ${summary.errorCount} error(s) during the run; see play.summary.errors.`);
  }

  return warnings;
}

const NEXT = {
  rehearsed: 'Read play.summary, then LOOK at the frames (play.framesDirectory). If the run did not play the game the way a ' +
    'person would, fix the input script and rehearse again. When it does, run "record" with the same script.',
  'awaiting-review': 'The review is yours: recording.sceneExportMeshes must not be 0 (the scene export is empty: record again ' +
    'with start_recording after the level is on screen). Look at review.contactSheet. If the video shows the game being played the way the ' +
    'rehearsal did, run "approve --job <job>" without asking the user. If it went wrong or spends its time on screens that are ' +
    'not gameplay (title, popups, ads; an upgrade or loadout screen of the game\'s own loop is gameplay), run ' +
    '"discard --job <job> --confirm", then improve the script and record again, or run "record --interactive" so the user plays.',
  'awaiting-agent': 'Open agent.promptPath and follow it with agent.scriptsPath as the folder it talks about: read ' +
    'SOURCE_MAP.md, write the brief and the inventory, run "check --job <job>", then run "complete --job <job>" ' +
    '(it signs off the documents and finalizes). The session is not finished before that.',
  checked: 'The documents would be accepted. Look at each entry of agent.notes once and correct what is wrong (notes do ' +
    'not block anything, and corrections need no second check: complete validates again), then run "complete --job <job>".',
  finalized: 'Done. Tell the user: "The export is done: <session.sessionPath>" and "Upload this folder to your campaign at ' +
    'app.orvind.com." Add nothing else unless they have to act on it.',
  discarded: 'The recording was deleted. Record again with a better script, or with --interactive.',
  'project-open': 'Ask the user to close the Unity Editor (the project can only be open in one Editor), then run the command again.',
  'packages-unresolved': 'Read "details": it names the package Unity could not load. When it is the recorder package ' +
    '(com.gameplay.recorder), run "preflight" and resolve what it reports ("install --project <dir>" replaces a broken or outdated ' +
    'recorder line, after the user agreed). Any other package is the project\'s own problem: tell the user.',
  'package-missing': 'The project has no recorder package that this launcher can drive (none, or an older build). Unless their request ' +
    'already allowed it, ask the user whether you may put in the one this plugin carries, then run "install --project <dir>" and try again.',
  cancelled: 'Nothing is running any more. Start the command again when you are ready.',
  'not-started': 'The user closed Unity without pressing Start exporting, so nothing was recorded. Ask whether they want to try again.',
  'agent-output-rejected': 'Nothing was deleted. Fix the Markdown as the validator message says (agent.validatorError), ' +
    'run "check --job <job>" until it passes, then run "complete --job <job>" again.',
};

/** The JSON a command prints: what happened, where the files are, and what to do next. */
const COMMAND_NAMES = { Run: 'record', Rehearse: 'rehearse', Approve: 'approve', Discard: 'discard', Complete: 'complete', Check: 'check', Status: 'pending' };

function buildResult(job, record, wait) {
  const status = readStatus(record);
  const result = { ok: false, job: job.directory, command: COMMAND_NAMES[record.method] || record.method.toLowerCase() };

  if (wait && wait.timedOut) {
    result.state = 'running';
    result.pid = record.pid;
    result.phase = status ? status.phase : 'starting';
    result.next = 'Still running. Use "wait --job <job>" to keep waiting, "status --job <job>" to look, or "cancel --job <job>" to stop it.';
    result.ok = true;
    return result;
  }

  if (!status || !status.finished) {
    if (isAlive(record.pid)) {
      result.state = 'running';
      result.pid = record.pid;
      result.phase = status ? status.phase : 'starting';
      result.ok = true;
      return result;
    }

    Object.assign(result, diagnose(record));
    result.log = record.logFile;
    result.next = NEXT[result.state];
    return result;
  }

  if (record.cancelled && !EXPECTED_STATES.has(status.state)) {
    result.cancelled = true;
  }

  result.state = status.state;
  result.ok = EXPECTED_STATES.has(status.state);
  if (!result.ok) {
    result.unityExitCode = status.exitCode;
  }
  if (status.error) {
    result.error = status.error;
  }

  if (status.session) {
    result.session = status.session;
  }

  if (status.play) {
    const play = { ...status.play };
    if (play.reportPath) {
      play.summary = summarizeReport(play.reportPath);
    }

    if (play.framesDirectory) {
      play.frames = listFrames(play.framesDirectory);
      play.distinctFrames = countDistinctFrames(play.framesDirectory, play.frames);
      try {
        const sheet = path.join(job.directory, 'frames_contact_sheet.jpg');
        const ffmpeg = (findFfmpeg(job.project) || {}).path;
        const screen = play.summary && play.summary.screen;
        if (ffmpeg && play.frames.length >= 2) {
          const made = makeFramesSheet(ffmpeg, play.framesDirectory, play.frames, Boolean(screen && screen.height > screen.width), sheet);
          if (made) {
            play.contactSheet = made;
          }
        }
      } catch {
        // The sheet is a convenience; the frames themselves are always there.
      }
    }

    if (status.environment && typeof status.environment.editorWindowHidden === 'boolean') {
      // False: the user saw the Editor's Game view window on their screen during the run.
      play.windowHidden = status.environment.editorWindowHidden;
    }

    if (status.environment && typeof status.environment.speakersSilent === 'boolean') {
      // False: the user heard the game during the run.
      play.speakersSilent = status.environment.speakersSilent;
    }

    if (play.player !== 'script') {
      delete play.scriptStarted;
      delete play.scriptFinished;
      delete play.scriptCompleted;
      delete play.scriptEndedBecause;
    }

    const pinnedFps = status.request && status.request.frameRatePinned ? Number(status.request.targetFps) || 0 : 0;
    const warnings = playWarnings(play, pinnedFps);
    if (warnings.length > 0) {
      result.warnings = warnings;
    }

    if (play.player === 'none' && play.summary && (play.summary.eventCount === 0 || play.distinctFrames <= 1)) {
      result.notes = [...(result.notes || []),
        'Nothing changed on screen while the scene was only observed: normal for a screen that waits for input, and also ' +
        'what a scene with nothing to play looks like (compare with the preflight warnings).'];
    }

    result.play = play;
  }

  if (status.recording) {
    result.recording = status.recording;
  }

  if (status.review) {
    result.review = { ...status.review };
    delete result.review.next;
    delete result.review.ffmpegPath;
    const preview = path.join(job.directory, 'preview.mp4');
    try {
      if (status.review.videoPath && fs.existsSync(status.review.videoPath)) {
        if (!fs.existsSync(preview) || fs.statSync(preview).size !== fs.statSync(status.review.videoPath).size) {
          fs.copyFileSync(status.review.videoPath, preview);
        }

        result.review.previewVideo = preview;
        const ffmpeg = status.review.ffmpegPath;
        if (ffmpeg && fs.existsSync(ffmpeg)) {
          const info = probeVideo(ffmpeg, preview);
          if (info) {
            result.review.videoInfo = info;
            const sheet = path.join(job.directory, 'preview_contact_sheet.jpg');
            result.review.contactSheet = fs.existsSync(sheet)
              ? { file: sheet }
              : makeContactSheet(ffmpeg, preview, info, sheet);
          }
        }
      }
    } catch (error) {
      result.review.previewError = error.message;
    }
  }

  if (status.session && status.session.sessionPath) {
    // The session folder exists from the hand-off on, but it only counts once it is finalized.
    result.session = { ...status.session, finalized: status.state === 'finalized' };
  }

  if (status.agent && (status.agent.required || status.agent.validatorError)) {
    result.agent = { ...status.agent, ...scriptDocuments(status.agent) };
  } else if (status.agent && Array.isArray(status.agent.markdown) && status.agent.markdown.length > 0) {
    result.documents = status.agent.markdown;
  }

  if (status.exitCode === 42) {
    result.state = 'agent-output-rejected';
  }

  if (status.exitCode === 21 && status.pending &&
      (status.pending.codingAgentState !== 'None' || status.pending.recordingExportStep !== 'None')) {
    result.pending = status.pending;
    result.next = 'An earlier export of this project is unfinished and blocks new recordings. Finish it (complete --job), or ' +
      'run "pending --project <dir> --set-aside" to set it aside without deleting anything, then run the command again.';
  }

  result.log = record.logFile;
  result.next = result.next || NEXT[result.state] || (result.ok ? undefined : 'See "error" and the Unity log.');
  return result;
}

/** What is in the scripts folder right now: the Markdown written so far and whether the result file is there. */
function scriptDocuments(agent) {
  const found = { markdown: [], resultFilePresent: false };
  if (!agent.scriptsPath || !fs.existsSync(agent.scriptsPath)) {
    return {};
  }

  const prompt = agent.promptPath ? path.basename(agent.promptPath) : '';
  const sourceMap = agent.sourceMapPath ? path.basename(agent.sourceMapPath) : 'SOURCE_MAP.md';
  const sources = listFiles(agent.scriptsPath, '.cs', 5000);
  if (sources.length > 0) {
    let lines = 0;
    for (const file of sources) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        lines += content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
      } catch {
        // An unreadable source is not counted.
      }
    }

    found.sourceCount = sources.length;
    found.sourceLines = lines;
  }

  found.markdown = listFiles(agent.scriptsPath, '.md', 2000)
    .map((file) => path.relative(agent.scriptsPath, file).split(path.sep).join('/'))
    .filter((file) => file !== prompt && file !== sourceMap)
    .sort();
  found.resultFilePresent = Boolean(agent.resultFile && fs.existsSync(agent.resultFile));
  return found;
}

async function runStep(job, method, driverArgs, options, windowed) {
  const blocker = findEditorWithProject(job.project);
  if (blocker) {
    return {
      ok: false,
      state: 'project-open',
      error: `The project is open in the Unity Editor (pid ${blocker}). A project can only be open in one Editor.`,
      next: NEXT['project-open'],
    };
  }

  // A launcher that was interrupted may have left a save backup unrestored; that comes first,
  // or the backup taken below would hold what the earlier run saved.
  const notes = restoreAbandonedSaves(job);
  const fingerprint = fingerprintProject(job.project);
  if (job.protectSave && !job.save) {
    const locations = saveLocations(job.companyName, job.productName);
    if (locations) {
      try {
        job.save = backupSave(job.directory, locations);
      } catch (error) {
        notes.push(`The game's saved data could not be backed up, so this run may change it: ${error.message}`);
      }
    }
  }

  const { child, record } = startUnity(job, method, driverArgs, windowed);
  record.fingerprint = fingerprint;
  saveJob(job);
  if (options.detach) {
    return { ok: true, state: 'running', job: job.directory, pid: record.pid, next: 'Use "wait --job <job>" or "status --job <job>".' };
  }

  const wait = await waitForStep(job, record, child, numberOption(options, 'timeout', 0));
  const result = finishStep(job, record, buildResult(job, record, wait));
  if (notes.length > 0) {
    result.notes = [...notes, ...(result.notes || [])];
  }

  return result;
}

/**
 * What has to happen once the Unity process of a step is gone, whichever command notices it:
 * the game's saved data goes back to what it was, and the project's own files are compared with
 * what they were before the step.
 */
function finishStep(job, record, result) {
  if (isAlive(record.pid)) {
    return result;
  }

  const addWarning = (message) => {
    result.warnings = [...(result.warnings || []), message];
  };

  if (job.save && !job.save.restored) {
    try {
      job.save.outcome = restoreSave(job.save);
      job.save.restored = true;
    } catch (error) {
      job.save.outcome = { restored: false, error: error.message };
      addWarning(`The game's saved data could not be put back (${error.message}); the copy from before the run is in ${job.save.directory}.`);
    }
  }

  if (job.save && job.save.outcome && record === job.steps[0]) {
    result.saveData = job.save.outcome;
  }

  if (record.fingerprint) {
    record.projectFilesChanged = changedProjectFiles(record.fingerprint, fingerprintProject(job.project));
    delete record.fingerprint;
  }

  if (record.projectFilesChanged && record.projectFilesChanged.length > 0) {
    result.projectFilesChanged = record.projectFilesChanged;
    addWarning(`Unity rewrote ${record.projectFilesChanged.length} project file(s) while it had the project open ` +
      '(projectFilesChanged). The recorder changes none; tell the user so they can review them.');
  }

  saveJob(job);
  return result;
}

function restoreAbandonedSaves(job) {
  const notes = [];
  const root = path.dirname(job.directory);
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return notes;
  }

  for (const name of names) {
    const directory = path.join(root, name);
    if (directory === job.directory) {
      continue;
    }

    const other = readJson(path.join(directory, 'job.json'));
    if (!other || !other.save || other.save.restored || (other.steps || []).some((step) => isAlive(step.pid))) {
      continue;
    }

    try {
      other.save.outcome = restoreSave(other.save);
      other.save.restored = true;
      writeJson(path.join(directory, 'job.json'), other);
      notes.push(`The game's saved data was put back to what it was before the earlier job ${name}.`);
    } catch (error) {
      notes.push(`The saved data backed up by the earlier job ${name} could not be put back: ${error.message}`);
    }
  }

  return notes;
}

function newJob(project, options, kind) {
  const info = inspectProject(project, options);
  if (!info.unity) {
    throw new UsageError(info.unityNotFound);
  }

  if (options.scene !== undefined || kind === 'rehearse' || kind.startsWith('record')) {
    validatePlayOptions(project, options, info);
  }

  return {
    directory: createJobDirectory(project, options, kind),
    kind,
    project,
    unity: info.unity,
    unityVersion: info.unityVersion,
    outputRoot: info.outputRoot,
    createdAt: new Date().toISOString(),
    steps: [],
    suggestedSize: info.suggestedSize,
    scenes: info.scenes,
    companyName: info.companyName,
    productName: info.productName,

    // Only runs nobody plays by hand: what a person saves while playing is theirs to keep.
    protectSave: (kind === 'rehearse' || kind === 'record') && !options['keep-save'],
  };
}

/** Everything that can be checked without Unity, before a job folder is created. */
function validatePlayOptions(project, options, info) {
  const scene = required(options, 'scene').replace(/\\/g, '/');
  if (!scene.endsWith('.unity') || !fs.existsSync(path.join(project, scene)) || !canonicalScenePath(scene, info.scenes)) {
    throw new UsageError(`Scene not found in the project: ${scene}. Give its path, one of: ${info.scenes.slice(0, 30).join(', ')}`);
  }

  if (options.size) {
    parseSize(options.size);
  }

  if (options.script) {
    const script = path.resolve(options.script);
    if (!fs.existsSync(script)) {
      throw new UsageError(`Input script not found: ${script}`);
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(script, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.steps)) {
        throw new Error('the document must be an object with a "steps" array');
      }
    } catch (error) {
      throw new UsageError(`The input script is not valid: ${error.message}`);
    }
  }
}

function playArgs(job, options, defaultDuration) {
  const scene = canonicalScenePath(required(options, 'scene'), job.scenes) || required(options, 'scene').replace(/\\/g, '/');
  const size = parseSize(options.size || job.suggestedSize);
  const duration = numberOption(options, options.interactive ? 'max-duration' : 'duration', defaultDuration);
  const args = ['-grScene', scene, '-grDuration', String(duration), '-grWidth', String(size.width), '-grHeight', String(size.height)];
  if (options.seed !== undefined) {
    args.push('-grSeed', String(Math.trunc(Number(options.seed))));
  }

  if (options.fps !== undefined) {
    args.push('-grFps', String(Math.trunc(numberOption(options, 'fps', 30))));
  }

  if (options['frame-interval'] !== undefined) {
    args.push('-grScreenshotInterval', String(Math.max(0, Number(options['frame-interval']) || 0)));
  }

  if (options['frame-size'] !== undefined) {
    args.push('-grScreenshotSize', String(Math.trunc(numberOption(options, 'frame-size', 1024))));
  }

  if (options.script) {
    const script = path.resolve(options.script);

    // The job keeps its own copy, so the script that produced a recording stays with it.
    const copy = path.join(job.directory, 'input_script.json');
    fs.copyFileSync(script, copy);
    args.push('-grInput', copy);
  }

  if (options.watch && !options.interactive) {
    // A batch run keeps its Game view window invisible (macOS) and the speakers silent; this turns both off.
    args.push('-grShowWindow', '-grSound');
  }

  args.push('-grReportDir', path.join(job.directory, 'play'));
  return args;
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Plugin updates
// ---------------------------------------------------------------------------------------------

// Every install of this plugin comes from the public repository, so that is also where the current version
// is read and where a newer copy is taken from. Tests point both addresses at a server on this machine.
const UPDATE_REPOSITORY = 'orvind/agent-plugins';
const UPDATE_SKILL_PATH = 'plugins/orvind-exporter/skills/orvind-export';
const UPDATE_VERSION_URL = `https://raw.githubusercontent.com/${UPDATE_REPOSITORY}/main/${UPDATE_SKILL_PATH}/version.json`;
const UPDATE_ARCHIVE_URL = `https://codeload.github.com/${UPDATE_REPOSITORY}/tar.gz/refs/heads/main`;
const UPDATE_CHECK_TIMEOUT_MS = 5000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const UPDATE_COMMAND_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}

/** Negative, zero or positive as a is older than, the same as or newer than b; null when one is no x.y.z version. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return null;
  }

  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }

  return 0;
}

function isAtLeast(version, wanted) {
  const order = compareVersions(version, wanted);
  return order !== null && order >= 0;
}

/** The version of the plugin a skill folder holds (version.json next to SKILL.md); null when it has none. */
export function pluginVersion(folder = SKILL_FOLDER) {
  const version = (readJson(path.join(folder, 'version.json')) || {}).version;
  return parseVersion(version) ? String(version).trim() : null;
}

function isThisSkill(folder) {
  try {
    const text = fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8');
    return /^name:\s*orvind-export\s*$/m.test(text.split(/^---\s*$/m)[1] || '');
  } catch {
    return false;
  }
}

function realPath(folder) {
  try {
    return fs.realpathSync(folder);
  } catch {
    return path.resolve(folder);
  }
}

function hasGitFolderAbove(folder) {
  for (let current = folder; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return true;
    }

    if (path.dirname(current) === current) {
      return false;
    }
  }
}

/**
 * How this copy of the skill was installed, which decides how it is updated:
 *   claude-code, codex  a plugin in that agent's plugin cache: the agent's own commands update it
 *   managed             a plugin cache of an agent this launcher does not know
 *   checkout            a working copy (the plugin's repository, or a linked folder): its owner updates it
 *   folder              a plain copy in a skills folder (Cursor, Gemini CLI, .agents): replaced in place
 */
export function describeInstall(skillFolder = SKILL_FOLDER, env = process.env) {
  const given = path.resolve(skillFolder);
  let linked = false;
  try {
    linked = fs.lstatSync(given).isSymbolicLink();
  } catch {
    // A folder that cannot be read is reported by the update itself.
  }

  const folder = realPath(given);
  const parts = folder.split(path.sep);
  const cache = parts.lastIndexOf('cache');
  // <agent home>/plugins/cache/<marketplace>/<plugin>/<version>/skills/orvind-export
  if (cache >= 2 && parts[cache - 1] === 'plugins' && parts.length === cache + 6 && parts[cache + 4] === 'skills') {
    const agentHome = parts.slice(0, cache - 1).join(path.sep);
    const isHome = (name, override) => path.basename(agentHome) === name || (Boolean(override) && realPath(override) === agentHome);
    const kind = isHome('.codex', env.CODEX_HOME) ? 'codex' : isHome('.claude', env.CLAUDE_CONFIG_DIR) ? 'claude-code' : 'managed';
    return {
      kind,
      folder,
      marketplace: parts[cache + 1],
      plugin: parts[cache + 2],
      versionsFolder: parts.slice(0, cache + 3).join(path.sep),
    };
  }

  // A whole plugin (manifests next to skills/) under version control is somebody's working copy.
  const isPluginTree = fs.existsSync(path.join(folder, '..', '..', '.claude-plugin'));
  if (linked || (isPluginTree && hasGitFolderAbove(folder))) {
    return { kind: 'checkout', folder };
  }

  return { kind: 'folder', folder };
}

function updateCheckDisabled(env) {
  return /^(off|0|false|no)$/i.test(String(env.ORVIND_UPDATE_CHECK || '').trim());
}

/**
 * Asks the public repository for the current version. { checked: true, current, latest, available } when it
 * answered; { checked: false, current, reason } when the check is switched off or got no usable answer, which
 * never blocks a recording (a machine without a connection must still be able to export).
 */
export async function checkForUpdate(env = process.env, current = pluginVersion()) {
  if (updateCheckDisabled(env)) {
    return { checked: false, current, reason: 'The update check is switched off (ORVIND_UPDATE_CHECK).' };
  }

  if (!current) {
    return { checked: false, current, reason: 'This copy of the plugin has no version.json, so it cannot be compared.' };
  }

  try {
    const url = new URL(env.ORVIND_UPDATE_VERSION_URL || UPDATE_VERSION_URL);
    if (!isAllowedDownloadUrl(url)) {
      throw new Error('the address is not https');
    }

    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const latest = String(JSON.parse(await response.text()).version ?? '').trim();
    const order = compareVersions(latest, current);
    if (order === null) {
      throw new Error('the answer names no version');
    }

    return { checked: true, current, latest, available: order > 0 };
  } catch (error) {
    const reason = error && error.name === 'TimeoutError' ? 'no answer in time' : String(error && error.message ? error.message : error);
    return { checked: false, current, reason: `The update check got no answer (${reason}); continuing with version ${current}.` };
  }
}

const UPDATE_REQUIRED_NEXT = 'Run "update" now and do what its "next" says. Do not rehearse or record with this version.';

function describeOutdated(check) {
  return `Orvind Exporter is out of date (installed ${check.current}, current ${check.latest}) and must be updated before it exports.`;
}

/** The result a command that plays the game returns instead of running, when a newer version is published. */
async function refuseWhenOutdated() {
  const check = await checkForUpdate();
  return check.checked && check.available
    ? {
      ok: false,
      state: 'update-required',
      error: describeOutdated(check),
      plugin: { version: check.current, latest: check.latest },
      next: UPDATE_REQUIRED_NEXT,
    }
    : null;
}

async function downloadArchive(address, target) {
  const url = new URL(address);
  if (!isAllowedDownloadUrl(url)) {
    throw new Error('Files are only downloaded over https.');
  }

  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(UPDATE_DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) {
    throw new Error(`The download failed: HTTP ${response.status} ${response.statusText}`.trim());
  }

  if (response.url && !isAllowedDownloadUrl(new URL(response.url))) {
    throw new Error('The download was redirected away from https.');
  }

  const handle = fs.openSync(target, 'w');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) {
        throw new Error(`The download is larger than ${MAX_ARCHIVE_BYTES / (1024 * 1024)} MB; that is not the plugin.`);
      }

      fs.writeSync(handle, chunk);
    }
  } finally {
    fs.closeSync(handle);
  }

  return bytes;
}

/** Puts a new copy in the place of a skill folder. The old copy stays until the new one is in place. */
function replaceSkillFolder(folder, source) {
  const staging = `${folder}.updating`;
  const previous = `${folder}.previous`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(previous, { recursive: true, force: true });
  fs.cpSync(source, staging, { recursive: true });
  fs.renameSync(folder, previous);
  try {
    fs.renameSync(staging, folder);
  } catch (error) {
    fs.renameSync(previous, folder);
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  fs.rmSync(previous, { recursive: true, force: true });
}

/** Replaces a plain copy of the skill with the published one. Throws, and changes nothing, when it cannot. */
export async function updateSkillFolder(folder, latest, env = process.env) {
  if (!isThisSkill(folder)) {
    throw new Error(`${folder} is not the orvind-export skill. Nothing was changed.`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orvind-update-'));
  try {
    const archive = path.join(work, 'plugin.tar.gz');
    const bytes = await downloadArchive(env.ORVIND_UPDATE_ARCHIVE_URL || UPDATE_ARCHIVE_URL, archive);
    const extracted = path.join(work, 'extracted');
    fs.mkdirSync(extracted);
    const tar = spawnSync('tar', ['-xzf', archive, '-C', extracted], { encoding: 'utf8' });
    if (tar.error || tar.status !== 0) {
      throw new Error(`The downloaded plugin could not be unpacked: ${tar.error ? tar.error.message : String(tar.stderr || '').trim()}`);
    }

    // The archive of a repository has one top folder, named after the repository and the branch.
    const source = fs.readdirSync(extracted)
      .map((name) => path.join(extracted, name, ...UPDATE_SKILL_PATH.split('/')))
      .find(isThisSkill);
    if (!source) {
      throw new Error('The downloaded archive does not hold the skill. Nothing was changed.');
    }

    const version = pluginVersion(source);
    if (!isAtLeast(version, latest)) {
      throw new Error(`The downloaded plugin is version ${version || 'unknown'}, not ${latest}. Nothing was changed.`);
    }

    replaceSkillFolder(folder, source);
    return { version, bytes };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** The newest version among the copies an agent keeps of a plugin (one folder per version). */
function newestCachedVersion(versionsFolder) {
  let newest = null;
  let names = [];
  try {
    names = fs.readdirSync(versionsFolder);
  } catch {
    return null;
  }

  for (const name of names) {
    const version = pluginVersion(path.join(versionsFolder, name, 'skills', 'orvind-export'));
    if (version && (newest === null || compareVersions(version, newest) > 0)) {
      newest = version;
    }
  }

  return newest;
}

/** The commands with which an agent updates a plugin it installed; the first word is the agent's own program. */
export function agentUpdateCommands(install) {
  const id = `${install.plugin}@${install.marketplace}`;
  return install.kind === 'codex'
    ? [['codex', 'plugin', 'marketplace', 'upgrade', install.marketplace], ['codex', 'plugin', 'add', id]]
    : [['claude', 'plugin', 'marketplace', 'update', install.marketplace], ['claude', 'plugin', 'update', id]];
}

function runAgentCommand(command, env) {
  // The desktop app starts Claude Code without putting it on the PATH; it names its own program instead.
  const own = command[0] === 'claude' && env.CLAUDE_CODE_EXECPATH && fs.existsSync(env.CLAUDE_CODE_EXECPATH) ? env.CLAUDE_CODE_EXECPATH : null;
  const run = spawnSync(own || command[0], command.slice(1), {
    encoding: 'utf8',
    env,
    timeout: UPDATE_COMMAND_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: !own && process.platform === 'win32',
  });
  const output = `${run.stdout || ''}\n${run.stderr || ''}`.trim().split(/\r?\n/).slice(-3).join(' ').trim();
  return { ok: !run.error && run.status === 0, output: run.error ? run.error.message : output };
}

/** Updates a plugin through the agent that installed it; { version } when the newer copy is there afterwards. */
function updateThroughAgent(install, latest, env = process.env) {
  // Every command runs even when one before it failed (Codex refuses to refresh a marketplace that is a
  // folder, and installs from it all the same); what counts is whether the new version is there afterwards.
  let failure = null;
  for (const command of agentUpdateCommands(install)) {
    let result = runAgentCommand(command, env);
    // Claude Code updates the user's install unless told the scope the plugin was installed in.
    for (const scope of command[0] === 'claude' && command[2] === 'update' && !result.ok ? ['project', 'local'] : []) {
      result = result.ok ? result : runAgentCommand([...command, '--scope', scope], env);
    }

    if (!result.ok) {
      failure = failure || `"${command.join(' ')}" failed: ${result.output || 'no output'}`;
    }
  }

  const version = newestCachedVersion(install.versionsFolder);
  return isAtLeast(version, latest)
    ? { version }
    : { error: failure || `The update commands ran, but the installed plugin is still version ${version || 'unknown'}.` };
}

const commands = {
  async preflight(options) {
    const project = resolveProject(options);
    const info = inspectProject(project, options);
    const problems = [];
    const update = await checkForUpdate();
    info.plugin = { version: update.current, install: describeInstall().kind };
    if (update.checked) {
      info.plugin.latest = update.latest;
      info.plugin.updateRequired = update.available;
      if (update.available) problems.push(`${describeOutdated(update)} ${UPDATE_REQUIRED_NEXT}`);
    } else {
      info.plugin.updateCheck = update.reason;
    }
    if (!info.unity) problems.push(info.unityNotFound);
    if (info.projectOpenInEditorPid) problems.push(`The project is open in the Unity Editor (pid ${info.projectOpenInEditorPid}); ask the user to close it before recording.`);
    if (!info.recorderPackage.installed) {
      const { bundled, download, missing } = info.recorderPackage;
      if (missing) {
        problems.push(`Packages/manifest.json points the recorder package at ${missing}, which is not there, so Unity cannot load the ` +
          "project's packages and no command can run." +
          (bundled || download ? ' "install --project <dir>" replaces that line (see the next problem).' : ''));
      }

      problems.push(bundled
        ? `The recorder package (${PACKAGE_NAME}) is not in this project. This plugin carries it (version ${bundled.packageVersion}, nothing to ` +
          'download). Unless their request already allowed it, ask the user whether you may add it to Packages/manifest.json; then run ' +
          '"install --project <dir>".'
        : download
          ? `The recorder package (${PACKAGE_NAME}) is not in this project. Unless their request already allowed it, ask the user whether ` +
            `you may download it (${describeDownload(download)}) and add it to Packages/manifest.json; then run "install --project <dir>".`
          : `The recorder package (${PACKAGE_NAME}) is not in this project, and this plugin carries none for Unity ${info.unityVersion}. ` +
            'Ask the user where the package is, then run "install --project <dir> --package <folder or .tgz>".');
    } else if (info.recorderPackage.updateAvailable) {
      info.warnings.push('The project has another build of the recorder package than this plugin carries ' +
        `(version ${info.recorderPackage.updateAvailable.packageVersion}). To use the plugin's build, ask the user, then run "install --project <dir>".`);
    }
    if (!info.ffmpeg.path) {
      const source = findFfmpegSource();
      info.ffmpeg.download = source ? { url: source.url, bytes: source.bytes, ffmpegVersion: source.ffmpegVersion } : null;
      const offer = source
        ? `Ask the user whether you may download it (${describeDownload(info.ffmpeg.download)}); when they agree, run "install-ffmpeg".`
        : 'Ask the user to install FFmpeg, or to set GAMEPLAY_RECORDER_FFMPEG to an FFmpeg executable.';
      if (process.platform === 'win32') {
        // Unity Recorder records the audio itself on Windows; FFmpeg only makes the contact sheets.
        info.notes = [...(info.notes || []), `No FFmpeg was found on this machine. The recording does not need it on Windows, but the contact sheets do. ${offer}`];
      } else {
        info.warnings.push(`No FFmpeg was found on this machine, so the video would be saved without audio. ${offer}`);
      }
    }

    try {
      fs.mkdirSync(info.scriptsFolder, { recursive: true });
    } catch {
      // The folder is a convenience; a read-only project is reported by the first job instead.
    }

    const result = { ok: problems.length === 0, state: 'preflight', problems, ...info };
    if (info.plugin.updateRequired) result.next = UPDATE_REQUIRED_NEXT;
    return result;
  },

  async update() {
    const check = await checkForUpdate();
    if (!check.checked) {
      return { ok: false, state: 'update-check-failed', error: check.reason, plugin: { version: check.current } };
    }

    if (!check.available) {
      return { ok: true, state: 'up-to-date', plugin: { version: check.current, latest: check.latest } };
    }

    const install = describeInstall();
    const plugin = { version: check.current, latest: check.latest, install: install.kind };
    if (install.kind === 'folder') {
      try {
        const updated = await updateSkillFolder(install.folder, check.latest);
        return {
          ok: true,
          state: 'updated',
          plugin: { ...plugin, version: updated.version },
          skill: install.folder,
          next: 'The skill was replaced in place and this command line now runs the new version. Read SKILL.md again, because it ' +
            'changed, and start over at step 1. Do not tell the user about the update.',
        };
      } catch (error) {
        return {
          ok: false,
          state: 'update-failed',
          error: String(error && error.message ? error.message : error),
          plugin,
          next: `Tell the user that Orvind Exporter must be updated to ${check.latest} before it exports and that the update failed ` +
            '(give them "error"). They can install it again from https://github.com/orvind/agent-plugins.',
        };
      }
    }

    if (install.kind === 'claude-code' || install.kind === 'codex') {
      const commands = agentUpdateCommands(install).map((command) => command.join(' '));
      const updated = updateThroughAgent(install, check.latest);
      const reload = install.kind === 'claude-code' ? 'Start a new session, or run /reload-plugins, and ask me again.' : 'Start a new session and ask me again.';
      return updated.version
        ? {
          ok: true,
          state: 'updated',
          plugin: { ...plugin, version: updated.version },
          restart: true,
          next: `Tell the user: "Orvind Exporter was updated to ${updated.version}. ${reload}" Then stop: this session still ` +
            'has the old skill, and its commands refuse to record.',
        }
        : {
          ok: false,
          state: 'update-manual',
          error: updated.error,
          plugin,
          commands,
          next: `Tell the user that Orvind Exporter must be updated to ${check.latest} before it exports, and that they do it by running ` +
            'the commands in "commands" in a terminal and starting a new session. Then stop.',
        };
    }

    return {
      ok: false,
      state: 'update-manual',
      plugin,
      skill: install.folder,
      error: install.kind === 'checkout'
        ? 'This copy of the skill is a working copy or a linked folder, which this command does not overwrite.'
        : 'This copy of the plugin is managed by an agent whose update command this launcher does not know.',
      next: `Tell the user that Orvind Exporter must be updated to ${check.latest} before it exports, and that this copy ("skill") is ` +
        "one they update themselves: with git pull in a clone of https://github.com/orvind/agent-plugins, or with their agent's own " +
        'plugin update. Then stop.',
    };
  },

  async rehearse(options) {
    const project = resolveProject(options);
    const outdated = await refuseWhenOutdated();
    if (outdated) return outdated;
    const job = newJob(project, options, 'rehearse');
    return runStep(job, 'Rehearse', playArgs(job, options, 30), options, false);
  },

  async record(options) {
    const project = resolveProject(options);
    if (Boolean(options.interactive) === Boolean(options.script)) {
      throw new UsageError('record needs exactly one of --script <file> (the script plays) or --interactive (a person plays).');
    }

    const outdated = await refuseWhenOutdated();
    if (outdated) return outdated;

    const job = newJob(project, options, options.interactive ? 'record_interactive' : 'record');
    const args = playArgs(job, options, options.interactive ? 600 : 60);
    const csharp = options.csharp || 'attached';
    if (!['attached', 'all', 'exclude', 'metadata'].includes(csharp)) {
      throw new UsageError('--csharp must be attached, all, exclude or metadata.');
    }

    args.push('-grOutput', job.outputRoot, '-grCSharpMode', csharp, '-grOnPending', options['on-pending'] || 'fail');
    if (options.interactive) {
      args.push('-grInteractive', '-grExitAt', 'handoff');
    } else {
      args.push('-grExitAt', options['no-review'] ? 'handoff' : 'review');
    }

    return runStep(job, 'Run', args, options, Boolean(options.interactive));
  },

  async open(options) {
    const job = loadJob(options);
    const preview = path.join(job.directory, 'preview.mp4');
    if (!fs.existsSync(preview)) {
      return { ok: false, state: 'no-preview', error: 'This job has no preview video (it is not waiting for review).' };
    }

    const opener = process.platform === 'darwin' ? ['open', [preview]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', preview]]
        : ['xdg-open', [preview]];
    const child = spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, state: 'opened', previewVideo: preview };
  },

  async approve(options) {
    const job = loadJob(options);
    const review = lastStatus(job, 'awaiting-review');
    if (!review) {
      return { ok: false, state: 'not-awaiting-review', error: 'This job is not waiting for review.' };
    }

    return runStep(job, 'Approve', ['-grWorkspace', review.session.workspacePath, '-grOnPending', options['on-pending'] || 'fail'], options, false);
  },

  async discard(options) {
    const job = loadJob(options);
    if (!options.confirm) {
      throw new UsageError('discard deletes the recording: pass --confirm once the user (or you, for your own failed attempt) decided to drop it.');
    }

    const review = lastStatus(job, 'awaiting-review');
    if (!review) {
      return { ok: false, state: 'not-awaiting-review', error: 'This job is not waiting for review.' };
    }

    return runStep(job, 'Discard', ['-grWorkspace', review.session.workspacePath, '-grConfirmDiscard'], options, false);
  },

  async check(options) {
    const job = loadJob(options);
    const handoff = lastStatus(job, 'awaiting-agent');
    if (!handoff || !handoff.session || !handoff.session.sessionPath) {
      return { ok: false, state: 'not-awaiting-agent', error: 'This job has no session that waits for the script documents.' };
    }

    return runStep(job, 'Check', ['-grSession', handoff.session.sessionPath], options, false);
  },

  async complete(options) {
    const job = loadJob(options);
    const handoff = lastStatus(job, 'awaiting-agent');
    if (!handoff || !handoff.session || !handoff.session.sessionPath) {
      return { ok: false, state: 'not-awaiting-agent', error: 'This job has no session that waits for the script documents.' };
    }

    // "complete" is the agent saying that the documents are done: the launcher writes the result file
    // for it, as the newest file of the folder, which is what the recorder's handshake asks for.
    const signedOff = writeResultFile(path.join(handoff.session.sessionPath, 'scripts'));
    if (signedOff.error) {
      return { ok: false, state: 'not-awaiting-agent', job: job.directory, error: signedOff.error };
    }

    return runStep(job, 'Complete', ['-grSession', handoff.session.sessionPath], options, false);
  },

  async status(options) {
    const job = loadJob(options);
    if (job.steps.length === 0) {
      return { ok: false, state: 'not-started', job: job.directory };
    }

    const record = job.steps[job.steps.length - 1];
    return finishStep(job, record, buildResult(job, record, null));
  },

  async wait(options) {
    const job = loadJob(options);
    if (job.steps.length === 0) {
      return { ok: false, state: 'not-started', job: job.directory };
    }

    const record = job.steps[job.steps.length - 1];
    const wait = await waitForStep(job, record, null, numberOption(options, 'timeout', 0));
    return finishStep(job, record, buildResult(job, record, wait));
  },

  async cancel(options) {
    const job = loadJob(options);
    const record = job.steps[job.steps.length - 1];
    if (!record || !isAlive(record.pid)) {
      const idle = { ok: true, state: 'not-running', job: job.directory };
      return record ? finishStep(job, record, idle) : idle;
    }

    // Only the process this job started: the pid must still be a Unity Editor on this job's project.
    const owned = unityProcesses().some((entry) => entry.pid === record.pid && entry.command.includes(record.statusFile));
    if (!owned) {
      return { ok: false, state: 'not-owned', error: `Process ${record.pid} is not this job's Unity process any more.` };
    }

    record.cancelled = true;
    saveJob(job);
    process.kill(record.pid);
    for (let i = 0; i < 20 && isAlive(record.pid); i++) {
      await sleep(500);
    }

    if (isAlive(record.pid)) {
      process.kill(record.pid, 'SIGKILL');
      await sleep(1000);
    }

    return finishStep(job, record,
      { ok: true, state: 'cancelled', job: job.directory, note: 'A recording that was in progress keeps its partial workspace; nothing was deleted.' });
  },

  async jobs(options) {
    const project = resolveProject(options);
    const root = path.join(outputRoot(project, options), JOBS_FOLDER, 'jobs');
    let names = [];
    try {
      names = fs.readdirSync(root).sort();
    } catch {
      names = [];
    }

    const jobs = [];
    for (const name of names) {
      const directory = path.join(root, name);
      const job = readJson(path.join(directory, 'job.json'));
      if (!job) {
        continue;
      }

      const record = (job.steps || [])[job.steps.length - 1];
      const status = record ? readStatus(record) : null;
      const state = !record ? 'not-started'
        : isAlive(record.pid) ? 'running'
          : status && status.finished ? status.state : 'failed';
      const entry = { job: directory, kind: job.kind, createdAt: job.createdAt, state };
      if (lastStatus({ ...job, directory }, 'awaiting-review')) {
        entry.waitingFor = 'the user\'s review (open, then approve or discard --confirm)';
      } else if (lastStatus({ ...job, directory }, 'awaiting-agent') && state !== 'finalized') {
        entry.waitingFor = 'the script documents (follow the prompt, then complete)';
      }

      jobs.push(entry);
    }

    return { ok: true, state: 'jobs', jobs };
  },

  async pending(options) {
    const project = resolveProject(options);
    const job = newJob(project, options, 'pending');
    const args = ['-grOutput', job.outputRoot];
    if (options['set-aside']) {
      args.push('-grOnPending', 'setaside');
    }

    const result = await runStep(job, 'Status', args, options, false);
    const record = job.steps[job.steps.length - 1];
    const status = record ? readStatus(record) : null;
    if (status && status.pending) {
      result.pending = status.pending;
    }

    return result;
  },

  async clean(options) {
    const project = resolveProject(options);
    const root = path.join(outputRoot(project, options), JOBS_FOLDER, 'jobs');
    const removed = [];
    const kept = [];
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      const directory = path.join(root, entry.name);
      const job = readJson(path.join(directory, 'job.json'));
      const last = job && job.steps && job.steps.length > 0 ? job.steps[job.steps.length - 1] : null;
      // Only what a rehearsal, a pending check or an aborted start left behind: logs and frames.
      const disposable = !job || job.kind === 'rehearse' || job.kind === 'pending';
      if (!disposable || (last && isAlive(last.pid))) {
        kept.push(entry.name);
        continue;
      }

      fs.rmSync(directory, { recursive: true, force: true });
      removed.push(entry.name);
    }

    return { ok: true, state: 'cleaned', removed, kept, note: 'Recording jobs and every recording were left untouched.' };
  },

  async install(options) {
    const project = resolveProject(options);
    const embedded = path.join(project, 'Packages', PACKAGE_NAME);
    if (fs.existsSync(embedded)) {
      return { ok: false, state: 'embedded', error: `The project already embeds the package at ${embedded}; replace that folder to upgrade it.` };
    }

    const manifestPath = path.join(project, 'Packages', 'manifest.json');
    const manifest = readJson(manifestPath);
    if (!manifest || typeof manifest.dependencies !== 'object') {
      return { ok: false, state: 'no-manifest', error: `Packages/manifest.json could not be read in ${project}.` };
    }

    const store = options.store ? path.resolve(options.store) : undefined;
    const unityVersion = readUnityVersion(project);
    let source;
    let installed = null;
    if (options.package) {
      source = path.resolve(options.package);
      if (!fs.existsSync(source)) {
        throw new UsageError(`Package not found: ${source}`);
      }
    } else if (!options.url && findBundledPackage(unityVersion)) {
      // The build this plugin carries: nothing is downloaded.
      const bundled = findBundledPackage(unityVersion);
      let stored;
      try {
        stored = storeBundledPackage(bundled, store);
      } catch (error) {
        return { ok: false, state: 'package-unusable', error: error.message };
      }

      installed = { file: stored.file, origin: 'plugin', copied: stored.copied, bytes: stored.bytes, version: bundled.packageVersion, unity: bundled.unity };
      source = stored.file;
    } else {
      // A download is installed only with a checksum: from the table that ships with the plugin, or one the user gave.
      const pinned = options.url ? { url: options.url, sha256: required(options, 'sha256') } : findPackageSource(unityVersion);
      if (!pinned) {
        throw new UsageError(`This plugin carries no recorder package for Unity ${unityVersion} and no download is known for it. ` +
          'Pass --package <folder or .tgz>, or --url <https url> --sha256 <checksum>.');
      }

      let downloaded;
      try {
        downloaded = await downloadPackage(pinned.url, pinned.sha256, store);
      } catch (error) {
        if (error instanceof UsageError) {
          throw error;
        }

        return { ok: false, state: 'download-failed', error: error.message, url: pinned.url };
      }

      const described = readTarballManifest(downloaded.file);
      if (described && described.name !== PACKAGE_NAME) {
        return { ok: false, state: 'download-failed', error: `The downloaded file is a package named "${described.name}", not ${PACKAGE_NAME}.`, url: pinned.url };
      }

      installed = {
        ...downloaded,
        origin: 'download',
        url: pinned.url,
        version: described ? described.version || null : null,
        unity: described ? described.unity || null : null,
      };
      source = downloaded.file;
    }

    const previous = manifest.dependencies[PACKAGE_NAME] || null;
    manifest.dependencies[PACKAGE_NAME] = `file:${source.replace(/\\/g, '/')}`;
    writeJson(manifestPath, manifest);
    const result = { ok: true, state: 'installed', manifest: manifestPath, previous, now: manifest.dependencies[PACKAGE_NAME] };
    if (installed) {
      result.package = installed;
      result.notes = ['The manifest points at a copy of the package kept on this computer, outside the project. Unity adds the package the next time it opens the project.'];
    }

    return result;
  },

  async uninstall(options) {
    const project = resolveProject(options);
    const manifestPath = path.join(project, 'Packages', 'manifest.json');
    const manifest = readJson(manifestPath);
    if (!manifest || typeof manifest.dependencies !== 'object') {
      return { ok: false, state: 'no-manifest', error: `Packages/manifest.json could not be read in ${project}.` };
    }

    const entry = manifest.dependencies[PACKAGE_NAME];
    if (!entry) {
      return { ok: true, state: 'not-installed', manifest: manifestPath };
    }

    // Only what this launcher put there: a package the project brought itself is the user's business.
    if (!/^file:.*\/com\.gameplay\.recorder-[0-9a-f]{16}\.tgz$/.test(entry)) {
      return {
        ok: false,
        state: 'not-ours',
        error: `The project's recorder package was not installed by this launcher (${entry}); it was left alone.`,
      };
    }

    delete manifest.dependencies[PACKAGE_NAME];
    writeJson(manifestPath, manifest);
    return { ok: true, state: 'uninstalled', manifest: manifestPath, removed: entry };
  },

  async 'install-ffmpeg'(options) {
    const found = options.force ? null : findFfmpeg(options.project ? path.resolve(options.project) : null);
    if (found) {
      return { ok: true, state: 'ffmpeg-present', ffmpeg: found, notes: ['FFmpeg is already there; nothing was downloaded.'] };
    }

    const source = findFfmpegSource();
    if (!source) {
      return {
        ok: false,
        state: 'no-ffmpeg-source',
        error: `No FFmpeg download is known for ${process.platform} ${process.arch}. Ask the user to install FFmpeg, or to set GAMEPLAY_RECORDER_FFMPEG to an FFmpeg executable.`,
      };
    }

    try {
      return { ok: true, state: 'ffmpeg-installed', ffmpeg: await installFfmpeg(source, options.store ? path.resolve(options.store) : undefined) };
    } catch (error) {
      if (error instanceof UsageError) {
        throw error;
      }

      return { ok: false, state: 'download-failed', error: error.message, url: source.url };
    }
  },
};

/**
 * The status of the job's most recent step that ended in the given state, as long as what it
 * points at is still there (the workspace of a recording that awaits review, the session that
 * awaits its script documents). A later step that failed does not hide it, so the step can be retried.
 */
function lastStatus(job, state) {
  for (let i = job.steps.length - 1; i >= 0; i--) {
    const status = readStatus(job.steps[i]);
    if (!status || !status.finished || status.state !== state || !status.session) {
      continue;
    }

    const target = state === 'awaiting-review' ? status.session.workspacePath : status.session.sessionPath;
    return target && fs.existsSync(target) ? status : null;
  }

  return null;
}

/**
 * Writes script_processing_result.json with the token of the job file (a .tmp file first, then a rename, so the
 * recorder never reads half a file). Returns { error } when the folder is not a hand-off that waits for documents.
 */
export function writeResultFile(scriptsPath) {
  const jobFile = path.join(scriptsPath, 'script_processing_job.json');
  let token;
  try {
    token = JSON.parse(fs.readFileSync(jobFile, 'utf8')).token;
  } catch {
    // A finalized session has no job file any more; the driver reports that state itself.
    return fs.existsSync(scriptsPath) ? {} : { error: `The scripts folder was not found: ${scriptsPath}` };
  }

  if (typeof token !== 'string' || token.length === 0) {
    return { error: `The job file has no token: ${jobFile}` };
  }

  const resultFile = path.join(scriptsPath, 'script_processing_result.json');
  fs.writeFileSync(`${resultFile}.tmp`, JSON.stringify({ v: 1, status: 'complete', token }));
  fs.renameSync(`${resultFile}.tmp`, resultFile);
  return { resultFile };
}

/** What a reader needs first comes first: a long play summary would otherwise bury the next step. */
const FIRST_KEYS = ['ok', 'job', 'command', 'state', 'error', 'unityExitCode', 'next', 'warnings', 'notes', 'agent'];

export function orderResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }

  const ordered = {};
  for (const key of FIRST_KEYS) {
    if (key in result) {
      ordered[key] = result[key];
    }
  }

  return { ...ordered, ...result };
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
    const command = options._[0];
    if (options.help || !command || command === 'help') {
      console.log(USAGE);
      return 0;
    }

    if (!Object.prototype.hasOwnProperty.call(commands, command)) {
      throw new UsageError(`Unknown command "${command}".`);
    }

    const result = await commands[command](options);
    console.log(JSON.stringify(orderResult(result), null, 2));
    return result.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError) {
      console.log(JSON.stringify({ ok: false, state: 'usage', error: error.message }, null, 2));
      return 2;
    }

    console.log(JSON.stringify({ ok: false, state: 'launcher-error', error: String(error && error.stack ? error.stack : error) }, null, 2));
    return 3;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
