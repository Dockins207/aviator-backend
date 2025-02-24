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

  // Log incoming socket connection attempt
  logger.warn('SOCKET_AUTH_ATTEMPT', {
    service: 'aviator-backend',
    socketId: socket.id,
    socketName: socketName,
    namespace: socketNamespace,
    handshakeAuth: socket.handshake.auth,
    handshakeHeaders: socket.handshake.headers,
    handshakeQuery: socket.handshake.query
  });

  try {
    // Extract token from multiple sources
    const token = extractToken(socket);

    // Log token extraction result
    logger.info('TOKEN_EXTRACTION_RESULT', {
      service: 'aviator-backend',
      socketId: socket.id,
      socketName: socketName,
      namespace: socketNamespace,
      hasToken: !!token,
      authKeys: Object.keys(socket.handshake.auth || {}),
      headerKeys: Object.keys(socket.handshake.headers || {}),
      queryKeys: Object.keys(socket.handshake.query || {})
    });

    if (!token) {
      logger.error('SOCKET_AUTH_NO_TOKEN', {
        service: 'aviator-backend',
        socketId: socket.id,
        socketName: socketName,
        namespace: socketNamespace,
        handshakeAuth: socket.handshake.auth,
        headers: socket.handshake.headers
      });
      return next(new Error('Authentication required'));
    }

    // Verify JWT token
    const decoded = await verifyToken(token, socketName, socketNamespace);
    
    // Log token verification result
    logger.info('TOKEN_VERIFICATION_RESULT', {
      service: 'aviator-backend',
      socketId: socket.id,
      socketName: socketName,
      namespace: socketNamespace,
      isValid: !!decoded,
      decodedFields: decoded ? Object.keys(decoded) : []
    });

    if (!decoded) {
      logger.error('SOCKET_AUTH_INVALID_TOKEN', {
        service: 'aviator-backend',
        socketId: socket.id,
        socketName: socketName,
        namespace: socketNamespace
      });
      return next(new Error('Invalid authentication token'));
    }

    // Verify user exists and is active
    const userProfile = await authService.getUserProfile(decoded.user_id);
    
    // Log user profile check
    logger.info('USER_PROFILE_CHECK', {
      service: 'aviator-backend',
      socketId: socket.id,
      socketName: socketName,
      namespace: socketNamespace,
      userId: decoded.user_id,
      hasProfile: !!userProfile,
      isActive: userProfile?.is_active
    });

    if (!userProfile || !userProfile.is_active) {
      logger.error('SOCKET_AUTH_INVALID_USER', {
        service: 'aviator-backend',
        socketId: socket.id,
        socketName: socketName,
        namespace: socketNamespace,
        userId: decoded.user_id,
        reason: !userProfile ? 'User not found' : 'User inactive'
      });
      return next(new Error('User not found or inactive'));
    }

    // Set authenticated user data on socket
    socket.user = {
      user_id: decoded.user_id,
      username: decoded.username,
      role: decoded.role
    };

    // Remove any user ID from incoming bet data
    socket.use((packet, next) => {
      if (packet[0] === 'placeBet') {
        const betData = packet[1];
        // Remove any user ID from the bet data
        delete betData.userId;
        packet[1] = betData;
      }
      next();
    });

    // Log successful authentication
    logger.info('SOCKET_AUTH_SUCCESS', {
      service: 'aviator-backend',
      socketId: socket.id,
      socketName: socketName,
      namespace: socketNamespace,
      userId: decoded.user_id,
      username: decoded.username,
      role: decoded.role
    });

    next();
  } catch (error) {
    // Log authentication error with full context
    logger.error('SOCKET_AUTH_ERROR', {
      service: 'aviator-backend',
      socketId: socket.id,
      socketName: socketName,
      namespace: socketNamespace,
      errorType: error.constructor.name,
      errorMessage: error.message,
      errorStack: error.stack,
      handshakeAuth: socket.handshake.auth
    });
    next(new Error('Authentication failed'));
  }
}

/**
 * Extract token from socket handshake
 */
function extractToken(socket) {
  try {
    // Log token extraction attempt
    logger.debug('TOKEN_EXTRACTION_ATTEMPT', {
      service: 'aviator-backend',
      socketId: socket.id,
      hasAuthToken: !!socket.handshake?.auth?.token,
      hasAuthHeader: !!socket.handshake?.headers?.authorization,
      hasQueryToken: !!socket.handshake?.query?.token,
      foundToken: false
    });

    // Try to get token from handshake auth
    const token = socket.handshake?.auth?.token ||
                 socket.handshake?.headers?.authorization?.replace('Bearer ', '') ||
                 socket.handshake?.query?.token;

    // Log token extraction result
    logger.debug('TOKEN_EXTRACTION_RESULT', {
      service: 'aviator-backend',
      socketId: socket.id,
      hasToken: !!token,
      authKeys: Object.keys(socket.handshake.auth || {}),
      headerKeys: Object.keys(socket.handshake.headers || {}),
      queryKeys: Object.keys(socket.handshake.query || {})
    });

    return token;
  } catch (error) {
    logger.error('TOKEN_EXTRACTION_ERROR', {
      service: 'aviator-backend',
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
    
    // Log token verification attempt
    logger.debug('TOKEN_VERIFY_ATTEMPT', {
      service: 'aviator-backend',
      socketName: socketName,
      namespace: namespace,
      decodedFields: Object.keys(decoded),
      hasUserId: !!decoded.user_id,
      hasUsername: !!decoded.username,
      hasRole: !!decoded.role
    });
    
    // Validate required fields
    const requiredFields = ['user_id', 'username', 'role'];
    const missingFields = requiredFields.filter(field => !decoded[field]);
    
    if (missingFields.length > 0) {
      logger.error('TOKEN_MISSING_FIELDS', {
        service: 'aviator-backend',
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
      service: 'aviator-backend',
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
