import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken'; // Import jwt
import { pool } from '../config/database.js';
import logger from '../config/logger.js';
import phoneValidator from '../utils/phoneValidator.js'; 
import { WalletRepository } from '../repositories/walletRepository.js';
import redisRepository from '../redis-services/redisRepository.js';

const balanceService = {
  // Sync balance from users table to wallets table
  async syncUserBalanceToWallet(userId) {
    const client = await pool.connect();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Get user's current balance from users table
      const userBalanceQuery = `
        SELECT balance FROM users WHERE user_id = $1
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
        SET balance = $1, updated_at = CURRENT_TIMESTAMP 
        WHERE user_id = $2
      `;
      await client.query(updateUserBalanceQuery, [currentWalletBalance, userId]);

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
        SELECT balance FROM users WHERE user_id = $1
      `;
      const userBalanceResult = await client.query(userBalanceQuery, [userId]);
      const currentUserBalance = userBalanceResult.rows[0]?.balance || 0;

      logger.info('Wallet initialization attempt', {
        userId,
        userTableBalance: currentUserBalance
      });

      // Create or update wallet with user's existing balance
      const upsertWalletQuery = `
        INSERT INTO wallets (user_id, balance, currency, created_at, updated_at)
        VALUES ($1, $2, 'KSH', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id) DO UPDATE 
        SET balance = EXCLUDED.balance, 
            updated_at = CURRENT_TIMESTAMP
        RETURNING balance
      `;
      const walletResult = await client.query(upsertWalletQuery, [userId, currentUserBalance]);

      // Commit transaction
      await client.query('COMMIT');

      const finalWalletBalance = walletResult.rows[0]?.balance;

      logger.info('Wallet initialized successfully', { 
        userId, 
        initialBalance: currentUserBalance,
        finalWalletBalance: finalWalletBalance
      });

      return finalWalletBalance;
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      
      logger.error('Wallet initialization failed', { 
        userId, 
        errorMessage: error.message,
        errorStack: error.stack
      });

      // If initialization fails, return 0 to prevent login failure
      return 0;
    } finally {
      client.release();
    }
  },

  // Periodic balance synchronization
  async syncWalletAndUserBalances() {
    const traceId = uuidv4();
    try {
      logger.info(`[${traceId}] Starting comprehensive balance synchronization`);

      // Query to find discrepancies between wallet and user balances
      const discrepancyQuery = `
        SELECT 
          u.user_id, 
          u.balance AS user_balance, 
          w.balance AS wallet_balance,
          w.updated_at AS wallet_updated_at
        FROM users u
        JOIN wallets w ON u.user_id = w.user_id
        WHERE 
          ABS(u.balance - w.balance) > 0.01  -- Allow small floating-point differences
          OR u.balance IS NULL 
          OR w.balance IS NULL
      `;

      const discrepancyResult = await pool.query(discrepancyQuery);

      logger.info(`[${traceId}] Balance discrepancies found`, {
        discrepancyCount: discrepancyResult.rows.length
      });

      // Sync balances for users with discrepancies
      for (const discrepancy of discrepancyResult.rows) {
        const { user_id, wallet_balance, wallet_updated_at } = discrepancy;

        try {
          // Update user balance from wallet
          const updateUserQuery = `
            UPDATE users 
            SET 
              balance = $1, 
              updated_at = $2
            WHERE user_id = $3
          `;
          
          await pool.query(updateUserQuery, [
            parseFloat(wallet_balance), 
            wallet_updated_at, 
            user_id
          ]);

          logger.info(`[${traceId}] Balance synchronized for user`, {
            userId: user_id,
            newBalance: wallet_balance
          });
        } catch (updateError) {
          logger.error(`[${traceId}] Balance sync failed for user`, {
            userId: user_id,
            errorMessage: updateError.message
          });
        }
      }

      return discrepancyResult.rows.length;
    } catch (error) {
      logger.error(`[${traceId}] Comprehensive balance sync failed`, {
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  },
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

      logger.info('User registration', {
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

      // Check if user already exists
      const existingUserQuery = 'SELECT * FROM users WHERE phone_number = $1 OR username = $2';
      const existingUserResult = await client.query(existingUserQuery, [validationResult.normalizedNumber, username]);
      
      if (existingUserResult.rows.length > 0) {
        logger.error('Registration failed', {
          reason: 'User already exists'
        });
        throw new Error('User with this phone number or username already exists');
      }

      // Generate salt
      const saltRounds = 10;
      const salt = await bcrypt.genSalt(saltRounds);

      // Hash password
      const passwordHash = await bcrypt.hash(password, salt);

      // Generate unique user ID
      const userId = uuidv4();

      // Insert new user with additional error handling
      const insertQuery = `
        INSERT INTO users (
          user_id, 
          username, 
          phone_number, 
          password_hash, 
          salt,
          is_active,  
          created_at,
          updated_at
        ) 
        VALUES ($1, $2, $3, $4, $5, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) 
        RETURNING user_id, username, phone_number, role, is_active, created_at
      `;
      
      let result;
      try {
        result = await client.query(insertQuery, [
          userId, 
          username, 
          validationResult.normalizedNumber, 
          passwordHash, 
          saltRounds.toString()
        ]);
      } catch (insertError) {
        logger.error('REGISTER_DATABASE_INSERT_ERROR', {
          errorCode: 'DATABASE_INSERT_FAILED',
          errorMessage: insertError.message,
          errorDetails: {
            sqlState: insertError.code,
            constraint: insertError.constraint
          },
          userData: {
            userId: userId,
            usernameLength: username.length,
            phoneNumberLength: phoneNumber.length
          }
        });
        throw new Error('Failed to create user account');
      }

      // Create wallet for the new user using WalletRepository
      try {
        await WalletRepository.createWallet(userId);
      } catch (walletError) {
        // Rollback the transaction if wallet creation fails
        await client.query('ROLLBACK');
        logger.error('WALLET_CREATION_FAILED', {
          userId,
          errorMessage: walletError.message
        });
        throw new Error('Failed to create user wallet');
      }

      // Commit the transaction
      await client.query('COMMIT');

      logger.info('User registered and activated successfully', {
        username: username,
        userId: userId,
        isActive: true
      });

      return {
        ...result.rows[0],
        is_active: true  
      };
    } catch (error) {
      // Ensure transaction is rolled back in case of any error
      await client.query('ROLLBACK');

      logger.error('REGISTER_FATAL_ERROR', {
        errorCode: 'REGISTRATION_FAILED',
        errorMessage: error.message,
        errorStack: error.stack,
        phoneNumberRedacted: phoneNumber.replace(/\d{4}/, '****'),
        additionalContext: {
          usernameLength: username ? username.length : 'N/A',
          phoneNumberLength: phoneNumber ? phoneNumber.length : 'N/A'
        }
      });
      throw error;
    } finally {
      // Always release the client back to the pool
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

      // Find user by normalized phone number
      const userQuery = 'SELECT * FROM users WHERE phone_number = $1';
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
      const isPasswordValid = await bcrypt.compare(password, user.password_hash);

      if (!isPasswordValid) {
        logger.error(`[${traceId}] Login failed`, {
          reason: 'Invalid password',
          userId: user.user_id
        });
        throw new Error('Invalid phone number or password');
      }

      // Update last login
      await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE user_id = $1', [user.user_id]);

      // Fetch the most recent wallet balance
      const walletBalanceQuery = `
        SELECT balance 
        FROM wallets 
        WHERE user_id = $1 
        ORDER BY updated_at DESC 
        LIMIT 1
      `;
      const walletBalanceResult = await pool.query(walletBalanceQuery, [user.user_id]);
      const currentBalance = walletBalanceResult.rows.length > 0 
        ? parseFloat(walletBalanceResult.rows[0].balance) 
        : 0;

      const balanceSource = walletBalanceResult.rows.length > 0 
        ? 'wallet_balance' 
        : 'user_balance';

      // Generate JWT token instead of custom token
      const token = jwt.sign(
        {
          user_id: user.user_id,
          username: user.username,
          role: user.role || 'user',  // Default role if not specified
          roles: user.roles || ['user'],  // Add roles array
          phone_number: user.phone_number,
          is_active: user.is_active || false
        },
        process.env.JWT_SECRET || '520274659b0b083575095c7f82961352a2bfa4d11c606b8e67c4d48d17be6237', 
        { expiresIn: '7d' }
      );

      // Optional: Still store token details in Redis for additional tracking
      try {
        const redisClient = await redisRepository.ensureClientReady();
        const userTokenKey = `user_token:${user.user_id}`;
        
        // Comprehensive token storage with enhanced error handling
        await redisClient.set(
          userTokenKey, 
          JSON.stringify({
            token,
            userId: user.user_id,
            username: user.username,
            lastLogin: new Date().toISOString(),
            loginTraceId: traceId
          }),
          {
            EX: 7 * 24 * 60 * 60, // 7 days in seconds
            NX: true  // Only set if key does not exist
          }
        );

        // Optional: Add a secondary tracking mechanism
        await redisClient.sAdd('active_user_tokens', userTokenKey);
      } catch (redisError) {
        logger.error(`[${traceId}] CRITICAL_REDIS_TOKEN_STORAGE_ERROR`, {
          reason: redisError.message,
          errorCode: redisError.code,
          errorStack: redisError.stack,
          context: 'login_token_storage',
          userId: user.user_id,
          timestamp: new Date().toISOString()
        });

        // More aggressive error handling
        if (redisError.code === 'CONNECTION_CLOSED' || 
            redisError.code === 'CONNECTION_REFUSED') {
          // Attempt to reconnect or reinitialize Redis
          try {
            await redisRepository.initializeClient();
          } catch (reInitError) {
            logger.error('REDIS_REINITIALIZATION_FAILED', {
              errorMessage: reInitError.message,
              timestamp: new Date().toISOString()
            });
          }
        }
      }

      logger.info(`[${traceId}] User JWT token generated`, {
        userId: user.user_id
      });

      // Remove sensitive information
      delete user.password_hash;

      return { 
        success: true,
        message: 'Login successful',
        token, 
        user: {
          userId: user.user_id,
          username: user.username,
          phoneNumber: user.phone_number,
          role: user.role || 'user',
          isActive: user.is_active || false
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

  // Verify user token using JWT verification
  async verifyUserToken(token) {
    if (!token) {
      throw new Error('No authentication token provided');
    }

    try {
      // Verify JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET || '520274659b0b083575095c7f82961352a2bfa4d11c606b8e67c4d48d17be6237');
      
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
      const redisClient = await redisRepository.getClient();

      // Check if the token is valid in Redis
      const userKey = `user_token:${token}`;
      
      const userData = await redisClient.get(userKey);

      if (!userData) {
        logger.warn('Token validation failed', { 
          message: 'Invalid or expired token',
          token: token 
        });
        throw new Error('Invalid or expired token');
      }

      const parsedUserData = JSON.parse(userData);
      
      logger.info('Token successfully validated', { 
        userId: parsedUserData.id 
      });

      return parsedUserData;
    } catch (error) {
      logger.error('Token authentication error', {
        errorMessage: error.message,
        token: token
      });
      throw error;
    }
  },

  async getProfile(userId) {
    try {
      const query = `
        SELECT 
          user_id, username, phone_number, balance, 
          role, verification_status, last_login, created_at 
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
    try {
      const query = `
        SELECT 
          user_id, 
          username, 
          phone_number, 
          role, 
          verification_status, 
          is_active, 
          profile_picture_url, 
          referral_code, 
          referred_by,
          last_login,
          last_password_change,
          created_at,
          updated_at
        FROM users 
        WHERE user_id = $1
      `;
      
      const result = await pool.query(query, [userId]);
      
      if (result.rows.length === 0) {
        throw new Error('User profile not found');
      }
      
      const userProfile = result.rows[0];
      
      // Debug log for username
      console.log('Retrieved User Profile:', {
        userId,
        username: userProfile.username
      });

      // Fetch wallet balance
      const walletQuery = `
        SELECT balance, currency 
        FROM wallets 
        WHERE user_id = $1
      `;
      const walletResult = await pool.query(walletQuery, [userId]);
      
      // Prepare base profile
      const profileWithWallet = {
        ...userProfile,
        wallet: walletResult.rows.length > 0 
          ? {
              balance: parseFloat(walletResult.rows[0].balance),
              currency: walletResult.rows[0].currency
            } 
          : null
      };

      // Auto-activate if requested
      if (autoActivate) {
        return await this.autoActivateUserAccount(profileWithWallet);
      }

      return profileWithWallet;
    } catch (error) {
      logger.error('Error retrieving user profile', { 
        userId, 
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  },

  async autoActivateUserAccount(userProfile) {
    // Conditions for automatic activation
    const shouldAutoActivate = 
      // Activate developer accounts
      (userProfile.username === 'developer') ||
      // Activate accounts with a valid phone number
      (userProfile.phone_number && userProfile.phone_number.startsWith('+254')) ||
      // Activate accounts created recently (within last 7 days)
      (new Date() - new Date(userProfile.created_at) < 7 * 24 * 60 * 60 * 1000);

    if (shouldAutoActivate && !userProfile.is_active) {
      try {
        // Activate the user account
        const activatedProfile = await this.activateUserAccount(userProfile.user_id);

        // Log auto-activation
        logger.info('USER_AUTO_ACTIVATED', {
          userId: userProfile.user_id,
          username: userProfile.username,
          reason: shouldAutoActivate ? 'Auto-activation criteria met' : 'Unknown'
        });

        return activatedProfile;
      } catch (error) {
        // Log auto-activation failure
        logger.error('USER_AUTO_ACTIVATION_FAILED', {
          userId: userProfile.user_id,
          username: userProfile.username,
          errorMessage: error.message
        });

        // Rethrow the error
        throw error;
      }
    }

    // Return original profile if no activation needed
    return userProfile;
  },

  async updateProfile(userId, updateData) {
    try {
      const { username, phoneNumber } = updateData;
      
      const updateQuery = `
        UPDATE users 
        SET 
          username = COALESCE($1, username), 
          phone_number = COALESCE($2, phone_number)
        WHERE user_id = $3
        RETURNING user_id, username, phone_number, role
      `;
      
      const validationResult = phoneValidator.validate(phoneNumber);
      if (!validationResult.isValid) {
        logger.error('PROFILE_UPDATE_INVALID_PHONE_NUMBER', {
          originalPhoneNumber: phoneNumber,
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

        // Generate new access token
        const accessToken = jwt.sign(
          {
            user_id: userProfile.user_id,
            username: userProfile.username,
            roles: userProfile.roles || ['user']
          },
          process.env.JWT_SECRET || '520274659b0b083575095c7f82961352a2bfa4d11c606b8e67c4d48d17be6237',
          { 
            expiresIn: '15m' 
          }
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
