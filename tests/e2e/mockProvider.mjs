/**
 * Dev-only mock provider + static fixture host for the e2e smoke suite (Phase 8
 * §5). Dependency-free Node HTTP server — the `custom` (OpenAI-compatible)
 * provider exists precisely so the e2e tests never touch a real vendor.
 *
 * Surfaces:
 *  - `POST /v1/chat/completions` — OpenAI Chat Completions. Counts image blocks:
 *    1 → a single-page canonical JSON body; N → a `pages` array of length N (so
 *    batching is e2e-exercisable). Configurable latency (MOCK_LATENCY_MS, default
 *    2000 ms — the Architecture acceptance number). Deterministic regions.
 *  - `GET /v1/models` (and `/models`) — the Phase 6 key-test path, so the options
 *    "Test" button works against the mock.
 *  - `GET /stats` — request/image counters, so the perf + leak specs can assert
 *    cache hits (zero provider traffic on the second pass) and coalescing.
 *  - `POST /reset` — zero the counters between scenarios.
 *  - Static host for `chapter.html` + its page images — hand-rolled raster PNGs
 *    (node:zlib, no image dependency; SVG is unusable because Firefox's
 *    `createImageBitmap` rejects SVG blobs), served over HTTP as SEPARATE image
 *    URLs (NOT data URIs) so the perf scenario exercises the real §7.3 path
 *    (optional host permission → background fetch), not a shortcut. Each page's
 *    bytes differ so page identity (content hash) is distinct per page.
 *
 * All responses carry permissive CORS (`Access-Control-Allow-Origin: *` +
 * preflight) — browser-origin provider calls are the real thing, same as vendors.
 *
 * Run standalone:  node tests/e2e/mockProvider.mjs [port]
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const LATENCY_MS = Number(process.env.MOCK_LATENCY_MS ?? 2000);
const PAGE_COUNT = Number(process.env.MOCK_PAGE_COUNT ?? 10);
const PAGE_W = 800;
const PAGE_H = 1200;

const stats = { chatRequests: 0, images: 0, modelRequests: 0 };

/** Deterministic regions for a page (corner-format bboxes [x_min,y_min,x_max,y_max]). */
function pageBody(index) {
  return {
    source_lang: "ja",
    regions: [
      {
        bbox: [0.1, 0.05, 0.45, 0.14],
        original: `ページ${index}のセリフ`,
        translated: `Page ${index} line one`,
        is_sfx: false,
        kind: "bubble",
      },
      {
        bbox: [0.55, 0.28, 0.92, 0.4],
        original: "つづく",
        translated: "To be continued",
        is_sfx: false,
        kind: "bubble",
      },
      {
        bbox: [0.3, 0.6, 0.6, 0.72],
        original: "ゴゴゴ",
        translated: "RUMBLE",
        is_sfx: true,
        kind: "sfx",
      },
    ],
  };
}

/** Count image blocks in an OpenAI chat request body (user message content array). */
function countImages(body) {
  try {
    const messages = body.messages ?? [];
    let n = 0;
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (block?.type === "image_url" || block?.type === "image") n++;
      }
    }
    return n;
  } catch {
    return 1;
  }
}

/** CORS headers on every response (browser-origin provider calls). */
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

