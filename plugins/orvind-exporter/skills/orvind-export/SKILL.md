---
name: orvind-export
description: Exports gameplay of a Unity project with Orvind Exporter, with no manual work from the user. You ask which scene to export from, play the game yourself through an input script, record it, document the game's scripts and finalize the export folder the user uploads to app.orvind.com. Use when the user asks to record, capture or export gameplay of a Unity project for Orvind or with Orvind Exporter.
---

# Export a Unity game for Orvind

The Orvind Exporter is a Unity package that records a play session (video, runtime
data, assets, scripts) into a `session_<id>` folder. Normally a person presses record and plays.
With this skill you do it: you start the Unity Editor from the command line, play the game with
an input script you write, and hand the user the finished export.

## Talking to the user

Say little. The user wants the export, not an account of how you make it. They hear from you:

1. Once at the start: which scene to export from (step 1).
2. A short question when something needs their agreement or their hands: adding the package to
   the project, downloading FFmpeg, closing Unity, playing the game themselves.
3. Once at the end: the report in step 6.
4. A problem that stops you, in a sentence or two, with what you need from them.

Nothing else. Do not announce steps, narrate rehearsals, describe the recording or summarize what
you wrote. Do not ask them to review the recording: you check it yourself. A question is one or
two sentences.

## The launcher

Everything goes through one script, `scripts/orvind-exporter.mjs`, next to this file. Run it with Node:

```bash
node "<folder of this SKILL.md>/scripts/orvind-exporter.mjs" <command> [options]
```

Every command except `help` prints one JSON object. `"ok": true` means the command did what you asked, whatever
`state` it ended in; otherwise read `state`, `error` and `next`. A command that starts a run
prints `job`, the folder of that job; the commands that continue it take that path as
`--job "<job>"`. `warnings` are things you must
not overlook even when `ok` is true; `notes` are for your information.

Commands that start Unity take from 10 seconds to several minutes: run them with a long timeout
(10 minutes), or add `--detach` and poll with `wait --job <job> --timeout 50`. Never start two
jobs on the same project at once, and do not run other heavy work while a job plays the game.
`jobs --project <project>` lists the jobs you started and what each one is waiting for, if you
lose track; `help` lists every command.

Never pass `-nographics` to Unity and never edit the user's project to make a run work. The only
project file you may change is `Packages/manifest.json`, through `install`, after the user agreed.

A rehearsal or a scripted recording leaves the game's saved progress untouched: the launcher puts
PlayerPrefs and the game's persistent data folder back as they were before the run (`saveData`
in the result says what the game had saved). Every run therefore starts from the same state.

A rehearsal or a scripted recording runs in the background, so the user can keep working while
the game plays: the game's sound is not sent to the speakers (`play.speakersSilent`), and on
macOS the Editor's Game view window is invisible and takes no clicks (`play.windowHidden`). The
screenshots and the video are the same, and the video keeps its audio. When `play.windowHidden`
is false (Windows, or a system that refused), the window was on the user's screen: tell them
before the next run. Pass `--watch` only when the user asks to watch the script play; it shows
the window and plays the sound.

## Workflow

### 1. Preflight, then ask for the scene

```bash
node orvind-exporter.mjs preflight --project "<project>"
```

Read the result before anything else:

- `plugin.updateRequired` is true (the first of the `problems` says so): a newer version of this
  plugin is published, and this one refuses to rehearse or record. Run `update` before anything
  else, without asking the user, and do what its `next` says. Either the skill was replaced in
  place (read this file again, it changed, and start over), or the new version only loads in a
  new session (tell the user so in one sentence and stop). Never work around it.
- `problems` is not empty: resolve them first. If the project is open in the Unity Editor, ask the
  user to close Unity (a project can only be open in one Editor).
