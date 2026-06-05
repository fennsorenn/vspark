import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { CHROMA_GLSL, type ChromaKeyConfig } from './videoFx';

/**
 * Renders a (playing) <video> element to a WebGL2 canvas with chroma keying
 * applied per frame, for the compose `video` layer. The <video> itself stays
 * the source of truth (and the registered MediaHandle target); this only
 * displays a keyed copy. When chroma is disabled the layer renders the plain
 * <video> instead, so this is only mounted while keying is on.
 */

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main(){
  // Flip Y so the texture isn't upside-down (canvas origin vs GL origin).
  vUv = vec2((aPos.x + 1.0) * 0.5, 1.0 - (aPos.y + 1.0) * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec3 uKeyColor;
uniform float uSimilarity, uSmoothness, uSpill;
${CHROMA_GLSL.replace(/texture2D/g, 'texture')}
void main(){
  vec4 col = texture(uTex, vUv);
  outColor = vfx_chroma(col, uKeyColor, uSimilarity, uSmoothness, uSpill);
}
`;

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 1, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[chroma] shader compile failed:', gl.getShaderInfoLog(sh));
  }
  return sh;
}

export function ChromaVideoCanvas({
  videoRef,
  chroma,
  objectFit,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  chroma: ChromaKeyConfig;
  objectFit: CSSProperties['objectFit'];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Latest chroma config, read inside the rAF loop without re-initialising GL.
  const chromaRef = useRef(chroma);
  chromaRef.current = chroma;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false });
    if (!gl) {
      console.warn('[chroma] WebGL2 unavailable; chroma key disabled');
      return;
    }

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const uTex = gl.getUniformLocation(prog, 'uTex');
    const uKey = gl.getUniformLocation(prog, 'uKeyColor');
    const uSim = gl.getUniformLocation(prog, 'uSimilarity');
    const uSmooth = gl.getUniformLocation(prog, 'uSmoothness');
    const uSpill = gl.getUniformLocation(prog, 'uSpill');

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const video = videoRef.current;
      if (!video || video.readyState < 2 || video.videoWidth === 0) return;
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        gl.viewport(0, 0, canvas.width, canvas.height);
      }
      const c = chromaRef.current;
      const [r, g, b] = hexToRgb(c.color);
      gl.useProgram(prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      try {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          video
        );
      } catch {
        return; // frame not ready / cross-origin tainted
      }
      gl.uniform1i(uTex, 0);
      gl.uniform3f(uKey, r, g, b);
      gl.uniform1f(uSim, c.similarity);
      gl.uniform1f(uSmooth, c.smoothness);
      gl.uniform1f(uSpill, c.spill);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      gl.deleteProgram(prog);
      gl.deleteBuffer(quad);
      gl.deleteTexture(tex);
    };
  }, [videoRef]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: '100%',
        height: '100%',
        objectFit,
        display: 'block',
        pointerEvents: 'none',
      }}
    />
  );
}
