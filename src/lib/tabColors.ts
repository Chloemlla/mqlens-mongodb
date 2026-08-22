export const TAB_COLORS = [
  { id: 'slate', hue: 215, saturation: 16, lightness: 47 },
  { id: 'red', hue: 0, saturation: 45, lightness: 55 },
  { id: 'orange', hue: 28, saturation: 48, lightness: 52 },
  { id: 'amber', hue: 45, saturation: 46, lightness: 50 },
  { id: 'green', hue: 145, saturation: 38, lightness: 45 },
  { id: 'blue', hue: 210, saturation: 45, lightness: 55 },
  { id: 'violet', hue: 270, saturation: 38, lightness: 58 },
] as const;

export type TabColorId = typeof TAB_COLORS[number]['id'];
export type TabColorMap = Record<string, TabColorId>;
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
const STORAGE_KEY = 'mqlens-tab-colors';
const validIds = new Set<string>(TAB_COLORS.map(color => color.id));

export const tabColorCss = (id: TabColorId): string => {
  const color = TAB_COLORS.find(candidate => candidate.id === id)!;
  return `hsl(${color.hue}, ${color.saturation}%, ${color.lightness}%)`;
};

export function loadTabColors(storage: StorageLike = localStorage): TabColorMap {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, TabColorId] =>
        typeof entry[1] === 'string' && validIds.has(entry[1]))
    );
  } catch {
    return {};
  }
}

export function saveTabColor(
  stableTabId: string,
  color: TabColorId | undefined,
  storage: StorageLike = localStorage,
): TabColorMap {
  const next = { ...loadTabColors(storage) };
  if (color) next[stableTabId] = color;
  else delete next[stableTabId];
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Keep the in-memory choice when storage is unavailable.
  }
  return next;
}