- The recorder package is missing (`recorderPackage.installed` is false): this skill carries the
  package for Unity 6000 and 2022.3 (`recorderPackage.bundled`). Ask the user first, because it
  adds a line to their `Packages/manifest.json` (no need to ask when their request already said
  you may). When they agree, run `install --project "<project>"`: it copies the package into the
  user's home folder and points the manifest at it; nothing is downloaded. For another Unity
  version, ask the user where the package is and run
  `install --project "<project>" --package "<folder or .tgz>"`. Then run `preflight` again.
  The line it adds is a path on this computer; the report at the end says so.
  `uninstall --project "<project>"` removes it again when the user asks.
- `recorderPackage.missing` is set: the project's manifest already has a recorder line, but it
  points at a file or folder that is gone, and Unity cannot open the project like that. It is the
  same question to the user and the same `install`, which replaces the line (the result's
  `previous` is the old one; name it in the question).
- `warnings`, `gameScriptCount` and `sceneDigests` (which of the project's scripts each scene
  uses) say whether there is a game to play at all. See "Nothing to play" below.
- `automation` and `needsHuman` say what a script can do in this project. Pointer input (taps,
  drags, UI clicks) always works. Keyboard and gamepad input need the Input System. If the game's
  core gameplay needs keys or axes of the legacy Input Manager, you cannot play it: after the
  scene question, go straight to step 5.
- `scenes`, `buildScenes`, `startScene` and `sceneDigests` are what you ask the scene question
  with (below). `preflight --scene "<scene>"` adds the digest of a scene that is not listed yet.
- `suggestedSize` is the render size every run uses unless you pass `--size`.
- `ffmpeg` is the FFmpeg the run will use for the video's audio and for the contact sheets: one
  that is already on the machine, or one this launcher downloaded earlier. When there is none, a
  warning says so and `ffmpeg.download` names what the launcher can fetch (20 to 30 MB from
  github.com). Ask the user, then run `install-ffmpeg`: it checks the file against the checksum
  that ships with this skill and keeps it in the user's home folder. Without FFmpeg a recording
  on macOS has no audio. A user who prefers their own can install FFmpeg themselves; run
  `preflight` again afterwards.
- `scriptsFolder` is where your input scripts go (it exists already and is outside `Assets/`).

**Ask which scene to export from.** When the problems above are resolved, show the project's
scenes as a numbered list and ask which one to export from. Then wait for the answer.

- List `buildScenes` first, in build order, then the other `scenes`. One line per scene: its path
  and at most a few words (`starts the game`, `gameplay`, `no scripts or UI`), taken from
  `startScene` and `sceneDigests`. Do not explain the list.
- Mark one scene as your suggestion: the scene that holds the gameplay itself rather than a
  menu or loading scene in front of it, when the digests show one. Otherwise the start scene.
- With more than fifteen scenes, list the build scenes and the scenes that hold game scripts,
  and say how many others there are.
- Skip the question only when the user's request names the scene, or `scenes` has exactly one
  entry. One build scene among several scenes is not a reason to skip it, and neither is being
  sure which scene holds the game: show the list and let the user choose.

Pass the chosen scene's asset path as `--scene` (for example `Assets/Scenes/Game.unity`); a scene
outside the build settings works too.

### 2. Understand the game

Read the scripts the scene uses (`sceneDigests`) until you can say: how the game is controlled,
what a normal session looks like, and what on screen shows progress (score, level, a result
panel). Then look at the running game once without touching it:

```bash
node orvind-exporter.mjs rehearse --project "<project>" --scene "<scene>" --duration 8
```

`play.summary` is the short version of the run. The report at `play.reportPath` lists the UI
elements, labels and objects with their names, world positions and screen positions
(`sceneAtStart`), and `play.frames` are screenshots in `play.framesDirectory`. Open
`play.contactSheet.file` first: up to twelve of the run's frames in one image, in reading order
(`play.contactSheet.frames` names them); open single frames when you need detail. You need the
names from the report for your script.

The start of the run only shows the first screen. To see what a later screen contains, write a
short exploration script that gets there and ends with a `snapshot` step (it stores the same
inventory for that moment). Exploration runs are cheap and do not count as attempts.

If the chosen scene does not run on its own (the screen stays empty, or the game logs errors about
managers that another scene creates), say so in one sentence and ask whether to export from
`startScene` instead.

