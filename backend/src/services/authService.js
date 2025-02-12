import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../config/database.js';
import logger from '../config/logger.js';
import { walletService } from './walletService.js'; // Import walletService

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_here';
const JWT_EXPIRATION = '7d';

const balanceService = {
  // Sync balance from users table to wallets table
  async syncUserBalanceToWallet(userId) {
    const client = await pool.connect();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Get user's current balance from users table
      const userBalanceQuery = `
        SELECT balance FROM users WHERE id = $1
      `;
      const userBalanceResult = await client.query(userBalanceQuery, [userId]);
      const currentUserBalance = userBalanceResult.rows[0].balance;

      // Update or create wallet with the user's balance
      const upsertWalletQuery = `
        INSERT INTO wallets (user_id, balance, currency)
        VALUES ($1, $2, 'KSH')
        ON CONFLICT (user_id) DO UPDATE 
        SET balance = $2, updated_at = CURRENT_TIMESTAMP
      `;
      await client.query(upsertWalletQuery, [userId, currentUserBalance]);

      // Commit transaction
      await client.query('COMMIT');

      logger.info('User balance synced to wallet', { 
        userId, 
        balance: currentUserBalance 
      });

      return currentUserBalance;
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      logger.error('Balance sync failed', { 
        userId, 
        errorMessage: error.message 
      });
      throw error;
    } finally {
      client.release();
    }
  },

  // Sync balance from wallets table to users table
  async syncWalletBalanceToUser(userId) {
    const client = await pool.connect();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Get wallet balance
      const walletBalanceQuery = `
        SELECT balance FROM wallets WHERE user_id = $1
      `;
      const walletBalanceResult = await client.query(walletBalanceQuery, [userId]);
      const currentWalletBalance = walletBalanceResult.rows[0].balance;

      // Update users table balance
      const updateUserBalanceQuery = `
        UPDATE users 
        SET balance = $2, updated_at = CURRENT_TIMESTAMP 
        WHERE id = $1
      `;
      await client.query(updateUserBalanceQuery, [userId, currentWalletBalance]);

      // Commit transaction
      await client.query('COMMIT');

      logger.info('Wallet balance synced to user', { 
        userId, 
        balance: currentWalletBalance 
      });

      return currentWalletBalance;
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      logger.error('Wallet balance sync failed', { 
        userId, 
        errorMessage: error.message 
      });
      throw error;
    } finally {
      client.release();
    }
  },

  // Initialize wallet during user registration with existing balance
  async initializeWalletFromUserBalance(userId) {
    const client = await pool.connect();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Get user's current balance from users table
      const userBalanceQuery = `
        SELECT balance FROM users WHERE id = $1
      `;
      const userBalanceResult = await client.query(userBalanceQuery, [userId]);
      const currentUserBalance = userBalanceResult.rows[0].balance;

      // Create wallet with user's existing balance
      const createWalletQuery = `
        INSERT INTO wallets (user_id, balance, currency)
        VALUES ($1, $2, 'KSH')
        ON CONFLICT (user_id) DO NOTHING
      `;
      await client.query(createWalletQuery, [userId, currentUserBalance]);

      // Commit transaction
      await client.query('COMMIT');

      logger.info('Wallet initialized from user balance', { 
        userId, 
        balance: currentUserBalance 
      });

      return currentUserBalance;
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      logger.error('Wallet initialization from user balance failed', { 
        userId, 
        errorMessage: error.message 
      });
      throw error;
    } finally {
      client.release();
    }
  }
};

