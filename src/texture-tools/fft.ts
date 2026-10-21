/** In-place complex FFT for ANY length (not just powers of two), used by
 * normal-to-height.ts. Power-of-two lengths use iterative radix-2
 * Cooley-Tukey; everything else goes through Bluestein's chirp-z
 * algorithm, which re-expresses an N-point DFT as a convolution that a
 * (larger, power-of-two) radix-2 FFT can evaluate. Texture dimensions in
 * captured games are usually powers of two, but not always (and the
 * solver's mirrored working size is 2x the texture's), so arbitrary sizes
 * have to work. */

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Per-length precomputed twiddle factors / bit-reversal table, so the
 * 2D transform (which runs thousands of same-length 1D transforms) doesn't
 * recompute sin/cos for every row. */
class Radix2Plan {
  readonly n: number;
  readonly cos: Float64Array;
  readonly sin: Float64Array;
  readonly rev: Uint32Array;

  constructor(n: number) {
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      const angle = (-2 * Math.PI * i) / n;
      this.cos[i] = Math.cos(angle);
      this.sin[i] = Math.sin(angle);
    }
    this.rev = new Uint32Array(n);
    let bits = 0;
    while (1 << bits < n) bits++;
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** Forward transform (e^{-i...}); inverse is done by the caller via the
   * conjugation trick, and is NOT normalised here. */
  run(re: Float64Array, im: Float64Array): void {
    const { n, cos, sin, rev } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const a = start + k;
          const b = a + half;
          const wr = cos[t];
          const wi = sin[t];
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

class BluesteinPlan {
  readonly n: number;
  readonly m: number;
  private readonly radix: Radix2Plan;
  private readonly chirpRe: Float64Array;
  private readonly chirpIm: Float64Array;
  private readonly kernelRe: Float64Array;
  private readonly kernelIm: Float64Array;
  private readonly bufRe: Float64Array;
  private readonly bufIm: Float64Array;

  constructor(n: number) {
    this.n = n;
    this.m = nextPowerOfTwo(2 * n - 1);
    this.radix = new Radix2Plan(this.m);
    this.chirpRe = new Float64Array(n);
    this.chirpIm = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      // i*i can exceed 2^53 only for absurd n; reduce mod 2n for accuracy.
      const k = (i * i) % (2 * n);
      const angle = (-Math.PI * k) / n;
      this.chirpRe[i] = Math.cos(angle);
      this.chirpIm[i] = Math.sin(angle);
    }
    this.kernelRe = new Float64Array(this.m);
    this.kernelIm = new Float64Array(this.m);
    this.kernelRe[0] = this.chirpRe[0];
    this.kernelIm[0] = -this.chirpIm[0];
    for (let i = 1; i < n; i++) {
      this.kernelRe[i] = this.kernelRe[this.m - i] = this.chirpRe[i];
      this.kernelIm[i] = this.kernelIm[this.m - i] = -this.chirpIm[i];
    }
    this.radix.run(this.kernelRe, this.kernelIm);
    this.bufRe = new Float64Array(this.m);
    this.bufIm = new Float64Array(this.m);
  }

  run(re: Float64Array, im: Float64Array): void {
    const { n, m, chirpRe, chirpIm, kernelRe, kernelIm, bufRe, bufIm } = this;
    bufRe.fill(0);
    bufIm.fill(0);
    for (let i = 0; i < n; i++) {
      bufRe[i] = re[i] * chirpRe[i] - im[i] * chirpIm[i];
      bufIm[i] = re[i] * chirpIm[i] + im[i] * chirpRe[i];
    }
    this.radix.run(bufRe, bufIm);
    for (let i = 0; i < m; i++) {
      const r = bufRe[i] * kernelRe[i] - bufIm[i] * kernelIm[i];
      const j = bufRe[i] * kernelIm[i] + bufIm[i] * kernelRe[i];
      bufRe[i] = r;
      bufIm[i] = j;
    }
    // Inverse radix-2 via conjugation: IFFT(x) = conj(FFT(conj(x))) / m
    for (let i = 0; i < m; i++) bufIm[i] = -bufIm[i];
    this.radix.run(bufRe, bufIm);
    for (let i = 0; i < n; i++) {
      const r = bufRe[i] / m;
      const j = -bufIm[i] / m;
      re[i] = r * chirpRe[i] - j * chirpIm[i];
      im[i] = r * chirpIm[i] + j * chirpRe[i];
    }
  }
}

type Plan = Radix2Plan | BluesteinPlan;

function makePlan(n: number): Plan {
  return isPowerOfTwo(n) ? new Radix2Plan(n) : new BluesteinPlan(n);
}

/** Storage for the 2D field. Float32 halves memory for very large fields
 * (every 1D line is still transformed in Float64 scratch - only the
 * between-pass storage is rounded), see normal-to-height.ts. */
export type FloatArray = Float32Array | Float64Array;

/** How many adjacent columns the column pass gathers at once. Reading a
 * column of a row-major field touches one cache line per element; taking
 * several neighbouring columns per sweep reuses each cache line instead,
 * which matters a lot at 4096+ rows. */
const COLUMN_BLOCK = 8;

/** 2D FFT over a row-major `width` x `height` complex field stored as
 * separate real/imaginary arrays. `inverse` applies the 1/(w*h)
 * normalisation too. */
export function fft2d(re: FloatArray, im: FloatArray, width: number, height: number, inverse: boolean): void {
  const rowPlan = makePlan(width);
  const colPlan = width === height ? rowPlan : makePlan(height);

  const transform = (plan: Plan, lineRe: Float64Array, lineIm: Float64Array) => {
    if (inverse) {
      for (let i = 0; i < lineIm.length; i++) lineIm[i] = -lineIm[i];
      plan.run(lineRe, lineIm);
      for (let i = 0; i < lineIm.length; i++) lineIm[i] = -lineIm[i];
    } else {
      plan.run(lineRe, lineIm);
    }
  };

  const rowRe = new Float64Array(width);
  const rowIm = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      rowRe[x] = re[base + x];
      rowIm[x] = im[base + x];
    }
    transform(rowPlan, rowRe, rowIm);
    for (let x = 0; x < width; x++) {
      re[base + x] = rowRe[x];
      im[base + x] = rowIm[x];
    }
  }

  const colRe: Float64Array[] = [];
  const colIm: Float64Array[] = [];
  for (let b = 0; b < COLUMN_BLOCK; b++) {
    colRe.push(new Float64Array(height));
    colIm.push(new Float64Array(height));
  }
  for (let x0 = 0; x0 < width; x0 += COLUMN_BLOCK) {
    const block = Math.min(COLUMN_BLOCK, width - x0);
    for (let y = 0; y < height; y++) {
      const base = y * width + x0;
      for (let b = 0; b < block; b++) {
        colRe[b][y] = re[base + b];
        colIm[b][y] = im[base + b];
      }
    }
    for (let b = 0; b < block; b++) transform(colPlan, colRe[b], colIm[b]);
    for (let y = 0; y < height; y++) {
      const base = y * width + x0;
      for (let b = 0; b < block; b++) {
        re[base + b] = colRe[b][y];
        im[base + b] = colIm[b][y];
      }
    }
  }

  if (inverse) {
    const scale = 1 / (width * height);
    for (let i = 0; i < re.length; i++) {
      re[i] *= scale;
      im[i] *= scale;
    }
  }
}
