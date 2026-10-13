import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { routerBasename } from './staticMode';
import './styles.css';

/** The read-only demo is served under a base path such as /<repository>/ on GitHub Pages. */
const STATIC = import.meta.env.VITE_STATIC === '1';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter basename={STATIC ? routerBasename() : undefined}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
