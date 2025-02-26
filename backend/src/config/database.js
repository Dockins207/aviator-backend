import pkg from 'pg';
import logger from './logger.js';

const { Pool } = pkg;

// Configuration object for PostgreSQL pool
const poolConfig = {
  host: process.env.DB_HOST || '192.168.75.118',
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
  database: process.env.DB_NAME || 'aviator_db',
  user: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD || '2020',
  
  // Enhanced pool configuration for persistence
  max: 20, // maximum number of clients in the pool
  min: 4, // minimum number of clients to keep in the pool
  idleTimeoutMillis: 30000, // how long a client is allowed to remain idle before being closed
  connectionTimeoutMillis: 15000, // increased from 5000 to 15000 for more robust connection
  
  // Persistence and reliability settings
  application_name: 'AviatorBackend', // helps in monitoring
  keepAlive: true, // maintain connection even when idle
  ssl: false, // explicitly disable SSL if not required
};

// Log configuration before creating pool (using console.log initially)
console.log('Initializing PostgreSQL pool with configuration:', {
  host: poolConfig.host,
  port: poolConfig.port,
  database: poolConfig.database,
  user: poolConfig.user,
  connectionTimeoutMillis: poolConfig.connectionTimeoutMillis,
  max: poolConfig.max,
  min: poolConfig.min
});

// Create pool instance
const pool = new Pool(poolConfig);

// Now that pool is created, we can use logger for subsequent operations
pool.on('error', (err) => {
  logger.error('POSTGRES_POOL_ERROR', {
    errorMessage: err.message,
    errorCode: err.code,
    errorStack: err.stack
  });
});

pool.on('connect', (client) => {
  logger.info('POSTGRES_CLIENT_CONNECTED', {
    host: client.connectionParameters.host,
    port: client.connectionParameters.port,
    database: client.connectionParameters.database,
    user: client.connectionParameters.user
  });
});

// Prevent multiple connection logs
let _hasLoggedDatabaseConnection = false;

async function connectWithRetry(maxRetries = 5) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log('Attempting database connection', { attempt, maxRetries });
      
      const client = await pool.connect();
      
      try {
        // Test the connection with a simple query
        await client.query('SELECT NOW()');
        
        if (!_hasLoggedDatabaseConnection) {
          logger.info('POSTGRES_CONNECTION_ESTABLISHED', {
            host: poolConfig.host,
            database: poolConfig.database,
            user: poolConfig.user,
            attempt
          });
          _hasLoggedDatabaseConnection = true;
        }
        
        client.release();
        return true;
      } catch (queryError) {
        logger.error('POSTGRES_QUERY_ERROR', {
          errorMessage: queryError.message,
          errorCode: queryError.code,
          errorStack: queryError.stack
        });
        client.release();
        throw queryError;
      }
    } catch (error) {
      lastError = error;
      logger.error('POSTGRES_CONNECTION_ATTEMPT_FAILED', {
        attempt,
        maxRetries,
        errorMessage: error.message,
        errorCode: error.code,
        errorStack: error.stack,
        host: poolConfig.host,
        port: poolConfig.port,
        database: poolConfig.database,
        user: poolConfig.user
      });
      
      if (attempt < maxRetries) {
        // Wait before retrying, with exponential backoff
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        console.log('Waiting before next connection attempt', { delay });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  logger.error('POSTGRES_CONNECTION_FAILED_AFTER_RETRIES', {
    maxRetries,
    lastErrorMessage: lastError?.message,
    lastErrorCode: lastError?.code
  });
  return false;
}

// Initial connection on module load
connectWithRetry();

// Periodic connection health check
const connectionHealthCheck = setInterval(async () => {
  if (!_hasLoggedDatabaseConnection) {
    await connectWithRetry();
  }
  
  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
  } catch (error) {
    logger.error('POSTGRES_HEALTH_CHECK_FAILED', {
      errorMessage: error.message,
      errorCode: error.code
    });
    _hasLoggedDatabaseConnection = false;
  }
}, 60000); // Check every minute

// Clean up on process exit
process.on('exit', () => {
  clearInterval(connectionHealthCheck);
  pool.end();
});

export { pool, connectWithRetry };
