import * as THREE from "three";
import type { VirtualFileSystem } from "../filesystem";

/**
 * Loads and caches textures from the virtual file system, downscaling
 * anything above maxDimension before it ever reaches the GPU.
 *
 * This exists specifically to fix a crash on large captures: the previous
 * (plain HTML/JS) version of this viewer used THREE.TextureLoader().load(),
 * which kicks off image decoding asynchronously and returns immediately
 * without waiting for it. Iterating thousands of draws in a loop that never
 * awaits the texture load fires off huge numbers of *concurrent*, unbounded
 * full-resolution image decodes almost immediately - easily exhausting GPU
 * memory and causing a WebGL context loss, which shows up as the canvas
 * silently going black with no error.
 *
 * Using createImageBitmap() here instead, and awaiting it per texture inside
 * the caller's sequential per-draw loop, means decodes are naturally
 * throttled to one at a time, and downscaling caps how much GPU memory each
 * texture can possibly use regardless of the source image's resolution.
 */
export class TextureManager {
  private cache = new Map<string, THREE.Texture>();
  maxDimension = 1024;

  async load(vfs: VirtualFileSystem, path: string): Promise<THREE.Texture | null> {
    const cached = this.cache.get(path);
    if (cached) return cached;

    const file = vfs.get(path);
    if (!file) return null;

    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (e) {
      console.warn(`Failed to decode texture ${path}`, e);
      return null;
    }

    const scale = Math.min(1, this.maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;

    this.cache.set(path, texture);
    return texture;
  }

  disposeAll(): void {
    for (const texture of this.cache.values()) texture.dispose();
    this.cache.clear();
  }
}
