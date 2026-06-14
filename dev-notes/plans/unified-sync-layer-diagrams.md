# Unified sync layer — illustrated

Companion to [`unified-sync-layer.md`](./unified-sync-layer.md). Diagrams (Mermaid) +
end-to-end use cases. Read the main doc for rationale and decisions.

---

## 1. The big picture

Four layers. Producers emit changes through one of four typed calls; a domain-agnostic core
stamps/persists/routes them; a transport carries them; consumers fold them into what renders.

```mermaid
flowchart TB
  subgraph P["① Producers (server)"]
    R["CRUD routes"]
    M["managers: overrides, data channels"]
    G["signal-graph nodes"]
    V["VMC receiver / pose"]
  end

  P -->|"document.upsert · field.set · stream.publish · event.emit"| C

  subgraph C["② Replication core (domain-agnostic)"]
    REG["Resource registry<br/>type → policy · loader · mapper · scope"]
    STAMP["HLC stamp + origin tag"]
    COAL["coalesce / rate buffers"]
    SNAP["snapshot assembly"]
  end

  DB[("SQLite")]
  C <--> DB

  C --> T

  subgraph T["③ Transports (a port, not a hard-wire)"]
    HUB["ClientHub — WSSync (today)"]
    MESH["ServerMesh — Redis / PartyKit (later)"]
  end

  T --> K

  subgraph K["④ Consumers (client)"]
    APPLY["applyRemote(envelope)<br/>→ store slice via registry"]
    COMP["layer compositor<br/>→ effective value"]
    REND["renderer (R3F / DOM)"]
  end

  APPLY --> COMP --> REND
```

The win: adding a syncable thing = **one registry entry on each side**, not a bespoke
sender + receiver + two mappers.

---

## 2. One message format (the envelope)

Every change on the wire looks the same, regardless of what it describes:

```mermaid
classDiagram
  class SyncEnvelope {
    rtype  : string   // scene_node | override | vmc_pose | ...
    op     : upsert | remove | patch | frame | event
    scope? : string   // sceneId / projectId / publicationId — routing
    key    : string   // entity id | field key | stream key
    data?  : unknown  // canonical DTO / value / frame
    v?     : HLC      // stamp for ordering+convergence (omitted for streams)
    origin?: string   // peer id — echo / loop suppression
  }
```

---

## 3. The four resource classes

Same pipe, different rules — chosen by how often a thing changes and whether it must survive.

```mermaid
flowchart LR
  subgraph Classes["resource classes"]
    D["Document<br/>saved, reliable, ordered<br/>(nodes, behaviors, clips)"]
    F["Field<br/>one setting, fast, coalesced<br/>(overrides, live edits, data channels)"]
    S["Stream<br/>firehose, lossy, latest-wins<br/>(pose, blendshapes, IK)"]
    E["Event<br/>one-shot command, no memory<br/>(play, stop, media_control)"]
  end
  D --> DBp[("persisted")]
  F --> Mem["memory (+ opt persist)"]
  S --> None["not persisted"]
  E --> None2["not persisted"]
```

---

## 4. The override-layer compositor

A field's rendered value is a **stack of layers** folded low→high. Each layer either
**replaces** the value beneath it or **composes** onto it (add / multiply).

```mermaid
flowchart TB
  subgraph Stack["layer stack for ONE field — fold low→high"]
    direction TB
    L5["Live edit / manual gesture — replace"]
    L4["Track-clip — replace ('override') / add ('relative')"]
    L3["Runtime override — replace / add"]
    L2["Pose / animation — replace / additive"]
    L1["Base (persisted) — identity"]
  end
  L1 --> L2 --> L3 --> L4 --> L5 --> EFF[["effective(target, paramPath)"]]
  EFF --> RENDER["renderer"]

  src1["Document"] -. feeds .-> L1
  src2["Stream"] -. feeds .-> L2
  src3["Field (bus)"] -. feeds .-> L3
  src4["clip Docs + playback Stream"] -. feeds .-> L4
  src5["Field (fast overlay)"] -. feeds .-> L5
```

Each layer is fed by one of the four resource classes — so the compositor **is** the sync
read-model. "Manual edit beats a paused clip" is just "the manual layer is higher" (no
suppression hack). Today's `clip > runtime > base` precedence is the top of this same stack.

---

## 5. Use case A — create via preset, other client updates (the original bug, generalized)

