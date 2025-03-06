import { pool } from '../config/database.js';
import logger from '../config/logger.js';
import { User } from '../models/User.js';
import bcrypt from 'bcryptjs';

export class UserRepository {
  // Create a new user
  static async createUser(username, phoneNumber, password, role = 'player') {
    // Generate salt and hashed password
    const saltRounds = 10;
    const salt = await bcrypt.genSalt(saltRounds);
    const hashedPassword = await bcrypt.hash(password, salt);
    
    const query = `
      INSERT INTO users (
        username, 
        phone_number, 
        password_hash, 
        salt,
        role,
        verification_status,
        is_active,
        referral_code
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
      RETURNING *
    `;

    try {
      const referralCode = this.generateReferralCode();
      
      const result = await pool.query(query, [
        username, 
        phoneNumber, 
        hashedPassword,
        salt,
        role,
        'unverified',
        true,
        referralCode
      ]);

      logger.info('USER_CREATED', {
        userId: result.rows[0].user_id,
        username,
        phoneNumber,
        role
      });

      return result.rows.length > 0 ? User.fromRow(result.rows[0]) : null;
    } catch (error) {
      logger.error('Error creating user', { 
        username, 
        phoneNumber, 
        errorMessage: error.message 
      });
      throw error;
    }
  }

  // Find user by phone number
  static async findByPhoneNumber(phoneNumber) {
    // Normalize phone number to remove non-digit characters
    const normalizedPhoneNumber = phoneNumber.replace(/[^\d]/g, '');
    
    // Try different phone number formats
    const phoneNumberVariants = [
      normalizedPhoneNumber,
      `+${normalizedPhoneNumber}`,
      `0${normalizedPhoneNumber.slice(-9)}`,
      `254${normalizedPhoneNumber.slice(-9)}`
    ];

    const query = `
      SELECT * FROM users 
      WHERE phone_number = ANY($1)
    `;

    try {
      logger.debug('USER_LOOKUP_QUERY', {
        query: query,
        phoneNumber: phoneNumber,
        normalizedPhoneNumber: normalizedPhoneNumber,
        phoneNumberVariants: phoneNumberVariants
      });

      const result = await pool.query(query, [phoneNumberVariants]);
      
      logger.debug('USER_LOOKUP', {
        phoneNumber,
        usersFound: result.rows.length,
        userDetails: result.rows.map(row => ({
          userId: row.user_id,
          username: row.username,
          phoneNumber: row.phone_number,
          role: row.role,
          isActive: row.is_active,
          verificationStatus: row.verification_status
        }))
      });

      return result.rows.length > 0 ? User.fromRow(result.rows[0]) : null;
    } catch (error) {
      logger.error('Error finding user by phone number', { 
        phoneNumber, 
        normalizedPhoneNumber,
        phoneNumberVariants,
        errorMessage: error.message,
        errorCode: error.code,
        errorStack: error.stack
      });
      
      // Log additional database connection details
      try {
        const client = await pool.connect();
        const tableQuery = `
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'users'
        `;
        const tableResult = await client.query(tableQuery);
        client.release();

        logger.debug('USERS_TABLE_COLUMNS', {
          columns: tableResult.rows.map(row => row.column_name)
        });
      } catch (connectionError) {
        logger.error('Error checking table columns', {
          errorMessage: connectionError.message
        });
      }

      throw error;
    }
  }

  // Authenticate user
  static async authenticate(phoneNumber, password) {
    try {
      const user = await this.findByPhoneNumber(phoneNumber);
      
      if (!user) return null;

      // Compare password using bcrypt
      const isMatch = await bcrypt.compare(password, user.passwordHash);
      
      if (isMatch) {
        // Update last login
        await this.updateLastLogin(user.userId);
        return user;
      }

      return null;
    } catch (error) {
      logger.error('Authentication Error', {
        phoneNumber,
        errorMessage: error.message
      });
      throw error;
    }
  }

  // Update last login timestamp
  static async updateLastLogin(userId) {
    const query = `
      UPDATE users 
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
      SELECT * FROM users 
      WHERE user_id = $1
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
