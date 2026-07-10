// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  classifyImageUrl,
  createScanner,
  isCandidate,
  parseCssUrl,
  scoreCandidate,
  type Candidate,
  type CandidateMetrics,
} from "../../src/content/scanner";

/** A qualifying manga-page metric set; override per test. */
function metrics(overrides: Partial<CandidateMetrics> = {}): CandidateMetrics {
  return {
    renderedW: 500,
    renderedH: 720,
    naturalW: 800,
    naturalH: 1200,
    viewportW: 1000,
    centerX: 500,
    ...overrides,
  };
}

describe("scanner — isCandidate (§7.1 heuristics)", () => {
  it("accepts a normal manga page", () => {
    expect(isCandidate(metrics())).toBe(true);
  });

  it("accepts an extreme-aspect webtoon strip (loose aspect filter)", () => {
    expect(
      isCandidate(metrics({ renderedW: 700, renderedH: 6000, naturalW: 800, naturalH: 20000 })),
    ).toBe(true);
  });

  it("rejects a too-small icon (rendered < 180)", () => {
    expect(isCandidate(metrics({ renderedW: 64, renderedH: 64, naturalW: 64, naturalH: 64 }))).toBe(
      false,
    );
  });

  it("rejects an avatar (natural < 400 on both sides)", () => {
    expect(
      isCandidate(metrics({ renderedW: 300, renderedH: 300, naturalW: 200, naturalH: 200 })),
    ).toBe(false);
  });
});

describe("scanner — scoreCandidate", () => {
  it("ranks a big centered image above a small footer/sidebar one", () => {
    const big = scoreCandidate(
      metrics({ renderedW: 700, renderedH: 1000, centerX: 500, viewportW: 1000 }),
    );
    const small = scoreCandidate(
      metrics({ renderedW: 200, renderedH: 200, centerX: 950, viewportW: 1000 }),
    );
    expect(big).toBeGreaterThan(small);
  });

  it("prefers a centered image over an equally-sized sidebar image", () => {
    const centered = scoreCandidate(metrics({ centerX: 500, viewportW: 1000 }));
    const sidebar = scoreCandidate(metrics({ centerX: 980, viewportW: 1000 }));
    expect(centered).toBeGreaterThan(sidebar);
  });
});

describe("scanner — classifyImageUrl (URL policy)", () => {
  it("accepts http(s) and data URLs", () => {
    expect(classifyImageUrl("https://x/y.jpg")).toBe("accept");
    expect(classifyImageUrl("http://x/y.png")).toBe("accept");
    expect(classifyImageUrl("data:image/png;base64,AAAA")).toBe("accept");
  });

  it("skips blob URLs (background can't fetch them cross-context, §7.3)", () => {
    expect(classifyImageUrl("blob:https://x/abc-123")).toBe("skip");
  });

  it("skips other schemes and nullish values", () => {
    expect(classifyImageUrl("about:blank")).toBe("skip");
    expect(classifyImageUrl(null)).toBe("skip");
    expect(classifyImageUrl(undefined)).toBe("skip");
    expect(classifyImageUrl("")).toBe("skip");
  });
});

describe("scanner — parseCssUrl", () => {
  it("extracts a quoted or unquoted url()", () => {
    expect(parseCssUrl('url("https://x/y.png")')).toBe("https://x/y.png");
    expect(parseCssUrl("url(a.png)")).toBe("a.png");
    expect(parseCssUrl("url('b.jpg'), linear-gradient(#fff,#000)")).toBe("b.jpg");
  });

  it("returns null when there is no url()", () => {
    expect(parseCssUrl("none")).toBeNull();
    expect(parseCssUrl("linear-gradient(#fff,#000)")).toBeNull();
  });
});

describe("scanner — DOM walker (jsdom, injected metrics seam)", () => {
  it("registers only qualifying images, de-dupes, re-registers on src swap, prunes removals", () => {
    const pageEl = document.createElement("img");
    const iconEl = document.createElement("img");
    document.body.append(pageEl, iconEl);

    const present: Element[] = [pageEl, iconEl];
    const metricsFor = new Map<Element, CandidateMetrics>([
      [pageEl, metrics()],
      [iconEl, metrics({ renderedW: 64, renderedH: 64, naturalW: 64, naturalH: 64 })],
    ]);
    const urlFor = new Map<Element, string>([
      [pageEl, "https://x/page.jpg"],
      [iconEl, "https://x/icon.png"],
    ]);

    const added: Candidate[] = [];
    const removed: Candidate[] = [];
    const scanner = createScanner({
      onAdded: (c) => added.push(c),
      onRemoved: (c) => removed.push(c),
      collectElements: () => [...present],
      readMetrics: (el) => metricsFor.get(el) ?? null,
      resolveUrl: (el) => urlFor.get(el) ?? null,
    });

    scanner.scan();
    expect(added).toHaveLength(1); // the icon is rejected by the predicate
    expect(added[0]!.el).toBe(pageEl);

    scanner.scan(); // unchanged → idempotent, no new registration
    expect(added).toHaveLength(1);

    urlFor.set(pageEl, "https://x/page2.jpg"); // in-place src swap
    scanner.scan();
    expect(removed).toHaveLength(1); // old candidate torn down
    expect(added).toHaveLength(2);
    expect(added[1]!.url).toBe("https://x/page2.jpg");

    present.splice(0, present.length); // both elements leave the DOM
    scanner.scan();
    expect(removed).toHaveLength(2); // the current page candidate is pruned

    scanner.stop();
  });
});
