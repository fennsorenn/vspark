/**
 * The slider field control (Play sound volume): shows the unset default, the
 * value as a percentage, and commits once when the drag / key press ends.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders } from './helpers/render';
import { FieldEditor } from '../src/components/editor/macros/MacrosPanel';
import type { MacroField } from '../src/components/editor/macros/types';

const volume: MacroField = {
  key: 'volume',
  labelKey: 'field.volume',
  control: 'slider',
  min: 0,
  max: 1,
  step: 0.05,
  defaultValue: 1,
  percent: true,
};

describe('slider field', () => {
  it('shows the default as a percentage while unset', () => {
    const { container } = renderWithProviders(
      <FieldEditor
        field={volume}
        value={undefined}
        values={{}}
        onChange={() => {}}
      />
    );
    const input = container.querySelector(
      'input[type=range]'
    ) as HTMLInputElement;
    expect(input.value).toBe('1');
    expect(container.textContent).toContain('100 %');
  });

  it('commits once, when the drag ends', () => {
    const onChange = vi.fn();
    const { container } = renderWithProviders(
      <FieldEditor field={volume} value={0.5} values={{}} onChange={onChange} />
    );
    const input = container.querySelector(
      'input[type=range]'
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.3' } });
    fireEvent.change(input, { target: { value: '0.25' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain('25 %');
    fireEvent.pointerUp(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(0.25);
  });
});
