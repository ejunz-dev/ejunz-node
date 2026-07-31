import { AppShell, Container } from '@mantine/core';
import React from 'react';
import {
  HashRouter, Outlet, Route, Routes,
} from 'react-router-dom';
import { Header } from './components/Header';
import Auth from './pages/Auth';
import Dashboard from './pages/Dashboard';
import Devices from './pages/Devices';
import Nodes from './pages/Nodes';
import Upstream from './pages/Upstream';

function DefaultLayout() {
  return (
    <AppShell
      header={{ height: '60px' }}
      padding="md"
    >
      <AppShell.Header>
        <Header />
      </AppShell.Header>
      <AppShell.Main>
        <Container size="xl">
          <Outlet />
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<DefaultLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="devices" element={<Devices />} />
          <Route path="nodes" element={<Nodes />} />
          <Route path="upstream" element={<Upstream />} />
          <Route path="auth" element={<Auth />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
