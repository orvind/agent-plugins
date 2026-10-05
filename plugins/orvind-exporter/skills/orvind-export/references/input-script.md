# Input script format

An input script is a JSON file that plays the game: a list of steps executed one after another
inside Unity. Parsing is strict. An unknown step, property or key name fails the run before the
game starts, and the error names the step (for example `step 4 (tap): "target" is required`).

```json
{
  "version": 1,
  "steps": [
    { "do": "wait_until", "condition": { "exists": "PlayButton" }, "timeout": 10 },
    { "do": "click", "target": { "text": "Play" } },
    { "do": "wait_until", "condition": { "scene": "Gameplay" }, "timeout": 15 },
    { "do": "start_recording" },
    { "do": "tap", "target": { "object": "TargetBlock" }, "times": 5, "interval": 1.2 },
    { "do": "wait_until", "condition": { "text": { "contains": "Level Complete" } }, "timeout": 20 }
  ]
}
```

## Script properties

| Property | Meaning |
|-|-|
| `version` | Must be `1`. |
| `steps` | The steps, in order. Required. |
| `pointer` | `"mouse"` (default, also written `"auto"`) or `"touch"`. Only matters with the Input System: use `"touch"` when the game reads `Touchscreen` or `EnhancedTouch` and has no mouse path. Legacy Input Manager projects always get simulated touches, which the game also sees as mouse button 0. |
| `subject` | An `object` target naming the object you control (the player). Used by `steer` and by `"pick": "nearest"`. Default: the object tagged `Player`, else an object whose name contains "player". |
| `tail` | Seconds to keep running after the last step (default 1), so the outcome is visible. |
| `stop_when_done` | Default `true`: a recording ends when the script ends. `false` keeps recording until the duration limit. |

Any step may carry a `"comment"` string; it is ignored.

## Coordinates, distances and names

Screen positions are normalized `[x, y]` with the origin at the **top-left**, exactly as you see
them in a screenshot: `[0.5, 0.5]` is the centre, `[0.9, 0.1]` is near the top-right corner. The
play report uses the same convention.

World positions are Unity world units, as listed in the report (`position`, `area`).

A **distance** between two objects is the gap between their bounding boxes: 0 when they touch or
overlap. A wide object (a building, a field) is therefore "reached" at its edge. The distance to
a `world` point is measured from the object's bounding box to that point.

A name matches an active object when it equals the object's name (case does not matter, and
Unity's `(Clone)` and ` (3)` suffixes are ignored), when it contains `/` and is the end of the
object's hierarchy path (`Canvas/Menu/PlayButton`), or when it contains `*` as a wildcard
(`Enemy*`). Inactive objects never match. An object that fell over or was pushed away is still
active: wait for what the game shows (a score, a text), not for it to stop existing.

## Targets

A target is an object with exactly one of these:

| Target | Resolves to |
|-|-|
| `{ "screen": [x, y] }` | That point of the screen. |
| `{ "ui": "name" }` | The uGUI element with that name; an interactable button, toggle or slider wins over other elements. |
| `{ "text": "label" }` | The clickable element that shows that text (uGUI Text or TextMeshPro). Exact label first, then a label containing it. |
| `{ "object": "name" }` | A scene object, at the centre of its renderer or collider as seen by the game camera. |
| `{ "world": [x, y, z] }` | A world position, projected by the game camera. |

Optional on any target: `"offset": [dx, dy]`, added to the screen position in the same normalized
units.

Optional on `object` targets, for when several objects match:

| Property | Meaning |
|-|-|
| `"pick"` | `"nearest"` (default: nearest to the subject, or to the screen centre when there is no subject), `"farthest"`, `"random"`, `"highest"` or `"lowest"` (by world height, for stacks). |
| `"within": { "of": target, "distance": d }` | Only objects at most `d` away from another `object` or `world` target: `{ "object": "Plant", "within": { "of": { "object": "FieldA" }, "distance": 1 } }`. |

A target that cannot be found is retried for 1.5 seconds (UI may still be animating in), then the
step fails with `target_not_found`. A target outside the screen also fails, except in `steer`.

UI Toolkit (`UIDocument`) elements have no names here; press them with `screen` targets.

## Steps