function sendJson(res, status, obj) {
  cors(res);
  res.setHeader("Content-Type", "application/json");
  res.statusCode = status;
  res.end(JSON.stringify(obj));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

// --- Raster PNG page fixtures ------------------------------------------------
// WHY PNG and not SVG: `prepareImage` decodes via `createImageBitmap`, and
// Firefox's `createImageBitmap` REJECTS SVG blobs — every job would die at prep,
// before any provider call, so no translation scenario could ever pass. Manga
// pages are never SVG, so teaching the product to decode them would be test-only
// product code. Instead the mock hand-rolls a tiny raster PNG (node:zlib only, no
// image dependency). Each page's bytes MUST differ (a per-index colour/stripe) —
// page identity is the CONTENT HASH, and identical bytes would collapse all pages
// into one cache entry / one coalesced job.

/** Standard PNG/zlib CRC-32 table (polynomial 0xEDB88320). */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length + type + data + CRC(type+data). */
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode a raw RGB raster (width*height*3 bytes) as an 8-bit truecolour PNG. */
function encodePng(width, height, rgb) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  // compression(10)/filter(11)/interlace(12) all 0 (Buffer.alloc zero-fills).
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // per-scanline filter type: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Build a distinct-per-page raster: a per-index background plus a moving stripe. */
function buildPageRaster(index, width, height) {
  const rgb = Buffer.alloc(width * height * 3);
  const bg = [0xf0, (0xf4 - index * 9) & 0xff, (0xe0 + index * 5) & 0xff];
  const stripe = [(0x30 + index * 23) & 0xff, 0x44, (0x88 + index * 11) & 0xff];
  const stripeTop = 100 + ((index * 80) % (height - 320));
  const stripeBot = stripeTop + 160;
  for (let y = 0; y < height; y++) {
    const c = y >= stripeTop && y < stripeBot ? stripe : bg;
    const row = y * width * 3;
    for (let x = 0; x < width; x++) {
      const o = row + x * 3;
      rgb[o] = c[0];
      rgb[o + 1] = c[1];
      rgb[o + 2] = c[2];
    }
  }
  return rgb;
}

/** Encoded PNG bytes per page index, built once (cheap solid-fill images). */
const PAGE_PNG_CACHE = new Map();
function pagePng(index) {
  let png = PAGE_PNG_CACHE.get(index);
  if (!png) {
    png = encodePng(PAGE_W, PAGE_H, buildPageRaster(index, PAGE_W, PAGE_H));
    PAGE_PNG_CACHE.set(index, png);
  }
  return png;
}

/** The 10-page chapter document — separate <img> src URLs, NOT data URIs. */
function chapterHtml({ leak = false } = {}) {
  const imgs = Array.from({ length: PAGE_COUNT }, (_, i) => {
    const n = i + 1;
    // One page is deliberately a blob: URL (built in-page) so the Phase 7.2 bytes
    // path rides along in the perf scenario (optional, not required for DoD).
    if (n === 3 && !leak) {
      return `<img class="page" data-blobsrc="/pages/${n}.png" alt="page ${n}" width="800" height="1200"/>`;
    }
    return `<img class="page" src="/pages/${n}.png" alt="page ${n}" width="800" height="1200"/>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mock chapter</title>
<style>body{margin:0;background:#111}img.page{display:block;margin:0 auto 8px;max-width:100%}</style>
</head><body>
<main id="reader">
${imgs}
</main>
<script>
  // Turn the data-blobsrc image into a blob: URL (Phase 7.2 bytes path).
  for (const img of document.querySelectorAll('img[data-blobsrc]')) {
    fetch(img.dataset.blobsrc).then(r => r.blob()).then(b => { img.src = URL.createObjectURL(b); });
  }
  ${leak ? leakScript() : ""}
</script>
</body></html>`;
}

/** SPA-churn harness for the leak scenario: swaps <main>'s images on demand. */
function leakScript() {
  return `
  let cycle = 0;
  window.__mangalensSwapPages = function () {
    cycle++;
    const main = document.getElementById('reader');
    main.replaceChildren();
    for (let i = 1; i <= ${PAGE_COUNT}; i++) {
      const img = document.createElement('img');
      img.className = 'page';
      // Same URLs each cycle → content-hash cache hits after cycle 1.
      img.src = '/pages/' + i + '.png';
      img.width = 800; img.height = 1200;
      main.appendChild(img);
    }
    return cycle;
  };`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  // --- Provider surface ---
  if (req.method === "POST" && path === "/v1/chat/completions") {
    const body = await readJsonBody(req);
    const n = Math.max(1, countImages(body));
    stats.chatRequests++;
    stats.images += n;
    const content =
      n === 1
        ? JSON.stringify(pageBody(1))
        : JSON.stringify({ pages: Array.from({ length: n }, (_, i) => pageBody(i + 1)) });
    setTimeout(() => {
      sendJson(res, 200, {
        id: "mock-cmpl",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 500 * n, completion_tokens: 60 * n, total_tokens: 560 * n },
      });
    }, LATENCY_MS);
    return;
  }

  if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
    stats.modelRequests++;
    sendJson(res, 200, { object: "list", data: [{ id: "mock-model", object: "model" }] });
    return;
  }

  // --- Test harness surface ---
  if (req.method === "GET" && path === "/stats") {
    sendJson(res, 200, { ...stats });
    return;
  }
  if (req.method === "POST" && path === "/reset") {
    stats.chatRequests = 0;
    stats.images = 0;
    stats.modelRequests = 0;
    sendJson(res, 200, { ok: true });
    return;
  }

  // --- Static fixture host ---
  if (req.method === "GET" && (path === "/chapter.html" || path === "/")) {
    cors(res);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(chapterHtml({ leak: url.searchParams.has("leak") }));
    return;
  }
  const pageMatch = /^\/pages\/(\d+)\.png$/.exec(path);
  if (req.method === "GET" && pageMatch) {
    cors(res);
    res.setHeader("Content-Type", "image/png");
    res.end(pagePng(Number(pageMatch[1])));
    return;
  }
  // Allow serving a real page file if one is dropped next to this server.
  if (req.method === "GET" && path === "/chapter-file.html") {
    try {
      const html = await readFile(join(HERE, "chapter.html"), "utf8");
      cors(res);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html);
      return;
    } catch {
      /* fall through to 404 */
    }
  }
  // Phase 9.8 §3: the 30-page long-chapter fixture (Scenario E — staged translate-all
  // window). Served straight from the static file; its /pages/N.png images reuse the
  // generator above (it scales to any N).
  if (req.method === "GET" && path === "/chapter-long.html") {
    try {
      const html = await readFile(join(HERE, "chapter-long.html"), "utf8");
      cors(res);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html);
      return;
    } catch {
      /* fall through to 404 */
    }
  }

  cors(res);
  res.statusCode = 404;
  res.end("not found");
});

