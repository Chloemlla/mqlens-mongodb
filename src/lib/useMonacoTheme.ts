import { useEffect, useMemo, useState } from "react";
import { useThemeOptional } from "@/hooks/use-theme";
import { scaleEditorFontSize, EDITOR_FONT_BASELINE_PX } from "./themes/ui-scale";
import {
  getMqlensMonacoThemeId,
  type MqlensMonacoThemeId,
} from "./monacoAppTheme";

/**
 * Re-render on window resize. computeEffectiveUiScale() folds in an auto DPI /
 * viewport term, and ThemeProvider recomputes the CSS variables on resize — so
 * without this the CSS side stays live while these memoized px values freeze,
 * leaving Monaco a few percent out of step with the surrounding UI text until
 * the editor remounts.
 */
function useResizeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return tick;
}

function resolveThemeId(resolvedMode?: "dark" | "light"): MqlensMonacoThemeId {
  if (resolvedMode === "light") return "mqlens-light";
  if (resolvedMode === "dark") return "mqlens-dark";
  return getMqlensMonacoThemeId();
}

/** Monaco theme id — driven by ThemeProvider, no DOM observers. */
export function useMonacoTheme(): MqlensMonacoThemeId {
  const themeCtx = useThemeOptional();
  return useMemo(
    () => resolveThemeId(themeCtx?.resolvedMode),
    [themeCtx?.resolvedMode]
  );
}

/**
 * Monaco font size that follows the interface font-size setting and zoom.
 * Monaco needs an absolute px number and can't read the CSS variables the rest
 * of the UI scales with, so editors would otherwise stay one fixed size while
 * everything around them grew or shrank. Pass the size the editor should use at
 * the default 13px root font; the hook returns it scaled to current settings.
 * Derived from the theme config (not the CSS vars) so it can't read a stale
 * value on the render where the setting changes.
 */
/**
 * The factor the interface is scaled by (font-size setting × zoom × DPI). The
 * CSS side gets this for free through rem units, but Monaco needs plain px
 * numbers for height/padding, so those have to be scaled by hand or the editor
 * box stays fixed while its row grows.
 */
export function useMonacoScale(): number {
  const themeCtx = useThemeOptional();
  const rootFontSize = themeCtx?.config.fontSize;
  const uiZoom = themeCtx?.config.uiZoom;
  const resizeTick = useResizeTick();
  return useMemo(
    () => scaleEditorFontSize(EDITOR_FONT_BASELINE_PX, rootFontSize, uiZoom) / EDITOR_FONT_BASELINE_PX,
    [rootFontSize, uiZoom, resizeTick]
  );
}

export function useMonacoFontSize(baseAt13px: number): number {
  const themeCtx = useThemeOptional();
  const rootFontSize = themeCtx?.config.fontSize;
  const uiZoom = themeCtx?.config.uiZoom;
  const resizeTick = useResizeTick();
  return useMemo(
    () => scaleEditorFontSize(baseAt13px, rootFontSize, uiZoom),
    [baseAt13px, rootFontSize, uiZoom, resizeTick]
  );
}
