import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken'; // Import jwt
import { pool } from '../config/database.js';
import logger from '../config/logger.js';
import phoneValidator from '../utils/phoneValidator.js'; 
import { WalletRepository } from '../repositories/walletRepository.js';
import { validateToken, generateToken, normalizePhoneNumber } from '../utils/authUtils.js'; // Import shared authentication utilities

const balanceService = {
  // Initialize wallet for new user
  async syncUserBalanceToWallet(userId) {
    const client = await pool.connect();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Create wallet if it doesn't exist
      const upsertWalletQuery = `
        INSERT INTO wallets (wallet_id, user_id, balance, currency) 
        VALUES ($1, $2, 0, 'KSH')
        ON CONFLICT (user_id) DO NOTHING
      `;
      await client.query(upsertWalletQuery, [uuidv4(), userId]);

      // Commit transaction
      await client.query('COMMIT');

      logger.info('Wallet initialized', { 
        userId
      });

      return 0;
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      logger.error('Wallet initialization failed', { 
        userId, 
        errorMessage: error.message 
      });
      throw error;
    } finally {
      client.release();
    }
  },

  // Get wallet balance
  async getWalletBalance(userId) {
    try {
      const walletQuery = `
        SELECT balance, currency 
        FROM wallets 
        WHERE user_id = $1
      `;
      const result = await pool.query(walletQuery, [userId]);
      if (result.rows.length > 0) {
        const { balance, currency } = result.rows[0];
        return {
          balance: parseFloat(balance),
          currency,
          formattedBalance: `${currency} ${parseFloat(balance).toFixed(2)}`
        };
      }
      return {
        balance: 0,
        currency: 'KSH',
        formattedBalance: 'KSH 0.00'
      };
    } catch (error) {
      logger.error('Failed to get wallet balance', {
        userId,
        error: error.message
      });
      return {
        balance: 0,
        currency: 'KSH',
        formattedBalance: 'KSH 0.00'
      };
    }
  }
};

const formatBalance = (balance, currency = 'KSH') => {
  // Ensure balance is a number and format with two decimal places
  const formattedBalance = Number(balance).toFixed(2);
  
  // Return balance with currency symbol before the amount
  return `${currency} ${formattedBalance}`;
};

