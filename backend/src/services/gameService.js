import gameUtils from '../utils/gameUtils.js';
import gameConfig from '../config/gameConfig.js';
import GameRepository from '../repositories/gameRepository.js';
import logger from '../config/logger.js';

class GameBoardService {
  constructor() {
    this.resetGameState();
    this.countdownInterval = null;
    this.multiplierInterval = null;
    this.gameLoopActive = false;
    this.pauseBetweenGames = false;
  }

  // Reset game state to initial betting phase
  resetGameState() {
    this.gameState = {
      status: 'betting',
      gameId: gameUtils.generateGameUUID(),
      multiplier: 1.00,
      countdown: 5,
      crashPoint: null,
      startTime: null,
      players: [],
      bets: []
    };
  }

  // Start game cycle
  async startGameCycle() {
    // Prevent multiple simultaneous game cycles
    if (this.gameLoopActive) {
      return;
    }

    try {
      // Mark game loop as active
      this.gameLoopActive = true;

      // Reset game state
      this.resetGameState();

      // Start betting phase
      await this.startBettingPhase();

      // Start flying phase
      await this.startFlyingPhase();

      // Crash game
      this.crashGame();
    } catch (error) {
      console.error('Game cycle error:', error);
    } finally {
      // Mark game loop as inactive
      this.gameLoopActive = false;

      // 4-second pause before next game
      await new Promise(resolve => setTimeout(resolve, 4000));

      // Start next game cycle
      this.startGameCycle();
    }
  }

  // Start betting phase with 5-second countdown
  startBettingPhase() {
    // Generate and log crash point
    this.gameState.crashPoint = gameUtils.generateCrashPoint();
    
    // Set initial countdown to 5
    this.gameState.countdown = 5;

    console.log(`🎲 Betting Phase Started`);
    console.log(`Game ID: ${this.gameState.gameId}`);
    console.log(`Crash Point: ${gameUtils.formatMultiplier(this.gameState.crashPoint)}x`);
    console.log(`Betting Countdown: 5 seconds`);

    // Start countdown
    return new Promise((resolve) => {
      this.countdownInterval = setInterval(() => {
        // Decrease countdown
        this.gameState.countdown--;

        // Real-time countdown logging
        console.log(`Betting Countdown: ${this.gameState.countdown} seconds`);

        // Check if countdown is complete
        if (this.gameState.countdown <= 0) {
          // Stop countdown
          clearInterval(this.countdownInterval);
          
          resolve(this.gameState);
        }
      }, 1000);
    });
  }

  // Start flying phase with multiplier progression
  startFlyingPhase() {
    // Set flying state
    this.gameState.status = 'flying';
    this.gameState.startTime = Date.now();
    this.gameState.multiplier = 1.00;

    console.log(`\n🚀 Flying Phase Started 🚀`);
    console.log(`Initial Multiplier: ${gameUtils.formatMultiplier(this.gameState.multiplier)}x`);

    // Start multiplier progression
    return new Promise((resolve) => {
      this.multiplierInterval = setInterval(() => {
        try {
          // Use the progression method from gameUtils
          this.gameState.multiplier = gameUtils.simulateMultiplierProgression(
            this.gameState.multiplier, 
            this.gameState.crashPoint
          );
          
          // Real-time multiplier logging
          console.log(`+0.01 Multiplier: ${gameUtils.formatMultiplier(this.gameState.multiplier)}x`);
          
          // Check if game has crashed (exactly at crash point)
          if (this.gameState.multiplier === this.gameState.crashPoint) {
            clearInterval(this.multiplierInterval);
            resolve(this.gameState);
          }
        } catch (error) {
          console.error('Error in flying phase:', error);
          clearInterval(this.multiplierInterval);
          resolve(this.gameState);
        }
      }, gameConfig.MULTIPLIER_UPDATE_INTERVAL);
    });
  }

