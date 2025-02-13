import { pool } from '../config/database.js';
import logger from '../config/logger.js';
import { User } from '../models/User.js';
import bcrypt from 'bcryptjs';

export class UserRepository {
  // Create a new user
  static async createUser(username, phoneNumber, password) {
    // Generate hashed password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    const query = `
      INSERT INTO users (
        username, 
        phone_number, 
        password_hash, 
        is_active
      ) VALUES ($1, $2, $3, TRUE) 
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [
        username, 
        phoneNumber, 
        hashedPassword
      ]);

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
    const query = `
      SELECT * FROM users 
      WHERE phone_number = $1
    `;

    try {
      const result = await pool.query(query, [phoneNumber]);
      return result.rows.length > 0 ? User.fromRow(result.rows[0]) : null;
    } catch (error) {
      logger.error('Error finding user by phone number', { 
        phoneNumber, 
        errorMessage: error.message 
      });
      throw error;
    }
  }

  // Authenticate user
  static async authenticate(phoneNumber, password) {
    const user = await this.findByPhoneNumber(phoneNumber);
    
    if (!user) return null;

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    
    if (isMatch) {
      // Update last login
      await this.updateLastLogin(user.id);
      return user;
    }

    return null;
  }

  // Update last login timestamp
  static async updateLastLogin(userId) {
    const query = `
      UPDATE users 
      SET last_login = CURRENT_TIMESTAMP 
      WHERE id = $1
    `;

    try {
      await pool.query(query, [userId]);
    } catch (error) {
      logger.error('Error updating last login', { 
        userId, 
        errorMessage: error.message 
      });
    }
  }
}
