import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Recursively collect all dotted key paths in a nested JSON object.
 * For example:
 *   { a: { b: "value", c: 1 }, d: "string" }
 * produces: ["a.b", "a.c", "d"]
 */
function collectKeyPaths(obj: unknown, prefix = ''): Set<string> {
  const keys = new Set<string>();

  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    // Leaf node (string, number, array, etc.)
    if (prefix) keys.add(prefix);
    return keys;
  }

  const record = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    const newPrefix = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Recursively collect from nested object
      const nestedKeys = collectKeyPaths(value, newPrefix);
      for (const k of nestedKeys) {
        keys.add(k);
      }
    } else {
      // Leaf node (string, number, array, or null)
      keys.add(newPrefix);
    }
  }

  return keys;
}

describe('i18n parity — EN vs DE locales', () => {
  // Discover all namespace files in the EN locale
  const localeDir = resolve(__dirname, '../src/i18n/locales');
  const enDir = join(localeDir, 'en');
  const deDir = join(localeDir, 'de');

  let namespaces: string[] = [];

  try {
    namespaces = readdirSync(enDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace('.json', ''));
  } catch (err) {
    throw new Error(`Failed to read EN locale directory: ${err}`);
  }

  it('should find namespace files in both EN and DE locales', () => {
    expect(namespaces.length).toBeGreaterThan(0);

    // Verify DE has the same set of namespaces
    let deNamespaces: string[] = [];
    try {
      deNamespaces = readdirSync(deDir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.replace('.json', ''));
    } catch (err) {
      throw new Error(`Failed to read DE locale directory: ${err}`);
    }

    expect(deNamespaces.sort()).toEqual(namespaces.sort());
  });

  // Test each namespace for key parity
  it.each(namespaces)(
    'namespace "%s" should have identical key structure in EN and DE',
    (namespace) => {
      // Load EN namespace
      let enContent: unknown;
      try {
        const enPath = join(enDir, `${namespace}.json`);
        const enText = readFileSync(enPath, 'utf-8');
        enContent = JSON.parse(enText);
      } catch (err) {
        throw new Error(
          `Failed to read or parse EN namespace "${namespace}": ${err}`
        );
      }

      // Load DE namespace
      let deContent: unknown;
      try {
        const dePath = join(deDir, `${namespace}.json`);
        const deText = readFileSync(dePath, 'utf-8');
        deContent = JSON.parse(deText);
      } catch (err) {
        throw new Error(
          `Failed to read or parse DE namespace "${namespace}": ${err}`
        );
      }

      // Collect key paths
      const enKeys = collectKeyPaths(enContent);
      const deKeys = collectKeyPaths(deContent);

      // Find differences
      const enOnly = Array.from(enKeys)
        .filter((k) => !deKeys.has(k))
        .sort();
      const deOnly = Array.from(deKeys)
        .filter((k) => !enKeys.has(k))
        .sort();

      // Assert parity
      if (enOnly.length > 0 || deOnly.length > 0) {
        const message = [
          `Key parity mismatch in namespace "${namespace}":`,
          enOnly.length > 0 ? `  EN only: ${enOnly.join(', ')}` : '',
          deOnly.length > 0 ? `  DE only: ${deOnly.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        expect(enOnly).toEqual(deOnly, message);
      }

      expect(enKeys).toEqual(deKeys);
    }
  );
});
