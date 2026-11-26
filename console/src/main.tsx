import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { applyTheme, applyThemeSkin, readTheme, readThemeSkin } from './lib/theme.ts';
import './index.css';

// The scheme and skin this browser chose, before the first paint: without them a page that
// is not following the defaults would flash on load.
applyTheme(readTheme());
applyThemeSkin(readThemeSkin());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (
  import.meta.env.PROD
  && 'serviceWorker' in navigator
  && !('__TAURI_INTERNALS__' in window)
) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  });
}
