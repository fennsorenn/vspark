# Assistant {#assistant}

The Assistant is a built-in AI helper that can **operate your project for you**.
Instead of clicking through panels, you describe what you want in plain language
and it makes the changes — creating objects, laying out 2D overlays, writing feed
templates, and wiring logic graphs.

It works by calling the same project tools you use by hand, so anything it does
shows up live in the editor and can be undone or edited like any other change.

## How to use it {#how-to-use}

Click the **🤖 Assistant** button in the top bar to open the chat window. Type a
request and press Enter. The window shows the assistant's reply along with a
short trace of each action it took (a green ✓ means a step succeeded).

Good requests are specific. For example:

- "Add a point light called Key Light, warm colour, fairly bright."
- "Make a chat overlay that shows each message on its own line in white text."
- "When a chat message comes in, move the Hero avatar to a random spot."

If you ask for something ambiguous, the assistant will inspect the project first
(listing scenes, objects, or signal-node ports) before changing anything.

Use **Reset conversation** to start fresh — it clears the chat and the
assistant's memory of the current session.

## Setup {#setup}

The assistant needs a language-model endpoint to think with. It speaks the
standard OpenAI-compatible chat protocol, so it works with a local server (such
as vLLM or Ollama) or a hosted one. Configure the endpoint URL, model name, and
optional API key in the assistant settings; until then the window shows a
"not configured" notice.

## What it can do today {#capabilities}

- Create and configure scene **objects** (avatars, lights, cameras, …).
- Build **compose overlays** and their layers, including **feed templates**.
- Create and **wire logic graphs** (signal graphs), discovering the right
  node kinds and ports as it goes.

It works on one project at a time — the project you currently have open.

## Attaching elements {#attach}

To point the assistant at a specific thing — *“use **this** image as a border”* or *“make **this** object spin”* — click the **📎** button next to the message box. The editor dims and the things you can attach (scene objects, compose layers, and assets) light up; click one to attach it, or press **Esc** to cancel. Attached items show as chips above the box and are sent with your next message so the assistant knows exactly which element you mean.

Tip: open the panel that holds what you want first (e.g. the **Images** tab for an image asset), then click 📎.

## Limits & safety {#limits}

The assistant only acts when you ask it to, and every change is a normal project
edit you can review or revert. It can still make mistakes — a smaller model may
occasionally pick a wrong value or miss a step — so glance over the result,
especially for complex logic graphs.
