import { createContext, useContext } from 'react';

/**
 * The per-response CSP nonce. `secureHeaders` mints one per request; `renderPage` puts it
 * in this context; every inline `<script>` in a page reads it back. An inline script
 * without it is blocked by the browser — which is the point: an injected one is too.
 */
export const NonceContext = createContext<string | undefined>(undefined);

export const useNonce = (): string | undefined => useContext(NonceContext);
