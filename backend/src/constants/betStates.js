export const BetState = {
  PLACED: 'PLACED',     // Initial state when bet is placed
  ACTIVE: 'ACTIVE',     // Bet is active in current game session
  WON: 'WON',          // Bet was won
  LOST: 'LOST'         // Bet was lost
};

export const GameState = {
  BETTING: 'BETTING',   // Game is in betting phase
  FLYING: 'FLYING',     // Game is in flying state (multiplier increasing)
  CRASHED: 'CRASHED'    // Game has crashed
};
