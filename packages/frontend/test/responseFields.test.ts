/**
 * The Actions panel's response field definitions match the shared response
 * set (same type ids, same fields) and every label exists in both languages.
 */
import { describe, it, expect } from 'vitest';
import { RESPONSE_TYPES } from '@vspark/shared/actions';
import {
  RESPONSE_FIELDS,
  effectiveFields,
} from '../src/components/editor/actions/responseFields';
import en from '../src/i18n/locales/en/actions.json';
import de from '../src/i18n/locales/de/actions.json';

const lookup = (bundle: unknown, key: string): unknown =>
  key
    .split('.')
    .reduce<unknown>(
      (o, k) =>
        o && typeof o === 'object'
          ? (o as Record<string, unknown>)[k]
          : undefined,
      bundle
    );

describe('response fields', () => {
  it('cover the shared response set field by field', () => {
    expect(Object.keys(RESPONSE_FIELDS).sort()).toEqual(
      Object.keys(RESPONSE_TYPES).sort()
    );
    for (const [id, def] of Object.entries(RESPONSE_TYPES))
      expect(RESPONSE_FIELDS[id].map((f) => f.key)).toEqual([...def.fields]);
  });

  it('have their labels in English and German', () => {
    const keys = Object.values(RESPONSE_FIELDS).flatMap((fs) =>
      fs.flatMap((f) => [
        f.labelKey,
        ...(f.options ?? []).flatMap((o) => (o.labelKey ? [o.labelKey] : [])),
      ])
    );
    for (const k of [
      ...keys,
      'field.choose',
      'shortcut.set',
      'shortcut.recording',
    ]) {
      expect(typeof lookup(en, k), `en ${k}`).toBe('string');
      expect(typeof lookup(de, k), `de ${k}`).toBe('string');
    }
  });

  it('type the property value by the chosen property', () => {
    const control = (paramPath?: string) =>
      effectiveFields('set_property', { paramPath }).find(
        (f) => f.key === 'value'
      )?.control;
    expect(control('visible')).toBe('bool');
    expect(control('opacity')).toBe('number');
    expect(control(undefined)).toBe('string');
    expect(effectiveFields('nope', {})).toEqual([]);
  });
});
