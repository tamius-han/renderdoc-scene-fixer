import { fft2d } from "./fft";

/** How the normal map's green channel is oriented. OpenGL-style maps
 * (Blender, glTF, Unity) have +Y pointing UP the image; DirectX-style maps
 * (Unreal, many game captures) have +Y pointing DOWN. Getting this wrong
 * inverts bumps into dents along one axis, so it's exposed as an option
 * rather than guessed. */
export type NormalMapGreenConvention = "opengl" | "directx";

export interface NormalToHeightOptions {
  greenConvention: NormalMapGreenConvention;
}

export interface HeightMapResult {
  width: number;
  height: number;
  /** One 16-bit sample per pixel, row-major, top row first; 0 = lowest
   * point of the surface, 65535 = highest (min/max normalised). */
  data: Uint16Array;
}

/** The smallest nz allowed when turning a normal into a slope (-nx/nz).
 * Without a floor, texels whose normal lies almost flat against the
 * surface produce near-infinite slopes that dominate the whole solve. */
const MIN_NZ = 0.05;

/** Converts a tangent-space normal map (RGBA bytes, as read straight off a
 * canvas) into a height map by integrating its slopes.
 *
 * A normal n = (nx, ny, nz) on a surface z = h(x, y) satisfies
 * (dh/dx, dh/dy) = (-nx/nz, -ny/nz). So the normal map is really just a
 * gradient field, and recovering h means finding the height field whose
 * gradient best matches it in the least-squares sense - which is a
 * Poisson equation, solved here in the Fourier domain (Frankot-Chellappa).
 *
 * Fourier solving implicitly assumes the field repeats forever, but a
 * texture's left edge doesn't generally continue into its right edge, and
 * that mismatch would smear a big ramp across the whole result. To avoid
 * it the gradient field is first MIRRORED into a 2W x 2H field (with the
 * mirrored slope's sign flipped along the mirrored axis, so it stays a
 * valid gradient of a mirrored height field) - that field is seamlessly
 * periodic by construction. Only the original quadrant is kept afterwards.
 *
 * Some captured normal maps store only X and Y (two-channel BC5 style) and
 * leave blue empty; in that case nz is rebuilt from sqrt(1 - nx^2 - ny^2).
 *
 * Absolute height is unrecoverable from slopes alone (a constant offset
 * has zero gradient), and so is real-world scale, so the result is simply
 * normalised to the full 16-bit range. */
export function normalToHeight(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options: NormalToHeightOptions,
  onProgress?: (stage: string) => void,
): HeightMapResult {
  const pixelCount = width * height;
  const sign = options.greenConvention === "opengl" ? 1 : -1;

  // Detect two-channel normal maps (blue ~empty everywhere).
  let maxBlue = 0;
  for (let i = 0; i < pixelCount; i++) maxBlue = Math.max(maxBlue, rgba[i * 4 + 2]);
  const reconstructZ = maxBlue < 16;

  onProgress?.("Building gradient field");
  const W = width * 2;
  const H = height * 2;
  // The mirrored field's two components live in ONE complex array F =
  // gx + i*gy: both gradients are real, so one forward FFT carries both
  // and they're separated again via the Hermitian symmetry of real
  // signals' spectra - one FFT fewer than doing them separately.
  //
  // Memory: the field is (2W)x(2H) complex. At a 4096 texture that's 8192^2
  // = 67M complex samples - 1 GB as Float64, 0.5 GB as Float32 - so fields
  // beyond the 2048-texture size are stored as Float32 (each 1D line is
  // still transformed in Float64, see fft2d(); the rounding error, ~1e-7
  // of the peak, is well below one step of the 16-bit output).
  const FieldArray = W * H > 4096 * 4096 ? Float32Array : Float64Array;
  const re = new FieldArray(W * H);
  const im = new FieldArray(W * H);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let nx = (rgba[i * 4] / 255) * 2 - 1;
      let ny = (rgba[i * 4 + 1] / 255) * 2 - 1;
      let nz: number;
      if (reconstructZ) {
        nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      } else {
        nz = (rgba[i * 4 + 2] / 255) * 2 - 1;
      }
      nz = Math.max(nz, MIN_NZ);
      // Renormalise so a not-quite-unit-length (compressed/filtered)
      // normal doesn't bias the slope.
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const gxv = -nx / nz;
      const gyv = (sign * ny) / nz; // dh/d(row): rows grow downward in an image

      const x2 = W - 1 - x;
      const y2 = H - 1 - y;
      // gx flips sign when mirrored in x; gy flips sign when mirrored in y.
      re[y * W + x] = gxv;
      im[y * W + x] = gyv;
      re[y * W + x2] = -gxv;
      im[y * W + x2] = gyv;
      re[y2 * W + x] = gxv;
      im[y2 * W + x] = -gyv;
      re[y2 * W + x2] = -gxv;
      im[y2 * W + x2] = -gyv;
    }
  }

  onProgress?.("Forward transform");
  fft2d(re, im, W, H, false);

  onProgress?.("Solving");
  for (let v = 0; v < H; v++) {
    const nv = (H - v) % H;
    const fv = v <= H / 2 ? v : v - H;
    for (let u = 0; u < W; u++) {
      const nu = (W - u) % W;
      const idx = v * W + u;
      const nidx = nv * W + nu;
      if (idx > nidx) continue; // handled together with its mirror partner

      if (idx === 0 || u === W / 2 || v === H / 2) {
        // DC (unknowable offset) and Nyquist lines (derivative ill-defined)
        re[idx] = 0;
        im[idx] = 0;
        re[nidx] = 0;
        im[nidx] = 0;
        continue;
      }

      const fu = u <= W / 2 ? u : u - W;
      const wx = (2 * Math.PI * fu) / W;
      const wy = (2 * Math.PI * fv) / H;
      const denom = wx * wx + wy * wy;

      const fr = re[idx];
      const fi = im[idx];
      const nfr = re[nidx];
      const nfi = im[nidx];

      // Gx = (F(k) + conj(F(-k))) / 2 ; Gy = (F(k) - conj(F(-k))) / (2i)
      const gxr = (fr + nfr) / 2;
      const gxi = (fi - nfi) / 2;
      const gyr = (fi + nfi) / 2;
      const gyi = -(fr - nfr) / 2;

      // H = -i (wx Gx + wy Gy) / denom
      const sr = wx * gxr + wy * gyr;
      const si = wx * gxi + wy * gyi;
      const hr = si / denom;
      const hi = -sr / denom;

      re[idx] = hr;
      im[idx] = hi;
      re[nidx] = hr; // H(-k) = conj(H(k))
      im[nidx] = -hi;
    }
  }

  onProgress?.("Inverse transform");
  fft2d(re, im, W, H, true);

  onProgress?.("Normalising");
  let min = Infinity;
  let max = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = re[y * W + x];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const range = max - min || 1;
  const data = new Uint16Array(pixelCount);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = Math.round(((re[y * W + x] - min) / range) * 65535);
    }
  }
  return { width, height, data };
}
