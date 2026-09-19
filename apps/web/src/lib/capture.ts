'use client';
/**
 * Image and animation capture from the live 3D view (spec §11 exports): retina/transparent PNG,
 * copy-as-image, rotating GIF and WebM/MP4. Frames are rendered deterministically (no reliance
 * on requestAnimationFrame), so captures work even while the tab is in the background.
 */
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

export interface CaptureTarget {
  gl: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  controls: OrbitControlsImpl | null;
  /** Runs one frame of scene updates (instance matrices, morphs) without waiting for rAF. */
  advance: () => void;
}

export const captureRef: { current: CaptureTarget | null } = { current: null };

function need(): CaptureTarget {
  if (!captureRef.current) throw new Error('Open the 3D view to capture an image.');
  captureRef.current.advance();
  return captureRef.current;
}

/** The post-processing composer turns autoClear off; captures must clear every frame. */
function renderClean(t: CaptureTarget): void {
  const prev = t.gl.autoClear;
  t.gl.autoClear = true;
  t.gl.setRenderTarget(null);
  t.gl.clear(true, true, true);
  t.gl.render(t.scene, t.camera);
  t.gl.autoClear = prev;
}

function canvasToBlob(c: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Capture failed'))), type));
}

/** Current frame exactly as shown (post-processing included). */
export async function snapshot(): Promise<Blob> {
  return canvasToBlob(need().gl.domElement);
}

/** Re-render at `scale` × device pixels with a transparent background. */
export async function snapshotTransparent(scale = 2): Promise<Blob> {
  const { gl, scene } = need();
  const prevRatio = gl.getPixelRatio();
  const prevClear = gl.getClearAlpha();
  const prevBg = scene.background;
  const hidden: THREE.Object3D[] = [];
  scene.traverse((o) => {
    // Contact shadows and helpers look odd floating on a transparent page.
    if (o.userData.noExport && o.visible) {
      hidden.push(o);
      o.visible = false;
    }
  });
  try {
    scene.background = null;
    gl.setPixelRatio(Math.min(4, prevRatio * scale));
    gl.setClearAlpha(0);
    renderClean(need());
    return await canvasToBlob(gl.domElement);
  } finally {
    for (const o of hidden) o.visible = true;
    scene.background = prevBg;
    gl.setPixelRatio(prevRatio);
    gl.setClearAlpha(prevClear);
    renderClean(need());
  }
}

export async function copyImage(): Promise<void> {
  const blob = await snapshot();
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

/** Orbit the camera once around the current target, calling `frame` after each render. */
async function orbit(frames: number, frame: (k: number) => Promise<void> | void): Promise<void> {
  const t = need();
  const { camera, controls } = t;
  const target = controls?.target.clone() ?? new THREE.Vector3();
  const start = camera.position.clone();
  const up = camera.up.clone().normalize();
  try {
    for (let k = 0; k < frames; k++) {
      const offset = start.clone().sub(target).applyAxisAngle(up, (2 * Math.PI * k) / frames);
      camera.position.copy(target).add(offset);
      camera.lookAt(target);
      renderClean(t);
      await frame(k);
    }
  } finally {
    camera.position.copy(start);
    camera.lookAt(target);
    controls?.update();
    renderClean(t);
  }
}

export async function recordGif(opts: { size?: number; frames?: number; background?: string } = {}): Promise<Blob> {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
  const { gl } = need();
  const src = gl.domElement;
  const size = opts.size ?? 480;
  const w = size;
  const h = Math.round((size * src.height) / src.width);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const gif = GIFEncoder();
  const frames = opts.frames ?? 60;
  await orbit(frames, (k) => {
    ctx.fillStyle = opts.background ?? '#0b0e14';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), w, h, { palette, delay: 50, repeat: k === 0 ? 0 : undefined });
  });
  gif.finish();
  return new Blob([gif.bytes() as Uint8Array<ArrayBuffer>], { type: "image/gif" });
}

export async function recordVideo(opts: { seconds?: number; fps?: number } = {}): Promise<{ blob: Blob; ext: string }> {
  const { gl } = need();
  const fps = opts.fps ?? 30;
  const frames = Math.round((opts.seconds ?? 5) * fps);
  const stream = gl.domElement.captureStream(0);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const mime = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
  rec.start();
  await orbit(frames, () => {
    track.requestFrame?.();
    return new Promise((r) => setTimeout(r, 1000 / fps));
  });
  rec.stop();
  await done;
  return { blob: new Blob(chunks, { type: mime.split(';')[0] }), ext: mime.includes('mp4') ? 'mp4' : 'webm' };
}
