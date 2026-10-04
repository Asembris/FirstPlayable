/**
 * The exported file's whole stylesheet.
 *
 * First-party CSS, no font file, no image, no gradient asset, and no external
 * request of any kind: the CSP in `html.ts` sets `default-src 'none'` and names
 * this string's own SHA-256, so anything that tried to load would be blocked
 * anyway. System serif for narrative, system sans for controls, which is the
 * same typographic rule the studio follows (specification section 3).
 *
 * Phase 6 owns the visual system. This is deliberately plain and readable.
 */
export const OFFLINE_PLAYER_CSS = [
  ":root{--ink:#16161a;--paper:#f6f2e8;--panel:#ffffff;--line:#d9d3c4;--amber:#a2620f;--muted:#5d5a52}",
  "*{box-sizing:border-box}",
  "body{margin:0;padding:24px 16px 48px;background:var(--ink);color:var(--paper);font-family:ui-sans-serif,system-ui,sans-serif;font-size:15px;line-height:1.5}",
  "#fp-root{max-width:720px;margin:0 auto}",
  ".fp-title{font-family:ui-serif,Georgia,serif;font-size:28px;line-height:1.2;margin:0 0 8px}",
  ".fp-meta{color:#b9b3a5;font-size:13px;margin:0 0 8px}",
  ".fp-stage{margin-top:24px}",
  ".fp-room,.fp-object,.fp-choices,.fp-ending,.fp-provenance{background:#1e1e23;border:1px solid #2e2e35;border-radius:8px;padding:24px;margin-bottom:16px}",
  ".fp-object{background:var(--paper);color:var(--ink);border-color:var(--line)}",
  ".fp-room-name,.fp-object-name,.fp-ending-title,.fp-choices-heading{font-family:ui-serif,Georgia,serif;margin:0 0 8px;font-size:20px}",
  ".fp-choices-heading{font-size:16px}",
  ".fp-room-text,.fp-line-text{font-family:ui-serif,Georgia,serif;font-size:18px;line-height:1.6;max-width:66ch;margin:0 0 8px}",
  ".fp-transcript{list-style:none;margin:0 0 16px;padding:0}",
  ".fp-transcript li{margin-bottom:16px}",
  ".fp-choice-made{color:var(--amber);font-size:14px}",
  ".fp-blocked{color:#b9b3a5;font-size:14px}",
  ".fp-speaker{display:block;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#b9b3a5}",
  ".fp-button{display:block;width:100%;text-align:left;margin:8px 0;padding:16px;font:inherit;font-size:16px;color:var(--paper);background:#26262c;border:1px solid #3a3a42;border-radius:6px;cursor:pointer}",
  ".fp-button:hover{border-color:var(--amber)}",
  ".fp-button:focus-visible{outline:2px solid var(--amber);outline-offset:2px}",
  ".fp-button-primary{background:var(--amber);border-color:var(--amber);color:#fff}",
  ".fp-choice-locked{opacity:.65;cursor:not-allowed}",
  ".fp-choice-reason{display:block;margin-top:8px;font-size:13px;color:#b9b3a5}",
  ".fp-provenance summary{cursor:pointer;font-size:14px}",
  ".fp-provenance-line{border-top:1px solid #2e2e35;margin-top:16px;padding-top:16px}",
  ".fp-footer{color:#8d887c;font-size:12px}",
  "@media (prefers-reduced-motion: reduce){*{transition:none!important;animation:none!important}}",
  "@media (max-width: 420px){body{padding:16px 12px 32px}.fp-room,.fp-object,.fp-choices,.fp-ending,.fp-provenance{padding:16px}}",
].join("\n");