| `do` | Properties | What it does |
|-|-|-|
| `wait` | `seconds` | Waits. Prefer `wait_until`. |
| `wait_until` | `condition`, `timeout` (10), `stop_on_timeout` | Waits until the condition holds. On timeout the step fails and the script continues, unless `stop_on_timeout` is true. |
| `tap` | `target`, `hold` (0.06), `times` (1), `interval` (0.25) | Presses and releases the pointer at the target. With `times`, the target is resolved again for every tap, so `"object": "Enemy"` taps the nearest enemy each time. |
| `click` | `target` (`ui` or `text`), `direct` | Taps a UI element. If another element covers it the result says so; `"direct": true` calls the element's click handler without a pointer. |
| `hold` | `target`, `seconds` | Presses, holds (following the target if it moves), releases. |
| `drag` | `from`, `to`, `seconds` (0.3), `hold` (0) | Presses at `from`, moves to `to` over `seconds`, optionally holds there, releases. A swipe is a short drag. |
| `steer` | see below | Moves the subject toward a target with closed-loop control. |
| `key` | `key`, `hold` (0.08), `times`, `interval` | Presses a keyboard key. |
| `hold_keys` | `keys` (array), `seconds` | Holds several keys together. |
| `stick` | `stick` (`left` or `right`), `value` `[x, y]`, `seconds` | Holds a gamepad stick at a value (y up). |
| `button` | `button`, `hold` (0.08) | Presses a gamepad button. |
| `screenshot` | `label` | Saves a labelled frame for you to look at. |
| `snapshot` | `label` | Stores what the scene contains at that moment in the report's `snapshots` (UI elements, labels, objects with positions, like `sceneAtStart`) and saves a frame. Use it to see a screen that only exists later in the run. Up to 8 per run. |
| `repeat` | `steps`, and at least one of `times`, `until` (condition), `seconds` | Repeats the steps. `until` is checked before each pass, `seconds` is the total time after which no new pass starts, `times` the number of passes; the first limit reached ends the loop. |
| `if` | `condition`, `then` (steps), `else` (steps) | Branches once, for things that may or may not be there (a tutorial popup). |
| `note` | `text` | Writes a note into the play report. |
| `stop` | | Ends the script here. It is a normal end: the script counts as completed. |
| `start_recording` | | The recording begins here. The steps before it are played without recording: they are in neither the video nor the scene export, which is taken at this moment. Use it after the steps that get past boot, loading and menu scenes, once the level is on screen. Top-level only, at most once. Without it the recording starts with the scene. In a rehearsal it only notes the moment. A script that ends before reaching it records nothing, and the run fails. |

`tap`, `click`, `hold`, `drag` and `steer` accept `"stop_on_failure": true` to end the script when
the step fails. Without it a failed step is reported and the script goes on.

Key names: `a` to `z`, `0` to `9`, `space`, `enter`, `escape`, `tab`, `backspace`, `delete`,
`left`, `right`, `up`, `down`, `shift`, `ctrl`, `alt`, `f1` to `f12`. Gamepad buttons: `south`,
`east`, `west`, `north`, `start`, `select`, `leftShoulder`, `rightShoulder`, `leftTrigger`,
`rightTrigger`, `dpadUp`, `dpadDown`, `dpadLeft`, `dpadRight`, `leftStickPress`, `rightStickPress`.

Keyboard and gamepad steps need the Input System. In a project that only has the legacy Input
Manager they fail with `unsupported`; preflight tells you this in advance.

## Conditions

A condition is an object with exactly one of these:

| Condition | True when |
|-|-|
| `{ "exists": "name" }` / `{ "not_exists": "name" }` | An active object with that name exists / does not exist. |
| `{ "count": { "object": "name", "op": "<=", "value": 0 } }` | The number of matching objects compares as given (`==`, `!=`, `>`, `>=`, `<`, `<=`). Add `"within": { "of": target, "distance": d }` to count only the ones near something. |
| `{ "text": { "contains": "Win" } }` | Any visible UI text contains the string. `"equals"` instead of `"contains"` for an exact match; add `"of": "ScoreText"` to look at one element. Case does not matter. A word drawn one letter per element (a curved banner; the report shows it as `Parent/*`) is compared as a whole and without spaces, so `"contains": "LEVEL COMPLETE"` matches it; `"of"` then takes the parent's name. |
| `{ "scene": "Gameplay" }` | A scene with that name (or asset path) is loaded. |
| `{ "near": { "a": target, "b": target, "distance": 1.5 } }` | Two `object` or `world` targets are at most that distance apart (the gap between their bounds). With several matches for `b`, the one nearest to `a` counts. |
| `{ "all": [ ... ] }`, `{ "any": [ ... ] }`, `{ "not": condition }` | Combinations. |

