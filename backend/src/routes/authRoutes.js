import express from 'express';
import { authService } from '../services/authService.js';
import logger from '../config/logger.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import phoneValidator from '../utils/phoneValidator.js';
import bcrypt from 'bcrypt';
import { pool } from '../config/database.js';

const router = express.Router();

// Login route
router.post('/login', async (req, res) => {
  try {
    // Comprehensive request logging
    logger.info('LOGIN_REQUEST_RECEIVED', { 
      timestamp: new Date().toISOString(),
      requestBody: JSON.stringify(req.body),
      requestHeaders: JSON.stringify(req.headers),
      clientIp: req.ip
    });

    const { phoneNumber, password } = req.body;

    // Validate input presence
    if (!phoneNumber || !password) {
      logger.error('LOGIN_MISSING_CREDENTIALS', {
        missingFields: {
          phoneNumber: !phoneNumber,
          password: !password
        }
      });
      return res.status(400).json({ 
        status: 'error',
        code: 'MISSING_CREDENTIALS',
        message: 'Phone number and password are required',
        details: {
          providedFields: Object.keys(req.body)
        }
      });
    }

    // Validate phone number
    const validationResult = phoneValidator.validate(phoneNumber);
    if (!validationResult.isValid) {
      logger.error('LOGIN_INVALID_PHONE_NUMBER', {
        originalPhoneNumber: phoneNumber,
        validationError: validationResult.error,
        supportedFormats: validationResult.supportedFormats
      });
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_PHONE_NUMBER',
        message: validationResult.error,
        details: {
          supportedFormats: validationResult.supportedFormats
        }
      });
    }

    try {
      // Use the formatted number for login
      const result = await authService.login(validationResult.formattedNumber, password);
      
      // Log successful login
      await logger.userActivity(
        result.user.user_id, 
        'login',
        req.ip,
        {
          userAgent: req.get('User-Agent'),
          phoneNumber: validationResult.formattedNumber,
          username: result.user.username
        }
      );

      res.status(200).json(result);
    } catch (loginError) {
      logger.error('LOGIN_SERVICE_ERROR', {
        errorMessage: loginError.message,
        errorStack: loginError.stack,
        phoneNumber: phoneNumber,
        sensitiveDetailsRedacted: true
      });

      res.status(401).json({ 
        status: 'error',
        code: 'LOGIN_FAILED',
        message: loginError.message || 'Login failed',
        details: {
          hint: 'Check phone number and password',
          supportedFormats: [
            '+254712345678',
            '0712345678',
            '0112345678'
          ]
        }
      });
    }
  } catch (unexpectedError) {
    logger.error('UNEXPECTED_LOGIN_ERROR', {
      errorMessage: unexpectedError.message,
      errorStack: unexpectedError.stack,
      requestBody: JSON.stringify(req.body)
    });

    res.status(500).json({ 
      status: 'error',
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred during login'
    });
  }
});