  // Crash the game
  crashGame() {
    // Set game state to crashed
    this.gameState.status = 'crashed';
    
    // Ensure final multiplier matches the crash point exactly
    this.gameState.multiplier = this.gameState.crashPoint;
    
    // Log crashed state with final multiplier
    console.log(`💥 CRASHES @ ${gameUtils.formatMultiplier(this.gameState.multiplier)}x`);

    // Save game result to repository
    GameRepository.saveGameResult(this.gameState);
  }

  // Get current game state
  getCurrentGameState() {
    return { ...this.gameState };
  }

  // Add a player to the game
  addPlayer(playerData) {
    // Check if player already exists
    const existingPlayerIndex = this.gameState.players.findIndex(
      player => player.id === playerData.id
    );

    if (existingPlayerIndex !== -1) {
      // Update existing player
      this.gameState.players[existingPlayerIndex] = {
        ...this.gameState.players[existingPlayerIndex],
        ...playerData
      };
    } else {
      // Add new player
      this.gameState.players.push(playerData);
    }
  }

  // Place a bet
  placeBet(betData) {
    // Validate bet
    if (!betData.playerId || !betData.betAmount || betData.betAmount <= 0) {
      throw new Error('Invalid bet');
    }

    // Check game status
    if (this.gameState.status !== 'betting') {
      throw new Error('Cannot place bet outside betting phase');
    }

    // Find player
    const playerIndex = this.gameState.players.findIndex(
      player => player.id === betData.playerId
    );

    if (playerIndex === -1) {
      throw new Error('Player not found');
    }

    // Add bet
    const bet = {
      playerId: betData.playerId,
      betAmount: betData.betAmount,
      timestamp: Date.now()
    };

    this.gameState.bets.push(bet);
    this.gameState.players[playerIndex].betAmount = betData.betAmount;
  }

  // Cash out during game
  cashOut(cashOutData) {
    // Validate cash out
    if (!cashOutData.playerId) {
      throw new Error('Invalid cash out');
    }

    // Check game status
    if (this.gameState.status !== 'flying') {
      throw new Error('Cannot cash out outside flying phase');
    }

    // Find player
    const playerIndex = this.gameState.players.findIndex(
      player => player.id === cashOutData.playerId
    );

    if (playerIndex === -1) {
      throw new Error('Player not found');
    }

    // Add cash out point
    this.gameState.players[playerIndex].cashOutPoint = this.gameState.multiplier;
  }

  // Add player during betting phase
  addPlayerToBetting(playerId, betAmount) {
    if (this.gameState.status !== 'betting') {
      logger.warn(`Cannot add player ${playerId} outside of betting phase`);
      throw new Error('Cannot add players outside of betting phase');
    }

    // Check for duplicate players
    const existingPlayerIndex = this.gameState.players.findIndex(p => p.playerId === playerId);
    if (existingPlayerIndex !== -1) {
      // Update existing player's bet
      this.gameState.players[existingPlayerIndex].betAmount = betAmount;
      logger.info(`Player ${playerId} updated bet to ${betAmount}`);
    } else {
      // Add new player
      this.gameState.players.push({
        playerId,
        betAmount,
        status: 'in_game',
        autoCashout: null
      });
      logger.info(`Player ${playerId} added with bet ${betAmount}`);
    }

    return this.gameState;
  }

  // Player cash out during flying phase
  playerCashOut(playerId, autoCashout) {
    if (this.gameState.status !== 'flying') {
      logger.warn(`Cannot cash out player ${playerId} outside of flying phase`);
      throw new Error('Cannot cash out outside of flying phase');
    }

    const playerIndex = this.gameState.players.findIndex(
      player => player.playerId === playerId
    );

    if (playerIndex === -1) {
      logger.warn(`Player ${playerId} not found in current game`);
      throw new Error('Player not found in current game');
    }

    this.gameState.players[playerIndex].autoCashout = autoCashout;
    logger.info(`Player ${playerId} set auto cashout at multiplier ${autoCashout}`);
    
    return this.gameState;
  }

  // Cleanup method
  destroy() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
    if (this.multiplierInterval) {
      clearInterval(this.multiplierInterval);
    }
    logger.info('Game service resources cleaned up');
  }
}

export default new GameBoardService();