## steer

`steer` is how you move a character or vehicle to where something is, without knowing the
controls' exact timing. Every frame it works out the direction from the subject to the target
and feeds it to the control you name.

```json
{
  "do": "steer",
  "control": { "joystick": { "anchor": { "screen": [0.5, 0.8] }, "radius": 0.12 } },
  "toward": { "object": "Wheat" },
  "retarget": true,
  "seconds": 20
}
```

| Property | Meaning |
|-|-|
| `control` | Exactly one of the controls below. |
| `toward` | The target to go to. Give `direction` instead (`[x, y]`, y up, for example `[1, 0]` for right) to push a fixed direction for `seconds`. |
| `subject` | The object that moves; defaults to the script's subject. A subject you name must exist, or the step fails. |
| `arrive` | The distance (gap between bounds) at which the target counts as reached (default 0.5). |
| `linger` | Seconds to stay on a reached target (default 0.5), still steering toward its centre: the subject ends up inside a trigger zone or on top of a pickup rather than at its edge, and the game gets time to take the object. Raise it when the game needs time at each target (cutting, mining, opening); a target that disappears ends the stay at once. |
| `retarget` | `true`: when the stay at a target is over or the target disappears (collected, destroyed), continue with the next nearest one that was not visited yet. Ends when none is left. |
| `until` | A condition that ends the step early, as soon as it holds (`"until": { "text": { "contains": "20/20" } }`). Use it with `seconds` for "do this until X, but for at most N seconds". |
| `seconds` | Maximum time (default 5). |
| `plane` | How a direction in the world becomes a direction on the control: `"auto"` (default), `"screen"` or `"ground"`. See below. |

Controls:

| Control | Input it produces |
|-|-|
| `{ "joystick": { "anchor": target, "radius": 0.12 } }` | Presses the pointer at the anchor and holds it `radius` (fraction of the shorter screen side) away in the wanted direction: on-screen sticks and "drag anywhere to move" games. |
| `{ "keys": { "up": "w", "down": "s", "left": "a", "right": "d" } }` | Holds the keys of the wanted direction (eight directions). |
| `{ "stick": "left" }` | Tilts a gamepad stick. |
| `{ "drive": { "forward": "w", "left": "a", "right": "d" } }` | For vehicles on a ground plane: holds forward and turns toward the target. Needs a subject and `toward`. |
| `{ "follow": true }` | Holds the pointer on the target itself (games where the character follows the finger). Needs `toward`, and the target on screen. |

