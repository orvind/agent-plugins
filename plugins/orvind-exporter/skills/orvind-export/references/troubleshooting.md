# Troubleshooting

Each job has a folder (`job` in every result) with `job.json`, `status.json`, `unity.log`,
`unity.stdout.txt`, the `play/` report and frames, `frames_contact_sheet.jpg`, a copy of the
input script, and `preview.mp4` with `preview_contact_sheet.jpg` once a recording waits for
review. Later steps of
the same job (approve, discard, check, complete) write `approve.status.json`, `approve.unity.log`
and so on. `save_before` and `save_after` hold the game's saved data from before and after an automated
run. Search the Unity log for `[HeadlessRecording]`, `[AutoPlayer]` and `[RecordingController]`
to follow a run.

`ok` is the only thing that says whether a command succeeded. `unityExitCode` is part of a
result only when the command failed; the table below says what each code means.

| `state` | Meaning | What to do |
|-|-|-|
| `project-open` | The project is open in a Unity Editor (possibly a job of yours that is still running). | Ask the user to close Unity, or wait for your job, then run the command again. |
| `compile-errors` | The project's scripts do not compile; Unity cannot enter Play Mode. `details` lists the errors. | Tell the user. Do not fix their code unless they ask. |
| `package-missing` | The recorder package is not installed, or it is an older build without the command-line driver. | Ask the user whether you may add the package this skill carries, then run `install --project <dir>` (see step 1 of the skill). |
| `packages-unresolved` | Unity could not resolve the project's packages and never opened the project. `details` names the package and the reason, for example a `file:` path that no longer exists. | For the recorder package: run `preflight`, ask the user, run `install` (it replaces the line). For any other package: tell the user; it is their project's problem. |
| `no-licence` | Unity could not get a licence, typical inside a restricted sandbox. | Ask the user to allow the launcher to run outside the sandbox. |
| `update-required` | A newer version of the plugin is published; this one does not rehearse or record. | Run `update` and do what its `next` says. |
| `update-manual`, `update-failed` | `update` could not install the new version from here. | Tell the user what `next` says: for `update-manual` the commands in `commands`, run in a terminal, then a new session. |
| `usage` | The launcher rejected the command before starting Unity (unknown scene, unreadable script, missing option). | Fix what `error` names. |
| `failed` with `unityExitCode` 20 | Bad arguments, usually an invalid input script; `error` lists every problem. | Fix the script. |
| `failed` with `unityExitCode` 21 | A prerequisite failed: an unfinished earlier export (`pending`), no graphics device, the Editor already in Play Mode. | See `error`. For a pending export, finish it or run `pending --set-aside` after asking the user. |
| `failed` with `unityExitCode` 30 or 31 | Play Mode or the recording did not start. | Look for errors right after `Requesting Play Mode` in the log. |
| `failed` with `unityExitCode` 32 | Play Mode ended before the recording was saved; the partial workspace was kept. | Record again. |
| `failed` with `unityExitCode` 40 or 41 | The export pipeline failed; the recording workspace was kept. | Report `error` to the user; `approve` can be run again on the same job. |
| `agent-output-rejected` | The validator rejected the Markdown. | Fix what `agent.validatorError` names, run `check` until the state is `checked`, then run `complete` (it writes the result file again). |
| `checked` | `check` found nothing to reject. `agent.notes` lists what to look at once more (a number that is in no source, a name no source contains, a used source the brief never names, documents that are very long). | Correct what is wrong, leave what is right, then run `complete`. |
| `failed` with `unityExitCode` 50 | The run exceeded its time limit. | Shorten the script or check whether the game is waiting for something. |

`pending --project <dir>` starts Unity (it has to ask the recorder), so it takes as long as any
other command and needs the project closed.

## Updates of the plugin

