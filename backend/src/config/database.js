import pkg from 'pg';
const { Pool } = pkg;

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

// Error handler for pool errors
pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err.message);
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
          console.log('Database connection established', {
            host: process.env.DB_HOST || 'localhost',
            database: process.env.DB_NAME || 'aviator_db',
            attempt
          });
          _hasLoggedDatabaseConnection = true;
        }
        
        client.release();
        return true;
      } catch (queryError) {
        client.release();
        throw queryError;
      }
    } catch (error) {
      lastError = error;
      console.error('Database connection attempt failed:', {
        attempt,
        error: error.message
      });
      
      if (attempt < maxRetries) {
        // Wait before retrying, with exponential backoff
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        console.log('Waiting before next connection attempt', { delay });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  console.error('Database connection failed after all retries', {
    maxRetries,
    lastError: lastError?.message
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
    console.error('Database health check failed:', error.message);
    _hasLoggedDatabaseConnection = false;
  }
}, 60000); // Check every minute

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Closing database connection pool', {
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
