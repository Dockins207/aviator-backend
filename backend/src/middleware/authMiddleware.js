import jwt from 'jsonwebtoken';
import logger from '../config/logger.js';

const JWT_SECRET = process.env.JWT_SECRET || '520274659b0b083575095c7f82961352a2bfa4d11c606b8e67c4d48d17be6237';

// Optional: In-memory token blacklist (can be replaced with Redis or database)
const tokenBlacklist = new Set();

export const authMiddleware = {
  // Token blacklisting method (can be expanded)
  blacklistToken(token) {
    tokenBlacklist.add(token);
    
    // Optional: Set a timeout to remove token from blacklist
    setTimeout(() => {
      tokenBlacklist.delete(token);
    }, 24 * 60 * 60 * 1000); // Remove after 24 hours
  },

  async authenticateToken(req, res, next) {
    let token;
    try {
      const authHeader = req.headers['authorization'];
      const allHeaders = JSON.stringify(req.headers);
      
      // Enhanced logging for all headers and authorization details
      logger.debug('FULL_REQUEST_HEADERS', {
        timestamp: new Date().toISOString(),
        allHeaders,
        authHeaderPresent: !!authHeader
      });

      token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

      // Log token details with more context
      logger.debug('TOKEN_DETAILS', {
        timestamp: new Date().toISOString(),
        hasAuthHeader: !!authHeader,
        authHeaderValue: authHeader,
        tokenExtracted: token ? token.substring(0, 10) + '...' : null
      });

      if (!token) {
        logger.error('NO_TOKEN_PROVIDED', {
          timestamp: new Date().toISOString(),
          headers: allHeaders,
          authHeaderValue: authHeader
        });
        return res.status(401).json({ 
          message: 'No token provided', 
          details: {
            authHeader: authHeader,
            headersReceived: Object.keys(req.headers)
          }
        });
      }

      // Check if token is blacklisted
      if (tokenBlacklist.has(token)) {
        logger.error('BLACKLISTED_TOKEN_USED', {
          timestamp: new Date().toISOString(),
          token: token.substring(0, 10) + '...'
        });
        return res.status(401).json({ message: 'Token is no longer valid' });
      }

      // Verify and decode token
      const decoded = jwt.verify(token, JWT_SECRET);

      // Log decoded token contents
      logger.debug('DECODED_TOKEN', {
        timestamp: new Date().toISOString(),
        userId: decoded.user_id,
        username: decoded.username,
        role: decoded.role
      });

      // Set user details from token
      req.user = {
        user_id: decoded.user_id, // Keep original user_id from token
        username: decoded.username,
        role: decoded.role,
        roles: decoded.roles || [],
        phone_number: decoded.phone_number,
        is_active: decoded.is_active
      };

      // Log final user object
      logger.debug('AUTH_USER_SET', {
        timestamp: new Date().toISOString(),
        userId: req.user.user_id,
        username: req.user.username,
        role: req.user.role
      });

      req.token = token; // Attach token for potential logout/blacklisting
      next();
    } catch (error) {
      logger.error('AUTHENTICATION_ERROR', {
        timestamp: new Date().toISOString(),
        error: error.message,
        type: error.name,
        stack: error.stack,
        token: token ? token.substring(0, 10) + '...' : null
      });
      
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ message: 'Token expired' });
      }
      
      return res.status(403).json({ message: 'Invalid token' });
    }
  },

  async authorizeRoles(...allowedRoles) {
    return (req, res, next) => {
      try {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
          return res.status(403).json({ message: 'Unauthorized access' });
        }
        next();
      } catch (error) {
        logger.error('Authorization error', { error: error.message });
        return res.status(500).json({ message: 'Authorization failed' });
      }
    };
  }
};
