import type { BootstrapResponse } from '../types/tracker';

export const INITIAL_STATE_GLOBAL_KEY = '__PRICEPULSE_INITIAL_STATE__';
export const INITIAL_STATE_SCRIPT_ID = '__pricepulse_initial_state__';

export interface InitialAuthState {
  configured: boolean;
  authenticated: boolean;
  username: string | null;
}

export interface InitialAppState {
  auth: InitialAuthState;
  bootstrap: BootstrapResponse | null;
}

/**
 * Enforce strict privacy invariant: unauthenticated payloads can never include
 * username or bootstrap data.
 */
export function sanitizeInitialAppState(state: InitialAppState): InitialAppState {
  const configured = Boolean(state?.auth?.configured);
  const authenticated = Boolean(state?.auth?.authenticated && state?.auth?.username);
  if (!authenticated) {
    return {
      auth: {
        configured,
        authenticated: false,
        username: null,
      },
      bootstrap: null,
    };
  }

  return {
    auth: {
      configured: true,
      authenticated: true,
      username: state.auth.username,
    },
    bootstrap: state.bootstrap ?? null,
  };
}

/**
 * Serialize initial state safely for embedding inside an inline <script> tag.
 * Escapes HTML/script breakout characters and JS line separators.
 */
export function serializeInitialAppState(state: InitialAppState): string {
  const safeState = sanitizeInitialAppState(state);
  return JSON.stringify(safeState).replace(/[<>&\u2028\u2029]/g, (ch) => {
    switch (ch) {
      case '<':
        return '\\u003c';
      case '>':
        return '\\u003e';
      case '&':
        return '\\u0026';
      case '\u2028':
        return '\\u2028';
      case '\u2029':
        return '\\u2029';
      default:
        return ch;
    }
  });
}

/**
 * Inject the serialized initial state script into index.html before </head>
 * using a function replacer so '$' sequences in product titles/prices never
 * trigger String.prototype.replace substitution patterns.
 */
export function injectInitialStateIntoHtml(html: string, state: InitialAppState): string {
  const serialized = serializeInitialAppState(state);
  const scriptTag = `<script id="${INITIAL_STATE_SCRIPT_ID}">window.${INITIAL_STATE_GLOBAL_KEY}=${serialized};</script>`;

  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, () => `    ${scriptTag}\n  </head>`);
  }

  return `${scriptTag}\n${html}`;
}

function isValidInitialAppState(value: unknown): value is InitialAppState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (!candidate.auth || typeof candidate.auth !== 'object') return false;
  const auth = candidate.auth as Record<string, unknown>;
  if (typeof auth.configured !== 'boolean' || typeof auth.authenticated !== 'boolean') {
    return false;
  }
  if (auth.username !== null && typeof auth.username !== 'string') {
    return false;
  }
  if (candidate.bootstrap !== null && typeof candidate.bootstrap !== 'object') {
    return false;
  }
  return true;
}

/**
 * Read and immediately clear the server-injected initial state from window
 * (or an explicit target object in unit tests).
 */
export function consumeInitialAppState(
  target?: Record<string, unknown> | null
): InitialAppState | null {
  const container: Record<string, unknown> | null =
    target !== undefined
      ? target
      : typeof window !== 'undefined'
        ? (window as unknown as Record<string, unknown>)
        : null;

  if (!container) return null;

  const raw = container[INITIAL_STATE_GLOBAL_KEY];
  if (raw === undefined) return null;

  try {
    delete container[INITIAL_STATE_GLOBAL_KEY];
  } catch {
    container[INITIAL_STATE_GLOBAL_KEY] = undefined;
  }

  if (typeof document !== 'undefined' && target === undefined) {
    const scriptEl = document.getElementById(INITIAL_STATE_SCRIPT_ID);
    if (scriptEl && scriptEl.parentNode) {
      scriptEl.parentNode.removeChild(scriptEl);
    }
  }

  if (!isValidInitialAppState(raw)) return null;
  return sanitizeInitialAppState(raw);
}