**Nothing to play.** If the project has no gameplay scripts, the scene has no scripted objects
and no UI, and the observe-only run shows a scene in which nothing happens, there is no game to
record. Do not record it and do not invent a script: tell the user what you found and ask which
scene or project they meant.

### 3. Write an input script and rehearse it

Write the script as a JSON file in `scriptsFolder`. The format is in
[references/input-script.md](references/input-script.md); read it before writing your first
script.

```bash
node orvind-exporter.mjs rehearse --project "<project>" --scene "<scene>" --script "<script.json>" --duration 45
```

**Record the gameplay, not what stands in front of it.** The export is for the game being
played. Put one `start_recording` step in the script at the point where the gameplay is on
screen: the steps before it are played but not recorded, so they are in neither the video nor
the scene export. Without the step the recording starts with the scene.

The scene export (`MainScene.glb`) is what the playable is rebuilt from, and it is taken at the
moment the recording starts. It must show the game's level. A game that boots in an empty or
loading scene, or opens a menu or hub scene first, has nothing of the level there: get to the
level first, wait until it exists (`wait_until` on its scene or on an object of it), then
`start_recording`. A recording whose scene export is empty is refused (the result says
`MainScene.glb is empty`); nothing is exported until you record again from the right moment.

First decide, from the scripts and the exploration runs, which screens are gameplay. A screen is
part of the gameplay when what the player does on it changes how the game plays, or when the
game's own loop sends the player there: buying upgrades for the car between races, choosing a
loadout, a card or a skill, placing or merging units, levelling up, picking the next level on a
map the game is about. Play those the way a player does (buy the upgrade you can afford, pick a
card) and let the next round show the effect. A screen is not gameplay when it only stands
between the player and the game: title, splash and loading screens, consent, login and rating
popups, daily rewards, offers and real-money stores, ads and interstitials, settings, credits.

- Before `start_recording`: press Play, Start or Continue as soon as it exists (`wait_until` it
  exists, then `click`), never after a fixed wait.
- Close what is not gameplay the same way, and skip a tutorial when it can be skipped. Use an
  `if` step for anything that only appears sometimes, so the script does not fail without it.
- After `start_recording`: do not open screens that are not gameplay, and do not wait on one.
- End on an outcome: the result of the round, or of the round after an upgrade when the game has
  such a loop (`tail` of 1 to 3 seconds). Do not record what comes after it.

A rehearsal plays the game with your script but records nothing. Judge it honestly:

- `play.summary.script.completed` must be true. `play.summary.steps` has one line per step: every
  result that is not `ok`, and every `!!` warning, needs a fix or an explanation.
- `completed` only says that the script ran to its end, not that the game went well: a lost
  round completes too. End the script on a `wait_until` for the outcome you want (the result
  panel, the win text), so that a run without it shows up as a failed step.
- Look at the contact sheet and at several frames across the run, not only the last one. A
  magenta ring marks where the pointer is pressed or held (during a joystick `steer` that is the
  stick, not the player). The ring is drawn into the screenshots only, never into the video.
  Does the game react to your input? Does it look like someone playing?
- `play.summary.texts` (what each UI text said at the start and at the end) and
  `play.summary.objects` (what appeared and disappeared) must show the game progressing: a score
  going up, a level starting, objects being hit or collected. The report's `events` and `gameLog`
  have the details and their times.
- `play.summary.errors` lists exceptions the game logged during the run.

- The step line of `start_recording` says when the recording would start: the frames from then
  on show gameplay, including the screens you counted as gameplay above, and no title screen,
  popup or interstitial. In a rehearsal the step only marks the moment.

If the run is not good, change the script and rehearse again. A good run plays the core loop of
the game and reaches a visible outcome, usually within 20 to 60 seconds. Do not pad a short game
with waits: one complete round at the game's natural pace is a good recording, and a second
round or level is better than slow pacing. Stop after about five attempts without progress
and go to step 5.

### 4. Record and check

```bash
node orvind-exporter.mjs record --project "<project>" --scene "<scene>" --script "<script.json>" --duration 60
```

