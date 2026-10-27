/** Icônes au trait (24 × 24), dessinées ici : aucune bibliothèque, rendu net à toutes les tailles. */
const PATHS = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  live: "M2 12h4l3-8 4 16 3-8h6",
  sparkle: "M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  download: "M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
  chart: "M4 20V10m6 10V4m6 16v-7m6 7H2",
  puzzle: "M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3z",
  phone: "M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm3 17h2",
  chat: "M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z",
  book: "M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5zm0 0v17M8 7h8",
  hammer: "M14 5l5 5-2 2-5-5zm-1 1L4 15l3 3 9-9M2 22l3-3",
  scale: "M12 3v18m-7 0h14M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zm14 0-3 7a3 3 0 0 0 6 0z",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M6 6l12 12M18 6 6 18",
  image: "M4 5h16v14H4zm0 11 5-5 4 4 2-2 5 5M15.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
  plus: "M12 5v14M5 12h14",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  play: "M7 4.5v15l12-7.5z",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zm4 4a2 2 0 0 0 4 0",
  check: "M5 12.5l4.5 4.5L19 7.5",
  folder: "M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  clock: "M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  palette: "M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4.1-4-7.2-9-7.2zM7.5 12.5h.01M9.5 8h.01M14.5 8h.01M17 11.5h.01",
  upload: "M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
  cube: "M12 2 3 7v10l9 5 9-5V7zm0 0v0M3 7l9 5 9-5M12 12v10",
  copy: "M9 9h10v12H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 3-4.2-4.2",
  motion: "M3 12h3m3 0h3m3 0h6M14 7l5 5-5 5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={`icon ${className ?? ""}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
