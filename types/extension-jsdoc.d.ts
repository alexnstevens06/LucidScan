/** JSDoc types for chrome_plugin/content.js. Not loaded by the extension. */

interface LucidStats {
  alive: boolean;
  badgesActive: boolean;
  listeners: number;
  chromeListeners: number;
  timers: number;
  badges: number;
  badgeTexts: Array<string | null>;
  badgesBySrc: Array<Array<string | null>>;
  historyPatched: boolean;
}

interface LucidInstance {
  alive: boolean;
  destroy: (() => void) | null;
  stats: (() => LucidStats) | null;
}

type LucidGlobal = typeof globalThis & {
  __lucidScanInstance?: LucidInstance | null;
  __lucidScanContentLoaded?: boolean;
};

interface TrackedListener {
  target: EventTarget;
  type: string;
  fn: EventListener;
  opts?: boolean | AddEventListenerOptions;
}

interface TrackedChromeListener {
  event: any;
  fn: any;
}

interface BadgeMount {
  host: HTMLElement;
  root: ShadowRoot;
  pill: HTMLElement;
}

interface ModelScore {
  score?: number;
  label?: string;
  state?: string;
  mode?: string;
  cached?: boolean;
  device?: string | null;
  model?: string;
  reason?: string;
  progress?: number | null;
  error?: string;
}

interface InferenceOverrides {
  inferenceMode?: string | null;
  forceMock?: boolean | null;
  autoWarmup?: boolean;
}

interface LoadProgress {
  which: string | null;
  status: string;
  percent: number | null;
  file: string | null;
  message: string | null;
}

interface TextClassRow {
  label?: string;
  score?: number;
}

interface LastScan {
  label?: string;
  contentType?: string;
  confidence?: number | null;
}

interface ModelStatus {
  mode?: string;
  text?: string | { status?: string };
  image?: string | { status?: string };
  textDevice?: string;
  imageDevice?: string;
  ok?: boolean;
  cancelled?: boolean;
  progress?: {
    status?: string;
    percent?: number | null;
    message?: string | null;
  } | null;
}

interface ScoreResult {
  state?: string;
  label?: string;
  score?: number;
  mode?: string;
  heuristics?: unknown;
  fallbackReason?: string;
  reason?: string;
  error?: string;
  progress?: number;
  id?: string;
  type?: string;
}
