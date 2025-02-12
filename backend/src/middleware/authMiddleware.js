import jwt from 'jsonwebtoken';
import logger from '../config/logger.js';

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_here';

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
      const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

      if (!token) {
        return res.status(401).json({ message: 'No token provided' });
      }

      // Check if token is blacklisted
      if (tokenBlacklist.has(token)) {
        return res.status(401).json({ message: 'Token is no longer valid' });
      }

      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      req.token = token; // Attach token for potential logout/blacklisting
      next();
    } catch (error) {
      logger.error('Authentication error', { error: error.message });
      
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
