declare module 'troika-three-text' {
  import * as THREE from 'three';

  /** Minimal ambient typing for the `Text` mesh class. Covers exactly the
   *  fields our text_troika scene-node renderer touches; extend as needed. */
  export class Text extends THREE.Mesh {
    text: string;
    font?: string;
    fontSize: number;
    color: THREE.ColorRepresentation;
    anchorX: 'left' | 'center' | 'right' | number;
    anchorY: 'top' | 'top-baseline' | 'middle' | 'bottom-baseline' | 'bottom' | number;
    maxWidth: number;
    lineHeight?: number | 'normal';
    letterSpacing?: number;
    outlineWidth?: number | string;
    outlineColor?: THREE.ColorRepresentation;
    textAlign?: 'left' | 'right' | 'center' | 'justify';
    overflowWrap?: 'normal' | 'break-word';
    whiteSpace?: 'normal' | 'nowrap';
    /** Schedule an SDF resync; must be called after mutating layout-affecting
     *  props for the next frame to reflect changes. */
    sync(cb?: () => void): void;
    /** Free GPU resources held by the SDF cache. */
    dispose(): void;
  }
}
