import { crc32 } from "./crc32";

async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  // CompressionStream("deflate") emits a zlib-wrapped stream, which is
  // exactly what a PNG IDAT chunk holds.
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encodes a single-channel, 16-bit grayscale PNG. Needed because
 * canvas.toBlob()/toDataURL() can only ever produce 8-bit images, and 256
 * height levels visibly band (terraced "stair-steps") once a height map
 * drives displacement. Rows use PNG's "Sub" filter, which makes smooth
 * height data compress far better than unfiltered rows would. */
export async function encodeGrayscale16Png(samples: Uint16Array, width: number, height: number): Promise<Uint8Array> {
  const rowBytes = width * 2;
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 1; // filter type 1: Sub
    let prevHi = 0;
    let prevLo = 0;
    for (let x = 0; x < width; x++) {
      const v = samples[y * width + x];
      const hi = v >> 8;
      const lo = v & 0xff;
      // Sub filter works bytewise against the corresponding byte of the
      // previous PIXEL (bytes-per-pixel = 2), i.e. hi vs prev hi, lo vs prev lo.
      raw[rowStart + 1 + x * 2] = (hi - prevHi) & 0xff;
      raw[rowStart + 2 + x * 2] = (lo - prevLo) & 0xff;
      prevHi = hi;
      prevLo = lo;
    }
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 16; // bit depth
  ihdr[9] = 0; // color type: grayscale

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", await zlibDeflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    png.set(p, offset);
    offset += p.length;
  }
  return png;
}
