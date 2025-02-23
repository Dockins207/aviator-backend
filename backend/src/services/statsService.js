import logger from '../config/logger.js';

class StatsService {
  constructor() {
    // Session-specific stats that reset between game rounds
    this.sessionStats = {
      onlineUsers: new Set(),
      totalBetsCount: 0,
      totalBetAmount: 0
    };

    // Track whether stats have been broadcasted in this session
    this.statsAlreadyBroadcasted = false;

    // Persistent stats that accumulate across sessions
    this.persistentStats = {
      totalBetsEver: 0,
      totalBetAmountEver: 0
    };

    // Deduplication tracking
    this.lastBroadcastedStats = {
      onlineUsers: 0,
      totalBetsCount: 0,
      totalBetAmount: 0,
      lastBroadcastTimestamp: 0
    };

    this.io = null;

    // Initialize and start real-time broadcasting
    this.initializeStatsTracking();
  }

  // Modify initialization to broadcast only once per session
  initializeStatsTracking() {
    // Reset broadcast flag at initialization
    this.statsAlreadyBroadcasted = false;
  }

  // Broadcast Current Session Stats with single broadcast
  broadcastSessionStats() {
    if (!this.io || this.statsAlreadyBroadcasted) {
      return;
    }

    try {
      const statsPayload = {
        onlineUsers: this.sessionStats.onlineUsers.size,
        totalBetsCount: this.sessionStats.totalBetsCount,
        totalBetAmount: this.sessionStats.totalBetAmount,
        timestamp: new Date().toISOString()
      };

      // Emit stats and mark as broadcasted
      this.io.emit('game_session_stats', statsPayload);
      this.statsAlreadyBroadcasted = true;
    } catch (error) {
      // Silently handle broadcast errors
      console.error('Stats broadcast error', error);
    }
  }

  // Override setSocketIO to reset broadcast flag
  setSocketIO(io) {
    this.io = io;
    this.statsAlreadyBroadcasted = false;
  }

  // Online Users Management
  addOnlineUser(userId) {
    if (userId) {
      this.sessionStats.onlineUsers.add(userId);
      // Only broadcast if not already done
      if (!this.statsAlreadyBroadcasted) {
        this.broadcastSessionStats();
      }
    }
  }

  removeOnlineUser(userId) {
    if (userId) {
      this.sessionStats.onlineUsers.delete(userId);
      // Only broadcast if not already done
      if (!this.statsAlreadyBroadcasted) {
        this.broadcastSessionStats();
      }
    }
  }

  // Bet Tracking Methods
  incrementTotalBetsCount() {
    this.sessionStats.totalBetsCount += 1;
    this.persistentStats.totalBetsEver += 1;
    // Only broadcast if not already done
    if (!this.statsAlreadyBroadcasted) {
      this.broadcastSessionStats();
    }
  }

  incrementTotalBetAmount(betAmount) {
    this.sessionStats.totalBetAmount += betAmount;
    this.persistentStats.totalBetAmountEver += betAmount;
    // Only broadcast if not already done
    if (!this.statsAlreadyBroadcasted) {
      this.broadcastSessionStats();
    }
  }

  // Increment total bets count and amount
  incrementTotalBets(count = 1, amount = 0) {
    // Increment session stats
    this.sessionStats.totalBetsCount += count;
    this.sessionStats.totalBetAmount += amount;

    // Increment persistent stats
    this.persistentStats.totalBetsEver += count;
    this.persistentStats.totalBetAmountEver += amount;

    // Reset broadcast flag to allow new stats broadcast
    this.statsAlreadyBroadcasted = false;

    // Optional: Log the increment for debugging
    console.log('Total Bets Incremented:', {
      sessionBetsCount: this.sessionStats.totalBetsCount,
      sessionBetAmount: this.sessionStats.totalBetAmount,
      persistentBetsCount: this.persistentStats.totalBetsEver,
      persistentBetAmount: this.persistentStats.totalBetAmountEver
    });

    return {
      sessionBetsCount: this.sessionStats.totalBetsCount,
      sessionBetAmount: this.sessionStats.totalBetAmount
    };
  }

  // Reset Session Stats
  resetSessionStats() {
    this.sessionStats.totalBetsCount = 0;
    this.sessionStats.totalBetAmount = 0;
    this.sessionStats.onlineUsers = new Set();
    this.statsAlreadyBroadcasted = false;

    console.log('Session Stats Reset');
  }

  // Reset stats when game crashes
  resetStatsOnGameCrash() {
    // Reset session-specific stats
    this.sessionStats = {
      onlineUsers: new Set(),
      totalBetsCount: 0,
      totalBetAmount: 0
    };

    // Optional: Log the crash reset
    logger.warn('STATS_RESET_ON_GAME_CRASH', {
      message: 'Game stats reset due to unexpected game crash'
    });

    // Reset broadcast flag
    this.statsAlreadyBroadcasted = false;
  }

  // Optional method to get persistent stats if needed
  getPersistentStats() {
    return {
      totalBetsEver: this.persistentStats.totalBetsEver,
      totalBetAmountEver: this.persistentStats.totalBetAmountEver
    };
  }
}

export default new StatsService();
