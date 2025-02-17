import jwt from 'jsonwebtoken';
import logger from '../config/logger.js';

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_here';

export default function socketAuthMiddleware(socket, next) {
  try {
    // Extract token from socket handshake, supporting multiple possible token fields
    const token = socket.handshake.auth.token || 
                  socket.handshake.auth.accessToken || 
                  socket.handshake.headers.authorization?.split(' ')[1];

    if (!token) {
      logger.error('Socket Authentication Error: No token provided', {
        authObject: socket.handshake.auth,
        headers: socket.handshake.headers
      });
      return next(new Error('Authentication error: No token provided'));
    }

    // Verify the token
    const decoded = jwt.verify(token, JWT_SECRET);

    // Attach user information to the socket
    socket.user = {
      id: decoded.id || socket.handshake.auth.userId,
      username: decoded.username || socket.handshake.auth.username
    };

    logger.info('Socket Authentication Successful', { 
      userId: socket.user.id, 
      socketId: socket.id 
    });

    next();
  } catch (error) {
    logger.error('Socket Authentication Error', { 
      error: error.message,
      errorName: error.name,
      authObject: socket.handshake.auth
    });

    if (error.name === 'TokenExpiredError') {
      return next(new Error('Authentication error: Token expired'));
    }

    return next(new Error('Authentication error: Invalid token'));
  }
}