// Register route
router.post('/register', async (req, res) => {
  const registerUser = async (req, res) => {
    const { username, phoneNumber, password } = req.body;
    const registrationTimestamp = new Date().toISOString();
    const startTime = performance.now(); // Performance tracking

    // Set a timeout for the entire registration process
    const registrationTimeout = setTimeout(() => {
      logger.warn('REGISTRATION_TIMEOUT', {
        username,
        phoneNumber: phoneNumber.replace(/\d{4}$/, '****'),
        elapsedTime: performance.now() - startTime
      });
      res.status(504).json({
        status: 'error',
        code: 'REGISTRATION_TIMEOUT',
        message: 'Registration process took too long'
      });
    }, 9000); // 9 seconds to allow some buffer

    try {
      // Enhanced logging for registration attempt
      logger.info('USER_REGISTRATION_ATTEMPT', {
        username,
        phoneNumber: phoneNumber.replace(/\d{4}$/, '****'),
        timestamp: registrationTimestamp
      });

      // Parallel database checks for efficiency
      const [existingUserByUsername, existingUserByPhone] = await Promise.all([
        pool.query('SELECT * FROM users WHERE username = $1', [username]),
        pool.query('SELECT * FROM users WHERE phone_number = $1', [phoneNumber])
      ]);

      if (existingUserByUsername.rows.length > 0) {
        clearTimeout(registrationTimeout);
        logger.warn('REGISTRATION_USERNAME_CONFLICT', {
          username,
          existingUserCount: existingUserByUsername.rows.length
        });
        return res.status(409).json({
          status: 'error',
          code: 'USERNAME_ALREADY_EXISTS',
          message: 'Username is already registered'
        });
      }

      if (existingUserByPhone.rows.length > 0) {
        clearTimeout(registrationTimeout);
        logger.warn('REGISTRATION_PHONE_CONFLICT', {
          phoneNumber: phoneNumber.replace(/\d{4}$/, '****'),
          existingUserCount: existingUserByPhone.rows.length
        });
        return res.status(409).json({
          status: 'error',
          code: 'PHONE_NUMBER_ALREADY_EXISTS',
          message: 'Phone number is already registered'
        });
      }

      // Hash password with performance tracking
      const passwordHashStart = performance.now();
      const hashedPassword = await bcrypt.hash(password, 10);
      const passwordHashDuration = performance.now() - passwordHashStart;

      // Begin transaction with timeout
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // User insertion with performance tracking
        const userInsertStart = performance.now();
        const userInsertQuery = `
          INSERT INTO users 
          (username, phone_number, password_hash, salt, role, verification_status, is_active, created_at, updated_at) 
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
          RETURNING user_id
        `;
        const userResult = await client.query(userInsertQuery, [
          username, 
          phoneNumber, 
          hashedPassword,
          '', // salt 
          'player', // default role
          'unverified', // verification_status
          true, // is_active
          new Date(), // created_at
          new Date() // updated_at
        ]);
        const userInsertDuration = performance.now() - userInsertStart;

        const userId = userResult.rows[0].user_id;

        // Commit transaction
        await client.query('COMMIT');

        // Clear timeout
        clearTimeout(registrationTimeout);

        const totalRegistrationTime = performance.now() - startTime;

        logger.info('USER_REGISTRATION_PERFORMANCE', {
          userId,
          username,
          totalTime: totalRegistrationTime,
          passwordHashTime: passwordHashDuration,
          userInsertTime: userInsertDuration
        });

        logger.info('USER_REGISTRATION_SUCCESS', {
          userId,
          username,
          registrationTimestamp
        });

        res.status(201).json({
          status: 'success',
          message: 'User registered successfully',
          userId,
          registrationTime: totalRegistrationTime
        });

      } catch (dbError) {
        // Rollback transaction
        await client.query('ROLLBACK');
        
        clearTimeout(registrationTimeout);

        logger.error('USER_REGISTRATION_DATABASE_ERROR', {
          error: dbError.message,
          stack: dbError.stack
        });

        res.status(500).json({
          status: 'error',
          code: 'DATABASE_ERROR',
          message: 'Failed to complete registration'
        });
      } finally {
        client.release();
      }

    } catch (error) {
      clearTimeout(registrationTimeout);

      logger.error('USER_REGISTRATION_UNEXPECTED_ERROR', {
        error: error.message,
        stack: error.stack
      });

      res.status(500).json({
        status: 'error',
        code: 'UNEXPECTED_ERROR',
        message: 'An unexpected error occurred during registration'
      });
    }
  };

  registerUser(req, res);
});

// Profile route (requires authentication)
router.get('/profile', authMiddleware.authenticateToken, async (req, res) => {
  try {
    // Log user activity
    await logger.userActivity(
      req.user.user_id, 
      'profile_view',
      req.ip,
      {
        userAgent: req.get('User-Agent'),
        phoneNumber: req.user.phone_number
      }
    );

    // Retrieve full user profile
    const userProfile = await authService.getUserProfile(req.user.user_id);
    
    res.status(200).json({
      status: 'success',
      data: userProfile
    });
  } catch (error) {
    logger.error('Profile retrieval failed', { 
      userId: req.user?.user_id, 
      errorMessage: error.message,
      errorStack: error.stack
    });

    res.status(500).json({
      status: 'error',
      code: 'PROFILE_RETRIEVAL_FAILED',
      message: 'Unable to retrieve user profile',
      details: error.message
    });
  }
});

