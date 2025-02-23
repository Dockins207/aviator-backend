import logger from '../config/logger.js';
import WagerMonitorRedisService from '../redis-services/wagerMonitorRedisService.js';
import { v4 as uuidv4 } from 'uuid';

class WagerMonitorService {
  constructor(redisService = new WagerMonitorRedisService()) {
    this.redisService = redisService;
    
    // Active wager tracking
    this.activeWagers = new Map();
    
    // Wager lifecycle events
    this.wagerEvents = {
      onBetPlaced: new Set(),
      onBetCashedOut: new Set(),
      onBetCrashed: new Set()
    };
  }

  // Comprehensive bet placement tracking
  async placeBet(userId, gameId, betAmount, username) {
    try {
      // Strict username validation with more robust fallback
      const sanitizedUsername = (username && username.trim() !== '') 
        ? username.trim() 
        : userId || 'Unknown Player';

      // Validate and format bet amount to two decimal places
      const formattedBetAmount = Number(betAmount.toFixed(2));
      if (formattedBetAmount <= 0) {
        throw new Error('Invalid bet amount');
      }

      // Create unique wager ID
      const wagerId = uuidv4();

      // Construct comprehensive wager object
      const wager = {
        id: wagerId,
        userId,
        username: sanitizedUsername,  // Use sanitized username
        gameId,
        betAmount: formattedBetAmount,
        status: 'active',
        placedAt: new Date().toISOString(),
        multiplier: 1.0,
        potentialWinnings: null
      };

      // Log the full wager details for verification with formatted amount
      console.log('Wager Placement Details:', {
        userId,
        username: wager.username,  // Always log the username
        betAmount: wager.betAmount.toFixed(2)
      });

      // Store in active wagers
      this.activeWagers.set(wagerId, wager);

      // Persist to Redis
      await this.redisService.saveWager(wager);

      // Log detailed bet placement with explicit username
      this.logWagerEvent('BET_PLACED', wager);

      // Trigger bet placed events
      this.wagerEvents.onBetPlaced.forEach(callback => 
        callback({
          ...wager,
          username: wager.username  // Ensure username is passed
        })
      );

      return wager;
    } catch (error) {
      console.error('Bet Placement Failed', {
        userId,
        gameId,
        betAmount: Number(betAmount.toFixed(2)),
        username: username || 'No Username Provided',
        errorMessage: error.message
      });
      throw error;
    }
  }

  // Dynamic cashout mechanism
  async cashoutBet(wagerId, cashoutPoint, multiplier) {
    try {
      const wager = this.activeWagers.get(wagerId);

      if (!wager) {
        throw new Error('Wager not found');
      }

      // Calculate winnings
      const winnings = wager.betAmount * multiplier;

      // Update wager status
      const updatedWager = {
        ...wager,
        status: 'cashed_out',
        cashoutPoint,
        multiplier,
        winnings,
        cashedOutAt: new Date().toISOString()
      };

      // Update in active wagers and Redis
      this.activeWagers.set(wagerId, updatedWager);
      await this.redisService.updateWager(updatedWager);

      // Log cashout event
      this.logWagerEvent('BET_CASHOUT', updatedWager);

      // Trigger cashout events
      this.wagerEvents.onBetCashedOut.forEach(callback => 
        callback(updatedWager)
      );

      return updatedWager;
    } catch (error) {
      logger.error('Bet Cashout Failed', {
        wagerId,
        cashoutPoint,
        errorMessage: error.message
      });
      throw error;
    }
  }

  // Handle individual wager crash
  async handleGameCrash(wagerId) {
    try {
      const wager = this.activeWagers.get(wagerId);

      if (!wager) {
        throw new Error('Wager not found');
      }

      // Update wager status
      const crashedWager = {
        ...wager,
        status: 'crashed',
        crashedAt: new Date().toISOString(),
        winnings: 0
      };

      // Update in active wagers and Redis
      this.activeWagers.set(wagerId, crashedWager);
      await this.redisService.updateWager(crashedWager);

      // Log crash event
      this.logWagerEvent('WAGER_CRASHED', crashedWager);

      // Trigger crash events
      this.wagerEvents.onBetCrashed.forEach(callback => 
        callback(crashedWager)
      );

      return crashedWager;
    } catch (error) {
      logger.error('Wager Crash Handling Failed', {
        wagerId,
        errorMessage: error.message
      });
      throw error;
    }
  }

  // Get user's active wagers
  async getUserActiveWagers(userId = null) {
    try {
      const activeWagers = userId 
        ? Array.from(this.activeWagers.values())
            .filter(wager => wager.userId === userId && wager.status === 'active')
        : Array.from(this.activeWagers.values())
            .filter(wager => wager.status === 'active');

      return activeWagers;
    } catch (error) {
      logger.error('Active Wagers Retrieval Failed', {
        userId,
        errorMessage: error.message
      });
      throw error;
    }
  }

  // Event subscription methods
  onBetPlaced(callback) {
    this.wagerEvents.onBetPlaced.add(callback);
    return () => this.wagerEvents.onBetPlaced.delete(callback);
  }

  onBetCashedOut(callback) {
    this.wagerEvents.onBetCashedOut.add(callback);
    return () => this.wagerEvents.onBetCashedOut.delete(callback);
  }

  onBetCrashed(callback) {
    this.wagerEvents.onBetCrashed.add(callback);
    return () => this.wagerEvents.onBetCrashed.delete(callback);
  }

  // Logging utility
  logWagerEvent(eventType, wagerData, additionalMetadata = {}) {
    // Ensure username is always included in the event
    const eventData = {
      ...wagerData,
      username: wagerData.username || 'Unknown Player'
    };

    console.log(`Wager Event: ${eventType}`, {
      username: eventData.username,
      betAmount: eventData.betAmount.toFixed(2)
    });

    // If using a notification service, emit the event with explicit username
    if (this.notificationService) {
      this.notificationService.broadcastNotification('bet_placed', {
        ...eventData,
        username: eventData.username  // Explicitly include username
      });
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      eventType,
      wagerId: wagerData.id,
      userId: wagerData.userId,
      username: wagerData.username,
      gameId: wagerData.gameId,
      betAmount: wagerData.betAmount,
      status: wagerData.status,
      ...additionalMetadata
    };

    // Log to console and logger
    console.log(`[WAGER_EVENT] ${eventType}:`, JSON.stringify(logEntry, null, 2));
    logger.info('Wager Event', logEntry);

    return logEntry;
  }

  // Cleanup method to remove old or completed wagers
  cleanupWagers(maxAgeMinutes = 60) {
    const now = new Date();
    
    for (const [wagerId, wager] of this.activeWagers.entries()) {
      const wagerAge = (now - new Date(wager.placedAt)) / (1000 * 60);
      
      if (
        wagerAge > maxAgeMinutes || 
        wager.status !== 'active'
      ) {
        this.activeWagers.delete(wagerId);
      }
    }
  }
}

export default new WagerMonitorService();
