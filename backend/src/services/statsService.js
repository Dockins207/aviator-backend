import logger from '../config/logger.js';

class StatsService {
  constructor() {
    this.onlineUsers = new Set();
    this.totalBets = 0;
    this.io = null;
  }

  // Set the Socket.IO instance for broadcasting
  setSocketIO(io) {
    this.io = io;
    logger.info('STATS_SERVICE_SOCKET_INITIALIZED', {
      message: 'Socket.IO instance set for stats service'
    });
  }

  // Track a user as online when they connect
  addOnlineUser(userId) {
    if (userId) {
      this.onlineUsers.add(userId);
      this.broadcastStats();
    }
  }

  // Remove a user from online users when they disconnect
  removeOnlineUser(userId) {
    if (userId) {
      this.onlineUsers.delete(userId);
      this.broadcastStats();
    }
  }

  // Increment total bets by amount
  incrementTotalBetsByAmount(betAmount) {
    this.totalBets += betAmount;
    this.broadcastStats();
  }

  // Reset total bets (e.g., at the start of a new game round)
  resetTotalBets() {
    this.totalBets = 0;
    this.broadcastStats();
  }

  // Broadcast current stats to all connected clients
  broadcastStats() {
    if (!this.io) {
      logger.warn('STATS_SERVICE_SOCKET_NOT_INITIALIZED', {
        message: 'Attempting to broadcast stats before Socket.IO initialization'
      });
      return;
    }

    try {
      this.io.emit('game_stats', {
        onlineUsers: this.onlineUsers.size,
        totalBets: this.totalBets,
        timestamp: new Date().toISOString()
      });

      logger.info('STATS_BROADCASTED', {
        onlineUsers: this.onlineUsers.size,
        totalBets: this.totalBets
      });
    } catch (error) {
      logger.error('STATS_BROADCAST_ERROR', {
        errorMessage: error.message
      });
    }
  }
}

export default new StatsService();
