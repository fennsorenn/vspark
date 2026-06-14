# Multiplayer connections {#multiplayer}

Connect your vspark server to another person's server to **share avatars live** —
their tracked avatar appears in your scene, driven in real time, with no port
forwarding on either side.

Connections go through a small public **rendezvous** server (set by your host);
the actual avatar/pose data flows **peer-to-peer** between the two servers.

## Your server ID {#identity}

Each server has a permanent **ID** (a cryptographic fingerprint). It's how
contacts recognise you even when your IP changes. Share it freely — it's safe to
publish. Use **Copy** to put it on your clipboard.

## Pairing {#pairing}

You only pair **once** with each person; after that you reconnect with no code.

- **Create code** → a short one-time code. Send it to the other person.
- **Enter pairing code** → paste a code someone gave you and **Join**.

Either way, both servers save each other as **contacts**.

## Incoming requests {#requests}

The first time a contact connects in a session, you get a prompt to **Accept** or
**Reject**. Accepting trusts them for the rest of the session (about 12 hours, and
across a restart), so reconnects are friction-free. **Disconnecting** a contact
manually clears that trust, so they're prompted again next time.

## Contacts {#contacts}

Your saved contacts, with a dot showing whether you're currently connected.
**Connect** opens a live link; **Disconnect** closes it; **✕** removes the
contact entirely (they'll need to pair again to reconnect).

## Connected members {#connected}

Everyone you currently have a live link with appears under **Connected**. Expand
a member's **Shared with you** section to see the objects they're offering you.

## Sharing objects {#sharing}

Sharing has two sides:

- **Offer an object** — right-click any object in the scene tree and pick
  **Share with**, then choose a connected member (or **Everyone connected**). A
  check mark shows who it's currently shared with; click again to revoke. You can
  also right-click a **scene** row to share the whole scene the same way.
- **Place a shared object** — open a connected member's **Shared with you** list
  and hit **Place**. A 📡 **container** appears in your scene tree holding their
  object; it follows their live edits. **Remove** takes it back out.

The placed item is an opaque **container** you own: you can move, rotate and
position *it* (the shared object follows, since it lives inside), but its
internals are the owner's — they don't show in your tree and you can't edit
them. The contents are a live **projection**: they're restocked from the owner's
copy whenever you're connected, and vanish if the owner stops sharing or
disconnects (the container stays and refills when they're back).

## Editing a shared object {#editing}

By default a shared object is **read-only** for the people you share it with.
When you offer one, the **Share with** menu has an **Allow editing** toggle: turn
it on *before* picking a member to give them edit rights as well as viewing.

A member who's been granted editing sees the shared object's inner nodes in their
own tree (not just the opaque container) and can select, move, recolour, rename,
**add child objects to** and **delete** them. Every such change is a *request* to
you, the owner: it's applied to **your** copy first (your machine stays the single
source of truth) and then echoed back live to everyone who has the object —
including the editor. Revoking the share, or turning **Allow editing** off, stops
further edits immediately.

One limit in this version: editors can only change the object's **structure and
properties**, not attach **assets** (models, images, audio) to it. Those files
live only on the editor's own machine, so dropping an asset onto a shared object
is declined — add assets on the owning server instead.