How the direction is worked out: with a subject and an `object` or `world` target, from their
positions in the world, so it stays right while the target is off screen or behind the camera.
`"plane": "ground"` treats up on the control as "away from the camera along the ground" (3D
games with a camera above or behind the player); `"plane": "screen"` treats it as "up on the
screen" (2D games, top-down views). `"auto"` picks the screen plane for an orthographic camera
and for a target that lies across the view, and the ground plane for a target that lies into the
view. For `screen`, `ui` and `text` targets, and when there is no subject, the direction is the
one on screen (from the subject's screen position, or from the screen centre).

`steer` goes in a straight line. To get around an obstacle (a fence, a wall), steer to a `world`
waypoint beside it first, then to the target; the inventory gives positions (`position`, `area`)
to work the waypoint out from, and a frame shows where the gap is.

How a `steer` step ends:

| Result | Meaning |
|-|-|
| `ok`, "arrived" | The subject came within `arrive` of the target and stayed for `linger`. |
| `ok`, "target gone" | The target disappeared, on the way or during the stay (usually: it was collected). |
| `ok`, "no targets left" | `retarget`: every matching object was reached or has disappeared. |
| `ok`, "condition met" | The `until` condition held. |
| `ok`, "time elapsed" | `direction` or `retarget` steering ran for its `seconds`. With an `until` that did not hold, the detail says so; that is not a failure. |
| `timeout` | A single target (no `retarget`) was not reached within `seconds`. The detail gives the closest distance: if it is small and stays above `arrive`, raise `arrive`. |
| `blocked` | The subject did not move for 2.5 seconds while it was steered toward the target, so the step ended early. Either something is in the way (the detail says how far from the target it stopped: steer to a `world` waypoint beside the obstacle first), or the subject never moved at all (the game reads another control, or another object is the one that moves). With `retarget`, a target the subject gets stuck on is skipped and counted in the detail instead. |
| `target_not_found` | No such object (or the named subject does not exist). |
| `target_not_visible` | The target has no position on the screen and the step needs one (the `follow` control, or no subject). |
| `subject_gone` | The subject was destroyed or deactivated during the step. |

The detail counts `targets reached` (the subject came within `arrive`) and, when there were any,
how many `disappeared` (the game removed the object: collected, destroyed). Reached is not the
same as taken, and many games keep an object after taking it (a cut plant that regrows): check
what the game itself counted (`objectSummary`, the score text). If it counted fewer than were
reached, the game needs more time at each target (`linger`) or a smaller `arrive`.

The detail also says how far the subject moved. A `subject_did_not_move` warning means input was
applied but the subject stayed where it was: the game reads another control, or another object is
the one that moves.

## Writing a script that plays well

- Start from the observe-only rehearsal: its report lists the names, labels and positions you can
  target. Use `snapshot` steps in a short exploration script to see later screens.
- Move between screens with conditions, not sleeps: `wait_until` the button exists, `click` it,
  `wait_until` the next screen is there.
- A "tap to start" screen is usually plain text, not a button, so the UI list is empty: tap the
  text (`{ "do": "tap", "target": { "text": "Tap to Start" } }`) or the middle of the screen
  (`{ "screen": [0.5, 0.5] }`).
- Play the core loop, not one action: start the game, do what the game is about several times,
  and end on a visible outcome (a score, a cleared level, a result panel).
- End on a condition that states the outcome: `wait_until` the result panel exists or the win
  text shows, with `"stop_on_timeout": true`. A script that merely runs to its end says nothing
  about whether the game was won.
- When hits move the targets (anything with physics), a name goes on matching objects that were
  knocked away or lie on the floor. Say which ones you mean: `within` a `world` point where they
  count (the stand, the goal area), and `pick` (`highest` for the top of a stack).
- Aim for 20 to 60 seconds at the game's natural pace; do not pad a short game with waits.
  `tail` leaves the last state on screen for a moment.
- Runs are not identical: targets that are named (`object`, `ui`, `text`) and conditions survive
  variation; fixed screen points and fixed waits often do not.
- A rehearsal and a recording run the game at the same frame rate (the video's, 30 by default)
  and from the same saved state, so a script that rehearses well records the same way.

## What the result tells you

Each step ends as `ok`, `timeout`, `blocked`, `target_not_found`, `target_not_visible`,
`subject_gone`, `unsupported`, `not_clickable`, `limit` or `error`, with a `detail` such as
`(0.50, 0.82) on Canvas/Menu/PlayButton`: the point that was pressed and what was under it.
`on nothing` means the press hit no UI element and no collider. A step inside a `repeat` carries
the number of the pass (`iteration`).

A step can be `ok` and still carry a `warning`:

- `covered_by_ui`: a press meant for a scene object landed on a UI element in front of it (a
  panel, a label, a full-screen touch area). The game may still react, if it reads the pointer
  itself; if it does not, close the panel first or press somewhere the object is not covered.
- `subject_did_not_move`: see `steer`.

`play_report.json` holds, in this order of usefulness:

| Part | Content |
|-|-|
| `steps` | Every step result. |
| `textSummary` | Per UI text: what it said first, what it says last, how often it changed. Text drawn one letter per element is reported once per group, as `Parent/*`. |
| `objectSummary` | Per object name: how many appeared and disappeared over the run, and how many are left. Only objects with behaviour are counted (scripts, physics, animators, particles, UI controls and panels), not the meshes inside them. |
| `events` | The same changes with their times, sampled once per second. |
| `gameLog`, `errors` | The game's own log lines (repeats are counted) and the exceptions it logged. `recorderErrors` are problems of the recorder itself: report them, they are not the game's. |
| `sceneAtStart`, `snapshots`, `sceneAtEnd` | Inventories: UI elements with labels and screen positions, texts, objects with their scripts, tag, world position (`position`, or `area` for several) and screen position. `"trigger": true` marks a trigger zone (a place where something happens when the player enters: a shop, a sell point, a finish line). A snapshot is also taken about a second after a new scene loads. |
| `subject`, `scenes`, `notes`, `screenshots` | How far the player moved, the scenes that were loaded, your `note` texts, and the frames with their times. |
