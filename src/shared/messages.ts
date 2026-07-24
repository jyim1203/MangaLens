/**
 * Typed runtime message contracts between content, background, popup, and
 * options (gap resolution #6).
 *
 * The whole bus is described by {@link MessageMap}: one entry per message
 * `type`, each pairing a request payload with its response. The helpers
 * ({@link sendToBackground}, {@link sendToTab}, {@link createMessageRouter})
 * are generic over that map, so callers get compile-time checking of both the
 * payload they send and the value they get back — there is no place to send an
 * unknown message type or mishandle a response shape.
 *
 * WHY a central map instead of ad-hoc `{ type: "..." }` objects: message
 * passing crosses module boundaries where TS can't otherwise follow the shape.
 * A single source-of-truth map is the one spot that keeps sender and handler in
 * agreement.
 */
import browser from "webextension-polyfill";
import { createLogger } from "./log";
import type { Settings, SettingsPatch } from "./settings";
import type {
  BBox,
  PageTranslation,
  ProviderErrorKind,
  ProviderId,
} from "./types";

const log = createLogger("messages");

/** Result of a "test this API key" ping from the options page (§7.6). */
export interface TestKeyResult {
  ok: boolean;
  /** Failure category when `ok` is false. */
  errorKind?: ProviderErrorKind;
  /** Human-readable detail for the options UI. */
  message?: string;
}

/** Content-script request to translate one on-page image (§7.3). */
export interface TranslatePageRequest {
  /**
   * Absolute image URL. The background fetches it with host permissions UNLESS
   * {@link imageBytes} is present — for a blob-sourced page the URL is then
   * identity/diagnostics only (a document-scoped `blob:` URL can't be fetched
   * cross-context, §7.3), and the content script ships the bytes instead.
   */
  imageUrl: string;
  /**
   * Raw image bytes for `blob:` sources the background cannot fetch (Phase 7.2 —
   * MangaDex and other 100%-blob readers). Mirrors
   * {@link TranslateRegionRequest.imageBytes}. WHY safe: Firefox
   * `runtime.sendMessage` structured-clones an ArrayBuffer intact; a future
   * Chrome port (JSON message passing) would need base64.
   */
  imageBytes?: ArrayBuffer;
  /** MIME of {@link imageBytes}; sent with it (defaults to image/jpeg background-side). */
  imageMime?: string;
  /** Overrides the settings target language when set (e.g. drag-select). */
  targetLang?: string;
  /** 0 = visible, 1 = near viewport, 2 = prefetch/all (§7.5). */
  priority: number;
  /**
   * Content-generated id (`crypto.randomUUID()`) so the content side can later
   * cancel this specific request via {@link MessageMap.cancelTranslation}
   * (Phase 5 real cancellation). Optional — omit for fire-and-forget callers.
   */
  requestId?: string;
  /**
   * Cache-only probe (Phase 7.6 hydrate): "answer from cache or say not-cached;
   * NEVER enqueue, coalesce, or call the provider." The content-side hydrate pass
   * sets this so a previously-translated page's overlays reappear on reload with
   * guaranteed-zero provider spend. A miss/expired lookup returns the
   * {@link TranslatePageResult} `not-cached` arm; it is unreachable for a normal
   * (non-`cacheOnly`) request.
   */
  cacheOnly?: boolean;
}

/**
 * Response of the `translatePage` message: a discriminated result rather than
 * a thrown error. WHY: `runtime.sendMessage` serializes a rejected Promise to
 * a bare message string — a typed `ProviderError`'s `kind` would be lost in
 * transit, and the PROMPTS.md §6 taxonomy must reach the content script to
 * drive UI ("check your API key" vs backoff vs "provider declined"). Returning
 * the failure as data survives the boundary and keeps the handler from ever
 * rejecting (fail soft, handoff rule 6).
 */
export type TranslatePageResult =
  | { ok: true; page: PageTranslation }
  | { ok: false; errorKind: ProviderErrorKind; message: string }
  // Phase 7.6 hydrate: a `cacheOnly` probe found no live cache entry. The literal
  // lives ONLY in this union, NOT in {@link ProviderErrorKind} — "not cached" is
  // not a provider error (it drives no negative-cache policy, no error badge). It
  // is unreachable for a non-`cacheOnly` request; the hydrate sender handles it
  // explicitly before the generic error branch, so `setError`/`errorKindToMessage`
  // never see it.
  | { ok: false; errorKind: "not-cached" };

