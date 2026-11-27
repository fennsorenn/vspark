# Plugins {#overview}

**Plugins** add things to vspark without a new vspark release: new nodes for
[Logic](topic:logic) graphs, new [Actions](topic:actions) and responses, new
widgets in the layer palette, and connections to outside services such as
Spotify. A plugin's own help pages appear in this help window under its name.

Plugins run with the same rights as vspark itself, so only install plugins
you trust.

## Plugin accounts {#accounts}

A plugin that talks to an outside service adds its own block to the
**Accounts** window. Accounts belong to a project, like Twitch accounts.

1. Create an app at the service (the plugin's help page explains where) and
   register the **Redirect URI** shown in the block. It starts with
   `http://127.0.0.1:` — services do not accept `localhost` there.
2. Enter the app's details (for example its client id) in the block.
3. Click **Connect** and sign in in the window that opens.

The first account of a service is the project's **default**; nodes and Actions
whose account is left empty use it. **Reconnect** appears when the service
asks you to sign in again. Your sign-in tokens never leave this computer.

## Missing plugins {#missing}

A node whose plugin is not installed (or not running) shows as
**⚠ Missing: …**. It and its connections are kept and do nothing until the
plugin runs again. When someone shares a scene with you, vspark can tell you
the name of the plugin a node needs, even if you do not have it.
