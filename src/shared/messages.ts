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
import type { PageTranslation, ProviderErrorKind } from "./types";

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
  /** Absolute image URL the background will fetch with host permissions. */
  imageUrl: string;
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
  | { ok: false; errorKind: ProviderErrorKind; message: string };

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
   */
  cancelTranslation: { request: { requestId: string }; response: void };

  /** Validate an API key with a cheap ping (options "test key" button, §7.6). */
  testApiKey: {
    request: { provider: PageTranslation["provider"]; apiKey: string };
    response: TestKeyResult;
  };
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
