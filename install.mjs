#!/usr/bin/env node
// Installs the Orvind Exporter skill for an agent that loads skills from a folder (Cursor, Antigravity
// and other agents that read SKILL.md). Claude Code, Codex and Gemini CLI install from this repository
// with their own commands instead: see README.md.
//
//   node install.mjs cursor                 into ~/.cursor/skills
//   node install.mjs antigravity            into ~/.gemini/config/skills
//   node install.mjs agents                 into ~/.agents/skills (the folder several agents share)
//   node install.mjs --dir <skills folder>  into the skills folder of any other agent
//   node install.mjs <target> --uninstall   remove the skill again
//
// Prints one JSON object. No dependencies; Node 18 or newer.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_NAME = 'orvind-export';
const REPOSITORY_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SKILL_SOURCE = path.join(REPOSITORY_ROOT, 'plugins', 'orvind-exporter', 'skills', SKILL_NAME);

/** The skills folder of each agent this script knows, below the user's home folder. */
export function knownSkillsFolders(home = os.homedir()) {
  return {
    cursor: path.join(home, '.cursor', 'skills'),
    // The one global folder that the Antigravity IDE, the Antigravity app and its CLI all read.
    antigravity: path.join(home, '.gemini', 'config', 'skills'),
    agents: path.join(home, '.agents', 'skills'),
  };
}

export function parseArguments(argv) {
  const options = { target: null, dir: null, uninstall: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--dir') {
      options.dir = argv[++index] || '';
    } else if (argument === '--uninstall') {
      options.uninstall = true;
    } else if (!argument.startsWith('--') && options.target === null) {
      options.target = argument;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

/** The folder the skill is installed into: `<skills folder>/orvind-export`. */
export function resolveSkillFolder(options, home = os.homedir()) {
  if (options.dir !== null) {
    if (!options.dir) {
      throw new Error('--dir needs the path of a skills folder.');
    }

    if (options.target !== null) {
      throw new Error('Pass an agent name or --dir, not both.');
    }

    return path.join(path.resolve(options.dir), SKILL_NAME);
  }

  const known = knownSkillsFolders(home);
  if (!options.target || !Object.hasOwn(known, options.target)) {
    throw new Error(
      `Say where to install: ${Object.keys(known).join(', ')}, or --dir <skills folder> for another agent.`,
    );
  }

  return path.join(known[options.target], SKILL_NAME);
}

/** True when a folder holds this skill (so an install may replace it and an uninstall may remove it). */
export function isThisSkill(folder) {
  try {
    const text = fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8');
    return /^name:\s*orvind-export\s*$/m.test(text.split(/^---\s*$/m)[1] || '');
  } catch {
    return false;
  }
}

function refuseForeignFolder(folder) {
  if (fs.existsSync(folder) && !isThisSkill(folder)) {
    throw new Error(`${folder} exists and is not the ${SKILL_NAME} skill. Nothing was changed.`);
  }
}

export function installSkill(folder, source = SKILL_SOURCE) {
  if (!isThisSkill(source)) {
    throw new Error(`The skill was not found at ${source}. Run this script from a full copy of the repository.`);
  }

  refuseForeignFolder(folder);
  const replaced = fs.existsSync(folder);
  // The new copy is complete next to the old one before the old one goes.
  const staging = `${folder}.installing`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(folder), { recursive: true });
  fs.cpSync(source, staging, { recursive: true, filter: (entry) => path.basename(entry) !== '.DS_Store' });
  fs.rmSync(folder, { recursive: true, force: true });
  fs.renameSync(staging, folder);
  return { ok: true, state: replaced ? 'updated' : 'installed', skill: folder };
}

export function uninstallSkill(folder) {
  if (!fs.existsSync(folder)) {
    return { ok: true, state: 'not-installed', skill: folder };
  }

  refuseForeignFolder(folder);
  fs.rmSync(folder, { recursive: true, force: true });
  return { ok: true, state: 'uninstalled', skill: folder };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try {
    const options = parseArguments(process.argv.slice(2));
    const folder = resolveSkillFolder(options);
    result = options.uninstall ? uninstallSkill(folder) : installSkill(folder);
    if (result.state === 'installed' || result.state === 'updated') {
      result.next =
        'Tell the user the skill is installed and that it loads in a new agent session. To use it they ask, ' +
        'with the path of their project at the end: "Export gameplay for Orvind from the Unity project at <path>"';
    }
  } catch (error) {
    result = { ok: false, state: 'failed', error: error.message };
  }

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
