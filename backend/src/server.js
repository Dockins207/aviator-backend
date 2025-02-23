import dotenv from 'dotenv';
import express from 'express';
import { default as cors } from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import os from 'os';
import logger from './config/logger.js';
import redisConnection from './config/redisConfig.js';
import { pool, connectWithRetry } from './config/database.js';
import { WalletRepository } from './repositories/walletRepository.js';
import gameService from './services/gameService.js';
import notificationService from './services/notificationService.js';
import statsService from './services/statsService.js';
import errorMiddleware from './middleware/errorMiddleware.js';
import authRoutes from './routes/authRoutes.js';
import gameRoutes from './routes/gameRoutes.js';
import walletRoutes from './routes/walletRoutes.js';
import betRoutes from './routes/betRoutes.js';
import { initializeStatsService } from './routes/betRoutes.js';
import schedule from 'node-schedule';
import { authService } from './services/authService.js';
import wagerMonitorSocket from './sockets/wagerMonitorSocket.js';
import redisRepository from './redis-services/redisRepository.js';
import socketManager from './sockets/socketManager.js';

// Load environment variables
dotenv.config();

// Explicitly set environment variables
const PORT = process.env.PORT || 8000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Create Express app
const app = express();

// Completely open CORS configuration for development
const corsOptions = {
  origin: function(origin, callback) {
    const allowedOrigins = [
      'http://localhost:3000', 
      'http://localhost:8000',
      'https://aviator.game', 
      'https://www.aviator.game',
      'http://192.168.0.11:3000',
      'http://192.168.0.12:3000',
      'http://192.168.0.12:8000'
    ];

    // Check if origin is undefined (for same-origin requests) or in allowed list
    if (!origin || allowedOrigins.includes(origin) || 
        (origin && /^http:\/\/192\.168\.0\.\d+:\d+$/.test(origin))) {
      callback(null, true);
    } else {
      logger.warn('SOCKET_CORS_ORIGIN_REJECTED', {
        service: 'aviator-backend',
        origin: origin,
        allowedOrigins: allowedOrigins
      });
      // Allow all origins during development if not in production
      if (process.env.NODE_ENV !== 'production') {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-access-token'],
  credentials: true
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());
app.use(errorMiddleware);

// Network interface logging
function getNetworkInterfaces() {
  try {
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
  } catch (error) {
    logger.error('Error getting network interfaces', { error: error.message });
  }
}

console.log('Server startup initiated');

// Main server startup function
async function startServer() {
  try {
    console.log('Starting server...');
    // Ensure database connection
    const isConnected = await connectWithRetry();
    
    if (!isConnected) {
      console.error('Failed to start server due to database connection issues');
      process.exit(1);
    }

    console.log('Database connection established');

    // Setup game session validator for Redis repository
    redisRepository.setGameSessionValidator(async (providedSessionId) => {
      try {
        // Use gameService to validate the session ID
        const currentGameState = gameService.gameState || {};
        
        // Check if the provided session ID matches the current game session ID
        if (!currentGameState || !currentGameState.gameId) {
          logger.warn('GAME_SESSION_STATE_UNAVAILABLE', {
            message: 'Current game state not found',
            providedSessionId
          });
          return false;
        }

        const isValid = providedSessionId === currentGameState.gameId;

        if (!isValid) {
          logger.warn('SESSION_ID_MISMATCH', {
            providedSessionId,
            currentGameSessionId: currentGameState.gameId,
            context: 'server_initialization'
          });
        }

        return isValid;
      } catch (error) {
        logger.error('GAME_SESSION_VALIDATOR_ERROR', {
          errorMessage: error.message,
          providedSessionId
        });
        return false;
      }
    });

    // Create HTTP server
    const httpServer = createServer(app);

    // Configure Socket.IO with CORS
    const socketOptions = {
      cors: {
        origin: function(origin, callback) {
          const ALLOWED_ORIGINS = [
            'http://localhost:3000', 
            'http://localhost:8000',
            'https://aviator.game', 
            'https://www.aviator.game',
            'http://192.168.0.11:3000',
            'http://192.168.0.12:3000',
            'http://192.168.0.12:8000'
          ];

          // If no origin (like in server-to-server communication), allow
          if (!origin) {
            callback(null, true);
            return;
          }

          // Check if origin is in allowed list or matches local network pattern
          if (ALLOWED_ORIGINS.includes(origin) || 
              /^http:\/\/192\.168\.0\.\d+:\d+$/.test(origin)) {
            callback(null, true);
          } else {
            logger.warn('SOCKET_CORS_ORIGIN_REJECTED', {
              origin,
              allowedOrigins: ALLOWED_ORIGINS
            });

            // Allow all origins during development if not in production
            if (process.env.NODE_ENV !== 'production') {
              callback(null, true);
            } else {
              callback(new Error('Not allowed by CORS'));
            }
          }
        },
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type', 'Authorization', 'x-access-token'],
        credentials: true
      },
      pingTimeout: 60000, // Increased timeout
      pingInterval: 25000, // Increased interval
      maxHttpBufferSize: 1e6, // 1 MB max payload
      connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
        skipMiddlewares: true
      }
    };

    const io = new SocketIOServer(httpServer, socketOptions);

    // Initialize socket manager
    socketManager.initialize(io);

    // Import socket and game modules dynamically
    Promise.all([
      import('./sockets/gameSocket.js'),
      import('./sockets/chatSocket.js'),
      import('./sockets/betSocket.js'),
      import('./sockets/walletSocket.js')
    ]).then(async ([
      { default: GameSocketClass }, 
      { default: ChatSocketInitializer }, 
      { default: BetSocketInitializer },
      { default: WalletSocketClass }
    ]) => {
      // Initialize socket namespaces with class-based modules
      const gameSocket = new GameSocketClass(io);
      ChatSocketInitializer(io);
      
      // Explicitly set Socket.IO for notification service
      notificationService.setSocketIO(io);
      
      // Explicitly set Socket.IO for stats service
      statsService.setSocketIO(io);
      
      // Initialize wallet socket
      const walletSocket = new WalletSocketClass(io);
      
      // Set wallet socket for repository
      WalletRepository.setWalletSocket(walletSocket);
      
      // Handle different socket initialization patterns
      if (typeof BetSocketInitializer === 'function') {
        BetSocketInitializer(io);
      } else if (typeof BetSocketInitializer === 'object' && BetSocketInitializer.default) {
        const betSocket = new BetSocketInitializer.default(io);
        betSocket.initialize();
      }

      wagerMonitorSocket(io);

      // Initialize stats service
      initializeStatsService(io);

      // Start the server
      httpServer.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`Environment: ${NODE_ENV}`);
        
        // Log network interfaces
        const networkInfo = getNetworkInterfaces();
        if (networkInfo) {
          console.log('Network Interfaces:');
          networkInfo.forEach(info => {
            console.log(`  ${info.name}: ${info.address}`);
          });
        }
      });

      // Optional: If you need to start any specific methods after initialization
      if (typeof gameSocket.startGameCycle === 'function') {
        gameSocket.startGameCycle();
      }
    }).catch(error => {
      console.error('Failed to initialize socket modules:', error);
      process.exit(1);
    });

    // Basic routes
    app.use('/api/auth', authRoutes);
    app.use('/api/game', gameRoutes);
    app.use('/api/wallet', walletRoutes);
    app.use('/api/bets', betRoutes);  
    app.get('/', (req, res) => {
      res.json({ 
        message: 'Aviator Game Backend', 
        environment: NODE_ENV,
        frontendUrl: FRONTEND_URL
      });
    });

    // Catch-all route for debugging
    app.use((req, res, next) => {
      console.error('[UNHANDLED_REQUEST]', {
        method: req.method,
        path: req.path,
        headers: req.headers,
        body: req.body
      });
      res.status(404).json({
        message: 'Route not found',
        method: req.method,
        path: req.path
      });
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      try {
        await redisConnection.disconnect();
        httpServer.close(() => {
          logger.info('Server and Redis connection closed');
          process.exit(0);
        });
      } catch (error) {
        logger.error('Error during shutdown', error);
        process.exit(1);
      }
    });

  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
}

// Global error handling
process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT_EXCEPTION]', error);
  logger.error('Uncaught Exception', {
    errorName: error.name,
    errorMessage: error.message,
    errorStack: error.stack
  });
  process.exit(1);
});

// Add unhandled promise rejection handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED_REJECTION]', reason);
  logger.error('Unhandled Rejection', {
    reason: reason,
    reasonType: typeof reason,
    reasonMessage: reason instanceof Error ? reason.message : 'Not an Error object',
    reasonStack: reason instanceof Error ? reason.stack : 'No stack trace',
    promise: promise ? 'Promise exists' : 'No promise'
  });
  process.exit(1);
});

// Start the server
startServer();
