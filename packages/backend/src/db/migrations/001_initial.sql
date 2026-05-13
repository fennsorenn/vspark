-- 001_initial: Create all 14 tables from architecture data model

-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Scenes
CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Scene Nodes (tree)
CREATE TABLE IF NOT EXISTS scene_nodes (
  id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES scene_nodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  file_path TEXT,
  components TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Players
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_avatar_id TEXT REFERENCES avatars(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Avatars
CREATE TABLE IF NOT EXISTS avatars (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  vrm_file_path TEXT NOT NULL,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  ws_connected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Presence
CREATE TABLE IF NOT EXISTS presence (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES scene_nodes(id) ON DELETE CASCADE,
  position TEXT NOT NULL DEFAULT '[0,0,0]',
  rotation TEXT NOT NULL DEFAULT '[0,0,0]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Asset Files
CREATE TABLE IF NOT EXISTS asset_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  is_deduplicated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Animation Clips
CREATE TABLE IF NOT EXISTS animation_clips (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_node_id TEXT NOT NULL REFERENCES scene_nodes(id) ON DELETE CASCADE,
  source_file_path TEXT NOT NULL,
  clip_index INTEGER NOT NULL,
  label TEXT NOT NULL,
  start_time REAL NOT NULL,
  end_time REAL NOT NULL,
  duration REAL NOT NULL,
  fps REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Triggers
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES scene_nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  condition TEXT NOT NULL DEFAULT '{}',
  action TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Preferences
CREATE TABLE IF NOT EXISTS preferences (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(player_id, key)
);

-- Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  player_id TEXT REFERENCES players(id),
  action TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_scenes_project_id ON scenes(project_id);
CREATE INDEX IF NOT EXISTS idx_scene_nodes_scene_id ON scene_nodes(scene_id);
CREATE INDEX IF NOT EXISTS idx_scene_nodes_parent_id ON scene_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_player_id ON sessions(player_id);
CREATE INDEX IF NOT EXISTS idx_sessions_scene_id ON sessions(scene_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_asset_files_project_id ON asset_files(project_id);
CREATE INDEX IF NOT EXISTS idx_asset_files_hash ON asset_files(hash);
CREATE INDEX IF NOT EXISTS idx_animation_clips_source_node_id ON animation_clips(source_node_id);
CREATE INDEX IF NOT EXISTS idx_triggers_node_id ON triggers(node_id);
CREATE INDEX IF NOT EXISTS idx_preferences_player_id ON preferences(player_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_project_id ON audit_logs(project_id);
