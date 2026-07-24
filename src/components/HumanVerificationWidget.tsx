import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  capWasmEndpoint,
  capWidgetEndpoint,
  featureNeedsVerification,
  fetchHumanVerificationConfig,
  type HumanVerificationConfig,
  type HumanVerificationFeature,
} from "../lib/humanVerification";
import { useTheme } from "../hooks/useTheme";

type TurnstileWidgetId = string;
type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => TurnstileWidgetId;
  reset: (id?: TurnstileWidgetId) => void;
  remove: (id: TurnstileWidgetId) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    CAP_CUSTOM_WASM_URL?: string;
  }
}

let turnstileScript: Promise<void> | null = null;
function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!turnstileScript) {
    turnstileScript = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Turnstile script failed"));
      document.head.appendChild(script);
    });
  }
  return turnstileScript;
}

let capWidgetLoader: Promise<unknown> | null = null;
function loadCapWidget(): Promise<unknown> {
  if (!capWidgetLoader) capWidgetLoader = import("@cap.js/widget");
  return capWidgetLoader;
}

export interface HumanVerificationHandle {
  reset: () => void;
}

export interface HumanVerificationState {
  required: boolean;
  ready: boolean;
  provider: HumanVerificationConfig["provider"];
}

interface Props {
  feature: HumanVerificationFeature;
  onToken: (token: string) => void;
  onStateChange?: (state: HumanVerificationState) => void;
  className?: string;
}

/**
 * A small imperative wrapper around either Turnstile or Cap. The page only
 * deals with a token and a required/ready state; provider-specific lifecycle
 * details stay here.
 */
export const HumanVerificationWidget = forwardRef<HumanVerificationHandle, Props>(function HumanVerificationWidget(
  { feature, onToken, onStateChange, className = "" },
  ref,
) {
  const { resolved: theme } = useTheme();
  const [config, setConfig] = useState<HumanVerificationConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [widgetReady, setWidgetReady] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const turnstileIdRef = useRef<TurnstileWidgetId | null>(null);
  const capElementRef = useRef<HTMLElement | null>(null);
  const onTokenRef = useRef(onToken);
  const onStateChangeRef = useRef(onStateChange);
  onTokenRef.current = onToken;
  onStateChangeRef.current = onStateChange;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setWidgetReady(false);
    onTokenRef.current("");
    void fetchHumanVerificationConfig().then((next) => {
      if (cancelled) return;
      setConfig(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [feature]);

  const required = !!config && featureNeedsVerification(config, feature);

  useEffect(() => {
    onStateChangeRef.current?.({
      required,
      ready: !loading && (!required || widgetReady),
      provider: config?.provider ?? "off",
    });
  }, [config, loading, required, widgetReady]);

  useImperativeHandle(ref, () => ({
    reset() {
      onTokenRef.current("");
      if (turnstileIdRef.current && window.turnstile) {
        try {
          window.turnstile.reset(turnstileIdRef.current);
        } catch {
          /* provider cleanup is best effort */
        }
      }
      const cap = capElementRef.current as (HTMLElement & { reset?: () => void }) | null;
      try {
        cap?.reset?.();
      } catch {
        /* provider cleanup is best effort */
      }
    },
  }), []);

  useEffect(() => {
    if (!config || !required || !config.configured || !containerRef.current) {
      setWidgetReady(!required);
      return;
    }

    let cancelled = false;
    const container = containerRef.current;
    container.replaceChildren();
    onTokenRef.current("");
    setWidgetReady(false);

    const cleanup = () => {
      if (turnstileIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(turnstileIdRef.current);
        } catch {
          /* ignore */
        }
        turnstileIdRef.current = null;
      }
      capElementRef.current?.remove();
      capElementRef.current = null;
      if (container) container.replaceChildren();
    };

    if (config.provider === "turnstile") {
      loadTurnstileScript()
        .then(() => {
          if (cancelled || !containerRef.current || !window.turnstile) return;
          turnstileIdRef.current = window.turnstile.render(containerRef.current, {
            sitekey: config.turnstileSiteKey,
            theme,
            callback: (token: string) => onTokenRef.current(token),
            "expired-callback": () => onTokenRef.current(""),
            "error-callback": () => onTokenRef.current(""),
          });
          if (!cancelled) setWidgetReady(true);
        })
        .catch(() => {
          if (!cancelled) setWidgetReady(false);
        });
    } else if (config.provider === "cap") {
      // Set this before importing the widget: the package starts preloading
      // WASM at module evaluation time. The URL points at our Cap asset server,
      // so the browser never has to reach jsDelivr for the solver.
      const wasmUrl = capWasmEndpoint(config);
      if (wasmUrl) window.CAP_CUSTOM_WASM_URL = wasmUrl;
      loadCapWidget()
        .then(() => {
          if (cancelled || !containerRef.current) return;
          const widget = document.createElement("cap-widget");
          widget.setAttribute("data-cap-api-endpoint", capWidgetEndpoint(config));
          widget.setAttribute("data-cap-disable-haptics", "");
          widget.setAttribute("data-cap-i18n-initial-state", "确认你是真人");
          widget.setAttribute("data-cap-i18n-verifying-label", "正在验证…");
          widget.setAttribute("data-cap-i18n-solved-label", "验证通过");
          widget.setAttribute("data-cap-i18n-error-label", "验证失败，请重试");
          widget.setAttribute("data-cap-i18n-verify-aria-label", "点击确认你是真人");
          widget.setAttribute("data-cap-i18n-verifying-aria-label", "正在验证，请稍候");
          widget.setAttribute("data-cap-i18n-verified-aria-label", "已确认你是真人");
          widget.setAttribute("data-cap-i18n-required-label", "请先完成人机验证");
          widget.style.setProperty("--cap-font", "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif");
          widget.addEventListener("solve", (event) => {
            const token = (event as CustomEvent<{ token?: string }>).detail?.token;
            onTokenRef.current(typeof token === "string" ? token : "");
          });
          widget.addEventListener("reset", () => onTokenRef.current(""));
          widget.addEventListener("error", () => onTokenRef.current(""));
          capElementRef.current = widget;
          containerRef.current.appendChild(widget);
          if (!cancelled) setWidgetReady(true);
        })
        .catch(() => {
          if (!cancelled) setWidgetReady(false);
        });
    }

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [config, required, theme]);

  if (!required) return null;

  return (
    <div className={`flex flex-col items-center gap-1.5 ${className}`}>
      <div ref={containerRef} className="min-h-[66px] flex items-center justify-center" />
      {loading && <span className="text-[11px] text-gray-400">正在加载人机验证…</span>}
      {!loading && !widgetReady && <span className="text-[11px] text-rose-500">人机验证加载失败，请刷新页面重试</span>}
    </div>
  );
});
