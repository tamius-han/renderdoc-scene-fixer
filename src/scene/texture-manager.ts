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
 * throttled to one at a time, and downscaling caps how much GPU memory each
 * texture can possibly use regardless of the source image's resolution.
 *
 * That sequential-per-caller pattern is the common case (scene import), but
 * isn't the only one - export (see SceneViewerApp.handleStartExport()/
 * loadAuxiliaryDrawTextures()) legitimately calls load() for many draws
 * CONCURRENTLY via Promise.all(), which can easily mean several in-flight
 * calls for the exact same path (many draws sharing one texture file) at
 * once. load()/pending below make that safe: every caller for the same
 * path converges on ONE decode and ONE shared THREE.Texture object, rather
 * than each kicking off its own (which, being pixel-identical but distinct
 * objects, would defeat the exporter's own identity-keyed texture dedup and
 * embed the same image more than once).
 */
export class TextureManager {
  private cache = new Map<string, THREE.Texture>();
  private pending = new Map<string, Promise<THREE.Texture | null>>();
  maxDimension = 1024;

  async load(vfs: VirtualFileSystem, path: string): Promise<THREE.Texture | null> {
    const cached = this.cache.get(path);
    if (cached) return cached.texture;

    const alreadyLoading = this.pending.get(path);
    if (alreadyLoading) return alreadyLoading;

    const promise = this.loadUncached(vfs, path);
    this.pending.set(path, promise);
    try {
      return await promise;
    } finally {
      // Only the (sole) in-flight load for this path should ever be
      // registered here, so it's always safe to just delete - no need to
      // check identity before clearing.
      this.pending.delete(path);
    }
  }

  private async loadUncached(vfs: VirtualFileSystem, path: string): Promise<THREE.Texture | null> {
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
