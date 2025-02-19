import logger from '../config/logger.js';

class NotificationService {
  constructor() {
    this.io = null;
    this.notificationQueue = [];
    this.initializationAttempts = 0;
    this.MAX_INITIALIZATION_ATTEMPTS = 10;
  }

  /**
   * Set the Socket.IO instance and process queued notifications
   * @param {SocketIOServer} io - Socket.IO server instance
   */
  setSocketIO(io) {
    this.io = io;
    this.initializationAttempts = 0;
    logger.info('NOTIFICATION_SERVICE_INITIALIZED', {
      message: 'Socket.IO instance set for notifications'
    });

    // Process queued notifications
    this.processQueuedNotifications();
  }

  /**
   * Process queued notifications with retry mechanism
   */
  processQueuedNotifications() {
    const MAX_QUEUE_PROCESS_ATTEMPTS = 3;
    let processingAttempts = 0;

    const processQueue = () => {
      processingAttempts++;
      
      while (this.notificationQueue.length > 0) {
        const { type, userId, event, data } = this.notificationQueue.shift();
        
        try {
          if (type === 'user') {
            this.sendUserNotification(userId, event, data);
          } else if (type === 'broadcast') {
            this.broadcastNotification(event, data);
          }
        } catch (error) {
          logger.warn('NOTIFICATION_QUEUE_PROCESSING_ERROR', {
            message: 'Failed to process queued notification',
            type,
            event,
            error: error.message,
            processingAttempts
          });

          // Re-queue the notification if processing attempts are not exhausted
          if (processingAttempts < MAX_QUEUE_PROCESS_ATTEMPTS) {
            this.notificationQueue.unshift({ type, userId, event, data });
            setTimeout(processQueue, 1000); // Retry after 1 second
            return;
          }
        }
      }
    };

    processQueue();
  }

  /**
   * Safely send notification to a specific user
   * @param {string} userId - Target user ID
   * @param {string} event - Event type
   * @param {Object} data - Notification payload
   */
  sendUserNotification(userId, event, data) {
    if (!this.io) {
      this.initializationAttempts++;
      
      logger.warn('SOCKET_NOT_INITIALIZED', {
        message: 'Queuing user notification before Socket.IO initialization',
        userId,
        event,
        attempts: this.initializationAttempts
      });

      // Prevent infinite queuing
      if (this.initializationAttempts <= this.MAX_INITIALIZATION_ATTEMPTS) {
        this.notificationQueue.push({ type: 'user', userId, event, data });
      } else {
        logger.error('MAX_SOCKET_INITIALIZATION_ATTEMPTS_EXCEEDED', {
          message: 'Failed to initialize socket after multiple attempts',
          userId,
          event
        });
      }
      return;
    }

    // Find all sockets for the specific user
    const userSockets = Array.from(this.io.sockets.sockets.values())
      .filter(socket => socket.user?.id === userId);

    userSockets.forEach(socket => {
      try {
        socket.emit(event, data);
      } catch (error) {
        logger.warn('USER_NOTIFICATION_EMIT_ERROR', {
          message: 'Failed to emit notification to user socket',
          userId,
          event,
          error: error.message
        });
      }
    });
  }

  /**
   * Safely broadcast notification to all connected clients
   * @param {string} event - Event type
   * @param {Object} data - Notification payload
   */
  broadcastNotification(event, data) {
    if (!this.io) {
      this.initializationAttempts++;
      
      logger.warn('SOCKET_NOT_INITIALIZED', {
        message: 'Queuing broadcast notification before Socket.IO initialization',
        event,
        attempts: this.initializationAttempts
      });

      // Prevent infinite queuing
      if (this.initializationAttempts <= this.MAX_INITIALIZATION_ATTEMPTS) {
        this.notificationQueue.push({ type: 'broadcast', event, data });
      } else {
        logger.error('MAX_SOCKET_INITIALIZATION_ATTEMPTS_EXCEEDED', {
          message: 'Failed to initialize socket after multiple attempts',
          event
        });
      }
      return;
    }

    try {
      this.io.emit(event, data);
      
      logger.info('BROADCAST_NOTIFICATION_SENT', {
        event,
        data
      });
    } catch (error) {
      logger.warn('BROADCAST_NOTIFICATION_ERROR', {
        message: 'Failed to broadcast notification',
        event,
        error: error.message
      });
    }
  }
}

export default new NotificationService();
