import React, { Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Box, CircularProgress } from '@mui/material';
import AdminLayout from './components/layout/AdminLayout';
import routes from './routes';

function App() {
  return (
    <AdminLayout>
      <Suspense fallback={
        <Box 
          display="flex" 
          justifyContent="center" 
          alignItems="center" 
          height="100vh"
        >
          <CircularProgress />
        </Box>
      }>
        <Routes>
          {routes.map((route) => (
            <Route 
              key={route.path} 
              path={route.path} 
              element={route.element} 
            />
          ))}
          {/* Default redirect */}
          <Route 
            path="/" 
            element={<Navigate to="/dashboard" replace />} 
          />
          {/* 404 route */}
          <Route 
            path="*" 
            element={<Navigate to="/dashboard" replace />} 
          />
        </Routes>
      </Suspense>
    </AdminLayout>
  );
}

export default App;
