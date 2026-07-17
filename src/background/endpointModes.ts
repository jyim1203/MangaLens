/**
 * Persistent request-shape memos the providers learn from 400s (Phase 8 §4 +
 * the Anthropic sampling memo it was extended to in the Phase 8.1 live pass):
 *
 *  1. The OpenAI-compatible structured-output mode per endpoint (PROMPTS §5.2,
 *     deferred from Phase 6). An endpoint that 400s on `json_schema` is
 *     downgraded to `json_object` once; remembering that avoids re-paying the
 *     failed round trip on every later request.
 *  2. Which Anthropic models reject sampling params (`temperature` 400s on
 *     Claude 4.6+). Phase 3.1 memoized this in a module-level set, which
 *     re-paid one 400 per model on EVERY event-page restart — Firefox unloads
 *     the event page after ~30 s idle, so a normal reading session pays it over
 *     and over (and at concurrency 6 a fresh page can pay several in parallel
 *     before the first response lands). Persisting it kills the recurring 400.
 *
 * WHY a SEPARATE `storage.local` key per memo and NOT `Settings`: a settings
 * write broadcasts to every tab and re-runs the content gate classification;
 * these are pure background-internal state with no UI surface, so keeping them
 * out of `SettingsPatch` avoids schema/migration churn and needless tab work.
 *
 * The in-memory map is the synchronous source of truth the provider reads/
 * writes during a request (buildRequest/downgrade are sync). Persistence is a
 * fail-soft overlay: hydrate once per event-page lifetime, write through on
 * each learn. A storage fault just re-pays one 400 — never breaks a request
 * (handoff rule 6).
 */
import browser from "webextension-polyfill";
import { isPlainObject } from "../shared/guards";
import { createLogger } from "../shared/log";

const log = createLogger("endpoint-modes");

/** A synchronous in-memory memo with fail-soft `storage.local` persistence. */
interface PersistedMemo<V> {
  /** The remembered value for `key`, or undefined (unlearned). Sync. */
  get(key: string): V | undefined;
  /** Learn `key → value`: effective IMMEDIATELY in-memory, persisted async. */
  learn(key: string, value: V): void;
  /** Hydrate from storage once per lifetime (idempotent, memoized promise). */
  load(): Promise<void>;
  /** Forget everything and allow a fresh hydrate — test seam. */
  reset(): void;
}

/**
 * Build one persisted memo over its own `storage.local` key.
 *
 * WHY the hydrate latches on the PROMISE, not a boolean: a boolean flips
 * synchronously before the startup `storage.get` resolves, so a `learn` racing
 * the hydrate would see "hydrated" and persist a memo still missing the
 * previous lifetime's entries — clobbering storage until the next learn.
 * Awaiting the promise makes the write-through wait for the merge, so persist
 * always writes the union (fail-soft: a lost memo just re-pays one 400).
 *
 * WHY hydrate-before-persist in `learn`: a bare `set(storage)` would CLOBBER
 * entries learned in a previous lifetime if the memo wasn't hydrated yet;
 * hydrating first merges the stored entries in, so persist writes the union,
 * not just this one key. The hydrate only fills keys NOT already learned this
 * lifetime, so a fresh learn is never overwritten by a staler stored value.
 *
 * @param storageKey the memo's own `storage.local` key.
 * @param isValid value guard applied to each stored entry on hydrate (corrupt
 *   entries are skipped; corrupt/absent storage heals to the in-memory state).
 * @param label log prefix for the fail-soft warnings.
 */
function createPersistedMemo<V>(
  storageKey: string,
  isValid: (value: unknown) => value is V,
  label: string,
): PersistedMemo<V> {
  const memo = new Map<string, V>();
  let hydrating: Promise<void> | undefined;

  async function hydrateOnce(): Promise<void> {
    try {
      const raw = (await browser.storage.local.get(storageKey))[storageKey];
      if (isPlainObject(raw)) {
        for (const [key, value] of Object.entries(raw)) {
          if (isValid(value) && !memo.has(key)) memo.set(key, value);
        }
      }
    } catch (err) {
      log.warn(`${label} load failed — running un-memoized`, err);
    }
  }

  /** Write the whole memo to storage (fail-soft — a fault just loses persistence). */
  async function persist(): Promise<void> {
    try {
      await browser.storage.local.set({ [storageKey]: Object.fromEntries(memo) });
    } catch (err) {
      log.warn(`${label} write failed`, err);
    }
  }

  function load(): Promise<void> {
    if (!hydrating) hydrating = hydrateOnce();
    return hydrating;
  }

  return {
    get: (key) => memo.get(key),
    learn(key, value) {
      memo.set(key, value);
      void load()
        .then(() => persist())
        .catch((err) => log.debug(`${label} persist skipped`, err));
    },
    load,
    reset() {
      memo.clear();
      hydrating = undefined;
    },
  };
}

// --- Memo 1: OpenAI-compatible structured-output mode per endpoint (§4) -----

/** `storage.local` key holding the persisted per-endpoint modes. */
export const ENDPOINT_MODES_KEY = "mangalens:endpoint-modes";

/** Structured-output delivery mode for an OpenAI-compatible endpoint. */
export type EndpointMode = "json_schema" | "json_object";

const endpointModes = createPersistedMemo<EndpointMode>(
  ENDPOINT_MODES_KEY,
  (value): value is EndpointMode => value === "json_schema" || value === "json_object",
  "endpoint-mode",
);

/** The remembered mode for `baseUrl`, or undefined (use the requested default). */
export function getEndpointMode(baseUrl: string): EndpointMode | undefined {
  return endpointModes.get(baseUrl);
}

/** Learn that `baseUrl` needs `mode` (called from the 400 downgrade). */
export function learnEndpointMode(baseUrl: string, mode: EndpointMode): void {
  endpointModes.learn(baseUrl, mode);
}

/** Hydrate the endpoint-mode memo (call at background startup). */
export function loadEndpointModes(): Promise<void> {
  return endpointModes.load();
}

/**
 * Forget every remembered endpoint mode and allow a fresh hydrate — test seam
 * (preserves the pre-Phase-8 `resetEndpointModes` name openai.ts re-exports).
 * Production has no caller.
 */
export function resetEndpointModes(): void {
  endpointModes.reset();
}

// --- Memo 2: Anthropic models that reject sampling params --------------------

/** `storage.local` key holding the models observed to reject sampling params. */
export const SAMPLING_REJECT_KEY = "mangalens:sampling-reject";

const samplingReject = createPersistedMemo<true>(
  SAMPLING_REJECT_KEY,
  (value): value is true => value === true,
  "sampling-reject",
);

/** Whether `model` is remembered to reject sampling params (omit temperature). */
export function isSamplingRejected(model: string): boolean {
  return samplingReject.get(model) === true;
}

/** Learn that `model` rejects sampling params (called from the 400 downgrade). */
export function learnSamplingRejected(model: string): void {
  samplingReject.learn(model, true);
}

/** Hydrate the sampling-rejection memo (call at background startup). */
export function loadSamplingMemo(): Promise<void> {
  return samplingReject.load();
}

/**
 * Forget every remembered sampling rejection and allow a fresh hydrate — test
 * seam (preserves the pre-Phase-8 `resetSamplingMemo` name anthropic.ts
 * re-exports). Production has no caller.
 */
export function resetSamplingMemo(): void {
  samplingReject.reset();
}