/** Start the server; resolves with { port, close } once listening. */
export function startMockProvider(port = 0) {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        port: actualPort,
        baseUrl: `http://127.0.0.1:${actualPort}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * Standalone self-check (§1): the page fixtures must be valid PNGs (8-byte magic)
 * AND each page's bytes must differ — page identity is the content hash, so
 * identical bytes would collapse every page into one cache entry. Throws on
 * failure so `node tests/e2e/mockProvider.mjs` fails loudly, no browser needed.
 */
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function selfCheckPages() {
  const p1 = pagePng(1);
  const p2 = pagePng(2);
  if (!p1.subarray(0, 8).equals(PNG_MAGIC) || !p2.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error("page fixtures are not valid PNGs (magic-byte check failed)");
  }
  if (p1.equals(p2)) {
    throw new Error("two pages produced identical bytes — page identity would collapse");
  }
}

// Run standalone when invoked directly (node tests/e2e/mockProvider.mjs [port]).
if (process.argv[1] && process.argv[1].endsWith("mockProvider.mjs")) {
  selfCheckPages();
  const port = Number(process.argv[2] ?? 8785);
  startMockProvider(port).then(({ baseUrl }) => {
    // eslint-disable-next-line no-console
    console.log(`mock provider @ ${baseUrl} (latency ${LATENCY_MS}ms, ${PAGE_COUNT} pages)`);
    console.log(`  self-check OK: pages are valid, distinct PNGs`);
    console.log(`  chapter: ${baseUrl}/chapter.html   leak: ${baseUrl}/chapter.html?leak`);
    console.log(`  provider base for the extension's custom endpoint: ${baseUrl}/v1`);
  });
}
