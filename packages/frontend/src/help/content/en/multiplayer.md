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