```mermaid
sequenceDiagram
  participant U as User @ Browser 1
  participant S as Server
  participant DB as SQLite
  participant B2 as Browser 2
  U->>S: instantiate preset
  S->>DB: insert node + behaviors + clips
  loop each created entity
    S->>S: document.upsert(rtype, id) — registry loads DTO, stamps HLC
    S-->>B2: envelope (document/upsert)
    S-->>U: envelope (deduped — already has it)
  end
  Note over B2: applyRemote routes each to its store slice → renders
```

Today this needs a hand-written broadcast per entity type (and forgetting one *was* the bug).
With `document.upsert`, the preset code just loops created ids — every type rides the same path.

---

## 6. Use case B — live param drag while a clip plays (compositor + preview→commit)

```mermaid
sequenceDiagram
  participant B1 as Browser 1 (dragging)
  participant S as Server
  participant B2 as Browser 2
  Note over B1: a track-clip is playing on this field
  loop each tick (coalesced)
    B1->>S: field.set(position.x, live overlay)
    S-->>B2: envelope (field/patch, origin=B1)
    Note over B1,B2: compositor: LIVE layer sits above CLIP layer → drag wins, smoothly
  end
  Note over B1: mouse release
  B1->>S: document.upsert(node)  %% commit base
  S->>S: persist + stamp HLC
  S-->>B2: envelope (document/upsert)
  S-->>B1: (echo suppressed)
  Note over B1,B2: live layer cleared; base updated; clip resumes control next frame
```

No `suppressedOverrides` muting — the live edit wins purely by being a higher layer. A late
stale drag frame loses because its stamp is older than the committed value.

---

## 7. Use case C — object share (borrow an avatar across servers)

```mermaid
flowchart LR
  subgraph A["Server A — publisher"]
    AO["Avatar O (owner)<br/>intrinsic state + pose stream"]
    ADB[("A's DB")]
    AO --- ADB
  end

  subgraph B["Server B — subscriber"]
    W["Wrapper group<br/>(B owns + persists:<br/>transform, placement, lighting)"]
    Pr["live projection of O<br/>(NOT persisted)"]
    AC["asset cache (sha256)"]
    BDB[("B's DB: wrapper only")]
    W --- BDB
    W --> Pr
  end

  AO ==>|"document (read-only) + stream (pose)"| Pr
  AO -. assets .-> AC
  Pr -. on disconnect .-> Gone(("dropped"))
```

A renders O and is its sole authority. B places it inside a wrapper it owns; B never persists
O's content (only caches assets). Disconnect → projection dropped, wrapper stays, re-projects on
reconnect. A remote avatar is literally a pose **Stream** with a remote producer, so `Avatar.tsx`
renders it unchanged.

---

## 8. Use case D — full scene sync with a disconnect + reconcile

```mermaid
sequenceDiagram
  participant A as Server A (reconciliation authority)
  participant B as Server B
  Note over A,B: connected — both own + persist, live convergence
  A->>B: edits (envelopes, HLC-stamped)
  B->>A: edits (envelopes, HLC-stamped)
  Note over A,B: 🔌 link drops
  Note over A: keeps editing its own persisted replica
  Note over B: keeps editing its own persisted replica
  Note over A,B: 🔗 reconnect
  B->>A: changes since last common sync (dirty-since markers)
  A->>A: reconcile — apply both;<br/>authority breaks ties on the SAME field
  A-->>B: reconciled state
  Note over B: converges to reconciled result
```

Both keep working standalone (the fall-back requirement). On reconnect a designated authority
arbitrates — no version-vector/CRDT machinery; non-conflicting offline edits from both sides
survive, only same-field clashes defer to the authority.

---

## 9. How today's code maps onto this

```mermaid
flowchart LR
  subgraph Now["today (ad-hoc)"]
    n1["_ws.broadcast('node_added', ...) ×58 sites"]
    n2["useWsSync if/else chain"]
    n3["dup mappers: backend rowTo* + frontend map*"]
    n4["RuntimeOverrideManager"]
    n5["DataChannelManager"]
    n6["trackClipPlayback.sendSnapshotTo"]
    n7["useTransformWithOverride + layerStyle + suppressedOverrides"]
  end
  subgraph Next["unified"]
    u1["document.upsert / .remove"]
    u2["applyRemote(envelope)"]
    u3["one DTO mapper at the boundary"]
    u4["Field resource"]
    u5["Field resource"]
    u6["registry snapshot protocol"]
    u7["layer compositor"]
  end
  n1 --> u1
  n2 --> u2
  n3 --> u3
  n4 --> u4
  n5 --> u5
  n6 --> u6
  n7 --> u7
```

The managers and snapshot/preview patterns already exist — they're the prototypes the unified
layer generalizes, not greenfield work.
