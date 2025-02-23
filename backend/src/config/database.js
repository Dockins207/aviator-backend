import pkg from 'pg';
const { Pool } = pkg;
import logger from '../config/logger.js';

// Create a new pool using the connection string
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
  database: process.env.DB_NAME || 'aviator_db',
  user: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD || '2020',
  
  // Enhanced pool configuration for persistence
  max: 20, // maximum number of clients in the pool
  min: 4, // minimum number of clients to keep in the pool
  idleTimeoutMillis: 30000, // how long a client is allowed to remain idle before being closed
  connectionTimeoutMillis: 5000, // increased from 2000 to 5000 for more robust connection
  
  // Persistence and reliability settings
  application_name: 'AviatorBackend', // helps in monitoring
  keepAlive: true, // maintain connection even when idle
  ssl: false, // explicitly disable SSL if not required
});

// Persistent connection management
let isConnected = false;

// Prevent multiple connection logs
let _hasLoggedDatabaseConnection = false;

async function connectWithRetry(maxRetries = 10) {  // Increased max retries
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔌 Attempting Database Connection (Attempt ${attempt})`);
      
      const client = await pool.connect();
      
      // Verify basic database functionality with timeout
      const queryPromise = client.query('SELECT NOW()');
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Query Timeout')), 3000)
      );
      
      await Promise.race([queryPromise, timeoutPromise]);
      
      // Log successful connection only once
      if (!_hasLoggedDatabaseConnection) {
        logger.info('Database Connection Established', { 
          host: process.env.DB_HOST || 'localhost',
          port: process.env.DB_PORT || 5432,
          database: process.env.DB_NAME || 'aviator_db',
          user: process.env.DB_USER || 'admin'
        });
        _hasLoggedDatabaseConnection = true;
      }
      
      isConnected = true;
      
      // Release the client back to the pool
      client.release();
      
      return true;
    } catch (err) {
      // Enhanced error logging
      logger.error('Database Connection Failure', { 
        error: err.message,
        errorName: err.name,
        errorCode: err.code,
        attempt: attempt,
        maxRetries: maxRetries,
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        database: process.env.DB_NAME || 'aviator_db',
        errorStack: err.stack
      });
      
      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
    }
  }
  
  // Critical failure logging
  logger.error('CRITICAL_DATABASE_CONNECTION_FAILURE', {
    message: 'Failed to establish database connection after multiple attempts',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'aviator_db'
  });
  
  return false;
}

// Initial connection on module load
connectWithRetry();

// Periodic connection health check
const connectionHealthCheck = setInterval(async () => {
  if (!isConnected) {
    await connectWithRetry();
  }
  
  try {
    // Lightweight query to check connection
    await pool.query('SELECT 1');
  } catch (err) {
    logger.error('Database connection lost', { 
      error: err.message,
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
      database: process.env.DB_NAME || 'aviator_db',
      user: process.env.DB_USER || 'admin',
    });
    isConnected = false;
  }
}, 60000); // Check every minute

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Closing database connection pool', {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
    database: process.env.DB_NAME || 'aviator_db',
    user: process.env.DB_USER || 'admin',
  });
  clearInterval(connectionHealthCheck);
  await pool.end();
  process.exit(0);
});

export { pool, connectWithRetry };
export default pool;
