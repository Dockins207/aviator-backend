import { performance } from 'perf_hooks';
import logger from '../config/logger.js';

/**
 * Performance Monitoring Middleware for Bet Activation
 */
class PerformanceMonitoring {
  /**
   * Measure and log performance of critical operations
   * @param {Function} operation - Function to monitor
   * @param {string} operationName - Name of the operation
   * @returns {Promise} Operation result
   */
  static async measurePerformance(operation, operationName) {
    const startTime = performance.now();
    
    try {
      const result = await operation();
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      this.logPerformance(operationName, duration, result);
      
      return result;
    } catch (error) {
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      this.logPerformanceError(operationName, duration, error);
      
      throw error;
    }
  }

  /**
   * Log performance metrics
   * @param {string} operationName - Name of the operation
   * @param {number} duration - Execution time in milliseconds
   * @param {Object} result - Operation result
   */
  static logPerformance(operationName, duration, result) {
    logger.info('Performance Metrics', {
      operation: operationName,
      durationMs: duration.toFixed(2),
      resultSize: result ? JSON.stringify(result).length : 0,
      timestamp: new Date().toISOString()
    });

    // Optional: Send to monitoring service
    this.sendToMonitoringService({
      operation: operationName,
      durationMs: duration,
      timestamp: Date.now()
    });
  }

  /**
   * Log performance errors
   * @param {string} operationName - Name of the operation
   * @param {number} duration - Execution time in milliseconds
   * @param {Error} error - Error object
   */
  static logPerformanceError(operationName, duration, error) {
    logger.error('Performance Error', {
      operation: operationName,
      durationMs: duration.toFixed(2),
      errorMessage: error.message,
      errorStack: error.stack,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send metrics to external monitoring service
   * @param {Object} metrics - Performance metrics
   */
  static sendToMonitoringService(metrics) {
    // Placeholder for external monitoring integration
    // Could be Datadog, Prometheus, New Relic, etc.
    console.debug('Monitoring Metrics:', metrics);
  }
}

export default PerformanceMonitoring;
