import type { CSSProperties } from 'react';

/** Shared control look of the Actions panel (same palette as the Macros panel). */
export const inputStyle: CSSProperties = {
  background: '#0e0e1a',
  border: '1px solid #333',
  color: '#ccc',
  borderRadius: 3,
  padding: '3px 6px',
  fontSize: 11,
  outline: 'none',
  minWidth: 0,
};

export const buttonStyle: CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
  padding: '2px 7px',
};

/** A form row's label (a flex row of label text and controls). */
export const labelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 10,
  color: '#888',
};
