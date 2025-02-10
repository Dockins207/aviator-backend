import dotenv from 'dotenv';
import express from 'express';
import { default as cors } from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import app from './app.js';
import logger from './config/logger.js';
import GameSocket from './sockets/gameSocket.js';

// Load environment variables
dotenv.config();

const PORT = process.env.PORT || 8000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const FRONTEND_URL = process.env.FRONTEND_URL || '*';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const SOCKET_PING_TIMEOUT = parseInt(process.env.SOCKET_PING_TIMEOUT) || 60000;
const SOCKET_PING_INTERVAL = parseInt(process.env.SOCKET_PING_INTERVAL) || 25000;

// Create Express app
const expressApp = express();

// Flexible CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Define allowed origins
    const allowedOrigins = [
      'http://localhost:3000', 
      'http://127.0.0.1:3000', 
      'http://192.168.0.10:3000',
      'http://192.168.0.12:3000',
      process.env.FRONTEND_URL
    ];
    
    if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

expressApp.use(cors(corsOptions));
expressApp.use(express.json());

// Create HTTP server
const httpServer = createServer(expressApp);

// Initialize Socket.IO with flexible CORS
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: function (origin, callback) {
      console.log('[SOCKET] Incoming Connection Origin:', origin);
      
      // Define allowed origins with more logging
      const allowedOrigins = [
        'http://localhost:3000', 
        'http://127.0.0.1:3000', 
        'http://192.168.0.10:3000',
        'http://192.168.0.12:3000',
        process.env.FRONTEND_URL,
        '*'  // Be very permissive for debugging
      ];
      
      console.log('[SOCKET] Allowed Origins:', allowedOrigins);
      
      if (allowedOrigins.includes(origin) || !origin) {
        callback(null, true);
      } else {
        console.warn('[SOCKET] Blocked connection from:', origin);
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Timestamp', 'X-Client-Version']
  },
  pingTimeout: SOCKET_PING_TIMEOUT,
  pingInterval: SOCKET_PING_INTERVAL,
  maxHttpBufferSize: 1e8  // Increase buffer size
});

// Initialize WebSocket
const gameSocket = new GameSocket(io);

// Basic routes
expressApp.get('/', (req, res) => {
  res.json({ 
    message: 'Aviator Game Backend', 
    environment: NODE_ENV,
    frontendUrl: FRONTEND_URL
  });
});

// Error handling middleware
expressApp.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    message: 'Something went wrong!',
    error: NODE_ENV === 'production' ? {} : err.message 
  });
});

// Import socket handlers
import('./sockets/chatSocket.js').then(({ default: chatSocket }) => {
  chatSocket(io);
});

// Start server
httpServer.listen(PORT, '0.0.0.0', () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${NODE_ENV}`);
  logger.info(`Frontend URL: ${FRONTEND_URL}`);
  
  // Use the game cycle from GameSocket
  gameSocket.startGameCycle();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully');
  httpServer.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});
