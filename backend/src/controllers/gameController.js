const GameBoardService = require('../services/gameBoardService');
const GameRepository = require('../repositories/gameRepository');

class GameController {
  async getGameState(req, res) {
    try {
      const gameState = GameBoardService.getGameState();
      res.json(gameState);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async getGameHistory(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const history = await GameRepository.getGameHistory(limit);
      res.json(history);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async placeBet(req, res) {
    try {
      const { playerId, betAmount } = req.body;
      
      // Validate bet amount
      if (betAmount < 1 || betAmount > 1000) {
        return res.status(400).json({ error: 'Invalid bet amount' });
      }

      // Add player to betting
      const gameState = GameBoardService.addPlayerToBetting(playerId, betAmount);
      res.json(gameState);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async cashOut(req, res) {
    try {
      const { playerId, autoCashout } = req.body;
      
      // Validate auto cashout
      if (autoCashout < 1) {
        return res.status(400).json({ error: 'Invalid cashout multiplier' });
      }

      // Process player cashout
      const gameState = GameBoardService.playerCashOut(playerId, autoCashout);
      res.json(gameState);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new GameController();
