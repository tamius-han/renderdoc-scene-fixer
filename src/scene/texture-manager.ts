import * as THREE from "three";
import type { VirtualFileSystem } from "../filesystem";

/**
 * Loads and caches textures from the virtual file system at their full,
 * native resolution - textures are never downscaled before reaching the
 * GPU.
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
 * throttled to one at a time - each texture still reaches the GPU at full
 * size, but never more than one decode is in flight simultaneously.
 */
export class TextureManager {
  private cache = new Map<string, { texture: THREE.Texture; bitmap: ImageBitmap }>();

  async load(vfs: VirtualFileSystem, path: string): Promise<THREE.Texture | null> {
    const cached = this.cache.get(path);
    if (cached) return cached.texture;

    const file = vfs.get(path);
    if (!file) return null;

    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (e) {
      console.warn(`Failed to decode texture ${path}`, e);
      return null;
    }

    // The bitmap becomes the texture's image directly, at whatever
    // resolution it was decoded at - no intermediate canvas resize.
    const texture = new THREE.Texture(bitmap);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;

    this.cache.set(path, { texture, bitmap });
    return texture;
  }

  disposeAll(): void {
    for (const { texture, bitmap } of this.cache.values()) {
      texture.dispose();
      bitmap.close();
    }
    this.cache.clear();
  }
}
