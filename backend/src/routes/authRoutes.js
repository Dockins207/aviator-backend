import express from 'express';
import { authService } from '../services/authService.js';
import { userLogger } from '../services/userLogger.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { phoneValidator } from '../utils/phoneValidator.js';
import logger from '../config/logger.js';

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
        supportedFormats: [
          '+254712345678',
          '0712345678',
          '0112345678'
        ]
      });
      return res.status(400).json({ 
        status: 'error',
        code: 'INVALID_PHONE_NUMBER',
        message: 'Invalid phone number format',
        error: validationResult.error,
        supportedFormats: [
          '+254712345678',
          '0712345678',
          '0112345678'
        ],
        supportedPrefixes: phoneValidator.getSupportedPrefixes()
      });
    }

    try {
      // Use the formatted number for login
      const result = await authService.login(phoneNumber, password);
      
      // Log successful login
      await userLogger.logUserLogin(
        result.user.id, 
        result.user.username, 
        result.user.phone_number,
        req.ip
      );

      logger.info('LOGIN_SUCCESS', {
        userId: result.user.id,
        username: result.user.username,
        phoneNumber: result.user.phone_number
      });

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
        supportedFormats: [
          '+254712345678',
          '0712345678',
          '0112345678'
        ]
      });
      return res.status(400).json({ 
        status: 'error',
        code: 'INVALID_PHONE_NUMBER',
        message: 'Invalid phone number format',
        error: validationResult.error,
        supportedFormats: [
          '+254712345678',
          '0712345678',
          '0112345678'
        ],
        supportedPrefixes: phoneValidator.getSupportedPrefixes()
      });
    }

    try {
      const user = await authService.register(
        username, 
        validationResult.formattedNumber, 
        password
      );
      
      // Log successful registration
      await userLogger.logUserRegistration(
        user.id, 
        username, 
        validationResult.formattedNumber
      );

      logger.info('REGISTRATION_SUCCESS', {
        userId: user.id,
        username: user.username,
        phoneNumber: user.phone_number
      });

      res.status(201).json(user);
    } catch (registrationError) {
      logger.error('REGISTRATION_SERVICE_ERROR', {
        errorMessage: registrationError.message,
        errorStack: registrationError.stack,
        username: username,
        phoneNumber: phoneNumber,
        sensitiveDetailsRedacted: true
      });

      res.status(400).json({ 
        status: 'error',
        code: 'REGISTRATION_FAILED',
        message: registrationError.message || 'Registration failed',
        details: {
          hint: 'Check username, phone number, and password',
          supportedFormats: [
            '+254712345678',
            '0712345678',
            '0112345678'
          ]
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
    const userId = req.user.id;
    const profile = await authService.getProfile(userId);
    res.status(200).json(profile);
  } catch (error) {
    logger.error('Profile retrieval error', { error: error.message });
    res.status(404).json({ message: error.message });
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
          supportedFormats: [
            '+254712345678',
            '0712345678',
            '0112345678'
          ],
          supportedPrefixes: phoneValidator.getSupportedPrefixes()
        });
      }
      validatedPhoneNumber = validationResult.formattedNumber;
    }
    
    const updatedProfile = await authService.updateProfile(userId, { 
      username, 
      phoneNumber: validatedPhoneNumber 
    });
    res.status(200).json(updatedProfile);
  } catch (error) {
    logger.error('Profile update error', { error: error.message });
    res.status(400).json({ message: error.message });
  }
});

// Logout route with token management
router.post('/logout', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const token = req.token;

    // Blacklist the current token
    authMiddleware.blacklistToken(token);
    
    // Log logout event
    await userLogger.logUserLogout(
      userId, 
      req.user.username, 
      req.user.phone_number,
      req.ip // Capture IP address
    );
    
    logger.info(`User ${userId} logged out successfully`);
    res.status(200).json({ 
      message: 'Logged out successfully',
      hint: 'Your previous token is now invalid'
    });
  } catch (error) {
    logger.error('Logout error', { error: error.message });
    res.status(500).json({ message: 'Logout failed', error: error.message });
  }
});

export default router;
