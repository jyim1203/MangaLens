/**
 * Error toasts (Phase 7 item 6). Per-image ⚠ badges (Phase 5) mark WHICH image
 * failed; toasts surface the two *actionable* failures — a bad key and a
 * throttle — once, so the user doesn't have to hunt for a badge.
 *
 * Split as usual:
 *  - PURE, unit-tested: {@link toastPolicy} — only `auth` / `rate-limit` toast,
 *    each at most once per activation (10 images failing auth must not stack 10
 *    toasts). The "already toasted" set resets on gate re-activate (a fresh
 *    {@link ToastManager} per activation), so fixing the key and re-enabling
 *    gives fresh signal.
 *  - THIN shell: {@link ToastManager} — one shadow-root host per page, bottom
 *    corner, `pointer-events: none` except the toast card's ✕ / action button
 *    (the interactive bits §7.2 allows). Auto-dismiss + manual close.
 */
import { createLogger } from "../shared/log";
import { t } from "../shared/i18n";
import { errorKindToMessage } from "./overlay/errorMessages";
import { OVERLAY_HOST_ATTR } from "../shared/constants";
import type { ProviderErrorKind } from "../shared/types";

const log = createLogger("toast");

/** Only these two failures get a toast; everything else stays badge-only. */
const TOASTABLE: ReadonlySet<ProviderErrorKind> = new Set(["auth", "rate-limit"]);

/** A toast decision: render one, or stay quiet. */
export type ToastDecision = "show" | "skip";

/**
 * Decide whether to toast for `kind` given the kinds already toasted this
 * activation. Only `auth`/`rate-limit` are actionable enough to interrupt with;
 * each shows at most once (dedupe on kind), so a chapter full of auth failures
 * produces exactly one "check your API key" toast. Pure.
 *
 * @param kind the provider error kind of the failed request.
 * @param alreadyToasted kinds already shown since the last (re)activation.
 */
export function toastPolicy(
  kind: ProviderErrorKind,
  alreadyToasted: ReadonlySet<ProviderErrorKind>,
): ToastDecision {
  if (!TOASTABLE.has(kind)) return "skip";
  return alreadyToasted.has(kind) ? "skip" : "show";
}

/** Auto-dismiss delay for a toast (ms). */
const TOAST_TTL_MS = 8000;

/** Options for {@link ToastManager}. */
export interface ToastManagerOptions {
  /** Invoked by the `auth` toast's action button (content opens options via a message). */
  onOpenSettings?: () => void;
}

/**
 * Owns the page's toast host (one shadow root) and the per-activation dedupe set.
 * A fresh instance is created on gate activate and {@link stop}ped on deactivate,
 * so the dedupe set naturally resets per activation (see {@link toastPolicy}).
 */
export class ToastManager {
  private readonly onOpenSettings?: () => void;
  private readonly toasted = new Set<ProviderErrorKind>();
  private host: HTMLElement | undefined;
  private shadow: ShadowRoot | undefined;

  constructor(opts: ToastManagerOptions = {}) {
    this.onOpenSettings = opts.onOpenSettings;
  }

  /**
   * Show a toast for a failed translation if the policy allows (auth/rate-limit,
   * once each). The `auth` toast carries an "Open settings" action. Fail-soft:
   * any DOM error degrades to no toast, never a broken page.
   */
  showError(kind: ProviderErrorKind): void {
    if (toastPolicy(kind, this.toasted) !== "show") return;
    this.toasted.add(kind);
    const message =
      errorKindToMessage(kind) ??
      t("errorUnknown", undefined, "MangaLens: translation failed");
    try {
      this.mount({
        message,
        actionLabel:
          kind === "auth" && this.onOpenSettings
            ? t("toastOpenSettings", undefined, "Open settings")
            : undefined,
        onAction: kind === "auth" ? this.onOpenSettings : undefined,
      });
    } catch (err) {
      log.warn("failed to render toast", err);
    }
  }

  /**
   * Show a one-off notice toast (drag-select feedback: "no image under
   * selection", "can't access this image"). NOT policy-gated — these are
   * immediate feedback for a single user gesture, shown once by nature.
   */
  showMessage(message: string): void {
    try {
      this.mount({ message });
    } catch (err) {
      log.warn("failed to render toast", err);
    }
  }

  /** Remove the toast host and reset dedupe state (deactivate). */
  stop(): void {
    this.toasted.clear();
    try {
      this.host?.remove();
    } catch (err) {
      log.warn("failed to tear down toast host", err);
    }
    this.host = undefined;
    this.shadow = undefined;
  }

  // --- internals -----------------------------------------------------------

  /** Lazily create the fixed bottom-corner host + shadow root. */
  private ensureHost(): ShadowRoot {
    if (this.shadow) return this.shadow;
    const host = document.createElement("div");
    host.setAttribute(OVERLAY_HOST_ATTR, "toast"); // scanner skips our own hosts
    Object.assign(host.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      // Host is inert; only the toast cards inside opt back into pointer events.
      pointerEvents: "none",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      maxWidth: "320px",
    } satisfies Partial<CSSStyleDeclaration>);
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = TOAST_STYLES;
    shadow.appendChild(style);
    document.body.appendChild(host);
    this.host = host;
    this.shadow = shadow;
    return shadow;
  }

  /** Build and mount one toast card. */
  private mount(opts: {
    message: string;
    actionLabel?: string;
    onAction?: () => void;
  }): void {
    const shadow = this.ensureHost();

    const card = document.createElement("div");
    card.className = "mangalens-toast";

    const text = document.createElement("span");
    text.className = "mangalens-toast-text";
    text.textContent = opts.message;
    card.appendChild(text);

    if (opts.actionLabel && opts.onAction) {
      const action = document.createElement("button");
      action.className = "mangalens-toast-action";
      action.textContent = opts.actionLabel;
      action.addEventListener("click", () => {
        try {
          opts.onAction?.();
        } catch (err) {
          log.warn("toast action failed", err);
        }
      });
      card.appendChild(action);
    }

    const close = document.createElement("button");
    close.className = "mangalens-toast-close";
    close.textContent = "✕";
    close.setAttribute("aria-label", "Dismiss");
    const dismiss = (): void => card.remove();
    close.addEventListener("click", dismiss);
    card.appendChild(close);

    shadow.appendChild(card);
    // Auto-dismiss; harmless if the user already closed it.
    setTimeout(dismiss, TOAST_TTL_MS);
  }
}

/** Toast card styles, injected into the toast shadow root only. */
const TOAST_STYLES = `
.mangalens-toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  background: #2b2b31;
  color: #f2f2f5;
  border: 1px solid #45454f;
  border-radius: 8px;
  padding: 10px 12px;
  font: 13px/1.4 system-ui, sans-serif;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.mangalens-toast-text { flex: 1; }
.mangalens-toast-action {
  flex: none;
  border: 1px solid #6c74f2;
  background: #6c74f2;
  color: #17171c;
  border-radius: 5px;
  padding: 4px 8px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.mangalens-toast-close {
  flex: none;
  border: none;
  background: none;
  color: #b9b9c2;
  font: 14px/1 system-ui, sans-serif;
  cursor: pointer;
  padding: 0 2px;
}
`;