// Update profile route (requires authentication)
router.put('/profile', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { username, phoneNumber } = req.body;
    
    // Validate phone number if provided
    let validatedPhoneNumber = null;
    if (phoneNumber) {
      const validationResult = phoneValidator.validate(phoneNumber);
      if (!validationResult.isValid) {
        return res.status(400).json({ 
          message: 'Invalid phone number', 
          error: validationResult.error,
          supportedFormats: validationResult.supportedFormats
        });
      }
      validatedPhoneNumber = validationResult.formattedNumber;
    }
    
    const updatedProfile = await authService.updateProfile(userId, { 
      username, 
      phoneNumber: validatedPhoneNumber 
    });
    
    await logger.userActivity(
      userId, 
      'profile_update',
      req.ip,
      {
        userAgent: req.get('User-Agent'),
        phoneNumber: req.user.phone_number
      }
    );

    res.status(200).json(updatedProfile);
  } catch (error) {
    logger.error('Profile update error', { error: error.message });
    res.status(400).json({ message: error.message });
  }
});

// Fallback balance route for backwards compatibility

// Logout route with token management
router.post('/logout', authMiddleware.authenticateToken, async (req, res) => {
  try {
    // Log user activity
    await logger.userActivity(
      req.user.user_id, 
      'logout',
      req.ip,
      {
        userAgent: req.get('User-Agent'),
        phoneNumber: req.user.phone_number
      }
    );

    // Blacklist the current token
    authMiddleware.blacklistToken(req.token);
    
    res.status(200).json({
      status: 'success',
      message: 'Logged out successfully'
    });
  } catch (error) {
    logger.error('Logout failed', { 
      userId: req.user?.user_id, 
      errorMessage: error.message,
      errorStack: error.stack
    });

    res.status(500).json({
      status: 'error',
      code: 'LOGOUT_FAILED',
      message: 'Unable to logout',
      details: error.message
    });
  }
});

// Refresh token route
router.post('/refresh', async (req, res) => {
  try {
    // Extract refresh token from multiple possible sources
    const refreshToken = 
      req.body.refreshToken || 
      req.headers['x-refresh-token'] || 
      req.query.refreshToken;

    if (!refreshToken) {
      logger.error('REFRESH_TOKEN_MISSING', {
        source: 'refresh_route'
      });
      return res.status(400).json({ 
        error: 'Refresh token is required',
        code: 'MISSING_REFRESH_TOKEN'
      });
    }

    // Attempt to refresh access token
    const { accessToken, refreshToken: newRefreshToken, user } = 
      await authService.refreshAccessToken(refreshToken);

    // Log successful token refresh
    logger.info('TOKEN_REFRESH_SUCCESSFUL', {
      userId: user.user_id,
      tokenRefreshed: true
    });

    // Return new tokens
    res.json({
      accessToken,
      refreshToken: newRefreshToken,
      user: {
        user_id: user.user_id,
        username: user.username
      }
    });
  } catch (error) {
    // Detailed error logging
    logger.error('TOKEN_REFRESH_FAILED', {
      errorMessage: error.message,
      errorName: error.name,
      source: 'refresh_route'
    });

    // Specific error responses
    if (error.message.includes('expired')) {
      return res.status(401).json({
        error: 'Refresh token expired',
        code: 'TOKEN_EXPIRED'
      });
    }

    if (error.message.includes('invalid')) {
      return res.status(401).json({
        error: 'Invalid refresh token',
        code: 'INVALID_TOKEN'
      });
    }

    // Generic server error
    res.status(500).json({
      error: 'Internal server error during token refresh',
      code: 'REFRESH_TOKEN_ERROR'
    });
  }
});

export default router;
