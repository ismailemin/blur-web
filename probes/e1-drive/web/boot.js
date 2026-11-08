// Entry point for the E1 drive page.
//
// The page is now a small launcher: a bare URL shows the game shell
// (menu -> mode -> car -> map -> race); any race URL keeps loading the driving
// slice directly, so every existing deep link and verifier URL is unchanged.
//
// `?race=1` is the marker the shell writes when it starts a race; it is not
// read by the driving slice.

const RACE_PARAMS = [
  'race', 'map', 'course', 'script', 'mp', 'car', 'ai', 'powerups',
  'telemetry', 'soak', 'survey', 'hold', 'sprintfall', 'collisionprobe'
];

const params = new URLSearchParams(location.search);
const direct = RACE_PARAMS.some((key) => params.has(key));

if (direct) {
  // A small, always-available way back to the menu; Escape does the same.
  const back = document.createElement('a');
  back.id = 'back-to-menu';
  back.href = location.pathname;
  back.textContent = 'MENU';
  back.title = 'Back to the game shell (Esc)';
  back.style.cssText = [
    'position:fixed', 'top:10px', 'left:10px', 'z-index:60',
    'padding:6px 12px', 'border:1px solid #3a4757', 'border-radius:8px',
    'background:rgba(8,11,16,.82)', 'color:#edf1f7', 'font:600 12px/1 "Segoe UI",system-ui,sans-serif',
    'letter-spacing:.08em', 'text-decoration:none', 'backdrop-filter:blur(8px)'
  ].join(';');
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(back));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.repeat) location.assign(location.pathname);
  });
  import('./app.js');
} else {
  // The shell owns the whole screen; hide the driving-slice chrome that lives
  // on the same page so the menu is not painted over.
  document.documentElement.dataset.menu = '1';
  import('./menu.js');
}
