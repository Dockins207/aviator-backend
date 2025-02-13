import express from 'express';
import { authService } from '../services/authService.js';
import logger from '../config/logger.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import phoneValidator from '../utils/phoneValidator.js';
import walletService from '../services/walletService.js'; // Update walletService import

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
  try {
    // Comprehensive request logging
    logger.info('REGISTRATION_REQUEST_RECEIVED', { 
      timestamp: new Date().toISOString(),
      requestBody: JSON.stringify(req.body),
      requestHeaders: JSON.stringify(req.headers),
      clientIp: req.ip
    });

    const { username, phoneNumber, password } = req.body;

    // Validate input presence
    if (!username || !phoneNumber || !password) {
      logger.error('REGISTRATION_MISSING_CREDENTIALS', {
        missingFields: {
          username: !username,
          phoneNumber: !phoneNumber,
          password: !password
        }
      });
      return res.status(400).json({ 
        status: 'error',
        code: 'MISSING_CREDENTIALS',
        message: 'Username, phone number, and password are required',
        details: {
          providedFields: Object.keys(req.body)
        }
      });
    }

    // Validate phone number
    const validationResult = phoneValidator.validate(phoneNumber);
    if (!validationResult.isValid) {
      logger.error('REGISTRATION_INVALID_PHONE_NUMBER', {
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
      const user = await authService.register(
        username, 
        validationResult.formattedNumber, 
        password
      );
      
      // Log successful registration
      await logger.userActivity(
        user.user_id, 
        'registration',
        req.ip,
        {
          userAgent: req.get('User-Agent'),
          phoneNumber: validationResult.formattedNumber,
          username: username
        }
      );

      res.status(201).json(user);
    } catch (registrationError) {
      // Detailed error response for registration failures
      logger.error('REGISTRATION_SERVICE_ERROR', {
        errorMessage: registrationError.message,
        errorStack: registrationError.stack,
        requestData: {
          username: username,
          phoneNumber: validationResult.formattedNumber
        }
      });

      // Categorize error responses
      const errorResponses = {
        'Username is required': {
          status: 400,
          code: 'USERNAME_REQUIRED',
          message: 'Username is a required field'
        },
        'Username must be at least 3 characters long': {
          status: 400,
          code: 'USERNAME_TOO_SHORT',
          message: 'Username must be at least 3 characters long'
        },
        'Username can only contain letters, numbers, and underscores': {
          status: 400,
          code: 'USERNAME_INVALID_CHARS',
          message: 'Username can only contain letters, numbers, and underscores'
        },
        'Password is required': {
          status: 400,
          code: 'PASSWORD_REQUIRED',
          message: 'Password is a required field'
        },
        'Password must be at least 8 characters long': {
          status: 400,
          code: 'PASSWORD_TOO_SHORT',
          message: 'Password must be at least 8 characters long'
        },
        'Password must contain at least one uppercase letter': {
          status: 400,
          code: 'PASSWORD_NO_UPPERCASE',
          message: 'Password must contain at least one uppercase letter'
        },
        'Password must contain at least one lowercase letter': {
          status: 400,
          code: 'PASSWORD_NO_LOWERCASE',
          message: 'Password must contain at least one lowercase letter'
        },
        'Password must contain at least one number': {
          status: 400,
          code: 'PASSWORD_NO_NUMBER',
          message: 'Password must contain at least one number'
        },
        'Password must contain at least one special character': {
          status: 400,
          code: 'PASSWORD_NO_SPECIAL_CHAR',
          message: 'Password must contain at least one special character'
        },
        'User with this phone number or username already exists': {
          status: 409,
          code: 'USER_ALREADY_EXISTS',
          message: 'A user with this phone number or username already exists'
        },
        'Failed to create user account': {
          status: 500,
          code: 'DATABASE_INSERT_FAILED',
          message: 'An error occurred while creating your account. Please try again later.'
        },
        'Failed to initialize user wallet': {
          status: 500,
          code: 'WALLET_INIT_FAILED',
          message: 'An error occurred while setting up your wallet. Please contact support.'
        }
      };

      const errorResponse = errorResponses[registrationError.message] || {
        status: 500,
        code: 'REGISTRATION_FAILED',
        message: 'Registration failed. Please try again later.'
      };

      res.status(errorResponse.status).json({
        status: 'error',
        code: errorResponse.code,
        message: errorResponse.message,
        details: {
          originalErrorMessage: registrationError.message
        }
      });
    }
  } catch (unexpectedError) {
    logger.error('UNEXPECTED_REGISTRATION_ERROR', {
      errorMessage: unexpectedError.message,
      errorStack: unexpectedError.stack,
      requestBody: JSON.stringify(req.body)
    });

    res.status(500).json({ 
      status: 'error',
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred during registration'
    });
  }
});

