import express from 'express';
import { authService } from '../services/authService.js';
import logger from '../config/logger.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import phoneValidator from '../utils/phoneValidator.js';
import bcrypt from 'bcrypt';
import { pool } from '../config/database.js';
import jwt from 'jsonwebtoken'; // Import jwt

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

    // Handle both phone and phoneNumber fields
    const { phone, phoneNumber, password } = req.body;
    const userPhone = phone || phoneNumber;

    // Validate input presence
    if (!userPhone || !password) {
      logger.error('LOGIN_MISSING_CREDENTIALS', {
        missingFields: {
          phone: !userPhone,
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
    const validationResult = phoneValidator.validate(userPhone);
    if (!validationResult.isValid) {
      logger.error('LOGIN_INVALID_PHONE_NUMBER', {
        originalPhoneNumber: userPhone,
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
        phone: userPhone,
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
  console.log('REGISTER REQUEST RECEIVED', {
    body: req.body,
    contentType: req.headers['content-type'],
    hasBody: !!req.body,
  });
  
  try {
    logger.debug('RAW_REGISTER_REQUEST', {
      timestamp: new Date().toISOString(),
      body: JSON.stringify(req.body),
      headers: JSON.stringify(req.headers),
      url: req.originalUrl
    });
  } catch (logError) {
    console.error('Failed to log request', logError);
  }
  
  const registerUser = async (req, res) => {
    // Handle both phone and phoneNumber fields for compatibility
    const { username, phone, phoneNumber, password } = req.body;
    
    // Use phone if available, otherwise use phoneNumber
    const userPhone = phone || phoneNumber;
    
    const registrationTimestamp = new Date().toISOString();
    const startTime = performance.now(); // Performance tracking

    console.log('Registration data extracted:', { 
      usernamePresent: !!username, 
      phonePresent: !!userPhone, 
      passwordPresent: !!password 
    });

    // Validate required fields
    if (!username || !userPhone || !password) {
      return res.status(400).json({
        status: 'error',
        code: 'MISSING_FIELDS',
        message: 'Missing required fields for registration',
        details: {
          username: !username ? 'Username is required' : undefined,
          phone: !userPhone ? 'Phone number is required' : undefined,
          password: !password ? 'Password is required' : undefined
        }
      });
    }

    // Set a timeout for the entire registration process
    const registrationTimeout = setTimeout(() => {
      logger.warn('REGISTRATION_TIMEOUT', {
        username,
        phone: userPhone ? userPhone.replace(/\d{4}$/, '****') : 'undefined',
        elapsedTime: performance.now() - startTime
      });
      res.status(504).json({
        status: 'error',
        code: 'REGISTRATION_TIMEOUT',
        message: 'Registration process took too long'
      });
    }, 15000); // Increased timeout to 15 seconds to allow wallet creation

    try {
      // Enhanced logging for registration attempt
      logger.info('USER_REGISTRATION_ATTEMPT', {
        username,
        phone: userPhone ? userPhone.replace(/\d{4}$/, '****') : 'undefined',
        timestamp: registrationTimestamp
      });

      // Register user
      const user = await authService.register(username, userPhone, password);
      
      // Clear timeout
      clearTimeout(registrationTimeout);
      
      // Check if user has a wallet
      const hasWallet = user.walletCreated || false;
      const walletInfo = hasWallet ? {
        walletCreated: true,
        initialBalance: 0,
        currency: 'KSH'
      } : {
        walletCreated: false,
        message: 'Wallet will be created on first login'
      };
      
      // Generate token for automatic login after registration
      const token = jwt.sign(
        {
          user_id: parseInt(user.user_id, 10),
          username: user.username,
          phone: user.phone,
          role: user.role || 'player'
        },
        process.env.JWT_SECRET || '520274659b0b083575095c7f82961352a2bfa4d11c606b8e67c4d48d17be6237',
        { expiresIn: '7d' }
      );

      // Return success response with token and wallet info
      res.status(201).json({
        status: 'success',
        message: 'User registered successfully',
        user: {
          userId: user.user_id,
          username: user.username,
          phone: user.phone
        },
        wallet: walletInfo,
        token
      });

    } catch (error) {
      clearTimeout(registrationTimeout);
      
      logger.error('USER_REGISTRATION_ERROR', {
        error: error.message,
        stack: error.stack
      });
      
      // Determine appropriate error code and message
      let errorCode = 'REGISTRATION_ERROR';
      let errorMessage = 'Registration failed. Please try again.';
      let statusCode = 500;
      
      if (error.message.includes('already exists')) {
        errorCode = 'USER_ALREADY_EXISTS';
        errorMessage = error.message;
        statusCode = 409; // Conflict
      } else if (error.message.includes('Invalid phone')) {
        errorCode = 'INVALID_PHONE';
        errorMessage = error.message;
        statusCode = 400; // Bad request
      }
      
      res.status(statusCode).json({
        status: 'error',
        code: errorCode,
        message: errorMessage
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
        phoneNumber: req.user.phone
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
    const { username, phone } = req.body; // Changed from phoneNumber to phone

    // Validate phone number if provided
    let validatedPhoneNumber = null;
    if (phone) { // Changed from phoneNumber to phone
      const validationResult = phoneValidator.validate(phone); // Changed from phoneNumber to phone
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
      phone: validatedPhoneNumber // Changed from phoneNumber to phone
    });

    await logger.userActivity(
      userId, 
      'profile_update',
      req.ip,
      {
        userAgent: req.get('User-Agent'),
        phoneNumber: req.user.phone // Changed from phoneNumber to phone
      }
    );

    res.status(200).json(updatedProfile);
  } catch (error) {
    logger.error('Profile update error', { error: error.message });
    res.status(400).json({ message: error.message });
  }
});

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
        phoneNumber: req.user.phone // Changed from phoneNumber to phone
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
