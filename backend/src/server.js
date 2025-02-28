import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import os from 'os';
import logger from './config/logger.js';
import { pool, connectWithRetry } from './config/database.js';
import { WalletRepository } from './repositories/walletRepository.js';
import gameService from './services/gameService.js';
import notificationService from './services/notificationService.js';
import errorMiddleware from './middleware/errorMiddleware.js';
import authRoutes from './routes/authRoutes.js';
import gameRoutes from './routes/gameRoutes.js';
import walletRoutes from './routes/walletRoutes.js';
import betRoutes from './routes/betRoutes.js';
import paymentRoutes from './routes/paymentRoutes.js';
import schedule from 'node-schedule';
import { authService } from './services/authService.js';
import socketManager from './sockets/socketManager.js';

// Load environment variables
dotenv.config();

// Explicitly set environment variables
const PORT = process.env.PORT || 8001;
const NODE_ENV = process.env.NODE_ENV || 'development';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000' || 'http://192.168.0.11:3000';

// Improved CORS configuration
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://192.168.0.11:3000',
  'http://192.168.0.11:8001',
  'https://localhost:3000',
  'http://127.0.0.1:3000',
  'https://avbetting.netlify.app',
  'capacitor://localhost',
  'http://localhost',
  'http://192.168.0.11'
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Check if the origin's hostname matches our local network pattern
    const isLocalNetwork = /^http:\/\/192\.168\.\d+\.\d+(?::\d+)?$/.test(origin);
    
    if (isLocalNetwork || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked for origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With', 
    'Accept', 
    'Origin', 
    'Cache-Control',
    'Pragma'  
  ],
  credentials: true,
  optionsSuccessStatus: 200
};

// Create Express app
const app = express();

// Apply CORS middleware
app.use(cors(corsOptions));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Add error handling middleware before routes
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err);
  res.status(500).json({
    status: 'error',
    message: 'Internal Server Error',
    details: process.env.NODE_ENV === 'development' ? err.message : {}
  });
});

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

    // Create HTTP server
    const server = createServer(app);

    // Initialize Socket.IO with CORS
    const io = new SocketIOServer(server, {
      cors: {
        origin: ALLOWED_ORIGINS,
        methods: ["GET", "POST"],
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization"]
      },
      pingTimeout: 120000,        // Increase ping timeout to 2 minutes
      pingInterval: 30000,        // Increase ping interval to 30 seconds
      maxHttpBufferSize: 1e6,
      connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: true
      }
    });

    // Initialize socket manager
    socketManager.initialize(io);

    // Import socket and game modules dynamically
    const [
      { default: GameSocketClass }, 
      { default: ChatSocketInitializer }, 
      { default: BetSocketClass },
      { default: WalletSocketClass }
    ] = await Promise.all([
      import('./sockets/gameSocket.js'),
      import('./sockets/chatSocket.js'),
      import('./sockets/betSocket.js'),
      import('./sockets/walletSocket.js')
    ]);

    // Initialize socket namespaces with class-based modules
    const gameSocket = new GameSocketClass(io);
    ChatSocketInitializer(io);
    
    // Explicitly set Socket.IO for notification service
    notificationService.setSocketIO(io);
    
    // Initialize wallet socket
    const walletSocket = new WalletSocketClass(io);
    
    // Set wallet socket for repository
    WalletRepository.setWalletSocket(walletSocket);
    
    // Handle different socket initialization patterns
    const betSocket = new BetSocketClass(io);
    betSocket.initialize();

    // Comprehensive Health Check Route
    app.get('/api/health', (req, res) => {
      try {
        // Capture request details for logging
        const requestDetails = {
          timestamp: new Date().toISOString(),
          method: req.method,
          headers: req.headers,
          gameId: req.headers['x-game-id'] || 'not-provided'
        };

        console.log('🩺 Health Check Request:', JSON.stringify(requestDetails, null, 2));

        const healthStatus = {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          environment: process.env.NODE_ENV || 'development',
          server: {
            name: 'Aviator Backend',
            version: process.env.npm_package_version || '1.0.0',
            nodeVersion: process.version
          },
          system: {
            platform: process.platform,
            architecture: process.arch
          },
          memory: {
            total: process.memoryUsage().heapTotal,
            used: process.memoryUsage().heapUsed,
            free: process.memoryUsage().heapTotal - process.memoryUsage().heapUsed
          },
          connections: {
            database: true,  // Add actual database connection check
            redis: true,     // Add actual Redis connection check
            socketIO: true   // Check socket.io connectivity if applicable
          },
          requestMetadata: {
            gameId: requestDetails.gameId
          }
        };

        res.status(200).json(healthStatus);
      } catch (error) {
        console.error('🚨 Health Check Error:', {
          message: error.message,
          stack: error.stack
        });

        res.status(500).json({
          status: 'error',
          message: 'Health check failed',
          details: process.env.NODE_ENV === 'development' ? error.message : 'Internal Server Error'
        });
      }
    });

    // Basic routes
    app.use('/api/auth', authRoutes);
    app.use('/api/game', gameRoutes);
    app.use('/api/bets', betRoutes);  
    app.use('/api/wallet', walletRoutes);
    app.use('/api/payments', paymentRoutes);
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

    // Start the server
    server.listen(PORT, '0.0.0.0', () => {
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

    // Graceful shutdown
    process.on('SIGINT', async () => {
      try {
        server.close(() => {
          logger.info('Server closed');
          process.exit(0);
        });
      } catch (error) {
        logger.error('Error during shutdown', error);
        process.exit(1);
      }
    });

  } catch (error) {
    console.error('Error starting server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();

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
