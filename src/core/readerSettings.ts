import type { KeyValueStore } from './ports';
import { parseAutoSync, parseFontSize, parseLinkPreview } from '../utils/readerSettings';

export interface ReaderSettings {
  /** Epoch ms of the last index refresh, or null when it never ran. */
  indexRefreshedAt: number | null;
  customCss: string;
  fontSize: number;
  /** 'off' | '2days' | 'weekly' */
  autoSync: string;
  linkPreview: boolean;
}

/** The settings that live as single meta rows, read and parsed together. */
export async function loadReaderSettings(meta: Pick<KeyValueStore, 'getMeta'>): Promise<ReaderSettings> {
  const [ts, css, font, auto, preview] = await Promise.all([
    meta.getMeta('index_refreshed_at'),
    meta.getMeta('custom_css'),
    meta.getMeta('font_size'),
    meta.getMeta('auto_sync'),
    meta.getMeta('link_preview'),
  ]);
  return {
    indexRefreshedAt: ts ? Number(ts) : null,
    customCss: css ?? '',
    fontSize: parseFontSize(font),
    autoSync: parseAutoSync(auto),
    linkPreview: parseLinkPreview(preview),
  };
}
