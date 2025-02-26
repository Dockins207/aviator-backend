import Redis from 'ioredis';
import logger from '../config/logger.js';

class CacheService {
  constructor() {
    // Initialize Redis client for caching
    this.redisClient = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || '2020', // Add authentication
      db: process.env.REDIS_CACHE_DB || 1, // Separate DB for caching
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      }
    });

    // Error handling
    this.redisClient.on('error', (error) => {
      logger.error('CACHE_REDIS_ERROR', {
        service: 'cache-service',
        errorMessage: error.message,
        errorType: error.name
      });
    });

    this.redisClient.on('connect', () => {
      logger.info('CACHE_REDIS_CONNECTED', {
        service: 'cache-service',
        host: this.redisClient.options.host,
        port: this.redisClient.options.port
      });
    });

    // Log cache service initialization
    logger.info('Cache Service Initialized', {
      service: 'aviator-backend',
      host: this.redisClient.options.host,
      port: this.redisClient.options.port
    });
  }

  /**
   * Set a value in cache with optional expiration
   * @param {string} key - Cache key
   * @param {*} value - Value to cache
   * @param {number} [ttl] - Time to live in seconds
   */
  async set(key, value, ttl = 3600) { // Default 1-hour expiration
    try {
      const serializedValue = JSON.stringify(value);
      
      if (ttl) {
        await this.redisClient.setex(key, ttl, serializedValue);
      } else {
        await this.redisClient.set(key, serializedValue);
      }

      logger.debug('Cache Set', { key, ttl });
    } catch (error) {
      logger.error('Cache Set Error', { 
        key, 
        errorMessage: error.message 
      });
    }
  }

  /**
   * Get a value from cache
   * @param {string} key - Cache key
   * @returns {Promise<*>} Cached value or null
   */
  async get(key) {
    try {
      const cachedValue = await this.redisClient.get(key);
      
      return cachedValue ? JSON.parse(cachedValue) : null;
    } catch (error) {
      logger.error('Cache Get Error', { 
        key, 
        errorMessage: error.message 
      });
      return null;
    }
  }

  /**
   * Delete a key from cache
   * @param {string} key - Cache key to invalidate
   */
  async invalidate(key) {
    try {
      await this.redisClient.del(key);
      
      logger.debug('Cache Invalidated', { key });
    } catch (error) {
      logger.error('Cache Invalidation Error', { 
        key, 
        errorMessage: error.message 
      });
    }
  }

  /**
   * Clear entire cache
   */
  async clear() {
    try {
      await this.redisClient.flushdb();
      
      logger.info('Entire Cache Cleared');
    } catch (error) {
      logger.error('Cache Clear Error', { 
        errorMessage: error.message 
      });
    }
  }

  /**
   * Memoize function results
   * @param {string} key - Unique cache key
   * @param {Function} fn - Function to memoize
   * @param {number} [ttl] - Time to live in seconds
   */
  async memoize(key, fn, ttl = 3600) {
    try {
      // Check cache first
      const cachedResult = await this.get(key);
      if (cachedResult !== null) {
        return cachedResult;
      }

      // Execute function and cache result
      const result = await fn();
      await this.set(key, result, ttl);

      return result;
    } catch (error) {
      logger.error('Memoization Error', { 
        key, 
        errorMessage: error.message 
      });
      
      // Fallback to direct function execution
      return fn();
    }
  }
}

export default new CacheService();
