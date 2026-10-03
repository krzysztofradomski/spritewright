import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import './styles.css';
import './theme-classic.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Asset Studio root element is missing.');
}

createRoot(root).render(<App />);
