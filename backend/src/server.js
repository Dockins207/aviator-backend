import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import app from './app.js';
import logger from './config/logger.js';

// Load environment variables
dotenv.config();

const PORT = process.env.PORT || 8000;

// Create HTTP server
const httpServer = createServer(app);

// Initialize Socket.IO
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST']
  }
});

// Import socket handlers
import('./sockets/gameSocket.js').then(({ default: gameSocket }) => {
  gameSocket(io);
});

import('./sockets/chatSocket.js').then(({ default: chatSocket }) => {
  chatSocket(io);
});

// Start server
httpServer.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully');
  httpServer.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});
