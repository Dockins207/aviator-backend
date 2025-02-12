import { pool } from '../config/database.js';
import logger from '../config/logger.js';

export const userLogger = {
  async logUserRegistration(userId, username, phoneNumber) {
    try {
      const logQuery = `
        INSERT INTO user_activity_logs (
          user_id, 
          username, 
          phone_number, 
          activity_type, 
          timestamp
        ) VALUES ($1, $2, $3, 'registration', CURRENT_TIMESTAMP)
      `;
      
      await pool.query(logQuery, [userId, username, phoneNumber]);
      
      logger.info(`User registration logged: ${username} (ID: ${userId})`);
    } catch (error) {
      logger.error('Failed to log user registration', { 
        error: error.message, 
        userId, 
        username 
      });
    }
  },

  async logUserLogin(userId, username, phoneNumber, ipAddress = null) {
    try {
      const logQuery = `
        INSERT INTO user_activity_logs (
          user_id, 
          username, 
          phone_number, 
          activity_type, 
          ip_address,
          timestamp
        ) VALUES ($1, $2, $3, 'login', $4, CURRENT_TIMESTAMP)
      `;
      
      await pool.query(logQuery, [userId, username, phoneNumber, ipAddress]);
      
      logger.info(`User login logged: ${username} (ID: ${userId})`);
    } catch (error) {
      logger.error('Failed to log user login', { 
        error: error.message, 
        userId, 
        username 
      });
    }
  },

  async logUserLogout(userId, username, phoneNumber, ipAddress = null) {
    try {
      const logQuery = `
        INSERT INTO user_activity_logs (
          user_id, 
          username, 
          phone_number, 
          activity_type, 
          ip_address,
          timestamp
        ) VALUES ($1, $2, $3, 'logout', $4, CURRENT_TIMESTAMP)
      `;
      
      await pool.query(logQuery, [userId, username, phoneNumber, ipAddress]);
      
      logger.info(`User logout logged: ${username} (ID: ${userId})`);
    } catch (error) {
      logger.error('Failed to log user logout', { 
        error: error.message, 
        userId, 
        username 
      });
    }
  }
};
