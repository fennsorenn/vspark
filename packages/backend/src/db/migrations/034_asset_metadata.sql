-- 034_asset_metadata: cache extracted VRM/GLB metadata (bones, materials, morph
-- targets, expressions) as JSON on asset_files, plus the file mtime used as a
-- cheap freshness gate (alongside size + hash) to decide when to re-extract.
ALTER TABLE asset_files ADD COLUMN metadata TEXT;
ALTER TABLE asset_files ADD COLUMN file_mtime TEXT;
