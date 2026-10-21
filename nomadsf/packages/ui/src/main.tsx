import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Dialogs } from './components/Dialogs';
import { installEmbed } from './embed';
import './styles.css';

installEmbed();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <Dialogs />
  </StrictMode>
);
