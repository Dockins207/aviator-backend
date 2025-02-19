import jwt from 'jsonwebtoken';
import logger from '../config/logger.js';

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_here';

// Track authenticated sockets to prevent duplicate logs
const authenticatedSockets = new Set();

export default async function socketAuthMiddleware(socket, next) {
  try {
    // Enhanced token extraction
    const token = 
      socket.handshake.auth.token || 
      socket.handshake.auth.accessToken || 
      socket.handshake.headers.authorization?.split(' ')[1] ||
      socket.handshake.headers['x-access-token'] ||
      socket.handshake.query.token;

    if (!token) {
      logger.error('Socket Authentication Error: No token provided', {
        authObject: socket.handshake.auth,
        headers: socket.handshake.headers,
        query: socket.handshake.query,
        socketId: socket.id
      });
      return next(new Error('Authentication error: No token provided'));
    }

    try {
      // Verify the token
      const decoded = jwt.verify(token, JWT_SECRET);

      // Attach decoded user to socket
      socket.user = {
        id: decoded.id || decoded.user_id || socket.handshake.auth.userId,
        username: decoded.username || socket.handshake.auth.username
      };

      // Create a unique key for this authentication event
      const authKey = `${socket.user.id}-${socket.id}`;

      // Log authentication only if not already logged
      if (!authenticatedSockets.has(authKey)) {
        logger.info('SOCKET_AUTHENTICATION', { 
          userId: socket.user.id, 
          socketId: socket.id 
        });
        authenticatedSockets.add(authKey);
      }

      next();
    } catch (error) {
      logger.error('Socket Authentication Error', { 
        error: error.message,
        errorName: error.name,
        token: token.substring(0, 10) + '...' // Partial token for debugging
      });
      if (error.name === 'TokenExpiredError') {
        return next(new Error('Authentication error: Token expired'));
      }

      return next(new Error('Authentication error: Invalid token'));
    }
  } catch (error) {
    logger.error('Unexpected Socket Authentication Error', { 
      errorMessage: error.message,
      socketId: socket.id
    });
    return next(new Error('Unexpected authentication error'));
  }
}
