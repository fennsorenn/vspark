/**
 * The form fields of each response type (@vspark/shared/actions
 * `RESPONSE_TYPES`): how each field is edited and labelled. A field's `key` is
 * the sink node's value-input port of the same name, fed from
 * `responses.<i>.<key>` by the action's settings node. Labels are keys in the
 * `actions` i18n namespace.
 */
import { getParamPathSpec } from '@vspark/shared/paramPaths';

/** How a field's value is edited. */
export type ResponseFieldControl =
  | 'clip'
  | 'sceneNode'
  | 'composeLayer'
  | 'sceneEntity'
  | 'videoEntity'
  | 'asset'
  | 'expression'
  | 'paramPath'
  | 'string'
  | 'number'
  | 'slider'
  | 'bool'
  | 'enum';

export interface ResponseFieldOption {
  value: string;
  labelKey?: string;
}

export interface ResponseField {
  /** The settings key, and the sink's value-input port of that name. */
  key: string;
  /** i18n key for the field label. */
  labelKey: string;
  control: ResponseFieldControl;
  /** Fixed options for `control: 'enum'`. */
  options?: ResponseFieldOption[];
  /** For `control: 'paramPath'` (and the value field that follows it): which
   *  paramPath registry to list / type against. Defaults to 'scene_node'. */
  paramTargetKind?: 'scene_node' | 'compose_layer';
  /** For `control: 'asset'`: which collection assets to list. */
  assetKind?: 'audio' | 'video';
  min?: number;
  max?: number;
  step?: number;
  /** For `control: 'slider'`: the value shown while the field is unset. */
  defaultValue?: number;
  /** For `control: 'slider'`: show the value as a percentage (0..1 → 0–100 %). */
  percent?: boolean;
}

export type ResponseFieldValue = string | number | boolean | undefined;

const clip: ResponseField = {
  key: 'clipId',
  labelKey: 'field.clip',
  control: 'clip',
};

/** Fields by response type id (the same ids and keys as `RESPONSE_TYPES`). */
export const RESPONSE_FIELDS: Readonly<
  Record<string, readonly ResponseField[]>
> = {
  play_clip: [clip],
  spawn_clip: [clip],
  play_sound: [
    {
      key: 'assetId',
      labelKey: 'field.sound',
      control: 'asset',
      assetKind: 'audio',
    },
    {
      key: 'volume',
      labelKey: 'field.volume',
      control: 'slider',
      min: 0,
      max: 1,
      step: 0.05,
      defaultValue: 1,
      percent: true,
    },
  ],
  play_video: [
    { key: 'target', labelKey: 'field.videoTarget', control: 'videoEntity' },
    {
      key: 'assetId',
      labelKey: 'field.video',
      control: 'asset',
      assetKind: 'video',
    },
  ],
  set_expression: [
    { key: 'nodeId', labelKey: 'field.avatar', control: 'sceneNode' },
    { key: 'expression', labelKey: 'field.expression', control: 'expression' },
    {
      key: 'weight',
      labelKey: 'field.weight',
      control: 'number',
      min: 0,
      max: 1,
      step: 0.05,
    },
  ],
  set_property: [
    { key: 'targetId', labelKey: 'field.target', control: 'sceneNode' },
    { key: 'paramPath', labelKey: 'field.property', control: 'paramPath' },
    { key: 'value', labelKey: 'field.value', control: 'string' },
  ],
  set_layer_property: [
    { key: 'targetId', labelKey: 'field.layer', control: 'composeLayer' },
    {
      key: 'paramPath',
      labelKey: 'field.property',
      control: 'paramPath',
      paramTargetKind: 'compose_layer',
    },
    {
      key: 'value',
      labelKey: 'field.value',
      control: 'string',
      paramTargetKind: 'compose_layer',
    },
  ],
  control_media: [
    { key: 'target', labelKey: 'field.target', control: 'sceneEntity' },
    {
      key: 'action',
      labelKey: 'field.action',
      control: 'enum',
      options: ['play', 'pause', 'stop', 'restart', 'mute', 'unmute'].map(
        (value) => ({ value, labelKey: `mediaAction.${value}` })
      ),
    },
  ],
};

/** The fields of response `type` given its current values. For the
 *  set-property types the value field's control follows the chosen property's
 *  type (so "visible" is a checkbox, "opacity" a number). */
export function effectiveFields(
  type: string,
  values: Record<string, ResponseFieldValue>
): readonly ResponseField[] {
  const fields = RESPONSE_FIELDS[type] ?? [];
  const pathField = fields.find((f) => f.control === 'paramPath');
  if (!pathField) return fields;
  const path = typeof values.paramPath === 'string' ? values.paramPath : '';
  const spec = path
    ? getParamPathSpec(pathField.paramTargetKind ?? 'scene_node', path)
    : undefined;
  const control: ResponseFieldControl =
    spec?.type === 'Bool'
      ? 'bool'
      : spec?.type === 'Float'
        ? 'number'
        : 'string';
  return fields.map((f) => (f.key === 'value' ? { ...f, control } : f));
}
