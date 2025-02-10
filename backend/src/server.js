import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import app from './app.js';
import logger from './config/logger.js';
import GameSocket from './sockets/gameSocket.js';

// Load environment variables
dotenv.config();

const PORT = process.env.PORT || 8000;

// Create Express app
const expressApp = express();
expressApp.use(cors());
expressApp.use(express.json());

// Create HTTP server
const httpServer = createServer(expressApp);

// Initialize Socket.IO
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST']
  }
});

// Initialize WebSocket
const gameSocket = new GameSocket(io);

// Basic routes
expressApp.get('/', (req, res) => {
  res.json({ message: 'Aviator Game Backend' });
});

// Error handling middleware
expressApp.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'production' ? {} : err.message 
  });
});

// Import socket handlers
import('./sockets/chatSocket.js').then(({ default: chatSocket }) => {
  chatSocket(io);
});

// Start server
httpServer.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  
  // Automatically start game cycles
  setInterval(() => {
    gameSocket.startGame();
  }, 30000); // Start a new game every 30 seconds
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully');
  httpServer.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});
