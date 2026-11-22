import React from 'react';
import ReactDOM from 'react-dom/client';
import { WorkbenchProvider } from './context/WorkbenchContext';
import { App } from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WorkbenchProvider>
      <App />
    </WorkbenchProvider>
  </React.StrictMode>
);
