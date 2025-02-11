import dotenv from 'dotenv';
import express from 'express';
import { default as cors } from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import os from 'os';
import logger from './config/logger.js';
import app from './app.js';

// Explicitly set environment variables
const PORT = process.env.PORT || 8000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Enhanced CORS configuration
const corsOptions = {
  origin: [
    'http://localhost:3000',   // Local development frontend
    'http://192.168.0.12:3000', // Local network frontend
    'http://127.0.0.1:3000'    // Localhost alternative
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

// Network interface logging
function getNetworkInterfaces() {
  const interfaces = os.networkInterfaces();
  const networkInfo = [];

  Object.keys(interfaces).forEach((interfaceName) => {
    interfaces[interfaceName].forEach((details) => {
      if (details.family === 'IPv4' && !details.internal) {
        networkInfo.push({
          name: interfaceName,
          address: details.address,
          netmask: details.netmask
        });
      }
    });
  });

  return networkInfo;
}

// Create HTTP server
const httpServer = createServer(app);

// Import socket and game modules dynamically
Promise.all([
  import('./sockets/gameSocket.js'),
  import('./sockets/chatSocket.js'),
  import('./sockets/betSocket.js')
]).then(([{ default: GameSocket }, { default: chatSocket }, { default: betSocket }]) => {
  // Initialize Socket.IO
  const io = new SocketIOServer(httpServer, {
    cors: corsOptions
  });

  // Initialize socket handlers
  const gameSocket = new GameSocket(io);
  chatSocket(io);
  betSocket(io);

  // Start server
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log('=== SERVER STARTUP DETAILS ===');
    console.log(`[SERVER] Running on ALL interfaces`);
    console.log(`[SERVER] Port: ${PORT}`);
    console.log(`[SERVER] Environment: ${NODE_ENV}`);
    console.log(`[SERVER] Frontend URL: ${FRONTEND_URL}`);
    
    // Log network interfaces
    console.log('[SERVER] Network Interfaces:');
    const networkInterfaces = getNetworkInterfaces();
    networkInterfaces.forEach((iface) => {
      console.log(`  - ${iface.name}: ${iface.address}`);
    });

    console.log('[SERVER] Accessible via:');
    console.log(`  - http://localhost:${PORT}`);
    console.log(`  - http://127.0.0.1:${PORT}`);
    console.log(`  - http://0.0.0.0:${PORT}`);
    networkInterfaces.forEach((iface) => {
      console.log(`  - http://${iface.address}:${PORT}`);
    });

    // Start game cycle
    gameSocket.startGameCycle();
  });

  // Error handling
  httpServer.on('error', (error) => {
    console.error('[SERVER ERROR]', error);
    process.exit(1);
  });
}).catch((error) => {
  console.error('[INITIALIZATION ERROR]', error);
  process.exit(1);
});

// Basic routes
app.get('/', (req, res) => {
  res.json({ 
    message: 'Aviator Game Backend', 
    environment: NODE_ENV,
    frontendUrl: FRONTEND_URL
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    message: 'Something went wrong!',
    error: NODE_ENV === 'production' ? {} : err.message 
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully');
  httpServer.close(() => {
    console.log('Process terminated');
    process.exit(0);
  });
});
