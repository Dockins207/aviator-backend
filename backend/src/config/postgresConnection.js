import pg from 'pg';
import logger from './logger.js';

class PostgresConnection {
  constructor() {
    this.pool = new pg.Pool({
      user: process.env.POSTGRES_USER || 'aviator',
      host: process.env.POSTGRES_HOST || 'localhost',
      database: process.env.POSTGRES_DB || 'aviator_db',
      password: process.env.POSTGRES_PASSWORD || '',
      port: process.env.POSTGRES_PORT || 5432,
      max: 20, // maximum number of clients in the pool
      idleTimeoutMillis: 30000, // how long a client is allowed to remain idle
      connectionTimeoutMillis: 2000 // how long to wait when connecting to a new client
    });

    // Log connection events
    this.pool.on('error', (err) => {
      logger.error('Unexpected PostgreSQL client error', {
        errorMessage: err.message,
        errorStack: err.stack
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
}

export default new PostgresConnection();