`--duration` is the maximum; the recording ends when the script ends. The result has state
`awaiting-review`: the recording is saved but nothing was exported yet. The review is yours.
Check it the same way as a rehearsal (`play.summary`, the frames), and open
`review.contactSheet.file`: twelve frames of the video itself, in reading order. A recording runs
the same script at the same frame rate as the rehearsal, but games are not perfectly repeatable.

- `recording.sceneExportMeshes` is 0, or the state is `failed` with `MainScene.glb is empty`:
  the recording started before the level was in the scene. Move `start_recording` behind a wait
  for the level and record again.
- The run went wrong, or it spends its time on screens that are not gameplay:
  `discard --job "<job>" --confirm`
  and record again. After three recordings that went wrong, go to step 5.
- `review.coverage` says how much of the project's animation content (clips, animator
  controllers, particle systems) played. It is information, not a pass mark. When something
  central to the game did not play, lengthen the script (a second round, another level) and
  record again.
- The run is good: `node orvind-exporter.mjs approve --job "<job>"`, then step 6. Do not ask the
  user and do not open the video.

### 5. When you cannot play the game

You get here when the game needs keys or axes you cannot press (step 1), after about five
rehearsals without progress (step 3), or after three recordings that went wrong (step 4). Do not
keep trying, and do not record a run that does not play the game. Ask the user one question and
wait for the answer:

```text
I could not play this game well enough to record it: <what blocked you, in one sentence>.
Can you tell me how it is played, or play one round yourself? If you play, I open Unity with a
Start exporting button: get to the gameplay, press it, play a round, then press Stop and finish.
```

Leave out the first option when an explanation cannot help (keys you cannot press).

- They explain how it is played: go back to step 3 with what they said. Three more rehearsals;
  when those do not get you there either, ask them to play.
- They play. Run this only after they said yes, because it opens Unity in front of their other
  windows:

  ```bash
  node orvind-exporter.mjs record --project "<project>" --scene "<scene>" --interactive --max-duration 600
  ```

  Unity opens the scene and waits with a small window; nothing is recorded yet. The user can
  change settings, press Play and go past the menus. The recording starts when they press Start
  exporting (pressed before Play, it starts the game as well) and ends when they press Stop and
  finish or leave Play Mode. Unity then saves, exports and closes by itself. There is no time
  limit while Unity waits; `--max-duration` limits the recording. The command returns when Unity
  has closed, so run it detached or with a long timeout. There is no review step for a recording
  the user made, and what they save while playing stays saved. Then step 6.

  State `not-started` means they closed Unity without pressing Start exporting: nothing was
  recorded. Ask whether they want to try again.
- They can do neither now: stop, and say in one sentence that nothing was exported.

### 6. Write the gameplay brief and finish

After `approve` (or an interactive recording) the state is `awaiting-agent` when the recording
exported C# scripts. `agent.scriptsPath` is the folder to work in: it holds the exported sources
(`agent.sourceCount` files, `agent.sourceLines` lines), the instructions (`agent.promptPath`) and
`SOURCE_MAP.md`, the recorder's map of the sources with the values each component held in the
recording. `status --job "<job>"` prints these paths again.

Open the prompt file and follow it, except for what it says about telling the user: the report
below is all they get. In short: start from the source map, read the scripts that
drive the game, and write one brief of the game's logic and constants (`_project_behavior.md`)
plus a one-table inventory (`_index.md`). It is not a document per script. Do not tell the user
about this step; it is part of the export.

- Use only that folder as your source of truth. A script you read in step 2 that is not among
  the exported sources does not exist for this task. Every rule and number comes from the
  sources or the recorded values.
- What you saw in the recording itself (which level was played, that a button was locked) may
  be stated when you say that it was seen in the recording. The play summary that `status`
  prints and the frames count as the recording.
- The prompt's rule against reading outside the folder is about the game's sources; this skill
  and the launcher remain yours to use.

When the documents are written, check them. `check` applies the recorder's validation and changes
nothing; it starts Unity, so it takes a minute or more:

