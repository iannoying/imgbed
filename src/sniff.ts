// Detect image type from magic bytes (never trust the client's Content-Type)
// and read width/height from the header where cheap to do so.

export interface ImageInfo {
  contentType: string;
  ext: string;
  width: number | null;
  height: number | null;
}

const startsWith = (b: Uint8Array, sig: number[], offset = 0) =>
  sig.every((v, i) => b[offset + i] === v);

const ascii = (b: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...b.subarray(start, end));

export function sniffImage(b: Uint8Array): ImageInfo | null {
  if (b.length < 12) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

  // PNG
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    const ok = b.length >= 24 && ascii(b, 12, 16) === "IHDR";
    return {
      contentType: "image/png",
      ext: "png",
      width: ok ? dv.getUint32(16) : null,
      height: ok ? dv.getUint32(20) : null,
    };
  }

  // GIF
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") {
    return {
      contentType: "image/gif",
      ext: "gif",
      width: dv.getUint16(6, true),
      height: dv.getUint16(8, true),
    };
  }

  // JPEG
  if (startsWith(b, [0xff, 0xd8, 0xff])) {
    return { contentType: "image/jpeg", ext: "jpg", ...jpegSize(b, dv) };
  }

  // WebP
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") {
    return { contentType: "image/webp", ext: "webp", ...webpSize(b, dv) };
  }

  // AVIF / HEIC are ISO-BMFF: "ftyp" box at offset 4
  if (ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12);
    if (brand === "avif" || brand === "avis") {
      return { contentType: "image/avif", ext: "avif", width: null, height: null };
    }
  }

  // BMP
  if (ascii(b, 0, 2) === "BM" && b.length >= 26) {
    return {
      contentType: "image/bmp",
      ext: "bmp",
      width: Math.abs(dv.getInt32(18, true)),
      height: Math.abs(dv.getInt32(22, true)),
    };
  }

  // ICO
  if (startsWith(b, [0x00, 0x00, 0x01, 0x00])) {
    return {
      contentType: "image/x-icon",
      ext: "ico",
      width: b[6] || 256,
      height: b[7] || 256,
    };
  }

  // SVG (text): look for an <svg tag near the start
  const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 4096)));
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    const tag = head.match(/<svg[^>]*>/i)?.[0] ?? "";
    const num = (name: string) => {
      const m = tag.match(new RegExp(`\\s${name}=["']\\s*([\\d.]+)(px)?\\s*["']`, "i"));
      return m ? Math.round(parseFloat(m[1])) : null;
    };
    let width = num("width");
    let height = num("height");
    if (width === null || height === null) {
      const vb = tag.match(/viewBox=["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
      if (vb) {
        width = Math.round(parseFloat(vb[1]));
        height = Math.round(parseFloat(vb[2]));
      }
    }
    return { contentType: "image/svg+xml", ext: "svg", width, height };
  }

  return null;
}

function jpegSize(b: Uint8Array, dv: DataView) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    // SOFn markers carry the frame size (excluding DHT/JPG/DAC)
    if (
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    i += 2 + dv.getUint16(i + 2);
  }
  return { width: null, height: null };
}

function webpSize(b: Uint8Array, dv: DataView) {
  if (b.length < 30) return { width: null, height: null };
  const chunk = ascii(b, 12, 16);
  if (chunk === "VP8 ") {
    return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = dv.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    const w = b[24] | (b[25] << 8) | (b[26] << 16);
    const h = b[27] | (b[28] << 8) | (b[29] << 16);
    return { width: w + 1, height: h + 1 };
  }
  return { width: null, height: null };
}
