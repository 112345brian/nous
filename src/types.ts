export interface EntryRow {
  slug: string;
  title: string;
  parent_label: string | null;
  source: string;
  author: string | null;
  pub_date: string | null;
  content_hash: string | null;
  toc_html: string | null;
  preamble_html: string | null;
  content_html: string | null;
  notes_html: string | null;
  content_ast: string | null;
  has_math: number | null;
  word_count: number;
  cached_at: number | null;
}

export interface EntrySummary {
  slug: string;
  title: string;
  parent_label?: string | null;
  author: string | null;
  cached_at: number | null;
  read_progress?: number | null;   // 0..1 fraction read
  annotation_count?: number;        // notes on this entry
  excerpt?: string | null;          // plain-text snippet for home rows
}

export interface ReadRow {
  id: number;
  slug: string;
  title: string;
  visited_at: number;
  from_slug: string | null;
  session_id: string;
}

export interface ReadNode extends ReadRow {
  depth: number;
  children: ReadNode[];
}

export interface Session {
  session_id: string;
  started_at: number;
  roots: ReadNode[];
  total: number;
}

export interface Annotation {
  id: number;
  /** Cross-device identity (sync); absent in rows from before the uid migration or v1 sync files. */
  uid?: string | null;
  slug: string;
  selected_text: string;
  context: string | null;
  note: string | null;
  color: string;
  content_hash: string | null;
  created_at: number;
  updated_at: number;
}

export interface GraphNode {
  slug: string; title: string; read: boolean;
  readProgress?: number; // 0–1; ≥ 0.9 = fully read, > 0 = in progress, 0/absent = unvisited
  // 'entry' = the centred article; 'idea'/'thinker' = InPhO nodes;
  // 'linked' = a neighbouring entry in the SEP hyperlink graph.
  kind?: 'entry' | 'idea' | 'thinker' | 'linked';
  birthYear?: number | null; deathYear?: number | null; // Timeline view
}
export interface GraphEdge { from_slug: string; to_slug: string; weight?: number; }

/** One row of the entry index (title list): what the index page and the bundled seed provide. */
export interface IndexEntry {
  slug: string;
  title: string;
  parent_label?: string | null;
}

/** Which part of the library an operation covers: SEP entries, OWL entries, or both. */
export type LibraryScope = 'all' | 'sep' | 'owl';

/** An entry as the download and sync loops see it. */
export interface EntryRef { slug: string; title: string }

/** Progress of a bulk download or sync. */
export type DownloadProgress = {
  done: number;
  total: number;
  current: string;
};

// ── Shapes the UI-facing stores return (see the stores in src/core/ports.ts) ──

/** First-run and settings preferences, kept in the `meta` table. */
export interface Prefs {
  homeMode: 'search' | 'continue';
  downloadAll: boolean;
  libraryScope: LibraryScope;
  seedUrl: string;
}

/** A reading-list row: the bookmark joined with what the entries table knows about it. */
export interface BookmarkRow {
  slug: string;
  title: string;
  saved_at: number;
  notes: string | null;
  author: string | null;
  pub_date: string | null;
  cached_at: number | null;
}

/** A highlight with the title of its article (null when the entry is not in the library). */
export interface AnnotationWithTitle extends Annotation {
  article_title: string | null;
}

// ── Knowledge graph (InPhO + SEP link graph) ─────────────────────────────────

export interface GraphData { nodes: GraphNode[]; edges: GraphEdge[]; }

export interface InphoNodeRow {
  id: number; kind: 'idea' | 'thinker'; label: string; sep_dir: string | null;
  birth_year?: number | null; death_year?: number | null;
}
export interface InphoInfluence { teachers: number[]; students: number[]; influenced: number[]; influenced_by: number[]; }
export interface InphoRelations { ideas: number[]; thinkers: number[]; influence?: InphoInfluence; }

/** InPhO semantic-graph modes. */
export type GraphMode = 'related' | 'timeline' | 'influence';
/** The views the graph screen toggles between: the SEP hyperlink graph plus the InPhO modes. */
export type GraphView = 'links' | GraphMode;

/** A settled layout position as a 0-1 fraction of the canvas, so it survives rotation. */
export interface CachedPosition { slug: string; xRel: number; yRel: number; }
