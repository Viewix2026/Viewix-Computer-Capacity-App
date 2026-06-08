// ════════════════════════════════════════════════════════════════════
// Icon — the unified 24px line-icon set (stroke 1.7) from the Viewix
// design language. Replaces the emoji sidebar glyphs and gives every
// tab/component one consistent icon vocabulary.
// ════════════════════════════════════════════════════════════════════

export const ICON_PATHS = {
  // nav
  home:      "M3 11.2 12 4l9 7.2M5.5 9.6V19a1 1 0 0 0 1 1H10v-5h4v5h3.5a1 1 0 0 0 1-1V9.6",
  founders:  "M3 9 12 4l9 5M5 9v9M19 9v9M9 9v9M15 9v9M3.5 19.5h17",
  capacity:  "M4 20V12M9.3 20V6M14.6 20v-5.5M20 20V9M3 20.2h18",
  sale:      "M12 2.5v19M16 6.2H9.8a3 3 0 0 0 0 6h4.4a3 3 0 0 1 0 6H7",
  nurture:   "M12 21v-8M12 13c0-3.2-2.2-5.4-5.4-5.4H3.6C3.6 10.8 5.8 13 9 13zM12 11c0-3.2 2.2-6 5.4-6h2.8c0 3.2-2.2 6-5.4 6z",
  accounts:  "M16.5 19.5v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9.2 10.4a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM22 19.5v-1a4 4 0 0 0-3-3.86M16.4 3.6a3.5 3.5 0 0 1 0 6.78",
  projects:  "M12 3.2 21 8l-9 4.8L3 8zM3.2 13 12 17.6 20.8 13M3.2 17.4 12 22l8.8-4.6",
  analytics: "M3.5 16.5 9 11l4 4 7.5-7.5M21 7.5h-4M21 7.5v4",
  socials:   "M9.5 13.2a3.8 3.8 0 0 0 5.4 0l2.8-2.8a3.8 3.8 0 0 0-5.4-5.4l-1.4 1.4M14.5 10.8a3.8 3.8 0 0 0-5.4 0l-2.8 2.8a3.8 3.8 0 0 0 5.4 5.4l1.4-1.4",
  preprod:   "M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17.2 4 20zM13.6 6.6l2.8 2.8",
  editors:   "M3.2 8 21 4.8M3.2 8v11a1 1 0 0 0 1 1h15.6a1 1 0 0 0 1-1V8H3.2zM7.5 5.1 9 8M12.3 4.2 13.8 7M17.1 3.3 18.6 6",
  training:  "M2.5 9 12 5l9.5 4-9.5 4zM6.5 11.2V16c0 1.1 2.5 2.5 5.5 2.5s5.5-1.4 5.5-2.5v-4.8M21.5 9.4V14",
  users:     "M19 20v-1a5 5 0 0 0-5-5h-4a5 5 0 0 0-5 5v1M12 11.2a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2z",
  resources: "M12 6.2C10.4 5.1 8 4.6 5.8 4.6H3v13h2.8c2.2 0 4.6.5 6.2 1.6M12 6.2c1.6-1.1 4-1.6 6.2-1.6H21v13h-2.8c-2.2 0-4.6.5-6.2 1.6M12 6.2V19.2",
  // utility
  search:    "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM21 21l-4.4-4.4",
  bell:      "M18 8.5a6 6 0 1 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14.5 18 8.5M13.5 19.5a2 2 0 0 1-3 0",
  plus:      "M12 5v14M5 12h14",
  chevron:   "M9.5 6 15 12l-5.5 6",
  chevdown:  "M6 9.5 12 15l6-5.5",
  external:  "M14 4h6v6M20 4l-8.5 8.5M18 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5.5",
  check:     "M5 12.5 10 17.5 20 6.5",
  filter:    "M3 5h18l-7 8v5l-4 2v-7z",
  calendar:  "M5 4.5h14a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1zM3.5 9.2h17M8 2.5v4M16 2.5v4",
  clock:     "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2",
  play:      "M7 4.5 19 12 7 19.5z",
  link2:     "M14 4h6v6M20 4l-8.5 8.5M18 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5.5",
  arrowup:   "M12 19V5M6 11l6-6 6 6",
  spark:     "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M18 18l-2.5-2.5M18 6l-2.5 2.5M6 18l2.5-2.5",
};

export function Icon({ name, size = 22, stroke = "currentColor", sw = 1.7, style }) {
  const d = ICON_PATHS[name];
  if (!d) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke}
      strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d={d} />
    </svg>
  );
}
