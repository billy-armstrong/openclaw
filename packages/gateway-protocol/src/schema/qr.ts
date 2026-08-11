// Gateway Protocol QR schemas share the established PNG data-URL contract.
import { Type } from "typebox";

export const QR_PNG_DATA_URL_MAX_LENGTH = 16_384;
export const QR_PNG_DATA_URL_PREFIX = "data:image/png;base64,";

// The first ten characters plus `o-r` encode the eight-byte PNG signature. If
// the payload ends there, only `o=` has canonical zero pad bits. Longer values
// complete that quartet before using the canonical padded Base64 tail grammar.
const QR_PNG_BASE64_SIGNATURE_PATTERN = "iVBORw0KGg";
const QR_PNG_BASE64_CANONICAL_TAIL_PATTERN =
  "(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?";
const QR_PNG_DATA_URL_PATTERN = `^${QR_PNG_DATA_URL_PREFIX}${QR_PNG_BASE64_SIGNATURE_PATTERN}(?:o=|[o-r][A-Za-z0-9+/]${QR_PNG_BASE64_CANONICAL_TAIL_PATTERN})$`;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const PNG_IHDR = 0x49484452;
const PNG_IDAT = 0x49444154;
const PNG_IEND = 0x49454e44;

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function pngCrc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeQrPngDataUrl(value: string): Uint8Array | undefined {
  if (!value.startsWith(QR_PNG_DATA_URL_PREFIX)) {
    return undefined;
  }
  try {
    const decoded = atob(value.slice(QR_PNG_DATA_URL_PREFIX.length));
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** Validates the bounded PNG structure that QR-capable protocol clients consume. */
function isValidQrPngDataUrl(value: string): boolean {
  const bytes = decodeQrPngDataUrl(value);
  if (!bytes || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    return false;
  }

  let offset: number = PNG_SIGNATURE.length;
  let sawIdat = false;
  while (offset + 12 <= bytes.length) {
    const length = readUint32Be(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const crcOffset = dataOffset + length;
    const nextOffset = crcOffset + 4;
    if (crcOffset > bytes.length - 4) {
      return false;
    }

    const type = readUint32Be(bytes, typeOffset);
    if (
      pngCrc32(bytes, typeOffset, crcOffset) !== readUint32Be(bytes, crcOffset) ||
      (offset === PNG_SIGNATURE.length &&
        (type !== PNG_IHDR ||
          length !== 13 ||
          readUint32Be(bytes, dataOffset) === 0 ||
          readUint32Be(bytes, dataOffset + 4) === 0))
    ) {
      return false;
    }

    if (type === PNG_IHDR && offset !== PNG_SIGNATURE.length) {
      return false;
    }
    if (type === PNG_IDAT) {
      sawIdat = true;
    }
    if (type === PNG_IEND) {
      return length === 0 && sawIdat && nextOffset === bytes.length;
    }
    offset = nextOffset;
  }
  return false;
}

export const QrPngDataUrlSchema = Type.Refine(
  Type.String({
    maxLength: QR_PNG_DATA_URL_MAX_LENGTH,
    pattern: QR_PNG_DATA_URL_PATTERN,
  }),
  isValidQrPngDataUrl,
  () => "Expected a structurally valid PNG QR data URL",
);