/**
 * Content-script request to translate a user-drawn crop of an image (F10
 * drag-select, Phase 7). Exactly one of {@link imageUrl} / {@link imageBytes}
 * is present: `http(s)`/`data:` sources send the URL (the background fetches,
 * reusing the HTTP cache, §7.3); `blob:`/`<canvas>` sources are read
 * content-side (only the page's own origin can) and their bytes shipped over
 * the structured-clone message boundary.
 */
export interface TranslateRegionRequest {
  /** `http(s)`/`data:` source URL — the background fetches it. */
  imageUrl?: string;
  /**
   * Raw image bytes for `blob:`/`<canvas>` sources the background cannot fetch.
   * WHY safe: Firefox `runtime.sendMessage` uses structured clone, so an
   * ArrayBuffer crosses intact. Firefox-only-safe — a future Chrome port (JSON
   * message passing) would need base64 here.
   */
  imageBytes?: ArrayBuffer;
  /** MIME of {@link imageBytes}; required with it. */
  imageMime?: string;
  /** The crop, normalized 0–1 in FULL-image space (treated as a tile offset). */
  crop: BBox;
  /** Overrides the settings target language when set. */
  targetLang?: string;
  /** Content-generated id, shared cancellation contract with {@link TranslatePageRequest}. */
  requestId?: string;
}

/**
 * The complete set of messages and their request/response shapes. Add a new
 * message by adding one entry here; every helper updates its types
 * automatically. Use `void` for a request or response that carries no data.
 */
export interface MessageMap {
  /** Liveness check used to prove the content ⇄ background channel (Phase 0). */
  ping: { request: void; response: { ok: true } };

  /** Fetch the current, migrated settings. */
  getSettings: { request: void; response: Settings };

  /** Persist a partial settings update; resolves with the full new settings.
   *  `null` entries in the open-keyed records delete (see {@link SettingsPatch}). */
  setSettings: { request: SettingsPatch; response: Settings };

  /** Broadcast (background/options → content/popup) that settings changed. */
  settingsChanged: { request: { settings: Settings }; response: void };

  /** Toggle the global enable flag; resolves with the full new settings (F1). */
  toggleEnabled: { request: void; response: Settings };

  /** Translate one image; resolves with a success/failure result (§7.3).
   *  Never rejects for translation failures — see {@link TranslatePageResult}. */
  translatePage: {
    request: TranslatePageRequest;
    response: TranslatePageResult;
  };

  /**
   * Cancel an in-flight {@link translatePage} by its `requestId` (Phase 5).
   * WHY: without this, disabling MangaLens or closing a tab mid-chapter leaves
   * the event page paying the provider for pages nobody will see. Cancelling an
   * unknown/already-settled id is a silent no-op (the normal teardown race).
   *
   * `mode` (Phase 9.6 §1) draws the same started/queued line the pause feature
   * ({@link cancelQueuedTranslations}) already draws:
   *  - `"hard"` (DEFAULT, so every pre-9.6 caller is byte-compatible) aborts
   *    unconditionally — teardown (`stop()`), extension-off, explicit drag-select
   *    cancel. The user is leaving; respect it.
   *  - `"queued-only"` aborts ONLY if the request has not crossed the started
   *    boundary. WHY: an already-SENT provider call bills regardless of client
   *    disconnect, so cancelling it destroys the cache value for ~zero refund —
   *    finishing it converts sunk cost into a cache entry a recycled element's
   *    re-send (§2) will hit. The content DOM-reconcile `unregister` path sends
   *    this so MangaDex's element churn stops killing in-flight tail pages.
   */
  cancelTranslation: {
    request: { requestId: string; mode?: "hard" | "queued-only" };
    response: void;
  };

  /**
   * Content → background: raise the priority of an in-flight {@link translatePage}
   * (Phase 8 §2). WHY: a prefetched / translate-all page (priority 2) that scrolls
   * into view should jump the queue instead of waiting behind the whole chapter.
   * Fire-and-forget: an unknown/settled/already-more-urgent id is a silent no-op
   * (same contract as {@link cancelTranslation}). UPGRADE-ONLY — the background
   * applies `min(current, priority)`, so this can never worsen a job's priority.
   */
  reprioritizeTranslation: {
    request: { requestId: string; priority: number };
    response: void;
  };

  /**
   * Cancel every QUEUED-but-not-yet-started {@link translatePage} in a batch, by
   * their `requestId`s (Phase 7.4 pause). The background aborts each id that has
   * a registered controller AND has not started its provider call, and replies
   * with how many it actually cancelled; already-started and unknown ids are
   * silently skipped — that's the feature ("let started calls finish, stop the
   * rest"). Composes with {@link cancelTranslation}'s controller registry.
   */
  cancelQueuedTranslations: {
    request: { requestIds: string[] };
    response: { cancelled: number };
  };