export const authService = {
  async register(username, phoneNumber, password) {
    try {
      // Log registration attempt with sensitive info redacted
      logger.info('REGISTER_ATTEMPT', {
        username: username,
        phoneNumber: phoneNumber.replace(/\d{4}/, '****'),
        timestamp: new Date().toISOString()
      });

      // Validate username length
      if (username.length < 3) {
        logger.error('REGISTER_USERNAME_TOO_SHORT', {
          usernameLength: username.length
        });
        throw new Error('Username must be at least 3 characters long');
      }

      // Validate password strength
      if (password.length < 8) {
        logger.error('REGISTER_WEAK_PASSWORD', {
          passwordLength: password.length
        });
        throw new Error('Password must be at least 8 characters long');
      }

      // Check if user already exists
      const existingUserQuery = 'SELECT * FROM users WHERE phone_number = $1 OR username = $2';
      const existingUserResult = await pool.query(existingUserQuery, [phoneNumber, username]);
      
      if (existingUserResult.rows.length > 0) {
        logger.error('REGISTER_USER_EXISTS', {
          existingUserCount: existingUserResult.rows.length,
          conflictFields: existingUserResult.rows.map(user => ({
            phoneNumberMatch: user.phone_number === phoneNumber,
            usernameMatch: user.username === username
          }))
        });
        throw new Error('User with this phone number or username already exists');
      }

      // Hash password
      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);

      // Insert new user
      const insertQuery = `
        INSERT INTO users (username, phone_number, password_hash) 
        VALUES ($1, $2, $3) 
        RETURNING id, username, phone_number, role, created_at
      `;
      const result = await pool.query(insertQuery, [username, phoneNumber, passwordHash]);

      // After successful user creation, create wallet
      // Create wallet for the new user
      const newUser = result.rows[0];
      await balanceService.initializeWalletFromUserBalance(newUser.id);

      logger.info('REGISTER_SUCCESS', {
        userId: result.rows[0].id,
        username: result.rows[0].username,
        phoneNumber: result.rows[0].phone_number
      });

      return result.rows[0];
    } catch (error) {
      logger.error('REGISTER_FATAL_ERROR', {
        errorMessage: error.message,
        errorStack: error.stack,
        username: username,
        phoneNumberRedacted: phoneNumber.replace(/\d{4}/, '****')
      });
      throw error;
    }
  },

  async login(phoneNumber, password) {
    try {
      // Log login attempt with sensitive info redacted
      logger.info('LOGIN_ATTEMPT', {
        phoneNumber: phoneNumber.replace(/\d{4}/, '****'),
        timestamp: new Date().toISOString()
      });

      // Validate password presence
      if (!password) {
        logger.error('LOGIN_MISSING_PASSWORD');
        throw new Error('Password is required');
      }

      // Normalize phone number formats
      let normalizedPhoneNumber;
      
      // Remove any non-digit characters
      const cleanedNumber = phoneNumber.replace(/[^\d]/g, '');
      
      // Support three formats:
      // 1. +254712345678
      // 2. 0712345678
      // 3. 0112345678
      if (cleanedNumber.startsWith('254')) {
        normalizedPhoneNumber = '+' + cleanedNumber;
      } else if (cleanedNumber.startsWith('0')) {
        normalizedPhoneNumber = '+254' + cleanedNumber.slice(1);
      } else {
        normalizedPhoneNumber = '+254' + cleanedNumber;
      }

      // Log normalized phone number
      logger.info('LOGIN_PHONE_NORMALIZATION', {
        originalNumber: phoneNumber.replace(/\d{4}/, '****'),
        normalizedNumber: normalizedPhoneNumber.replace(/\d{4}/, '****')
      });

      // Find user by normalized phone number
      const userQuery = 'SELECT * FROM users WHERE phone_number = $1';
      const userResult = await pool.query(userQuery, [normalizedPhoneNumber]);

      if (userResult.rows.length === 0) {
        // If no user found, try alternative normalization
        const alternativeQuery = 'SELECT * FROM users WHERE phone_number IN ($1, $2, $3)';
        const alternativeResult = await pool.query(alternativeQuery, [
          normalizedPhoneNumber,
          '+254' + cleanedNumber,
          cleanedNumber
        ]);

        if (alternativeResult.rows.length === 0) {
          logger.error('LOGIN_USER_NOT_FOUND', {
            attemptedPhoneNumbers: [
              normalizedPhoneNumber,
              '+254' + cleanedNumber,
              cleanedNumber
            ]
          });
          throw new Error('Invalid phone number or password');
        }

        // Use the first matching user
        userResult.rows[0] = alternativeResult.rows[0];
      }

      const user = userResult.rows[0];

      // Compare passwords
      const isPasswordValid = await bcrypt.compare(password, user.password_hash);
      if (!isPasswordValid) {
        logger.error('LOGIN_INVALID_PASSWORD', {
          userId: user.id,
          username: user.username
        });
        throw new Error('Invalid phone number or password');
      }

      // Update last login
      await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

      // Generate JWT token
      const token = jwt.sign(
        { 
          id: user.id, 
          phone_number: user.phone_number, 
          username: user.username, 
          role: user.role 
        }, 
        JWT_SECRET, 
        { expiresIn: JWT_EXPIRATION }
      );

      // Remove sensitive information
      delete user.password_hash;

      logger.info('LOGIN_SUCCESS', {
        userId: user.id,
        username: user.username,
        phoneNumber: user.phone_number
      });

      return { user, token };
    } catch (error) {
      logger.error('LOGIN_FATAL_ERROR', {
        errorMessage: error.message,
        errorStack: error.stack,
        phoneNumberRedacted: phoneNumber.replace(/\d{4}/, '****')
      });
      throw error;
    }
  },

  async getProfile(userId) {
    try {
      const query = `
        SELECT id, username, phone_number, balance, role, is_verified, last_login, created_at 
        FROM users 
        WHERE id = $1
      `;
      const result = await pool.query(query, [userId]);

      if (result.rows.length === 0) {
        throw new Error('User not found');
      }

      return result.rows[0];
    } catch (error) {
      logger.error('PROFILE_RETRIEVAL_ERROR', {
        errorMessage: error.message,
        errorStack: error.stack,
        userId: userId
      });
      throw error;
    }
  },

  async updateProfile(userId, updateData) {
    try {
      const { username, phoneNumber } = updateData;
      
      const updateQuery = `
        UPDATE users 
        SET 
          username = COALESCE($1, username), 
          phone_number = COALESCE($2, phone_number)
        WHERE id = $3
        RETURNING id, username, phone_number, role
      `;
      
      const result = await pool.query(updateQuery, [username, phoneNumber, userId]);

      if (result.rows.length === 0) {
        throw new Error('User not found');
      }

      logger.info('PROFILE_UPDATE_SUCCESS', {
        userId: result.rows[0].id,
        username: result.rows[0].username,
        phoneNumber: result.rows[0].phone_number
      });

      return result.rows[0];
    } catch (error) {
      logger.error('PROFILE_UPDATE_ERROR', {
        errorMessage: error.message,
        errorStack: error.stack,
        userId: userId
      });
      throw error;
    }
  }
};

export { balanceService };
