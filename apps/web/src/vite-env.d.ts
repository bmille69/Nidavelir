/// <reference types="vite/client" />

/** Posé par le preload de l'application de bureau (apps/desktop/preload.cjs) ; absent dans un navigateur. */
interface Window {
  nidavellir?: { desktop: true; material: string; restart?: () => void };
}