  /** Validate an API key with a cheap ping (options "test key" button, §7.6).
   *  `customEndpoint` is required in practice when `provider: "custom"` (Phase 6
   *  contract addition — the custom endpoint has no fixed URL to ping). */
  testApiKey: {
    request: { provider: ProviderId; apiKey: string; customEndpoint?: string };
    response: TestKeyResult;
  };

  /**
   * Reset the F17 usage/cost totals (options page). WHY a message and not a
   * direct `resetCostStats()` import in the options page: cost WRITES are
   * serialized through a per-context promise chain in costTracker.ts — a write
   * from a second context (the options page) would race the background's chain
   * and reintroduce the Phase 4.1 lost-update bug. Reads stay direct.
   */
  resetCostStats: { request: void; response: void };

  /**
   * Popup → content: translate every detected image (F8 "translate all").
   * Phase 9.8 §1: the content side dispatches this as a SLIDING window (an initial
   * ~12-page wave, refilled as the reader scrolls) rather than firing the whole
   * chapter at once, but `count` remains the TOTAL number of pages the click buys
   * overall — not the initial wave — so the popup's confirm/report stays "the whole
   * chapter". `dryRun: true` only counts what would be queued, so the popup can
   * confirm-first when the count is large (Risks: confirm dialog on "translate all"
   * > 30 pages) without paying for anything.
   */
  translateAll: {
    request: { dryRun?: boolean };
    response: { count: number };
  };

  /**
   * Translate one drag-select crop (F10, Phase 7). Reuses
   * {@link TranslatePageResult} — it never rejects (fail soft, rule 6) and
   * carries the §6 error-kind across the boundary as data. Region results are
   * NOT cached (two hand-drawn rects are never pixel-identical), so this bypasses
   * the cache entirely; the crop is treated as a tile so the existing
   * `tileOffset` remap lifts crop-local bboxes back to full-image space.
   */
  translateRegion: {
    request: TranslateRegionRequest;
    response: TranslatePageResult;
  };

  /**
   * Background command fan-out → content: enter drag-select mode (F10). Replies
   * `{ started: false }` when MangaLens is inert on this tab (the passive
   * bootstrap router is registered even while inactive — same inert-safety as
   * {@link translateAll}); `{ started: true }` when selection mode was entered.
   */
  startRegionSelect: { request: void; response: { started: boolean } };

  /**
   * Background command fan-out → content: flip "peek" on every done overlay (F14
   * toggle-all) — hide every translation overlay so the raw page shows through
   * (Phase 10 §1; the message name is kept for protocol stability). No-op while inert.
   */
  togglePeekOriginal: { request: void; response: void };

  /**
   * Content → background: open the options page (F14/error-toast "Open
   * settings" action). WHY a message: content scripts cannot call
   * `runtime.openOptionsPage()` — only an extension page can.
   */
  openOptionsPage: { request: void; response: void };

  /**
   * Popup → content: pause/resume this tab's translate queue (Phase 7.4). Pausing
   * lets every already-STARTED provider call finish and render, aborts every
   * queued-but-not-started page job, and stops new sends until resumed. Replies
   * with the resulting state and, on pause, how many queued jobs were cancelled.
   * Per-tab RUNTIME state — it dies with the content script on navigation. No-op
   * (`{ paused: false, cancelledQueued: 0 }`) while inert on this tab.
   */
  setTranslationsPaused: {
    request: { paused: boolean };
    response: { paused: boolean; cancelledQueued: number };
  };

  /** Popup → content: read the current pause state to reflect it on open
   *  (Phase 7.4). `{ paused: false }` while inert. */
  getTranslationsPaused: { request: void; response: { paused: boolean } };

  /**
   * Content → background: how many cache entries exist for this tab's origin
   * (Phase 7.6 hydrate gate). The origin is derived from `sender.url` background-
   * side; the background counts on the `origin` index (`IDBIndex.count`, O(log n),
   * no getAll). Fail-soft to `{ count: 0 }`. The content hydrate pass calls this
   * ONCE per queue lifetime before probing: a count of 0 short-circuits all
   * probes, so sites the user never translated on stay inert (no per-image
   * fetch+hash on every pageload).
   */
  countCachedForSite: { request: void; response: { count: number } };

