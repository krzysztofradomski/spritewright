import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import './styles.css';
import './theme-classic.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Spritewright root element is missing.');
}

createRoot(root).render(<App />);