`preflight`, `rehearse` and `record` ask the plugin's public repository
(github.com/orvind/agent-plugins) which version is current. `plugin` in the preflight result has
the installed `version`, the `latest` one and how this copy was installed (`install`). When a
newer version exists, `update` installs it: a plain skill folder (Cursor, Gemini CLI,
`.agents/skills`, `install: "folder"`) is replaced in place and works at once; a plugin of Claude
Code or Codex is updated with that agent's own commands and loads in a new session.

A machine without a connection is not held up: the check waits five seconds at most, and
`plugin.updateCheck` says that it got no answer. `ORVIND_UPDATE_CHECK=off` in the environment
switches the check off. Set it only when the user asks for it: an export made with an old
version may be one Orvind no longer accepts.

## What the user sees and hears during a run

A rehearsal or a scripted recording should be invisible and silent: `play.windowHidden` and
`play.speakersSilent` are true. The video still has the game's audio.

- A video without audio (`recording.videoMuxStatus` is not `MuxedWithAudio`): on macOS the
  recorder needs FFmpeg for the audio. `preflight` shows which one it found (`ffmpeg`); when
  there is none, ask the user and run `install-ffmpeg`, then record again.
- `play.windowHidden` is false: the Editor's Game view window was on the user's screen. That is
  expected on Windows and Linux (the window is hidden on macOS only). On macOS, search the Unity
  log for `[HeadlessEditorWindows]`.
- The user wants to watch: add `--watch` to `rehearse` or `record`. The window is shown and the
  sound plays.
- A game that draws from the sound it plays (a spectrum visualizer) sees silence in a silent
  run; record such a game with `--watch`.

## The script runs but the game does not react

- The press lands `on nothing` or on the wrong element: compare the step's `detail` with the
  frame that shows the magenta ring. A `covered_by_ui` warning names the UI element that took a
  press meant for a scene object.
- Input System project, game reads `Touchscreen` or `EnhancedTouch` only: add `"pointer": "touch"`.
- Keyboard step ends as `unsupported`: the project only has the legacy Input Manager. Pointer
  steps still work; anything that needs keys needs a person (`record --interactive`).
- The game needs a real pause between actions (cooldowns, animations): add `interval` to `tap`,
  or `wait_until` a condition between actions.
- `steer` ends with `subject_did_not_move`: the control is not the one the game reads (try the
  joystick, the keys or `follow`), or the subject is not the object that moves (name it).
- `steer` moves the wrong way: set `"plane"` to `"ground"` or `"screen"`; if the game's controls
  are not relative to the camera at all, use `direction` or the `drive` control.
- `steer` times out close to the target: the detail shows the closest distance; raise `arrive`
  above it.
- `steer` ends as `blocked`: the subject stopped moving on the way. Look at a frame from that
  moment for what is in the way and steer to a `world` waypoint beside it first.
- The game starts in a menu or boot scene: record from the first build scene and click through
  the menus in the script.
- The game is at a different level or state than you expected: `saveData` shows what earlier
  runs saved. Automated runs put the saved data back afterwards, so each run starts where the
  user's own progress is; what you see at the start of the observe-only run is that state.

## Lines in the Unity log that are not problems

- `ArgumentOutOfRangeException` with `UnityEditor.Search` in its stack: the Editor's own search
  indexer starting up. It is left out of the play report.
- `[usbmuxd]`, `Curl error`, licensing and package-resolution lines at start-up.
- `Couldn't find a readme`: a project template script.

## Limits you should tell the user about

- Runs are real time. A 45 second script takes about 45 seconds plus Unity start-up and export.
- The scripted player cannot do what it cannot name or see: precise timing puzzles, long
  progression and UI Toolkit menus are hard. That is what the interactive fallback is for.
- Saved data is protected through PlayerPrefs and the game's persistent data folder. A game that
  saves somewhere else (its own server, a file outside that folder) keeps what a run saved.
- The tool was verified on macOS. Windows and Linux are untested with batch-mode video capture.
