/**
 * @vspark/plugin-sdk — typings of the vspark plugin API (apiVersion 1).
 *
 * vspark INJECTS the SDK into each entry module's default-exported factory;
 * nothing in this package runs. Plugin code must only `import type` from it
 * (bundling vspark's modules would register nodes in a copy the engine never
 * sees). Kept in step with the host by hand: packages/backend/src/plugins/
 * (loader.ts BACKEND_SDK, context.ts, accounts/api.ts) and
 * @vspark/shared/actions (PLUGIN_ACTIONS_SDK, FormField, registries).
 * See vspark dev-notes/modules/plugins.md.
 */

export type ApiVersion = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Signal graph
// ─────────────────────────────────────────────────────────────────────────────

/** Port type tags. Subset of vspark's `SignalTypeName` relevant to plugins. */
export type SignalTypeName =
  | 'Float'
  | 'Bool'
  | 'Trigger'
  | 'String'
  | 'Any'
  | 'Account'
  | 'SceneNode'
  | 'ComposeLayer'
  | 'SceneEntity';

export interface SignalEvent<T> {
  readonly payload: T;
  readonly timestamp: number;
}

export interface Emitter<T> {
  emit(value: T): void;
}

export interface NodeDisplay {
  label: string;
  description?: string;
  /** Category tags — a node appears in every palette tab whose tag it carries. */
  tags: string[];
  /** Hex header colour. */
  color: string;
  internal?: boolean;
  /** Which account provider an `Account` input lists (`'<pluginId>:<provider>'`). */
  accountProvider?: string;
}

/** Base class of every signal node (the host's `Node`). */
export declare abstract class SignalNodeBase {
  /** The node's inline config; also carries host-injected `_projectId`. */
  protected get config(): Record<string, unknown>;
  protected get selfId(): string;
  protected get enabled(): boolean;
  protected getState<T = unknown>(): T;
  protected setState(state: unknown): void;
  protected input(portName: string): unknown;
  protected emitOn(portName: string, value: unknown): void;
  /** Called after the engine wired all ports. */
  protected onBind(): void;
  protected onUnbind(): void;
}

export interface SignalNodeClass {
  /** Must start with `<pluginId>_`. */
  readonly kind: string;
  new (): SignalNodeBase;
}

type FieldDecorator = (value: undefined, ctx: ClassFieldDecoratorContext) => void;
type MethodDecorator = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: (...args: any[]) => any,
  ctx: ClassMethodDecoratorContext
) => void;
type ClassDecorator = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: abstract new (...args: any[]) => unknown,
  ctx: ClassDecoratorContext
) => void;

