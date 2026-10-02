import { fileTypeFromBuffer } from "file-type";

/**
 * Decide the MIME type of uploaded bytes from their content, never from
 * what the client claimed. Anything not on this list is refused, so an
 * uploaded HTML or script file can never be stored and served back from
 * the app's own origin.
 */

const BINARY_ALLOWED = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/avif",
  "audio/ogg",
  "audio/opus",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/wav",
  "video/mp4",
  "video/quicktime",
  "application/pdf",
  "model/gltf-binary",
]);

// text formats are identified by extension and must parse / be printable
const TEXT_BY_EXT: Record<string, string> = {
  json: "application/json",
  geojson: "application/geo+json",
  gltf: "model/gltf+json",
  obj: "model/obj",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
};

export class UnsupportedFileType extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFileType";
  }
}

export async function sniffMime(bytes: Uint8Array, fileName?: string): Promise<string> {
  const ext = (fileName?.split(".").pop() ?? "").toLowerCase();
  const detected = await fileTypeFromBuffer(bytes);

  if (detected) {
    if (BINARY_ALLOWED.has(detected.mime)) return detected.mime;
    // usdz is a zip container; only accept it under its own extension
    if (detected.mime === "application/zip" && ext === "usdz") return "model/vnd.usdz+zip";
    throw new UnsupportedFileType(`File type ${detected.mime} is not accepted.`);
  }

  const textMime = TEXT_BY_EXT[ext];
  if (!textMime) throw new UnsupportedFileType(`Files of type .${ext || "?"} are not accepted.`);
  const head = bytes.subarray(0, 64 * 1024);
  for (const b of head) {
    // control bytes other than tab/newline/CR mean this is not a text file
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
      throw new UnsupportedFileType("File looks binary but has a text extension.");
    }
  }
  if (ext === "json" || ext === "geojson" || ext === "gltf") {
    try {
      JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw new UnsupportedFileType("File is not valid JSON.");
    }
  }
  return textMime;
}

/** Content types the browser may render inline; everything else downloads. */
export function isInlineMime(mime: string): boolean {
  return mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/") || mime === "application/pdf";
}

/** Best-effort MIME from a stored file's extension, for serving. */
export function mimeFromExtension(fileName: string): string {
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    heic: "image/heic",
    avif: "image/avif",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    mp4: "video/mp4",
    mov: "video/quicktime",
    pdf: "application/pdf",
    glb: "model/gltf-binary",
    usdz: "model/vnd.usdz+zip",
    ...TEXT_BY_EXT,
  };
  return map[ext] ?? "application/octet-stream";
}
