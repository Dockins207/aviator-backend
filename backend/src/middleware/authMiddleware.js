import { JWT_SECRET, validateToken } from '../utils/authUtils.js';
import logger from '../config/logger.js';

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
    try {
      const authHeader = req.headers['authorization'];
      const allHeaders = JSON.stringify(req.headers);
      
      // Enhanced logging for all headers and authorization details
      logger.debug('FULL_REQUEST_HEADERS', {
        timestamp: new Date().toISOString(),
        allHeaders,
        authHeaderPresent: !!authHeader
      });

      if (!authHeader) {
        logger.error('NO_AUTH_HEADER', {
          timestamp: new Date().toISOString(),
          headers: allHeaders
        });
        return res.status(401).json({ 
          message: 'No authorization header provided',
          details: { headersReceived: Object.keys(req.headers) }
        });
      }

      const token = authHeader.split(' ')[1];

      // Check if token is blacklisted
      if (tokenBlacklist.has(token)) {
        logger.error('BLACKLISTED_TOKEN_USED', {
          timestamp: new Date().toISOString(),
          token: token.substring(0, 10) + '...'
        });
        return res.status(401).json({ message: 'Token is no longer valid' });
      }

      // Use shared token validation
      const decoded = await validateToken(token);

      // Set user details from token
      req.user = {
        user_id: decoded.user_id,
        username: decoded.username,
        role: decoded.role,
        roles: decoded.roles || [],
        phone_number: decoded.phone_number,
        is_active: decoded.is_active
      };

      req.token = token;
      next();
    } catch (error) {
      logger.error('AUTHENTICATION_ERROR', {
        timestamp: new Date().toISOString(),
        error: error.message,
        stack: error.stack
      });
      return res.status(401).json({ message: error.message });
    }
  }
};
