export const DEFAULT_FONT_SIZE_PX = 17;

export const parseFontSize = (v: string | null): number => (v ? parseInt(v, 10) : DEFAULT_FONT_SIZE_PX);
/** Link previews are on unless explicitly stored as '0'. */
export const parseLinkPreview = (v: string | null): boolean => v !== '0';
export const parseAutoSync = (v: string | null): string => v ?? 'off';
export const linkPreviewValue = (on: boolean): string => (on ? '1' : '0');
