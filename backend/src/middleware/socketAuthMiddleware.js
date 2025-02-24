import jwt from 'jsonwebtoken';
import logger from '../config/logger.js';
import { authService } from '../services/authService.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Get JWT secret from environment
const JWT_SECRET = process.env.JWT_SECRET || '520274659b0b083575095c7f82961352a2bfa4d11c606b8e67c4d48d17be6237';

/**
 * Socket authentication middleware with strict token validation and logging
 */
export default async function socketAuthMiddleware(socket, next) {
  // Get socket namespace and name
  const socketNamespace = socket.nsp?.name || '/';
  const socketName = getSocketName(socketNamespace);

  try {
    // Extract token from multiple sources
    const token = extractToken(socket);

    if (!token) {
      logger.error('SOCKET_AUTH_NO_TOKEN', {
        socketId: socket.id,
        socketName: socketName
      });
      return next(new Error('Authentication required'));
    }

    // Verify JWT token
    const decoded = await verifyToken(token, socketName, socketNamespace);

    if (!decoded) {
      logger.error('SOCKET_AUTH_INVALID_TOKEN', {
        socketId: socket.id,
        socketName: socketName
      });
      return next(new Error('Invalid authentication token'));
    }

    // Verify user exists and is active
    const userProfile = await authService.getUserProfile(decoded.user_id);

    if (!userProfile || !userProfile.is_active) {
      logger.error('SOCKET_AUTH_INVALID_USER', {
        socketId: socket.id,
        socketName: socketName,
        userId: decoded.user_id
      });
      return next(new Error('Invalid or inactive user'));
    }

    // Set user data on socket
    socket.user = {
      user_id: decoded.user_id,
      username: userProfile.username,
      role: userProfile.role
    };

    // Only log authentication success in debug mode
    if (process.env.NODE_ENV === 'development') {
      logger.debug('SOCKET_AUTH_SUCCESS', {
        socketId: socket.id,
        socketName: socketName,
        userId: decoded.user_id,
        username: userProfile.username,
        role: userProfile.role
      });
    }

    next();
  } catch (error) {
    logger.error('SOCKET_AUTH_ERROR', {
      socketId: socket.id,
      socketName: socketName,
      error: error.message
    });
    next(new Error('Authentication failed'));
  }
}

/**
 * Extract token from socket handshake
 */
function extractToken(socket) {
  try {
    // Try to get token from handshake auth
    const token = socket.handshake?.auth?.token ||
                 socket.handshake?.headers?.authorization?.replace('Bearer ', '') ||
                 socket.handshake?.query?.token;

    return token;
  } catch (error) {
    logger.error('TOKEN_EXTRACTION_ERROR', {
      socketId: socket.id,
      error: error.message
    });
    return null;
  }
}

/**
 * Verify JWT token
 */
async function verifyToken(token, socketName, namespace) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Validate required fields
    const requiredFields = ['user_id', 'username', 'role'];
    const missingFields = requiredFields.filter(field => !decoded[field]);
    
    if (missingFields.length > 0) {
      logger.error('TOKEN_MISSING_FIELDS', {
        socketName: socketName,
        namespace: namespace,
        missingFields,
        decodedFields: Object.keys(decoded)
      });
      return null;
    }

    return decoded;
  } catch (error) {
    logger.error('TOKEN_VERIFICATION_ERROR', {
      socketName: socketName,
      namespace: namespace,
      errorType: error.constructor.name,
      errorMessage: error.message
    });
    return null;
  }
}

/**
 * Get readable socket name from namespace
 */
function getSocketName(namespace) {
  const namespaceMap = {
    '/': 'Default',
    '/game': 'Game',
    '/bet': 'Bet',
    '/chat': 'Chat',
    '/wallet': 'Wallet',
    '/wager': 'Wager'
  };

  return namespaceMap[namespace] || namespace.replace('/', '');
}
