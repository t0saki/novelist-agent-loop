import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { queryClient } from './api/queryClient';
import { GlobalOverlays } from './components/ui';
import { initTheme } from './lib/theme';
import { router } from './router';
import './styles.css';

initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <GlobalOverlays />
    </QueryClientProvider>
  </StrictMode>,
);
