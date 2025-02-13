import pg from 'pg';
import logger from './logger.js';

// Create a new pool using the connection string
const pool = new pg.Pool({
  host: 'localhost',
  port: 5432,
  database: 'aviator_db',
  user: 'admin',
  password: '2020',
  
  // Enhanced pool configuration for persistence
  max: 20, // maximum number of clients in the pool
  min: 4, // minimum number of clients to keep in the pool
  idleTimeoutMillis: 30000, // how long a client is allowed to remain idle before being closed
  connectionTimeoutMillis: 2000, // how long to wait when connecting to a new client
  
  // Persistence and reliability settings
  application_name: 'AviatorBackend', // helps in monitoring
  keepAlive: true, // maintain connection even when idle
  ssl: false, // explicitly disable SSL if not required
});

// Persistent connection management
let isConnected = false;

async function connectWithRetry(maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = await pool.connect();
      
      // Verify basic database functionality
      await client.query('SELECT NOW()');
      
      logger.databaseInfo(`Database connection established successfully (Attempt ${attempt})`);
      
      isConnected = true;
      
      // Release the client back to the pool
      client.release();
      
      return true;
    } catch (err) {
      logger.databaseError(`Database connection attempt ${attempt} failed`, { 
        error: err.message,
        attempt: attempt,
        maxRetries: maxRetries,
        host: 'localhost',
        port: 5432,
        database: 'aviator_db',
        user: 'admin',
      });
      
      // Wait before retrying (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
  
  logger.databaseError('Failed to connect to the database after multiple attempts', {
    host: 'localhost',
    port: 5432,
    database: 'aviator_db',
    user: 'admin',
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
      host: 'localhost',
      port: 5432,
      database: 'aviator_db',
      user: 'admin',
    });
    isConnected = false;
  }
}, 60000); // Check every minute

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Closing database connection pool', {
    host: 'localhost',
    port: 5432,
    database: 'aviator_db',
    user: 'admin',
  });
  clearInterval(connectionHealthCheck);
  await pool.end();
  process.exit(0);
});

export { pool, connectWithRetry };
