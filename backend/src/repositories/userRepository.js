import { pool } from '../config/database.js';
import logger from '../config/logger.js';
import { User } from '../models/User.js';
import bcrypt from 'bcryptjs';

export class UserRepository {
  // Create a new user
  static async createUser(username, phone, password, role = 'player') {
    const client = await pool.connect();
    
    try {
      // Begin transaction
      await client.query('BEGIN');
      
      // Generate salt and hashed password
      const saltRounds = 10;
      const salt = await bcrypt.genSalt(saltRounds);
      const hashedPassword = await bcrypt.hash(password, salt);
      
      // Insert into users table
      const userQuery = `
        INSERT INTO users (
          username, 
          phone, 
          pwd_hash, 
          salt,
          role
        ) VALUES ($1, $2, $3, $4, $5) 
        RETURNING *
      `;

      const userResult = await client.query(userQuery, [
        username, 
        phone, 
        hashedPassword,
        salt,
        role
      ]);
      
      const userId = userResult.rows[0].user_id;
      
      // Insert into user_profiles table
      const profileQuery = `
        INSERT INTO user_profiles (
          user_id,
          ver_status,
          is_active
        ) VALUES ($1, $2, $3)
        RETURNING *
      `;
      
      const profileResult = await client.query(profileQuery, [
        userId,
        'unverified',
        true
      ]);
      
      // Commit transaction
      await client.query('COMMIT');

      logger.info('USER_CREATED', {
        userId: userId,
        username,
        phone
      });

      return userResult.rows.length > 0 ? User.fromRow(userResult.rows[0], profileResult.rows[0]) : null;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error creating user', { 
        username, 
        phone, 
        errorMessage: error.message 
      });
      throw error;
    } finally {
      client.release();
    }
  }

  // Find user by phone number
  static async findByPhoneNumber(phoneNumber) {
    // Normalize phone number to remove non-digit characters
    const normalizedPhone = phoneNumber.replace(/[^\d]/g, '');
    
    // Try different phone number formats
    const phoneVariants = [
      normalizedPhone,
      `+${normalizedPhone}`,
      `0${normalizedPhone.slice(-9)}`,
      `254${normalizedPhone.slice(-9)}`
    ];

    const query = `
      SELECT u.*, p.* FROM users u
      LEFT JOIN user_profiles p ON u.user_id = p.user_id
      WHERE u.phone = ANY($1)
    `;

    try {
      logger.debug('USER_LOOKUP_QUERY', {
        query: query,
        phoneNumber: phoneNumber,
        normalizedPhone: normalizedPhone,
        phoneVariants: phoneVariants
      });

      const result = await pool.query(query, [phoneVariants]);
      
      logger.debug('USER_LOOKUP', {
        phoneNumber,
        usersFound: result.rows.length,
        userDetails: result.rows.map(row => ({
          userId: row.user_id,
          username: row.username,
          phone: row.phone,
          role: row.role,
          isActive: row.is_active,
          verStatus: row.ver_status
        }))
      });

      return result.rows.length > 0 ? User.fromRow(result.rows[0]) : null;
    } catch (error) {
      logger.error('Error finding user by phone number', { 
        phoneNumber, 
        normalizedPhone,
        phoneVariants,
        errorMessage: error.message,
        errorCode: error.code,
        errorStack: error.stack
      });
      
      throw error;
    }
  }

  // Authenticate user
  static async authenticate(phone, password) {
    try {
      const user = await this.findByPhoneNumber(phone);
      
      if (!user) return null;

      // Compare password using bcrypt
      const isMatch = await bcrypt.compare(password, user.pwdHash);
      
      if (isMatch) {
        // Update last login
        await this.updateLastLogin(user.userId);
        return user;
      }

      return null;
    } catch (error) {
      logger.error('Authentication Error', {
        phone,
        errorMessage: error.message
      });
      throw error;
    }
  }

  // Update last login timestamp
  static async updateLastLogin(userId) {
    const query = `
      UPDATE user_profiles 
      SET last_login = CURRENT_TIMESTAMP 
      WHERE user_id = $1
    `;

    try {
      await pool.query(query, [userId]);
      
      logger.debug('USER_LAST_LOGIN_UPDATED', {
        userId
      });
    } catch (error) {
      logger.error('Error updating last login', { 
        userId, 
        errorMessage: error.message 
      });
    }
  }

  // Generate a unique referral code
  static generateReferralCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  // Find user by ID
  static async findById(userId) {
    const query = `
      SELECT u.*, p.* FROM users u
      LEFT JOIN user_profiles p ON u.user_id = p.user_id
      WHERE u.user_id = $1
    `;

    try {
      logger.debug('USER_LOOKUP_BY_ID', {
        userId
      });

      const result = await pool.query(query, [userId]);
      
      logger.debug('USER_LOOKUP_RESULT', {
        userId,
        userFound: result.rows.length > 0
      });

      return result.rows.length > 0 ? User.fromRow(result.rows[0]) : null;
    } catch (error) {
      logger.error('Error finding user by ID', { 
        userId, 
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }
}
