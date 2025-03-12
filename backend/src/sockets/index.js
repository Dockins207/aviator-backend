import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import betSocketHandler from './betSocket.js';
import gameSocketHandler from './gameSocket.js';
import chatSocketHandler from './chatSocket.js';
import logger from '../config/logger.js';
import config from '../config/index.js';

/**
 * Initialize Socket.IO server with authentication and handlers
 * @param {Object} httpServer - HTTP server to attach socket.io to
 * @returns {Object} - Initialized Socket.IO server
 */
const initializeSocketServer = (httpServer) => {
  const io = new Server(httpServer, {
    cors: {
      origin: config.corsOrigin,
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  // Middleware for authentication
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      
      if (!token) {
        logger.warn('SOCKET_AUTH_MISSING_TOKEN', {
          socketId: socket.id,
          ip: socket.handshake.address
        });
        return next(new Error('Authentication token required'));
      }

      // Verify JWT token
      const decoded = jwt.verify(token, config.jwtSecret);
      
      // Store user data in socket for use in handlers
      socket.user = {
        userId: decoded.userId,
        username: decoded.username,
        role: decoded.role || 'user'
      };

      logger.info('SOCKET_USER_CONNECTED', {
        userId: decoded.userId,
        username: decoded.username,
        socketId: socket.id
      });

      // Add socket to user-specific room for targeted events
      socket.join(`user:${decoded.userId}`);
      
      next();
    } catch (error) {
      logger.error('SOCKET_AUTH_ERROR', {
        error: error.message,
        socketId: socket.id,
        ip: socket.handshake.address
      });
      next(new Error('Authentication failed'));
    }
  });

  // Connection handler
  io.on('connection', (socket) => {
    logger.info('SOCKET_NEW_CONNECTION', {
      socketId: socket.id,
      userId: socket.user?.userId
    });

    // Initialize socket handlers
    betSocketHandler(io, socket, socket.user);
    
    // These would be other socket handlers if they exist
    if (typeof gameSocketHandler === 'function') {
      gameSocketHandler(io, socket, socket.user);
    }
    
    if (typeof chatSocketHandler === 'function') {
      chatSocketHandler(io, socket, socket.user);
    }
  });

  // Global error handler for uncaught socket errors
  io.engine.on('connection_error', (err) => {
    logger.error('SOCKET_CONNECTION_ERROR', {
      error: err.message,
      code: err.code,
      type: err.type
    });
  });

  return io;
};

export default initializeSocketServer;
