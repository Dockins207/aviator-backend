import express from 'express';
import cors from 'cors';
import logger from './config/logger.js';
import { pool, connectWithRetry } from './config/database.js';
import errorMiddleware from './middleware/errorMiddleware.js';
import authRoutes from './routes/authRoutes.js';
import gameRoutes from './routes/gameRoutes.js';
import walletRoutes from './routes/walletRoutes.js';
import betRoutes from './routes/betRoutes.js';
import paymentRoutes from './routes/paymentRoutes.js';

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
  maxAge: 3600
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Preflight handler for all routes
app.options('*', cors(corsOptions));

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Authentication routes
app.use('/api/auth', authRoutes);

// Routes
app.use('/api/game', gameRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/bet', betRoutes);
app.use('/api/payments', paymentRoutes);

// Error handling middleware
app.use(errorMiddleware);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// Ensure database connection before starting server
async function startServer() {
  try {
    // Attempt to connect to the database
    const isConnected = await connectWithRetry();
    
    if (!isConnected) {
      logger.error('Failed to start server due to database connection issues');
      process.exit(1);
    }

    // Start the Express server
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
    });
  } catch (error) {
    logger.error('Error starting server', { error: error.message });
    process.exit(1);
  }
}

// Call the start server function
startServer();

export default app;
