export default {
  BETTING_DURATION: 5000,  // 5 seconds
  MIN_BET: 1,
  MAX_BET: 1000,
  MULTIPLIER_UPDATE_INTERVAL: 100, // Update multiplier every 100ms
  PAUSE_BETWEEN_GAMES: 3000, // Pause duration between game cycles (in milliseconds)
  // Bet transfer configuration
  BET_TRANSFER_WINDOW_MINUTES: 5,  // Maximum time to transfer a bet between game sessions
  BET_TRANSFER_MAX_AMOUNT_VARIANCE: 0.2,  // 20% variance allowed in bet amount
  BET_TRANSFER_SUSPICIOUS_THRESHOLD: 2,  // Multiplier to detect suspicious bet patterns
};