export const authService = {
  async register(username, phoneNumber, password) {
    const client = await pool.connect();

    try {
      // Start a database transaction
      await client.query('BEGIN');

      logger.info('Starting user registration process', {
        username: username,
        phoneNumber: phoneNumber.replace(/\d{4}/, '****')
      });

      // Validate username length with more detailed logging
      if (!username) {
        logger.error('REGISTER_USERNAME_MISSING', {
          errorCode: 'USERNAME_REQUIRED',
          message: 'Username is a required field',
          providedUsername: username
        });
        throw new Error('Username is required');
      }

      if (username.length < 3) {
        logger.error('REGISTER_USERNAME_TOO_SHORT', {
          errorCode: 'USERNAME_TOO_SHORT',
          usernameLength: username.length,
          minRequiredLength: 3,
          providedUsername: username.substring(0, 1) + '***'
        });
        throw new Error('Username must be at least 3 characters long');
      }

      // Validate username characters
      const usernameRegex = /^[a-zA-Z0-9_]+$/;
      if (!usernameRegex.test(username)) {
        logger.error('REGISTER_USERNAME_INVALID_CHARS', {
          errorCode: 'USERNAME_INVALID_CHARS',
          message: 'Username can only contain letters, numbers, and underscores',
          providedUsername: username.substring(0, 1) + '***'
        });
        throw new Error('Username can only contain letters, numbers, and underscores');
      }

      // Validate password strength with more detailed logging
      if (!password) {
        logger.error('REGISTER_PASSWORD_MISSING', {
          errorCode: 'PASSWORD_REQUIRED',
          message: 'Password is a required field'
        });
        throw new Error('Password is required');
      }

      if (password.length < 8) {
        logger.error('REGISTER_WEAK_PASSWORD', {
          errorCode: 'PASSWORD_TOO_SHORT',
          passwordLength: password.length,
          minRequiredLength: 8
        });
        throw new Error('Password must be at least 8 characters long');
      }

      // Additional password complexity checks
      const passwordComplexityChecks = [
        { regex: /[A-Z]/, errorCode: 'PASSWORD_NO_UPPERCASE', message: 'Password must contain at least one uppercase letter' },
        { regex: /[a-z]/, errorCode: 'PASSWORD_NO_LOWERCASE', message: 'Password must contain at least one lowercase letter' },
        { regex: /[0-9]/, errorCode: 'PASSWORD_NO_NUMBER', message: 'Password must contain at least one number' },
        { regex: /[!@#$%^&*(),.?":{}|<>]/, errorCode: 'PASSWORD_NO_SPECIAL_CHAR', message: 'Password must contain at least one special character' }
      ];

      for (const check of passwordComplexityChecks) {
        if (!check.regex.test(password)) {
          logger.error('REGISTER_PASSWORD_COMPLEXITY_FAILED', {
            errorCode: check.errorCode,
            message: check.message
          });
          throw new Error(check.message);
        }
      }

      // Validate phone number
      const validationResult = phoneValidator.validate(phoneNumber);
      if (!validationResult.isValid) {
        logger.error('REGISTER_INVALID_PHONE_NUMBER', {
          originalPhoneNumber: phoneNumber,
          validationError: validationResult.error,
          supportedFormats: validationResult.supportedFormats
        });
        throw new Error(validationResult.error);
      }

      // Check if user already exists - UPDATED column name
      const existingUserQuery = 'SELECT * FROM users WHERE phone = $1 OR username = $2';
      const existingUserResult = await client.query(existingUserQuery, [validationResult.normalizedNumber, username]);
      
      if (existingUserResult.rows.length > 0) {
        logger.error('Registration failed', {
          reason: 'User already exists'
        });
        throw new Error('User with this phone number or username already exists');
      }

      // Insert new user with correct column names
      const insertQuery = `
        INSERT INTO users (
          username, 
          phone, 
          pwd_hash, 
          salt,
          role,
          created_at
        ) 
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP) 
        RETURNING user_id, username, phone, role, created_at
      `;
      
      let result;
      try {
        // Generate salt for password
        const saltRounds = 10;
        const salt = await bcrypt.genSalt(saltRounds);
        const passwordHash = await bcrypt.hash(password, salt);
        
        // Insert user
        result = await client.query(insertQuery, [
          username, 
          validationResult.normalizedNumber, 
          passwordHash, 
          salt,
          'player' // default role
        ]);
        
        const userId = result.rows[0].user_id;
        
        logger.info('User created successfully', {
          userId,
          username
        });
        
        // Also create user profile
        const profileQuery = `
          INSERT INTO user_profiles (
            user_id, 
            ver_status, 
            is_active,
            updated_at
          ) 
          VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        `;
        
        await client.query(profileQuery, [
          userId,
          'unverified',
          true
        ]);
        
        logger.info('User profile created', {
          userId
        });

        // Commit the transaction to ensure user is created
        await client.query('COMMIT');

        // Create wallet for the new user in a separate transaction
        await WalletRepository.createWallet(userId);

      } catch (insertError) {
        // Rollback transaction on error
        await client.query('ROLLBACK');
        logger.error('User insert error', {
          errorMessage: insertError.message,
          errorCode: insertError.code,
          username: username
        });
        
        throw new Error(insertError.code === '23505' ? 
          'Username or phone number already exists' : 
          'Error creating user account');
      }

      logger.info('User registered successfully', {
        username: username,
        userId: result.rows[0].user_id,
        isActive: true
      });

      return {
        ...result.rows[0],
        is_active: true
      };
    } catch (error) {
      logger.error('Registration error', {
        username,
        error: error.message,
        stack: error.stack
      });
      
      throw error;
    } finally {
      client.release();
    }
  },

  async login(phoneNumber, password) {
    // Create a unique trace ID for this login attempt
    const traceId = crypto.randomUUID();

    try {
      logger.info(`[${traceId}] Login attempt started`, {
        phoneNumber: phoneNumber.replace(/\d{4}/, '****'),
        timestamp: new Date().toISOString()
      });

      // Validate password presence
      if (!password) {
        logger.error(`[${traceId}] LOGIN_MISSING_PASSWORD`);
        throw new Error('Password is required');
      }

      // Validate phone number
      const validationResult = phoneValidator.validate(phoneNumber);
      if (!validationResult.isValid) {
        logger.error(`[${traceId}] LOGIN_INVALID_PHONE_NUMBER`, {
          originalPhoneNumber: phoneNumber,
          validationError: validationResult.error,
          supportedFormats: validationResult.supportedFormats
        });
        throw new Error(validationResult.error);
      }

      // Use normalized phone number for further processing
      const normalizedPhoneNumber = validationResult.normalizedNumber;

      // Find user by normalized phone number with updated column names and table join
      const userQuery = `
        SELECT 
          u.user_id,
          u.username,
          u.pwd_hash,
          u.phone,
          u.role,
          p.is_active,
          p.last_login,
          u.created_at,
          p.updated_at
        FROM users u
        LEFT JOIN user_profiles p ON u.user_id = p.user_id
        WHERE u.phone = $1
      `;
      const userResult = await pool.query(userQuery, [normalizedPhoneNumber]);

      if (userResult.rows.length === 0) {
        logger.error(`[${traceId}] Login failed`, {
          reason: 'User not found',
          phoneNumber: normalizedPhoneNumber
        });
        throw new Error('Invalid phone number or password');
      }

      const user = userResult.rows[0];

      // Verify password
      const isPasswordValid = await bcrypt.compare(password, user.pwd_hash);

      if (!isPasswordValid) {
        logger.error(`[${traceId}] Login failed`, {
          reason: 'Invalid password',
          userId: user.user_id
        });
        throw new Error('Invalid phone number or password');
      }

      // Update last login in user_profiles table
      await pool.query('UPDATE user_profiles SET last_login = CURRENT_TIMESTAMP WHERE user_id = $1', [user.user_id]);

      // Initialize wallet if needed and get balance
      await balanceService.syncUserBalanceToWallet(user.user_id);
      const walletInfo = await balanceService.getWalletBalance(user.user_id);

      // Generate JWT token with updated field names - ensure user_id is numeric
      const token = jwt.sign(
        {
          user_id: parseInt(user.user_id, 10), // Ensure ID is a number
          username: user.username,
          role: user.role || 'player',
          phone: user.phone,
          is_active: user.is_active || false,
          ver_status: user.ver_status || 'unverified'
        },
        process.env.JWT_SECRET || '520274659b0b083575095c7f82961352a2bfa4d11c606b8e67c4d48d17be6237', 
        { expiresIn: '7d' }
      );

      logger.info(`[${traceId}] User JWT token generated`, {
        userId: user.user_id
      });

      // Remove sensitive information
      delete user.pwd_hash;

      return { 
        success: true,
        message: 'Login successful',
        token, 
        user: {
          userId: parseInt(user.user_id, 10), // Ensure ID is a number
          username: user.username,
          phone: user.phone,
          role: user.role || 'player',
          isActive: user.is_active || false,
          balance: walletInfo.balance,
          currency: walletInfo.currency,
          formattedBalance: walletInfo.formattedBalance
        }
      };
    } catch (error) {
      logger.error(`[${traceId}] Login error`, {
        reason: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  },

  async verifyUserToken(token) {
    if (!token) {
      throw new Error('No authentication token provided');
    }

    try {
      // Verify JWT token with multiple fallback options
      const JWT_SECRET = process.env.JWT_SECRET || 
                         process.env.REACT_APP_JWT_SECRET || 
                         '520274659b0b083575095c7f82961352a2bfa4d11c606b8e67c4d48d17be6237';
      
      const decoded = jwt.verify(token, JWT_SECRET);
      
      return {
        id: decoded.user_id,
        username: decoded.username,
        role: decoded.role
      };
    } catch (error) {
      logger.error('User token verification failed', {
        errorMessage: error.message
      });
      throw new Error('Invalid or expired token');
    }
  },

  async authenticateUserByToken(token) {
    try {
      // Use shared token validation first
      const decoded = await validateToken(token);

      // Check if the token is valid in Redis
      // const redisClient = await redisRepository.getClient();
      // const userTokenKey = `user_token:${token}`;
      // const userData = await redisClient.get(userTokenKey);

      // if (!userData) {
      //   logger.warn('Token validation failed', { 
      //     message: 'Invalid or expired token',
      //     token: token 
      //   });
      //   throw new Error('Invalid or expired token');
      // }

      // const parsedUserData = JSON.parse(userData);
      logger.info('Token successfully validated', { 
        userId: decoded.user_id,
        timestamp: new Date().toISOString()
      });

      return decoded;
    } catch (error) {
      logger.error('Token authentication error', {
        errorMessage: error.message,
        token: token,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  },

  async getProfile(userId) {
    try {
      const query = `
        SELECT 
          user_id, username, phone, role, 
          created_at 
        FROM users 
        WHERE user_id = $1
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

  async getUserProfile(userId, autoActivate = false) {
    // Validate that userId is an integer
    if (!Number.isInteger(userId)) {
        throw new Error(`Invalid input syntax for type integer: "${userId}"`);
    }

    try {
      logger.debug('FETCHING_USER_PROFILE', {
        userId,
        autoActivate
      });

      // First get user data with correct column names
      const userQuery = `
        SELECT 
          u.user_id,
          u.username,
          u.phone,
          u.role,
          p.is_active,
          p.last_login,
          p.last_pwd_change,
          u.created_at,
          p.updated_at
        FROM users u
        LEFT JOIN user_profiles p ON u.user_id = p.user_id
        WHERE u.user_id = $1
      `;
      
      const userResult = await pool.query(userQuery, [userId]);
      
      if (userResult.rows.length === 0) {
        logger.warn('USER_PROFILE_NOT_FOUND', {
          userId,
          autoActivate
        });

        // Insert default profile for valid tokens
        const defaultProfile = {
          user_id: userId || crypto.randomUUID(),
          username: 'Guest User',
          phone: '', // Changed from phone_number to phone
          role: 'player',
          is_active: true,
          created_at: new Date(),
          updated_at: new Date()
        };

        // Insert default profile
        const insertQuery = `
          INSERT INTO users (
            user_id, 
            username, 
            phone, 
            role, 
            pwd_hash, 
            salt
          ) VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *
        `;

        // Generate a secure random password hash for default profile
        const defaultPasswordHash = await bcrypt.hash(crypto.randomUUID(), 10);
        
        // Generate a secure random salt
        const salt = crypto.randomBytes(16).toString('hex');

        const insertResult = await pool.query(insertQuery, [
          defaultProfile.user_id,
          defaultProfile.username,
          defaultProfile.phone,
          defaultProfile.role,
          defaultPasswordHash,
          salt
        ]);

        // Also create profile
        const profileQuery = `
          INSERT INTO user_profiles (
            user_id,
            is_active,
            updated_at
          ) VALUES ($1, $2, $3)
        `;

        await pool.query(profileQuery, [
          defaultProfile.user_id,
          true,
          new Date()
        ]);

        return insertResult.rows[0];
      }

      const userProfile = userResult.rows[0];

      // Get wallet data
      const walletQuery = `
        SELECT balance, currency 
        FROM wallets 
        WHERE user_id = $1
      `;
      
      try {
        const walletResult = await pool.query(walletQuery, [userId]);
        if (walletResult.rows.length > 0) {
          const { balance, currency } = walletResult.rows[0];
          userProfile.balance = {
            balance: parseFloat(balance),
            currency,
            formattedBalance: `${currency} ${parseFloat(balance).toFixed(2)}`
          };
        } else {
          userProfile.balance = {
            balance: 0,
            currency: 'KSH',
            formattedBalance: 'KSH 0.00'
          };
        }
      } catch (walletError) {
        logger.warn('Failed to fetch wallet balance', {
          userId,
          error: walletError.message
        });
        userProfile.balance = {
          balance: 0,
          currency: 'KSH',
          formattedBalance: 'KSH 0.00'
        };
      }
      
      // Debug log for username
      logger.debug('RETRIEVED_USER_PROFILE', {
        userId,
        username: userProfile.username
      });

      // If auto-activate is enabled and user is not active
      if (autoActivate && !userProfile.is_active) {
        return await this.autoActivateUserAccount(userProfile);
      }

      return userProfile;

    } catch (error) {
      logger.error('ERROR_FETCHING_USER_PROFILE', {
        userId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  },

  async updateProfile(userId, updateData) {
    try {
      const { username, phone } = updateData;

      // UPDATED column name
      const updateQuery = `
        UPDATE users 
        SET 
          username = COALESCE($1, username), 
          phone = COALESCE($2, phone)
        WHERE user_id = $3
        RETURNING user_id, username, phone, role
      `;

      const validationResult = phoneValidator.validate(phone);
      if (!validationResult.isValid) {
        logger.error('PROFILE_UPDATE_INVALID_PHONE_NUMBER', {
          originalPhoneNumber: phone,
          validationError: validationResult.error,
          supportedFormats: validationResult.supportedFormats
        });
        throw new Error(validationResult.error);
      }

      const result = await pool.query(updateQuery, [username, validationResult.normalizedNumber, userId]);
      
      if (result.rows.length === 0) {
        throw new Error('User not found');
      }

      logger.info('PROFILE_UPDATE_SUCCESS', {
        userId: result.rows[0].user_id,
        phoneNumber: result.rows[0].phone
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
  },

  /**
   * Activate a user account
   * @param {string} userId - ID of the user to activate
   * @returns {Promise<Object>} Updated user profile
   */
  async activateUserAccount(userId) {
    const client = await pool.connect();
    try {
      // Start transaction
      await client.query('BEGIN');

      // Update user account status
      const activateUserQuery = `
        UPDATE users
        SET 
          is_active = true, 
          updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1
        RETURNING *
      `;
      const activationResult = await client.query(activateUserQuery, [userId]);

      // Check if user was found and updated
      if (activationResult.rows.length === 0) {
        throw new Error('User not found');
      }

      // Commit transaction
      await client.query('COMMIT');

      // Log successful account activation
      logger.info('USER_ACCOUNT_ACTIVATED', {
        userId,
        username: activationResult.rows[0].username
      });

      // Return updated user profile
      return this.getUserProfile(userId);
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      logger.error('USER_ACCOUNT_ACTIVATION_FAILED', {
        userId,
        errorMessage: error.message,
        errorStack: error.stack
      });

      throw error;
    } finally {
      client.release();
    }
  },

  /**
   * Bulk activate user accounts
   * @param {string[]} userIds - Array of user IDs to activate
   * @returns {Promise<Object[]>} Array of activated user profiles
   */
  async bulkActivateUserAccounts(userIds) {
    const client = await pool.connect();
    try {
      // Start transaction
      await client.query('BEGIN');

      // Bulk update user account statuses
      const bulkActivateQuery = `
        UPDATE users
        SET 
          is_active = true, 
          updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ANY($1)
        RETURNING user_id
      `;
      const bulkActivationResult = await client.query(bulkActivateQuery, [userIds]);

      // Commit transaction
      await client.query('COMMIT');

      // Log successful bulk account activation
      logger.info('BULK_USER_ACCOUNTS_ACTIVATED', {
        totalActivated: bulkActivationResult.rows.length,
        userIds
      });

      // Fetch and return updated user profiles
      const activatedProfiles = await Promise.all(
        bulkActivationResult.rows.map(row => this.getUserProfile(row.user_id))
      );

      return activatedProfiles;
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      logger.error('BULK_USER_ACCOUNT_ACTIVATION_FAILED', {
        userIds,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    } finally {
      client.release();
    }
  },

  async storeRefreshToken(userId, refreshToken, tokenSalt) {
    const client = await pool.connect();
    try {
      // Hash the refresh token before storage for additional security
      const hashedToken = crypto.createHash('sha256')
        .update(refreshToken + tokenSalt)
        .digest('hex');

      await client.query(
        `INSERT INTO user_refresh_tokens 
        (user_id, token, token_salt, created_at, expires_at, is_revoked) 
        VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '7 days', FALSE) 
        ON CONFLICT (user_id) DO UPDATE 
        SET 
          token = $2, 
          token_salt = $3, 
          created_at = NOW(), 
          expires_at = NOW() + INTERVAL '7 days', 
          is_revoked = FALSE`,
        [userId, hashedToken, tokenSalt]
      );

      logger.info('REFRESH_TOKEN_STORED', {
        userId,
        tokenStored: true
      });
    } catch (error) {
      logger.error('REFRESH_TOKEN_STORAGE_CRITICAL_FAILURE', {
        userId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw new Error('Critical failure in refresh token storage');
    } finally {
      client.release();
    }
  },

  async refreshAccessToken(refreshToken) {
    try {
      // Comprehensive token verification
      const decoded = jwt.verify(
        refreshToken, 
        process.env.JWT_SECRET || '520274659b0b083575095c7f82961352a2bfa4d11c606b8e67c4d48d17be6237'
      );

      // Validate token type and structure
      if (decoded.type !== 'refresh' || !decoded.userId) {
        logger.error('INVALID_REFRESH_TOKEN_STRUCTURE', {
          tokenType: decoded.type,
          hasUserId: !!decoded.userId
        });
        throw new Error('Invalid refresh token structure');
      }

      // Check token in database
      const client = await pool.connect();
      try {
        const hashedToken = crypto.createHash('sha256')
          .update(refreshToken + (decoded.salt || ''))
          .digest('hex');

        const tokenCheck = await client.query(
          `SELECT * FROM user_refresh_tokens 
           WHERE user_id = $1 AND token = $2 AND is_revoked = FALSE AND expires_at > NOW()`,
          [decoded.userId, hashedToken]
        );

        if (tokenCheck.rows.length === 0) {
          logger.error('REFRESH_TOKEN_INVALID_OR_REVOKED', {
            userId: decoded.userId
          });
          throw new Error('Refresh token is invalid or has been revoked');
        }

        // Retrieve user profile 
        const userProfile = await this.getUserProfile(decoded.userId);
        if (!userProfile) {
          throw new Error('User not found');
        }

        // Generate new access token with correct field names
        const accessToken = jwt.sign(
          {
            user_id: userProfile.user_id,
            username: userProfile.username,
            phone: userProfile.phone,  // Changed from phone_number to phone
            is_active: userProfile.is_active || false,
            ver_status: userProfile.ver_status || 'unverified'
          },
          process.env.JWT_SECRET || '520274659b0b083575095c7f82961352a2bfa4d11c606b8e67c4d48d17be6237', 
          { expiresIn: '15m' }
        );

        // Generate new refresh token
        const newRefreshToken = await this.generateRefreshToken(userProfile.user_id);

        logger.info('ACCESS_TOKEN_REFRESHED', { 
          userId: userProfile.user_id,
          username: userProfile.username
        });

        return {
          accessToken,
          refreshToken: newRefreshToken,
          user: {
            user_id: userProfile.user_id,
            username: userProfile.username
          }
        };
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error('ACCESS_TOKEN_REFRESH_CRITICAL_FAILURE', {
        errorMessage: error.message,
        errorName: error.name,
        errorStack: error.stack
      });

      // Specific error handling
      if (error.name === 'TokenExpiredError') {
        throw new Error('Refresh token expired. Please login again.');
      }
      if (error.name === 'JsonWebTokenError') {
        throw new Error('Invalid refresh token. Please login again.');
      }
      throw error;
    }
  },

  async revokeRefreshToken(userId) {
    const client = await pool.connect();
    try {
      await client.query(
        'UPDATE user_refresh_tokens SET is_revoked = TRUE WHERE user_id = $1',
        [userId]
      );
      
      logger.info('REFRESH_TOKEN_REVOKED', { 
        userId,
        revocationMethod: 'mark_revoked'
      });
    } catch (error) {
      logger.error('REFRESH_TOKEN_REVOCATION_CRITICAL_FAILURE', {
        userId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw new Error('Critical failure in refresh token revocation');
    } finally {
      client.release();
    }
  }
};

export { balanceService };
