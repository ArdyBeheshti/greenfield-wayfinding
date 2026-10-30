import type { StepIcon } from './directions';

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const STEP_ICONS: Record<StepIcon, string> = {
  start: svg('<circle cx="12" cy="12" r="4" fill="currentColor"/><circle cx="12" cy="12" r="8"/>'),
  straight: svg('<path d="M12 20V4M6 10l6-6 6 6"/>'),
  left: svg('<path d="M18 20v-7a4 4 0 0 0-4-4H5M10 4 5 9l5 5"/>'),
  right: svg('<path d="M6 20v-7a4 4 0 0 1 4-4h9M14 4l5 5-5 5"/>'),
  'slight-left': svg('<path d="M15 20v-6L8 6M8 12V6h6"/>'),
  'slight-right': svg('<path d="M9 20v-6l7-8M16 12V6h-6"/>'),
  back: svg('<path d="M9 20V9a5 5 0 0 1 10 0v3M5 16l4 4 4-4"/>'),
  connection: svg('<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M10 9l2-2 2 2M10 15l2 2 2-2"/>'),
  arrive: svg('<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5" fill="currentColor"/>'),
};

export const ICON = {
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  prev: svg('<path d="m15 6-6 6 6 6"/>'),
  next: svg('<path d="m9 6 6 6-6 6"/>'),
  share: svg('<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>'),
  list: svg('<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>'),
  door: svg('<path d="M4 21h16M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17"/><circle cx="14.5" cy="12" r="1" fill="currentColor"/>'),
  car: svg('<path d="M5 17h14M6 17v2M18 17v2M4 13l2-5a2 2 0 0 1 1.9-1.4h8.2A2 2 0 0 1 18 8l2 5v4H4v-4z"/><circle cx="8" cy="14" r="1" fill="currentColor"/><circle cx="16" cy="14" r="1" fill="currentColor"/>'),
  store: svg('<path d="M4 9h16l-1-5H5L4 9zM5 9v11h14V9M9 20v-6h6v6"/>'),
};
