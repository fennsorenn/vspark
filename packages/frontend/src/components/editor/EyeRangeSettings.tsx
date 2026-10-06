/**
 * Gaze settings shared by the tracking receivers (VMC, iFacialMocap): whether
 * tracked eye rotations are fitted to the avatar model's own eye range, and how
 * much physical eye rotation counts as "fully sideways".
 *
 * Writes `config.eyeRange = { enabled, inputMaxDeg }`, read by the receiver
 * graph's eye range stage (backend signal/nodes/eye_range_map.ts). The default
 * for `enabled` differs per receiver — on for iFacialMocap, off for VMC — and
 * must match the graph's `behavior_config` default (behaviors/<kind>/graph.ts).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HelpButton } from '../../help/HelpButton';
import { commitBehaviorPatch } from '../../mesh/behaviorWrites';
import type { Behavior } from '../../store/editorStore';
import { NumInput } from './numericInputs';

/** Matches the backend's DEFAULT_EYE_INPUT_MAX_DEG. */
const DEFAULT_INPUT_MAX_DEG = 30;

interface EyeRangeConfig {
  enabled?: boolean;
  inputMaxDeg?: number;
}

export function EyeRangeSettings({
  comp,
  defaultEnabled,
}: {
  comp: Behavior;
  defaultEnabled: boolean;
}) {
  const { t } = useTranslation('properties');
  const stored = (comp.config?.eyeRange ?? {}) as EyeRangeConfig;
  const enabled = stored.enabled ?? defaultEnabled;
  const [maxDeg, setMaxDeg] = useState(
    stored.inputMaxDeg ?? DEFAULT_INPUT_MAX_DEG
  );
  useEffect(() => {
    setMaxDeg(stored.inputMaxDeg ?? DEFAULT_INPUT_MAX_DEG);
  }, [stored.inputMaxDeg]);

  const save = (patch: EyeRangeConfig) =>
    commitBehaviorPatch(comp.id, {
      config: {
        ...comp.config,
        eyeRange: { enabled, inputMaxDeg: maxDeg, ...patch },
      },
    });

  return (
    <>
      <div
        style={{
          fontSize: 10,
          color: '#666',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          marginTop: 4,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {t('eyeRange.header')}
        <HelpButton
          topic="behaviors"
          anchor="eye-range"
          tip={t('help.eyeRange')}
          size={12}
        />
      </div>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          fontSize: 12,
          color: '#ccc',
        }}
      >
        <input
          className="vs-eye-range-enabled"
          type="checkbox"
          checked={enabled}
          onChange={(e) => save({ enabled: e.target.checked })}
          style={{ cursor: 'pointer' }}
        />
        {t('eyeRange.enabled')}
      </label>
      {enabled && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{ fontSize: 12, color: '#888', width: 120, flexShrink: 0 }}
          >
            {t('eyeRange.inputMax')}
          </span>
          <NumInput
            className="vs-eye-range-max"
            value={maxDeg}
            step={1}
            min={5}
            max={90}
            precision={0}
            style={{ flex: 1 }}
            onChange={(v) => setMaxDeg(v)}
            onCommit={(v) => {
              setMaxDeg(v);
              save({ inputMaxDeg: v });
            }}
          />
        </div>
      )}
      <div style={{ fontSize: 10, color: '#555', lineHeight: 1.4 }}>
        {t('eyeRange.hint')}
      </div>
    </>
  );
}
