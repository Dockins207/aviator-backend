import pg from 'pg';
import logger from './logger.js';

class PostgresConnection {
  constructor() {
    const connectionConfig = {
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
      port: parseInt(process.env.DB_PORT, 10),
      max: 20, // maximum number of clients in the pool
      idleTimeoutMillis: 30000, // how long a client is allowed to remain idle
      connectionTimeoutMillis: 15000, // increased timeout for connection
      ssl: false, // Disable SSL if not required
      log: (msg) => {
        logger.info('POSTGRES_CONNECTION_LOG', { message: msg });
      }
    };

    logger.info('POSTGRES_CONNECTION_ATTEMPT', {
      host: connectionConfig.host,
      port: connectionConfig.port,
      database: connectionConfig.database,
      user: connectionConfig.user
    });

    this.pool = new pg.Pool(connectionConfig);

    // Enhanced error handling
    this.pool.on('error', (err, client) => {
      logger.error('Unexpected PostgreSQL client error', {
        errorMessage: err.message,
        errorCode: err.code,
        errorStack: err.stack,
        clientDetails: {
          host: client?.connectionParameters?.host,
          port: client?.connectionParameters?.port,
          database: client?.connectionParameters?.database
        }
      });
    });

    this.pool.on('connect', (client) => {
      logger.info('POSTGRES_CONNECTION_SUCCESSFUL', {
        host: client.connectionParameters.host,
        port: client.connectionParameters.port,
        database: client.connectionParameters.database
      });
    });
  }

  /**
   * Execute a query with optional parameters
   * @param {string} text - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise<Object>} Query result
   */
  async query(text, params = []) {
    const start = Date.now();
    try {
      const result = await this.pool.query(text, params);
      
      const duration = Date.now() - start;
      logger.info('PostgreSQL Query Executed', {
        query: text,
        duration,
        rowCount: result.rowCount
      });

      return result;
    } catch (error) {
      logger.error('PostgreSQL Query Error', {
        query: text,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  /**
   * Get a client from the connection pool
   * @returns {Promise<Object>} PostgreSQL client
   */
  async getClient() {
    return await this.pool.connect();
  }

  /**
   * Close all pool connections
   */
  async close() {
    await this.pool.end();
    logger.info('PostgreSQL Connection Pool Closed');
  }

  // Enhanced connection testing method
  async testConnection() {
    try {
      const client = await this.pool.connect();
      
      logger.info('POSTGRES_TEST_CONNECTION_SUCCESSFUL', {
        host: client.connectionParameters.host,
        port: client.connectionParameters.port,
        database: client.connectionParameters.database,
        user: client.connectionParameters.user
      });
      
      // Run a simple query to verify full functionality
      const result = await client.query('SELECT 1 as connection_test');
      
      logger.info('POSTGRES_TEST_QUERY_SUCCESSFUL', {
        result: result.rows[0]
      });
      
      client.release();
      return true;
    } catch (error) {
      logger.error('POSTGRES_TEST_CONNECTION_FAILED', {
        errorMessage: error.message,
        errorCode: error.code,
        errorType: error.constructor.name,
        errorStack: error.stack
      });
      return false;
    }
  }
}

export default new PostgresConnection();
