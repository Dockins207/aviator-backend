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
import errorMiddleware from './middleware/errorMiddleware.js';
import authRoutes from './routes/authRoutes.js';
import gameRoutes from './routes/gameRoutes.js';
import walletRoutes from './routes/walletRoutes.js';
import betRoutes from './routes/betRoutes.js';
import schedule from 'node-schedule';
import { authService } from './services/authService.js';

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
    // Allow any origin during development
    callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Origin', 'Accept'],
  credentials: true,
  optionsSuccessStatus: 200,
  maxAge: 3600
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

// Main server startup function
async function startServer() {
  try {
    // Ensure database connection
    const isConnected = await connectWithRetry();
    
    if (!isConnected) {
      logger.error('Failed to start server due to database connection issues');
      process.exit(1);
    }

    // Create HTTP server
    const httpServer = createServer(app);

    // Import socket and game modules dynamically
    Promise.all([
      import('./sockets/gameSocket.js'),
      import('./sockets/chatSocket.js'),
      import('./sockets/betSocket.js'),
      import('./sockets/walletSocket.js')
    ]).then(async ([{ default: GameSocket }, { default: chatSocket }, { default: betSocket }, { default: WalletSocket }]) => {
      // Initialize Socket.IO
      const io = new SocketIOServer(httpServer, {
        cors: corsOptions
      });

      // Initialize socket handlers
      const gameSocket = new GameSocket(io);
      chatSocket(io);
      betSocket(io);
      
      // Set up wallet socket and repository
      WalletRepository.setWalletSocket(io);

      // Start server
      httpServer.listen(PORT, '0.0.0.0', async () => {
        // Removed console.log for server startup details
        
        // Log all registered routes
        app._router.stack.forEach((r) => {
          if (r.route && r.route.path) {
            // Removed console.log for registered routes
          }
        });

        // Explicitly connect to Redis before starting game cycle
        try {
          await redisConnection.connect();
          // Removed console.log for Redis connection
        } catch (redisError) {
          console.error('[SERVER] Failed to connect to Redis', redisError);
          // Optionally, you might want to exit the process or handle this differently
        }

        // Removed console.log for port, environment, and frontend URL
        
        // Log network interfaces
        const networkInterfaces = getNetworkInterfaces();
        // Removed console.log for network interfaces

        // Removed console.log for accessible URLs

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
    app.use('/api/auth', authRoutes);
    app.use('/api/game', gameRoutes);
    app.use('/api/wallet', walletRoutes);
    app.use('/api/bet', betRoutes);
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

// Start the server
startServer();