// Profile route (requires authentication)
router.get('/profile', authMiddleware.authenticateToken, async (req, res) => {
  try {
    console.log('DEBUG: Profile route - Request details', {
      userId: req.user?.user_id,
      phoneNumber: req.user?.phone_number,
      headers: req.headers
    });

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
    
    console.log('DEBUG: Profile route - Retrieved profile', {
      userId: userProfile.user_id,
      username: userProfile.username,
      role: userProfile.role
    });

    res.status(200).json({
      status: 'success',
      data: userProfile
    });
  } catch (error) {
    console.error('DEBUG: Profile route - Full error', error);

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

// Get user profile balance
router.get('/profile/balance', authMiddleware.authenticateToken, async (req, res) => {
  try {
    console.log('DEBUG: Balance route - Full request object', {
      headers: req.headers,
      user: req.user,
      token: req.token
    });

    console.log('DEBUG: Balance route - User details', {
      userId: req.user?.user_id,
      phoneNumber: req.user?.phone_number
    });

    if (!req.user || !req.user.user_id) {
      return res.status(401).json({
        status: 'error',
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing user information'
      });
    }

    const profileBalance = await walletService.getUserProfileBalance(req.user.user_id);
    
    console.log('DEBUG: Balance route - Retrieved balance', {
      userId: req.user.user_id,
      balance: profileBalance
    });

    res.status(200).json(profileBalance);
  } catch (error) {
    console.error('DEBUG: Balance route - Full error', error);

    logger.error('Profile balance retrieval failed', { 
      userId: req.user?.user_id, 
      errorMessage: error.message,
      errorStack: error.stack
    });

    res.status(500).json({
      status: 'error',
      code: 'BALANCE_RETRIEVAL_FAILED',
      message: 'Unable to retrieve profile balance',
      details: error.message
    });
  }
});

// Deposit funds into user wallet
router.post('/profile/deposit', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { amount, description } = req.body;

    console.log('DEBUG: Deposit route - Request details', {
      userId: req.user.user_id,
      amount,
      description
    });

    // Validate input
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_AMOUNT',
        message: 'Invalid deposit amount. Must be a positive number.'
      });
    }

    const updatedWallet = await walletService.depositFunds(
      req.user.user_id, 
      amount, 
      description || 'Manual Deposit'
    );
    
    console.log('DEBUG: Deposit route - Updated wallet', {
      userId: req.user.user_id,
      newBalance: updatedWallet.balance
    });

    res.status(200).json(updatedWallet);
  } catch (error) {
    console.error('DEBUG: Deposit route - Full error', error);

    logger.error('Wallet deposit failed', { 
      userId: req.user.user_id, 
      errorMessage: error.message,
      errorStack: error.stack
    });

    res.status(500).json({
      status: 'error',
      code: 'DEPOSIT_FAILED',
      message: 'Unable to deposit funds',
      details: error.message
    });
  }
});

// Withdraw funds from user wallet
router.post('/profile/withdraw', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { amount, description } = req.body;

    console.log('DEBUG: Withdrawal route - Request details', {
      userId: req.user.user_id,
      amount,
      description
    });

    // Validate input
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_AMOUNT',
        message: 'Invalid withdrawal amount. Must be a positive number.'
      });
    }

    const updatedWallet = await walletService.withdrawFunds(
      req.user.user_id, 
      amount, 
      description || 'Manual Withdrawal'
    );
    
    console.log('DEBUG: Withdrawal route - Updated wallet', {
      userId: req.user.user_id,
      newBalance: updatedWallet.balance
    });

    res.status(200).json(updatedWallet);
  } catch (error) {
    console.error('DEBUG: Withdrawal route - Full error', error);

    logger.error('Wallet withdrawal failed', { 
      userId: req.user.user_id, 
      errorMessage: error.message,
      errorStack: error.stack
    });

    res.status(500).json({
      status: 'error',
      code: 'WITHDRAWAL_FAILED',
      message: 'Unable to withdraw funds',
      details: error.message
    });
  }
});

// Get wallet transaction history
router.get('/profile/transactions', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { limit, offset } = req.query;

    console.log('DEBUG: Transaction history route - Request details', {
      userId: req.user.user_id,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined
    });

    // Validate and convert query parameters
    const parsedLimit = limit ? parseInt(limit) : 50;
    const parsedOffset = offset ? parseInt(offset) : 0;

    // Validate parsed parameters
    if (isNaN(parsedLimit) || isNaN(parsedOffset)) {
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_PARAMETERS',
        message: 'Invalid limit or offset parameters'
      });
    }

    const transactionHistory = await walletService.getTransactionHistory(
      req.user.user_id, 
      parsedLimit, 
      parsedOffset
    );
    
    console.log('DEBUG: Transaction history route - Retrieved transactions', {
      userId: req.user.user_id,
      transactionCount: transactionHistory.transactions.length
    });

    res.status(200).json(transactionHistory);
  } catch (error) {
    console.error('DEBUG: Transaction history route - Full error', error);

    logger.error('Wallet transaction history retrieval failed', { 
      userId: req.user.user_id, 
      errorMessage: error.message,
      errorStack: error.stack
    });

    res.status(500).json({
      status: 'error',
      code: 'TRANSACTION_HISTORY_FAILED',
      message: 'Unable to retrieve transaction history',
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

// Logout route with token management
router.post('/logout', authMiddleware.authenticateToken, async (req, res) => {
  try {
    console.log('DEBUG: Logout route - Request details', {
      userId: req.user?.user_id,
      phoneNumber: req.user?.phone_number,
      headers: req.headers
    });

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
    
    console.log('DEBUG: Logout route - Token blacklisted', {
      userId: req.user.user_id
    });

    res.status(200).json({
      status: 'success',
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('DEBUG: Logout route - Full error', error);

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

export default router;
