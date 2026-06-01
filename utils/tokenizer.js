// utils/tokenizer.js
// ─────────────────────────────────────────────────────────────────────────────
// Heuristic token estimator. Calibrated against tiktoken cl100k_base for
// English prose, against Anthropic's published per-language ratios for CJK.
//
// Targets:
//   ±10%  for English prose
//   ±15%  for code-heavy text
//   ±20%  for CJK-dominant text
//
// NOT a real tokenizer. The dispatcher's calibration loop (consuming
// detectQuotaSignals from the platform) is what corrects systemic bias
// over time. This estimator only needs to be locally consistent.
//
// Bugs fixed since v1.x:
//   - whitespace was being attributed to latin char count → resolved by
//     normalizing whitespace before counting
//   - punctuation was double-counted as both "code" and latin → resolved
//     by splitting code-region detection from prose punctuation
//   - long runs of digits got over-estimated → numbers now scored separately
// ─────────────────────────────────────────────────────────────────────────────

const Tokenizer = (function () {

  // Ratios are tokens-per-character, derived from tiktoken benchmark on
  // mixed corpora. These calibrate further at runtime via dispatcher.
  const RATIO = {
    cjk:    0.55,   // Han / Hiragana / Katakana / Hangul — most chars are 1-2 tokens
    latin:  0.27,   // English / Latin scripts — ~3.7 chars/token
    code:   0.35,   // identifiers, syntax, lots of short tokens
    digits: 0.40,   // long number runs split into chunks of 3-4 digits
    space:  0.0,    // whitespace mostly merges into adjacent tokens
  };

  // Markdown code fences — when present, content inside scored as `code`.
  const FENCE = /```[\s\S]*?```|`[^`\n]+`/g;

  // CJK ranges: Han + Hiragana + Katakana + Hangul + CJK punct
  const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/g;

  const DIGIT_RUN = /\d{3,}/g;

  /**
   * Estimate tokens for a string.
   * @param {string} text
   * @returns {number}
   */
  function estimate(text) {
    if (!text || typeof text !== 'string') return 0;

    let total = 0;
    let remaining = text;

    // 1. Pull out code fences and score them as code.
    remaining = remaining.replace(FENCE, (match) => {
      total += Math.ceil(match.length * RATIO.code);
      return ' '; // leave a single space marker
    });

    // 2. Pull out CJK chars and score by RATIO.cjk.
    let cjkCount = 0;
    remaining = remaining.replace(CJK, () => {
      cjkCount++;
      return '';
    });
    total += Math.ceil(cjkCount * RATIO.cjk);

    // 3. Pull out long digit runs (phone numbers, ids).
    let digitChars = 0;
    remaining = remaining.replace(DIGIT_RUN, (run) => {
      digitChars += run.length;
      return '';
    });
    total += Math.ceil(digitChars * RATIO.digits);

    // 4. What's left is latin prose + short numbers + punctuation.
    //    Strip leading/trailing whitespace, collapse runs.
    const collapsed = remaining.replace(/\s+/g, ' ').trim();
    total += Math.ceil(collapsed.length * RATIO.latin);

    return total;
  }

  /**
   * Estimate tokens for an attachment by file size + type.
   * Conservative — better to over-estimate than under-warn user.
   * @param {{ name: string, sizeBytes: number, mediaType: string }} att
   * @returns {number}
   */
  function estimateAttachment(att) {
    if (!att) return 0;
    const { name = '', sizeBytes = 0, mediaType = '' } = att;
    const ext = (name.split('.').pop() || '').toLowerCase();

    // Images: Anthropic's tokenizer maps images to a fixed bucket.
    // Per docs: ~1.5k tokens for medium images, more for high-res.
    if (mediaType.startsWith('image/') || ['png','jpg','jpeg','gif','webp'].includes(ext)) {
      return 1600;
    }

    // PDFs: roughly bytes/4 for text-heavy, but many PDFs are mostly text.
    // Use bytes/3.5 as a conservative middle ground.
    if (ext === 'pdf' || mediaType === 'application/pdf') {
      return Math.ceil(sizeBytes / 3.5);
    }

    // Office docs: docx/xlsx/pptx are zipped XML; effective text is smaller.
    if (['docx','xlsx','pptx'].includes(ext)) {
      return Math.ceil(sizeBytes / 5);
    }

    // Plaintext / code / csv: bytes ≈ chars, then standard ratio.
    return Math.ceil(sizeBytes * RATIO.latin);
  }

  /**
   * Fixed overhead for tools / connectors / system prompts. These are
   * loose estimates from probing system prompt sizes via API echoes.
   * Adjust as Anthropic's hidden prompts change.
   */
  const TOOL_COST = {
    web_search:        600,
    analysis:         1200,
    artifacts:         800,
    google_drive:      900,
    google_calendar:   700,
    gmail:             900,
    notion:            800,
    slack:             900,
    asana:             700,
    linear:            700,
    github:            700,
    figma:             800,
    mcp_generic:       600,    // per unknown MCP server
  };

  function estimateToolsOverhead(activeToolIds) {
    if (!Array.isArray(activeToolIds)) return 0;
    return activeToolIds.reduce((sum, id) => {
      return sum + (TOOL_COST[id] || TOOL_COST.mcp_generic);
    }, 0);
  }

  return { estimate, estimateAttachment, estimateToolsOverhead, _RATIO: RATIO };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Tokenizer;
