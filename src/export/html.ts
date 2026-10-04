/**
 * The exported file: a trusted build-time bundle, trusted styles, and inert
 * data (specification section 12, "Export and share safety").
 *
 * Three decisions make the scene unable to become markup or code, and none of
 * them depends on escaping being remembered at the right call site:
 *
 *   * **The data is base64.** The snapshot is serialized, UTF-8 encoded, and
 *     base64 encoded, and it sits in a plain `<div hidden>` — not in a script
 *     element. Base64's alphabet is `A-Za-z0-9+/=`, so a scene containing
 *     `</script>`, `<img onerror=...>`, a Unicode line separator, or a URL
 *     cannot terminate its container, introduce an attribute, or be read as
 *     anything but characters. The trusted loader decodes it.
 *   * **The script is a build-time bundle, pinned by hash.** The one inline
 *     script is the committed bundle of `src/export/offline-entry.ts` and the
 *     Phase 1 engine. The CSP names its SHA-256 and the stylesheet's, and
 *     `default-src 'none'` closes everything else: no CDN, no font, no image,
 *     no `connect-src`, no `form-action`, no `base-uri`. A file that was
 *     tampered with does not run at all.
 *   * **Nothing private is reachable.** The only payload is the same
 *     `PublicSnapshot` a published link would serve, which has no field for a
 *     project id, an owner session, a brief, a draft, a rejected proposal, a
 *     capture, or a token.
 */

import {
  exportFileName,
  OFFLINE_EXPORT_SCHEMA,
  type OfflineExport,
  OfflineExportSchema,
  type PublicSnapshot,
  SHARE_WARNING,
} from "@/domain/publish";
import { sha256Hex } from "@/engine/hash";
import { OFFLINE_PLAYER_JS } from "./generated/offline-player";
import { OFFLINE_PLAYER_CSS } from "./styles";

export { exportFileName };

/** The base64 SHA-256 digest a CSP hash source needs. */
export function cspHash(source: string): string {
  const hex = sha256Hex(source);
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `sha256-${base64(binary)}`;
}

/** Base64 without a Node or DOM dependency, so this module stays portable. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(binary: string): string {
  let out = "";
  for (let index = 0; index < binary.length; index += 3) {
    const a = binary.charCodeAt(index);
    const b = index + 1 < binary.length ? binary.charCodeAt(index + 1) : Number.NaN;
    const c = index + 2 < binary.length ? binary.charCodeAt(index + 2) : Number.NaN;
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 0x03) << 4) | (Number.isNaN(b) ? 0 : b >> 4)];
    out += Number.isNaN(b)
      ? "="
      : ALPHABET[((b & 0x0f) << 2) | (Number.isNaN(c) ? 0 : c >> 6)];
    out += Number.isNaN(c) ? "=" : ALPHABET[c & 0x3f];
  }
  return out;
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return base64(binary);
}

/**
 * Escapes the few strings that are interpolated into markup rather than
 * carried as data: the document title and the warning sentence.
 *
 * The scene itself never comes through here — it is base64 — so this function is
 * a belt on a document whose braces are already structural.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\u2028/g, "")
    .replace(/\u2029/g, "");
}

export type ExportResult = {
  readonly html: string;
  readonly fileName: string;
  readonly bytes: number;
};

/**
 * Builds the whole exported document for one public snapshot.
 *
 * The document is self-contained: open it from a disk with the network
 * unplugged and it plays, because there is nothing in it to fetch.
 */
export function buildOfflineExport(
  snapshot: PublicSnapshot,
  exportedAt: string,
): ExportResult {
  const payload: OfflineExport = OfflineExportSchema.parse({
    schema: OFFLINE_EXPORT_SCHEMA,
    exported_at: exportedAt,
    snapshot,
  } satisfies OfflineExport);

  const data = base64Utf8(JSON.stringify(payload));
  const scriptHash = cspHash(OFFLINE_PLAYER_JS);
  const styleHash = cspHash(OFFLINE_PLAYER_CSS);
  const csp = [
    "default-src 'none'",
    `script-src '${scriptHash}'`,
    `style-src '${styleHash}'`,
    "img-src 'none'",
    "font-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "media-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">`,
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escapeHtml(snapshot.title)} · FirstPlayable</title>`,
    `<style>${OFFLINE_PLAYER_CSS}</style>`,
    "</head>",
    "<body>",
    `<div id="fp-data" hidden>${data}</div>`,
    '<div id="fp-root"></div>',
    `<noscript><p>${escapeHtml(
      "This playable runs in your browser. Enable JavaScript for this file to play it.",
    )}</p></noscript>`,
    `<script>${OFFLINE_PLAYER_JS}</script>`,
    `<!-- ${escapeHtml(SHARE_WARNING)} -->`,
    "</body>",
    "</html>",
    "",
  ].join("\n");

  return {
    html,
    fileName: exportFileName(snapshot.version_id),
    bytes: new TextEncoder().encode(html).byteLength,
  };
}
