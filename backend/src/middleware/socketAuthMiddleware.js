import jwt from 'jsonwebtoken';
import logger from '../config/logger.js';

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_here';

// Track authenticated sockets to prevent duplicate logs
const authenticatedSockets = new Set();

export default async function socketAuthMiddleware(socket, next) {
  try {
    // ABSOLUTE Token Extraction Strategy 
    const extractToken = () => {
      const extractionStrategies = [
        () => socket.handshake.auth.token,
        () => socket.handshake.auth.accessToken,
        () => socket.handshake.headers.authorization?.split(' ')[1],
        () => socket.handshake.headers['x-access-token'],
        () => socket.handshake.query.token
      ];

      for (const [index, strategy] of extractionStrategies.entries()) {
        const token = strategy();
        if (token) {
          return token;
        }
      }

      return null;
    };

    const token = extractToken();

    // STRICT Token Validation
    if (!token) {
      return next(new Error('SECURITY_VIOLATION_NO_TOKEN'));
    }

    try {
      // COMPREHENSIVE Token Verification
      const decoded = jwt.verify(token, JWT_SECRET);

      // STRICT Decoded Payload Validation
      const REQUIRED_PAYLOAD_FIELDS = [
        'user_id', 
        'username'
      ];

      const OPTIONAL_PAYLOAD_FIELDS = [
        'roles',
        'role',
        'is_active'
      ];

      // Check required fields
      const missingFields = REQUIRED_PAYLOAD_FIELDS.filter(field => !decoded[field]);
      if (missingFields.length > 0) {
        return next(new Error(`SECURITY_VIOLATION_MISSING_FIELDS: ${missingFields.join(', ')}`));
      }

      // Normalize roles
      const roles = decoded.roles || 
                    (decoded.role ? [decoded.role] : ['user']);

      // CONSISTENT User Object Creation with Strict Mapping
      socket.user = {
        user_id: decoded.user_id,  // Consistent user_id
        username: decoded.username,
        email: decoded.email,
        roles: roles,
        is_active: decoded.is_active || false,
        authSource: 'socket_jwt',
        authTimestamp: new Date().toISOString()
      };

      next();
    } catch (tokenVerificationError) {
      // COMPREHENSIVE Token Error Handling
      const errorHandlers = {
        'TokenExpiredError': () => {
          return new Error('SECURITY_VIOLATION_TOKEN_EXPIRED');
        },
        'JsonWebTokenError': () => {
          return new Error('SECURITY_VIOLATION_INVALID_TOKEN');
        },
        'default': () => {
          return new Error('SECURITY_VIOLATION_UNEXPECTED_TOKEN_ERROR');
        }
      };

      const errorHandler = errorHandlers[tokenVerificationError.name] || errorHandlers['default'];
      return next(errorHandler());
    }
  } catch (unexpectedError) {
    // LAST RESORT Error Handling
    return next(new Error('SECURITY_VIOLATION_UNEXPECTED_AUTH_ERROR'));
  }
}
