# Orvind agent plugins

`orvind-exporter` lets a coding agent record gameplay of a Unity project for Orvind. It installs
in Claude Code, Codex, Cursor, Gemini CLI, Antigravity and other agents that read `SKILL.md` skills.

## Install

Paste this into your agent:

```text
Install the Orvind Exporter plugin for me. Follow the steps for the agent you are in https://github.com/orvind/agent-plugins#install-steps-for-agents
```

Or run the steps below yourself.

## Install steps (for agents)

Run the steps of the agent you are, and no others. You need `git` and Node.js 18 or newer
(`node --version`); if one is missing, tell the user instead of installing it. Nothing here needs
an account, a key or a secret: if a step asks for one, stop and tell the user.

When the install is done, tell the user that the plugin loads in a new session and that they use
it by asking this, with the path of their project in place of `<path>`:

```text
Export gameplay for Orvind from the Unity project at <path>
```

### Claude Code

```bash
claude plugin marketplace add orvind/agent-plugins
claude plugin install orvind-exporter@orvind
```

The plugin loads in a new session, or after `/reload-plugins` in a running one.

### Codex

```bash
codex plugin marketplace add orvind/agent-plugins
codex plugin add orvind-exporter@orvind
```

### Gemini CLI

Gemini CLI asks for a confirmation before it installs a skill, and waits for it: in a shell without
a terminal the command never returns. Ask the user whether they agree to install the skill; when
they do, run it with `--consent`:

```bash
gemini skills install https://github.com/orvind/agent-plugins.git --path plugins/orvind-exporter/skills/orvind-export --consent
```

### Cursor

Cursor loads skills from `.cursor/skills` in the user's home folder. Clone this repository into a
folder that stays, then copy the skill there with the installer:

```bash
git clone --depth 1 https://github.com/orvind/agent-plugins.git "$HOME/.orvind/agent-plugins"
node "$HOME/.orvind/agent-plugins/install.mjs" cursor
```

When the folder already exists, run `git -C "$HOME/.orvind/agent-plugins" pull` instead of the
clone. The installer prints one JSON object; `"ok": true` means the skill is in place.

### Antigravity

Antigravity loads skills from `.gemini/config/skills` in the user's home folder: the IDE, the app
and the CLI all read that folder. Clone this repository into a folder that stays, then copy the
skill there with the installer:

```bash
git clone --depth 1 https://github.com/orvind/agent-plugins.git "$HOME/.orvind/agent-plugins"
node "$HOME/.orvind/agent-plugins/install.mjs" antigravity
```

When the folder already exists, run `git -C "$HOME/.orvind/agent-plugins" pull` instead of the
clone. The installer prints one JSON object; `"ok": true` means the skill is in place.

### Any other agent that reads SKILL.md skills

Clone as for Cursor, then give the installer the agent's skills folder:

```bash
node "$HOME/.orvind/agent-plugins/install.mjs" --dir "<skills folder of the agent>"
```

`node install.mjs agents` installs into `.agents/skills` in the user's home folder, which several
agents share. If you do not know where the agent loads skills from, ask the user rather than guess.
