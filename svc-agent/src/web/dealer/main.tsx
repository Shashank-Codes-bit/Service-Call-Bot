import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App.tsx';
import { TryPage } from './try/TryPage.tsx';

// /try/<centre> is the public "Talk to the agent" page: no sign-in, no portal.
const tryPage = /^\/try\/([a-z0-9][a-z0-9-]{1,29})\/?$/i.exec(location.pathname);

createRoot(document.getElementById('root')!).render(
  <StrictMode>{tryPage ? <TryPage slug={tryPage[1]!.toLowerCase()} /> : <App />}</StrictMode>,
);
