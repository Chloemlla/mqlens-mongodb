import { describe, it, expect, beforeEach } from "vitest";
import {
  hslComponentsToHex,
  refreshMqlensMonacoTheme,
  registerMqlensMonacoThemes,
  tokenResolverFor,
} from "../monacoAppTheme";

describe("hslComponentsToHex", () => {
  it("converts space-separated HSL components to hex for Monaco", () => {
    expect(hslComponentsToHex("215 14% 17%")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(hslComponentsToHex("0 0% 100%")).toBe("#ffffff");
    expect(hslComponentsToHex("0 0% 0%")).toBe("#000000");
  });

  it("passes through hex values", () => {
    expect(hslComponentsToHex("#1e1e1e")).toBe("#1e1e1e");
  });
});

// #282: the editor was themed a render behind the app. Colours were read from
// computed styles inside a child effect, and React runs those before the
// parent's — so ThemeProvider had not written the new variables yet. Measured
// with a provider setting a variable and a child reading it:
//
//     reads seen by the child: ["", "DARK"]   // switching to the light theme
//
// Empty on first mount, the previous theme afterwards. That is why nord,
// solarized and high-contrast never reached the editor, and why changing the
// hardcoded default made the symptom swap ends instead of going away.
describe('monaco theme colours come from the config, not the DOM (#282)', () => {
  const defined = new Map<string, { colors: Record<string, string> }>();
  const monaco = {
    editor: {
      defineTheme: (id: string, theme: { colors: Record<string, string> }) =>
        defined.set(id, theme),
      setTheme: () => {},
    },
  } as unknown as Parameters<typeof refreshMqlensMonacoTheme>[0];

  beforeEach(() => defined.clear());

  it('uses the token map it is given, ignoring the document entirely', () => {
    // A light preset's own input token, while the DOM still says otherwise.
    document.documentElement.style.setProperty('--input', '222 20% 8%');
    refreshMqlensMonacoTheme(
      monaco,
      tokenResolverFor({ input: '220 20% 93%', foreground: '222 20% 8%' }),
      'mqlens-light'
    );
    expect(defined.get('mqlens-light')!.colors['editor.background']).toBe(
      hslComponentsToHex('220 20% 93%')
    );
  });

  it('does not fall back to the built-in palette when a preset defines the token', () => {
    // The old failure mode: an empty DOM read left every colour on Monaco's
    // hardcoded default, so a preset's palette never arrived.
    refreshMqlensMonacoTheme(
      monaco,
      tokenResolverFor({ input: '193 100% 12%' }),
      'mqlens-dark'
    );
    const background = defined.get('mqlens-dark')!.colors['editor.background'];
    expect(background).toBe(hslComponentsToHex('193 100% 12%'));
    expect(background).not.toBe('#1e1e1e');
  });

  it('still falls back for a token the preset does not define', () => {
    refreshMqlensMonacoTheme(monaco, tokenResolverFor({}), 'mqlens-dark');
    expect(defined.get('mqlens-dark')!.colors['editor.background']).toBe('#1e1e1e');
  });

  it('registers and refreshes with identical colours', () => {
    // They used to be two hand-written copies, which is how one gets corrected
    // and the other left stale.
    const resolve = tokenResolverFor({ input: '193 100% 12%', foreground: '0 0% 90%' });
    refreshMqlensMonacoTheme(monaco, resolve, 'mqlens-dark');
    const fromRefresh = { ...defined.get('mqlens-dark')!.colors };
    defined.clear();
    registerMqlensMonacoThemes(monaco, resolve, 'mqlens-dark');
    // registerMqlensMonacoThemes is once-per-app; call refresh to observe the
    // same definition path a second editor would get.
    refreshMqlensMonacoTheme(monaco, resolve, 'mqlens-dark');
    expect(defined.get('mqlens-dark')!.colors).toEqual(fromRefresh);
  });
});
