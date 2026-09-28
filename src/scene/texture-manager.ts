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
 * throttled to one at a time.
 *
 * The decoded bitmap is copied onto a same-size (never smaller) <canvas>
 * rather than handed to THREE.Texture directly, and that's still worth
 * doing even with no resize involved: per the WebGL spec, the
 * UNPACK_FLIP_Y_WEBGL pixel-storage parameter - which is how THREE.Texture's
 * default flipY=true normally gets an image's rows into WebGL's
 * bottom-row-first order - is explicitly ignored when the upload source is
 * an ImageBitmap, but not when it's a <canvas>. Skipping the canvas and
 * uploading the ImageBitmap straight to the GPU would silently break that
 * flip: the texture would still decode fine for other consumers (e.g. this
 * app's own glTF export, which reads pixel rows directly via a 2D canvas
 * context - see canvasToPngBytes()/flipUvV() in gltf-exporter.ts, which are
 * written assuming exactly this canvas-backed, untouched-orientation
 * texture) but would appear vertically flipped in this app's own WebGL
 * viewer specifically. Routing through a canvas here keeps flipY meaningful
 * without reintroducing any downscaling - the canvas is always created at
 * the bitmap's own width/height, and the pixels drawn onto it are left in
 * their as-decoded orientation (no imageOrientation flip at decode time,
 * and no texture.flipY override below) - both the live viewer's GPU upload
 * and the exporter's canvas read-back need that same starting point, and
 * flipY:true (three.js's own default, left alone here) is what makes the
 * former correct; flipUvV() in gltf-exporter.ts is what makes the latter
 * correct.
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
  // Tracks a load that's already IN PROGRESS for a given path, so two
  // concurrent load() calls for the SAME path (e.g. several draws sharing
  // one texture file, all exported in the same Promise.all() batch - see
  // SceneViewerApp.handleStartExport()) share the one in-flight decode
  // instead of each kicking off their own. Without this, both calls see
  // an empty `cache` (nothing's been AWAITED yet, so nothing's been
  // written back to it), each decodes and caches its OWN separate
  // THREE.Texture wrapping an OWN separate (if pixel-identical) canvas,
  // and the second one to finish simply overwrites the first in `cache` -
  // by which point the first caller already has its own texture object in
  // hand. The exporter's own texture/image dedup (getOrCreateTexture() in
  // gltf-exporter.ts) keys strictly on OBJECT IDENTITY, so those two
  // "same file" textures look like two different textures to it, and the
  // same PNG bytes get embedded into the .glb twice.
  private pending = new Map<string, Promise<THREE.Texture | null>>();

  async load(vfs: VirtualFileSystem, path: string): Promise<THREE.Texture | null> {
    const cached = this.cache.get(path);
    if (cached) return cached;

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

    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0);
    // The canvas now holds its own independent copy of every pixel, so the
    // bitmap itself is done being useful right away - close() releases its
    // separate decoded-pixel-buffer handle immediately rather than leaving
    // it (redundantly) alive for as long as the texture/canvas is cached.
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
