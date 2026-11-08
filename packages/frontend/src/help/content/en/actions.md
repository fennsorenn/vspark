# Actions {#overview}

**Actions** are ready-made automations for common stream moments — set one up
by filling in a form instead of wiring nodes. A hotkey that plays a clip, a
chat command that replies with a counter, or an emote combo that triggers an
animation is a single action.

Actions belong to the whole project and live on the **Actions** tab. Each
action is backed by a normal [Logic](topic:logic) graph that vspark builds for
you from the action's settings — you never have to look at it, but you can open
and change it any time.

## Adding an action {#add}

Click **+ Add** and pick a kind. The new action appears in the list, grouped
with the other actions of the same kind. Each row shows its most important
settings at a glance — for a hotkey, the key combination and what it does.

- Click a row to edit that action: its settings open in the main area next to
  the list (a new action opens there right away).
- The checkbox at the start of a row turns the action on or off without deleting
  it.
- The **+** next to a group's name adds another action of that kind in one
  click.
- **Delete action** (at the bottom of the settings) deletes the action and its
  graph (**Undo** brings both back).

## Hotkey {#hotkey}

A **Hotkey** action reacts to a key combination pressed anywhere on the computer
running vspark — even when vspark is not the focused window.

- **Shortcut**: click the button, then press the keys you want (for example
  `Ctrl + Shift + 1`). Press `Esc` to cancel.
- **Mode**:
  - *Single* — every press runs the same response.
  - *Toggle* — presses alternate between two responses (on / off).
  - *Cycle* — presses step through several responses in turn; **Positions**
    sets how many.
