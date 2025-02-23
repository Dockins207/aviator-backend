import logger from '../config/logger.js';

class NotificationService {
  constructor() {
    this.io = null;
  }

  setSocketIO(io) {
    this.io = io;
    logger.info('Notification service socket initialized');
  }

  sendUserNotification(userId, event, data) {
    if (!this.io) {
      logger.error('Socket IO not initialized for notifications');
      return;
    }

    // Find all socket connections for this user
    const userSockets = Array.from(this.io.sockets.sockets.values())
      .filter(socket => socket.user && socket.user.user_id === userId);

    if (userSockets.length === 0) {
      logger.warn('No active sockets found for user', { userId, event });
      return;
    }

    // Emit the event only to the user's sockets
    userSockets.forEach(socket => {
      socket.emit(event, data);
    });

    logger.info('User notification sent', { 
      userId, 
      event, 
      socketCount: userSockets.length 
    });
  }

  broadcastNotification(event, data) {
    if (!this.io) {
      logger.error('Socket IO not initialized for notifications');
      return;
    }

    // Only broadcast game-related events that should be public
    const publicEvents = ['gameState', 'totalBetsUpdate', 'multiplierUpdate'];
    if (!publicEvents.includes(event)) {
      logger.warn('Attempted to broadcast non-public event', { event });
      return;
    }

    this.io.emit(event, data);
    logger.info('Broadcast notification sent', { event });
  }

  static sendNotification() {
    logger.warn('Notifications are currently disabled');
  }

  initialize() {
    logger.info('Notification service initialized');
    return true;
  }

  health() {
    return {
      status: 'healthy',
      details: 'Notification service is operational'
    };
  }
}

export default new NotificationService();
