#!/usr/bin/env node
/**
 * buildMigrations: for every `NNN_name.sql` in src/db/migrations/, write a
 * sibling `NNN_name.ts` exporting the SQL as a default string. The runtime
 * imports the .ts (so the SQL ships inside the JS bundle); we keep the .sql
 * as the source of truth so they're easy to edit and diff.
 *
 * Run automatically before `dev`, `build`, and `lint`. Safe to re-run: writes
 * are idempotent (skipped when the file content matches).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', 'src', 'db', 'migrations')

const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
if (sqlFiles.length === 0) {
  console.warn('[buildMigrations] no .sql files found in', MIGRATIONS_DIR)
}

let wrote = 0, skipped = 0
for (const sqlFile of sqlFiles) {
  const sqlPath = join(MIGRATIONS_DIR, sqlFile)
  const tsPath  = join(MIGRATIONS_DIR, sqlFile.replace(/\.sql$/, '.ts'))
  const sql     = readFileSync(sqlPath, 'utf8')
  const tsBody  = `export default ${JSON.stringify(sql)};\n`

  let existing = ''
  try { existing = readFileSync(tsPath, 'utf8') } catch { /* fresh file */ }
  if (existing === tsBody) { skipped++; continue }
  writeFileSync(tsPath, tsBody)
  wrote++
}

console.log(`[buildMigrations] ${wrote} written, ${skipped} unchanged`)