```bash
node orvind-exporter.mjs check --job "<job>"
```

- `checked`: the documents would be accepted. `agent.notes` lists what to look at once more
  (numbers and names that occur in no source, a used source the brief never mentions). Correct
  what is wrong and leave what is right. Notes do not block anything: a number you saw in the
  recording stays listed, and that is fine. After corrections you do not need another check,
  because `complete` validates again and a rejection there loses nothing.
- `agent-output-rejected`: `agent.validatorError` says what to fix. Fix it and check again.

Then finish. `complete` signs off the documents for you (it writes the result file the prompt
mentions, so you do not) and finalizes the session:

```bash
node orvind-exporter.mjs complete --job "<job>"
```

- `finalized`: done. The session's `scripts` folder now holds only your Markdown; the sources
  and the hand-off files were removed. Run `clean --project "<project>"` (it removes the job
  folders of rehearsals; your input scripts stay where they are), then give the user the report
  below.
- `agent-output-rejected`: fix what `agent.validatorError` names, run `check` until it passes,
  and run `complete` again. Nothing is lost between attempts. If it is still rejected after
  four attempts, tell the user what the validator says.

If the state after `approve` is already `finalized`, the recording had no scripts to document:
give the report.

**The report.** Exactly this, with `session.sessionPath` as the folder:

```text
The export is done: <session folder>
Upload this folder to your campaign at app.orvind.com.
```

Add a line only for something the user has to act on: files Unity rewrote in their project
(`projectFilesChanged`), a recording without audio, or the package line in
`Packages/manifest.json` if you added it (it is a path on this computer, not for committing).
Nothing about how the run went.

## Options

| Option | Commands | Meaning |
|-|-|-|
| `--size <WxH>` | rehearse, record | Render size. Default: `suggestedSize` (720x1280 for portrait games, else 1280x720). Keep one size for all runs so screen positions stay comparable. |
| `--duration <s>` | rehearse, record | Time limit of the run (default 30 for a rehearsal, 60 for a recording). The script ending ends the run earlier. |
| `--fps <n>` | rehearse, record | Video frame rate (default 30). Scripted runs are held to this rate; a busy machine can fall below it (`play.summary.averageFps`), so run one job at a time. |
| `--seed <n>` | rehearse, record | Seeds `UnityEngine.Random`, for games whose levels are random. |
| `--frame-interval <s>` | rehearse, record | Seconds between automatic screenshots (default 2; 0 turns them off). A screenshot is also taken at pointer presses and by `screenshot` and `snapshot` steps. |
| `--frame-size <px>` | rehearse, record | Longest side of a screenshot (default 1024). |
| `--csharp <mode>` | record | Which C# sources are exported for step 6: `attached` (default: the scripts on the objects seen during the recording, in every scene it went through, and the project scripts those use), `all` (every script of the project), `exclude` or `metadata`. Keep the default unless the user asks for something else. |
| `--keep-save` | rehearse, record | Leaves what the game saved during the run. Only when the user wants the run's progress kept. |
| `--watch` | rehearse, record | Shows the Editor's Game view window and plays the game's sound while the script plays. Only when the user asks to watch; without it a run is invisible (macOS) and silent. |
| `--output <dir>` | all | Where recordings and jobs go (default `<project>/ExportedData/GameplayRecording`). |

## Rules

- A recording is the user's data. Discard one only when it is your own attempt that went wrong,
  or when the user asks. Never delete anything by hand; `clean` removes
  the job folders of rehearsals when you are done.
- Do not claim a run worked without having looked at its frames and report.
- Do not record a project that has nothing to play.
- If a command reports an unfinished earlier export (`pending`), finish it if it is yours;
  otherwise ask the user before running `pending --set-aside`.
- If a result lists `projectFilesChanged`, name those files in the final report: Unity rewrote
  them while it had the project open.
- If Unity will not start in your sandbox (licence or permission errors in the log), say so and
  ask the user to allow the command outside the sandbox; do not retry in a loop.

More help: [references/troubleshooting.md](references/troubleshooting.md).