  /**
   * Popup → content: on-demand "Show cached translations" (Phase 8 §0). Probes
   * EVERY currently-registered, not-yet-requested candidate for a cached
   * translation and renders each hit with ZERO provider spend — the explicit,
   * works-everywhere complement to the Phase 7.6 automatic hydrate (which only
   * runs on non-auto sites and only on register). WHY a distinct message and not
   * a `cacheOnly` flag on {@link translateAll}: keeping the spend-nothing path its
   * own message means an inert tab or a mis-click can never accidentally start
   * real provider requests. `count` = how many candidates a probe was scheduled
   * for (0 while inert / nothing registered), so the popup can show
   * "Showing N cached…" / "Nothing to show" feedback. Bypasses the per-lifetime
   * origin gate — the user's click IS the intent signal — so it works whether or
   * not the queue was constructed with `hydrate: true` (auto sites included).
   */
  hydrateCached: { request: void; response: { count: number } };
}

/** Every valid message `type`. */
export type MessageType = keyof MessageMap;

/** The request payload for a given message type. */
export type RequestOf<T extends MessageType> = MessageMap[T]["request"];

/** The response value for a given message type. */
export type ResponseOf<T extends MessageType> = MessageMap[T]["response"];

/**
 * The wire shape actually passed to `runtime.sendMessage`: the discriminant
 * `type` plus a `payload` (omitted when the request is `void`). Keeping the
 * payload in one field (rather than spreading it) means the router never has to
 * guess which top-level keys belong to the envelope vs. the message.
 */
export type Envelope<T extends MessageType = MessageType> = {
  type: T;
} & (RequestOf<T> extends void ? { payload?: undefined } : { payload: RequestOf<T> });

/** Runtime type guard: is `value` a MangaLens message envelope of any type? */
export function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/** Build an envelope; the payload arg is required exactly when the request is not `void`. */
function envelope<T extends MessageType>(
  type: T,
  ...rest: RequestOf<T> extends void ? [] : [payload: RequestOf<T>]
): Envelope<T> {
  return { type, payload: rest[0] } as Envelope<T>;
}

/**
 * Send a message to the background event page and await its typed response.
 *
 * @throws if the receiver throws or the channel closes; callers should fail
 *   soft (handoff rule 6) around this.
 */
export async function sendToBackground<T extends MessageType>(
  type: T,
  ...rest: RequestOf<T> extends void ? [] : [payload: RequestOf<T>]
): Promise<ResponseOf<T>> {
  const msg = envelope(type, ...rest);
  return (await browser.runtime.sendMessage(msg)) as ResponseOf<T>;
}

/**
 * Send a message to a specific tab's content script and await its response.
 * Used for background/options → content broadcasts (e.g. `settingsChanged`).
 */
export async function sendToTab<T extends MessageType>(
  tabId: number,
  type: T,
  ...rest: RequestOf<T> extends void ? [] : [payload: RequestOf<T>]
): Promise<ResponseOf<T>> {
  const msg = envelope(type, ...rest);
  return (await browser.tabs.sendMessage(tabId, msg)) as ResponseOf<T>;
}

/** A handler for one message type: receives the payload + the polyfill sender. */
export type MessageHandler<T extends MessageType> = (
  payload: RequestOf<T>,
  sender: browser.Runtime.MessageSender,
) => ResponseOf<T> | Promise<ResponseOf<T>>;

/** A partial map of handlers — a context only handles the messages it cares about. */
export type MessageHandlers = {
  [T in MessageType]?: MessageHandler<T>;
};

/**
 * Build a `runtime.onMessage` listener from a typed handler map.
 *
 * WHY return `undefined` (not a resolved Promise) for unhandled types: Firefox
 * dispatches every `onMessage` listener; returning a Promise from a listener
 * claims the message and suppresses other listeners' replies. Returning
 * `undefined` lets other listeners (or none) handle it — critical because
 * content, background, and popup may each register a router.
 *
 * Handler errors are caught and re-thrown as a rejected Promise so the sender's
 * `await` rejects instead of the listener dying silently.
 */
export function createMessageRouter(handlers: MessageHandlers) {
  return (
    message: unknown,
    sender: browser.Runtime.MessageSender,
  ): Promise<unknown> | undefined => {
    if (!isEnvelope(message)) return undefined;

    const handler = handlers[message.type] as
      | MessageHandler<MessageType>
      | undefined;
    if (!handler) return undefined;

    try {
      // Payload is `undefined` for void-request messages — handlers for those
      // simply ignore their first arg.
      const result = handler(
        (message as { payload?: unknown }).payload as RequestOf<MessageType>,
        sender,
      );
      return Promise.resolve(result);
    } catch (err) {
      log.warn(`handler for "${message.type}" threw`, err);
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };
}
