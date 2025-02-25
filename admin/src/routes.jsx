import React, { lazy } from 'react';

// Lazy load components for better performance
const Dashboard = lazy(() => import('./features/dashboard/Dashboard'));
const UserManagement = lazy(() => import('./features/users/UserManagement'));
const GameLogs = lazy(() => import('./features/games/GameLogs'));
const TransactionLogs = lazy(() => import('./features/transactions/TransactionLogs'));
const SystemConfig = lazy(() => import('./features/system/SystemConfig'));
const Login = lazy(() => import('./features/auth/Login'));

const routes = [
  {
    path: '/login',
    element: <Login />,
  },
  {
    path: '/dashboard',
    element: <Dashboard />,
  },
  {
    path: '/users',
    element: <UserManagement />,
  },
  {
    path: '/game-logs',
    element: <GameLogs />,
  },
  {
    path: '/transactions',
    element: <TransactionLogs />,
  },
  {
    path: '/system-config',
    element: <SystemConfig />,
  }
];

export default routes;