export interface SignalSdk {
  Node: typeof SignalNodeBase;
  SignalNode(display: NodeDisplay): ClassDecorator;
  eventIn(name: string, type: SignalTypeName): MethodDecorator;
  valueIn(name: string, type: SignalTypeName): FieldDecorator;
  listIn(name: string, type: SignalTypeName): FieldDecorator;
  eventOut(name: string, type: SignalTypeName): FieldDecorator;
  valueOut(name: string, type: SignalTypeName): FieldDecorator;
  mkEvent<T>(payload: T): SignalEvent<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph descriptors (shared by Actions and composites)
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphNodeDescriptor {
  id: string;
  kind: string;
  position: { x: number; y: number };
  defaultConfig?: Record<string, unknown>;
}

export interface GraphEdgeDescriptor {
  fromNodeId: string;
  fromPort: string;
  toNodeId: string;
  toPort: string;
}

export interface TemplateGraph {
  nodes: GraphNodeDescriptor[];
  edges: GraphEdgeDescriptor[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Declarative form fields (host-rendered; no plugin React needed)
// ─────────────────────────────────────────────────────────────────────────────

export type FieldControl =
  | 'text'
  | 'textarea'
  | 'number'
  | 'slider'
  | 'select'
  | 'toggle'
  | 'color'
  | 'duration'
  | 'account'
  | 'rank'
  | 'cooldown'
  | 'list';

export interface FormField {
  /** Dotted settings path. */
  path: string;
  control: FieldControl;
  /** i18n key in the plugin's namespace (`plugin-<id>`). */
  label: string;
  hint?: string;
  options?: readonly string[];
  min?: number;
  max?: number;
  step?: number;
  /** `select` option labels: `option.<path>.<value>` (the value is shown
   *  when there is no translation). `account`: provider id
   *  (`'overlive'` or `'<pluginId>:<provider>'`). */
  provider?: string;
  /** Placeholders the field accepts (shown as chips under a template field). */
  placeholders?: readonly string[];
  when?: (read: (path: string) => unknown) => boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

export type ActionSettings = Record<string, unknown>;

export interface ActionSettingField {
  path: string;
  class: 'value' | 'shape';
}

export type PreviewToken =
  | { t: 'text'; text: string }
  | { t: 'msg'; key: string; params?: Record<string, string | number> };

export interface ActionPreview {
  headline: PreviewToken[];
  lines: PreviewToken[][];
}

export interface ActionKindDef {
  /** Must start with `<pluginId>_`. */
  kind: string;
  label: string;
  icon: string;
  fields: readonly ActionSettingField[];
  /** The generated form (host `SchemaForm`). Omit when `ui.mjs` provides one. */
  form?: readonly FormField[];
  defaults(): ActionSettings;
  normalize(raw: unknown): ActionSettings;
  build(shape: ActionSettings): TemplateGraph;
  preview(settings: ActionSettings): ActionPreview;
}

/** A response a Hotkey / Chat keyword / Keyword combo / Redemption / Named
 *  trigger action can run. */
export interface ResponseTypeDef {
  /** Sink node kind. */
  nodeKind: string;
  /** Event input the trigger wires into. */
  entryPort: string;
  /** Value inputs of the sink, fed from `response.<field>`. */
  fields: readonly string[];
  /** How the editor renders each field. */
  form: readonly FormField[];
  /** i18n key of the response's label. */
  label: string;
}

export type Out = [nodeId: string, port: string];

/** The template builder the built-in Action kinds use (`Tpl`). */
export interface TemplateBuilder {
  node(id: string, kind: string, x: number, y: number, defaultConfig?: Record<string, unknown>): string;
  wire(fromNodeId: string, fromPort: string, toNodeId: string, toPort: string): void;
  /** Feed settings field `field` into `to.toPort` through a `settings` node. */
  setting(field: string, to: string, toPort: string, x: number, y: number): void;
  out(): TemplateGraph;
}

export interface CooldownSettings {
  seconds: number;
  group: string;
}

export interface ActionsSdk {
  Tpl: new () => TemplateBuilder;
  /** `chat_rank` gate fed by `minRank`. Returns the gate's pass output. */
  addRankGate(b: TemplateBuilder, source: string, entry: Out, x: number): Out;
  /** `cooldown` fed by `cooldown.seconds` / `cooldown.group`. */
  addCooldown(b: TemplateBuilder, entries: Out[], x: number): Out;
  /** Builds `!name` aliases → anchored regex (the Chat command kind's matcher). */
  commandNames(command: unknown, aliases: unknown): string[];
  commandPattern(names: string[]): string;
  escapeRegExp(text: string): string;
  /** Anchored, case-insensitive match of a reward title. */
  rewardPattern(reward: unknown): string;
  normalizeRank(raw: unknown): 'everyone' | 'sub' | 'mod' | 'broadcaster';
  normalizeCooldown(raw: unknown, defaultSeconds: number): CooldownSettings;
  /** Node kinds of the chat / redemption / named-trigger sources. */
  readonly sources: {
    chatCommand: 'overlive_chat_command';
    redemption: 'overlive_redemption';
    namedTrigger: 'on_trigger';
    sendChat: 'overlive_send_chat';
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Composites (compound layers)
// ─────────────────────────────────────────────────────────────────────────────

export type PartRtype = 'compose_layer' | 'scene_node' | 'logic' | 'track_clip';

export interface SettingLink {
  part: string;
  path: string;
  cssVar?: string;
}

export interface CompositeSetting {
  key: string;
  control: 'text' | 'number' | 'slider' | 'select' | 'color' | 'asset' | 'account' | 'toggle' | 'duration';
  group: string;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  percent?: boolean;
  links?: SettingLink[];
  provider?: string;
  when?: (read: (key: string) => unknown) => boolean;
}

/** Labels live in the plugin's namespace under the host's composite keys:
 *  `type.<type>`, `group.<group>`, `setting.<key>`, `option.<key>.<option>`. */
export interface CompositeTypeDef {
  /** Must start with `<pluginId>_`. */
  type: string;
  rootRtype: 'compose_layer' | 'scene_node';
  parts: Record<string, PartRtype>;
  settings: CompositeSetting[];
}

/** A placeable composite: one feed layer (plus optional logic). */
export interface FeedCompositePreset {
  /** Composite type it instantiates. */
  type: string;
  /** i18n keys (plugin namespace). */
  name: string;
  description: string;
  template: string;
  css: string;
  box: { x: number; y: number; width: number; height: number };
  /** Optional graph owned by the layer (role `flow`); declare the type's
   *  `parts.flow: 'logic'`. Edges name their transport. */
  flow?: {
    nodes: GraphNodeDescriptor[];
    edges: Array<GraphEdgeDescriptor & { kind: 'event' | 'value' | 'list' }>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry factories
// ─────────────────────────────────────────────────────────────────────────────

export interface SharedSdk {
  apiVersion: ApiVersion;
  actions: ActionsSdk;
}

export interface SharedPlugin {
  responseTypes?: Record<string, ResponseTypeDef>;
  actionKinds?: ActionKindDef[];
  compositeTypes?: CompositeTypeDef[];
  compositePresets?: FeedCompositePreset[];
}

/** `shared.mjs` default export. Runs in the backend AND the browser. */
export type SharedFactory = (sdk: SharedSdk) => SharedPlugin;

// ── backend ──

export type AccountStatus =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'disconnected'
  | 'error'
  | 'needs_reauth';

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
  scopes?: string[];
}

export interface AccountRow<Identity = Record<string, unknown>> {
  id: string;
  projectId: string;
  provider: string;
  label: string;
  identity: Identity;
  status: AccountStatus;
  statusMessage: string | null;
  isDefault: boolean;
}

export interface AccountProviderDef<Identity = Record<string, unknown>> {
  /** Unique within the plugin. Full id: `<pluginId>:<id>`. */
  id: string;
  /** i18n key. */
  label: string;
  icon?: string;
  auth: {
    kind: 'oauth_pkce';
    authorizeUrl: string;
    tokenUrl: string;
    scopes: readonly string[];
    /** App credentials the user enters once per project (e.g. `clientId`). */
    appFields: readonly { path: string; control: 'text'; label: string; hint?: string; secret?: boolean }[];
    /** Extra authorize params. */
    extraParams?: Record<string, string>;
  };
  /** Called after a token exchange; returns the identity shown in the list. */
  fetchIdentity(tokens: OAuthTokens): Promise<{ label: string; identity: Identity & Record<string, unknown> }>;
  /** i18n key of a setup walkthrough shown in the add dialog (markdown). */
  setupHelp?: string;
}

export interface AccountsApi {
  defineProvider(def: AccountProviderDef): void;
  list(projectId: string, provider: string): AccountRow[];
  get(accountId: string): AccountRow | undefined;
  /** The project's default account of a provider (empty `account` ports resolve to it). */
  defaultFor(projectId: string, provider: string): AccountRow | undefined;
  /** Runs `fn` with a valid access token, refreshing (and persisting) when expired.
   *  On a revoked refresh token the account goes to `needs_reauth` and this rejects. */
  withToken<T>(accountId: string, fn: (accessToken: string) => Promise<T>): Promise<T>;
  /** Forces a refresh on the next `withToken` (e.g. after a 401). */
  invalidate(accountId: string): void;
  setStatus(accountId: string, status: AccountStatus, message?: string): void;
  /** Fires on create / delete / reconnect of an account of this plugin. */
  onChanged(fn: (projectId: string) => void): () => void;
}

export interface LogicApi {
  /** Fire `payload` into the `port` event input of every running node of `kind`
   *  in the project whose `account` input resolves to `accountId` (empty = default). */
  routeEvent(projectId: string, kind: string, port: string, payload: unknown, accountId?: string): void;
  /** Whether a running graph in the project contains a node of one of `kinds`. */
  hasConsumers(projectId: string, kinds: readonly string[]): boolean;
}

export interface DataApi {
  /** Publish data fields the project's feed layers see by bare name (mesh
   *  `data_field` documents in the project's scope — other projects never see
   *  them). Field names must be JS identifiers prefixed with the plugin id
   *  (`spotifyNowPlaying`). */
  publish(projectId: string, fields: Record<string, unknown>): void;
  /** Whether a feed layer in the project references `field` in its template. */
  isReferenced(projectId: string, field: string): boolean;
}

export interface StorageApi {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  /** Same, namespaced per project (removed with the project). */
  project(projectId: string): Omit<StorageApi, 'project'>;
}

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface BackendContext {
  readonly pluginId: string;
  readonly version: string;
  readonly nodes: { register(...classes: SignalNodeClass[]): void };
  readonly accounts: AccountsApi;
  readonly logic: LogicApi;
  readonly data: DataApi;
  readonly storage: StorageApi;
  readonly projects: {
    loaded(): string[];
    onLoaded(fn: (projectId: string) => void): () => void;
    onUnloaded(fn: (projectId: string) => void): () => void;
  };
  /** Express router mounted at `/api/plugin/<id>/` — for OUTSIDE callers
   *  (OAuth redirects, webhooks). Editor features must use mesh documents
   *  (data fields), never these routes. Typed loosely on purpose. */
  readonly http: { router(): unknown };
  readonly log: Logger;
  /** The plugin's section of config.json. */
  readonly config: Record<string, unknown>;
  /** The shared module's output, already registered with the host. */
  readonly shared: SharedPlugin;
  onDispose(fn: () => void | Promise<void>): void;
}

export interface BackendSdk extends SharedSdk {
  signal: SignalSdk;
  /** `fetch` routed through the host (proxy, User-Agent). */
  fetch: typeof fetch;
}

export interface BackendPlugin {
  activate(ctx: BackendContext): void | Promise<void>;
}

/** `backend.mjs` default export. */
export type BackendFactory = (sdk: BackendSdk) => BackendPlugin;

// ── browser (optional ui.mjs) ──

export interface UiSdk extends SharedSdk {
  // Typed loosely so the preview does not depend on @types/react.
  React: unknown;
  useTranslation: (ns?: string) => { t: (key: string, opts?: Record<string, unknown>) => string };
  components: Record<string, unknown>;
}

export interface UiPlugin {
  /** Custom forms per action kind (instead of the generated `SchemaForm`). */
  actionForms?: Record<string, unknown>;
}

/** `ui.mjs` default export. Reserved: the editor does not load `ui.mjs` yet
 *  (apiVersion 1 generates forms from `form`). */
export type UiFactory = (sdk: UiSdk) => UiPlugin;

// ─────────────────────────────────────────────────────────────────────────────
// plugin.json
// ─────────────────────────────────────────────────────────────────────────────

export interface PluginManifest {
  id: string;
  version: string;
  apiVersion: ApiVersion;
  /** Semver range of vspark versions. */
  vspark: string;
  name: Record<string, string>;
  description: Record<string, string>;
  author: string;
  homepage?: string;
  icon?: string;
  entries: { backend?: string; shared?: string; ui?: string };
  /** Hosts the plugin talks to (shown in the install dialog). */
  network?: string[];
}