- **Response** (one per position): play a clip, spawn a clip, play a sound,
  play a video, set an expression, set a property of an object or layer, or
  control a video or audio file. Pick the response, then fill in its details.
  See [Sounds and videos](#media).

## Chat command {#chat_command}

A **Chat command** replies when someone types a command such as `!hug` in your
chat (Twitch).

- **Command** and **Aliases**: the command name (with or without `!`) and other
  names that do the same, separated by spaces or commas — `!hug` with aliases
  `cuddle snuggle` also reacts to `!cuddle` and `!snuggle`. Upper and lower case
  do not matter.
- **Who may use it**: everyone, or only subscribers, moderators or the
  broadcaster (each rank includes the ones above it).
- **Cooldown**: see [Cooldown](#cooldown).
- **Args must match** (optional): a [pattern](#patterns) the text after the
  command has to match, for example `^@?(?<target>\w+)$` for "exactly one name".
  When it does not match, nothing happens. Named groups become
  [placeholders](#placeholders) for the reply.
- **Counter** (optional): see [Counter](#counter).
- **Reply**: the chat message to send back, with
  [placeholders](#placeholders) `${user}`, `${args}` and `${count}`. Leave it
  empty to send nothing.

Example: command `!hug`, reply `${user} hugs ${args}! (${count} hugs so far)`.

## Chat pattern {#chat_pattern}

A **Chat pattern** works like a chat command, but reacts to any chat message
whose *whole* text matches a [pattern](#patterns). Named groups in the pattern
become [placeholders](#placeholders) for the reply, next to `${user}`,
`${message}` and `${count}`.

Example: the pattern `"(?<quote>.+)" - (?<who>[^.]+)\. (?<year>\d{4})` matches
`"I'll be back" - Terminator. 1984` and the reply can use `${quote}`, `${who}`
and `${year}`.

## Chat keyword {#chat_keyword}

A **Chat keyword** reacts when one of its keywords or emote names shows up
anywhere in a chat message — as a whole word, ignoring upper and lower case
(`LUL` matches "haha lul!" but not "LULZ").

- **Keywords**: words, phrases or emote names, separated by commas.
- **Cooldown**: see [Cooldown](#cooldown).
- **Response**: what happens — play a clip, play a sound or video (see
  [Sounds and videos](#media)), set an expression or property, control a video
  or audio file, or *No response*.
- **Send trigger** (optional): see [Triggers](#trigger).

## Keyword combo {#keyword_combo}

A **Keyword combo** reacts when a keyword or emote is spammed: it counts the
chat messages containing it, as long as each new message arrives **within** the
given number of seconds of the previous one. When no message arrives for that
long, the combo ends and the count starts over.

- **Mode** decides when the response runs:
  - **On threshold**: as soon as the count reaches the **Threshold**.
  - **After timeout**: when the combo ends, if the count reached the
    **Threshold** by then — so the response comes after the spam has died
    down, and the end message can name the final count.

  Changing the mode rebuilds the action's graph (see
  [Settings that rebuild the graph](#value-shape)).
- **Count each chatter once**: a chatter who repeats the keyword neither counts
  again nor keeps the combo alive. Turn it off to count every message.
- **When reached** / **When it ends**: the response that runs once per combo.
- **End message** (optional): a chat message sent when a combo that reached the
  threshold ends, with `${count}` for the final count.

## Redemption {#redemption}

A **Redemption** reacts when a viewer redeems one of your channel-point rewards.

- **Reward**: the reward's title, exactly as it is named on Twitch (upper and
  lower case do not matter).
- **Response**: what happens when it is redeemed.
- **Counter** (optional): see [Counter](#counter).
- **Reply** (optional): a chat message with `${user}`, `${message}` (the text
  the viewer entered), `${reward}` and `${count}`.
- **Send trigger** (optional): sends a trigger with the redemption's details
  (viewer, reward, message, …) — see [Triggers](#trigger).
- **Mark the redemption as complete**: marks it as fulfilled on Twitch, so it
  leaves your reward queue. This needs the account's permission to manage
  redemptions and only works for rewards created by the same app.

## Placeholders {#placeholders}

Replies and messages can contain placeholders in the form `${name}`, which are
replaced when the message is sent:

| Placeholder | Meaning |
|---|---|
| `${user}` | The display name of the chatter or viewer |
| `${args}` | Everything after the command (chat command) |
| `${message}` | The chat message, or the text entered with a redemption |
| `${reward}` | The reward's title (redemption) |
| `${count}` | The counter's value after counting (see [Counter](#counter)), or the final count of a combo |
| `${…}` | Every *named group* of a pattern, e.g. `${quote}` for `(?<quote>…)` |

A placeholder with no value is left empty.

## Patterns {#patterns}

Patterns are *regular expressions* — a compact way to describe text. A few
building blocks go a long way:

- `.` any character, `\d` a digit, `\w` a letter, digit or underscore, `\s` a
  space;
- `+` "one or more", `*` "any number", `?` "optional";
- `^` the start and `$` the end of the text;
- `(?<name>…)` a *named group*: whatever it matches becomes the placeholder
  `${name}`.

Upper and lower case are ignored. An invalid pattern never matches.

## Cooldown {#cooldown}

The **Cooldown** is the number of seconds the action waits after running before
it reacts again; `0` turns it off. Uses during the cooldown are ignored.

Give several actions the same **shared group** name and they share one
cooldown: after any of them runs, all of them wait. Without a group, each action
has its own cooldown.

## Counter {#counter}

With **Count each use**, the action counts how often it ran, and `${count}` in
the reply shows the number. **Step** is how much each use adds.

- Without a name, the counter belongs to this action alone.
- With a name, it is a shared counter: actions using the same name count
  together, and any Logic can read it with a **Get Variable** node.
- **Keep after restart** stores the counter, so it survives restarting vspark.

## Account {#account}

Chat and redemption actions listen on — and reply with — a streaming
**account** from the project's accounts (**Accounts** in the toolbar). *Default
account* is the project's default; pick another one if you have several.

## Triggers {#trigger}

**Send trigger** sends a named *trigger* each time the action runs. Any
[Logic](topic:logic) graph in the project can react to it with an **On Trigger**
node of the same name — for example to show an alert. Leave the name empty to
send nothing.

## Sounds and videos {#media}

- **Play sound** plays a sound from your collection once, at the chosen
  **Volume** (0–1). You don't need to place an audio object for it. It is heard
  in the viewer, and in the editor only while audio preview is on.
- **Play video** plays a video from your collection on a video object or video
  layer you already placed (**On**), without changing that object: it plays
  once, then the object's own *On end* setting applies, and the next time the
  scene loads it shows its own video again. *Stop* (with *Control media*) also
  brings its own video back. One video object can so show any number of
  different clips.

In a Logic graph the same is done by the **Play Sound** node and the **asset**
input of the **Media Control** node.

## Settings that rebuild the graph {#value-shape}

Most settings — the shortcut, which clip to play, a value to set — are read by
the graph while it runs. Changing them takes effect right away and never touches
the graph itself.

A few settings decide what the graph *looks like*: a hotkey's **mode** and
number of **positions**, a keyword combo's **mode**, and the **type** of each response (in every kind that
has one). Changing one of these rebuilds
the graph. If you have edited the graph yourself, vspark asks first, because
the rebuild discards those edits.

## Modified and template updates {#modified}

- **Modified** means the action's graph was changed by hand and no longer
  matches what its settings would generate. Moving nodes around on the canvas
  does not count as a change.
- **Template update** means a newer version of vspark generates this kind of
  action differently. Unmodified actions are updated automatically when vspark
  starts; modified ones keep your edits and show this badge instead.

## Reset {#reset}

**Reset** throws away your edits to the graph and builds it again from the
action's current settings. vspark asks for confirmation first. **Undo** brings
the edited graph back.

## Opening the graph {#graph}

**Open graph** shows the action's graph on the Logic canvas, where you can
change it like any other Logic — add nodes, rewire, tweak values. The graph
reads the action's settings through **Settings** nodes, so the form keeps
working after you edit the graph. The Logic tab lists every action's graph in
its own **Action Logic** section.
