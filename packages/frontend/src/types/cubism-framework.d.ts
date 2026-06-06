// ---------------------------------------------------------------------------
// Ambient type boundary for the vendored Live2D Cubism Web Framework
// (packages/frontend/vendor/CubismWebFramework, a git submodule).
//
// WHY AMBIENT: the framework's own source is authored for its own (looser)
// tsconfig and references the proprietary Core's global types — it would not
// pass this repo's strict tsconfig (noUnusedLocals/strict). We therefore do NOT
// let tsc resolve these specifiers to the real .ts files. Instead:
//   - tsc resolves `@cubism/framework/*` to THESE hand-written declarations
//     (no tsconfig `paths` entry exists for it, so the ambient decls win);
//   - Vite resolves `@cubism/framework/*` to the real submodule source via a
//     `resolve.alias` and esbuild-transpiles it for the actual bundle.
//
// This surface is intentionally minimal — only what Live2DRuntime.ts calls.
// Signatures mirror the real framework (verified against the submodule source);
// runtime behaviour still needs in-browser verification.
// ---------------------------------------------------------------------------

declare module '@cubism/framework/live2dcubismframework' {
  export class Option {
    logFunction: unknown;
    loggingLevel: number;
  }
  export class CubismFramework {
    static startUp(option?: Option | null): boolean;
    static initialize(memorySize?: number): void;
    static dispose(): void;
    static isStarted(): boolean;
    static getIdManager(): {
      getId(id: string): CubismId;
    };
  }
  export enum LogLevel {
    LogLevel_Verbose = 0,
    LogLevel_Debug,
    LogLevel_Info,
    LogLevel_Warning,
    LogLevel_Error,
    LogLevel_Off,
  }
  // Re-exported for convenience; concrete shape lives in id/cubismid.
  export type CubismId = import('@cubism/framework/id/cubismid').CubismId;
}

declare module '@cubism/framework/id/cubismid' {
  export class CubismId {
    getString(): string;
  }
}

declare module '@cubism/framework/cubismmodelsettingjson' {
  export class CubismModelSettingJson {
    constructor(buffer: ArrayBuffer, size: number);
    getModelFileName(): string;
    getTextureCount(): number;
    getTextureFileName(index: number): string;
  }
}

declare module '@cubism/framework/math/cubismmatrix44' {
  export class CubismMatrix44 {
    loadIdentity(): void;
    scale(x: number, y: number): void;
    translate(x: number, y: number): void;
    multiplyByMatrix(m: CubismMatrix44): void;
    getArray(): Float32Array;
  }
}

declare module '@cubism/framework/model/cubismmodel' {
  import { CubismId } from '@cubism/framework/id/cubismid';
  export class CubismModel {
    getParameterCount(): number;
    getParameterId(index: number): CubismId;
    getParameterIndex(id: CubismId): number;
    setParameterValueById(id: CubismId, value: number, weight?: number): void;
    setParameterValueByIndex(index: number, value: number, weight?: number): void;
    loadParameters(): void;
    saveParameters(): void;
    update(): void;
    getCanvasWidth(): number;
    getCanvasHeight(): number;
  }
}

declare module '@cubism/framework/rendering/cubismrenderer_webgl' {
  import { CubismModel } from '@cubism/framework/model/cubismmodel';
  import { CubismMatrix44 } from '@cubism/framework/math/cubismmatrix44';
  export class CubismRenderer_WebGL {
    initialize(model: CubismModel, maskBufferCount?: number): void;
    startUp(gl: WebGLRenderingContext | WebGL2RenderingContext): void;
    bindTexture(modelTextureNo: number, glTexture: WebGLTexture): void;
    setMvpMatrix(matrix44: CubismMatrix44): void;
    setIsPremultipliedAlpha(enable: boolean): void;
    setRenderState(fbo: WebGLFramebuffer | null, viewport: number[]): void;
    drawModel(): void;
    release(): void;
  }
}

declare module '@cubism/framework/model/cubismusermodel' {
  import { CubismModel } from '@cubism/framework/model/cubismmodel';
  import { CubismRenderer_WebGL } from '@cubism/framework/rendering/cubismrenderer_webgl';
  import { CubismMatrix44 } from '@cubism/framework/math/cubismmatrix44';
  export class CubismUserModel {
    loadModel(buffer: ArrayBuffer, shouldCheckMocConsistency?: boolean): void;
    createRenderer(width: number, height: number, maskBufferCount?: number): void;
    deleteRenderer(): void;
    getRenderer(): CubismRenderer_WebGL;
    getModel(): CubismModel;
    getModelMatrix(): CubismMatrix44;
    release(): void;
  }
}
