const express = require('express');
const gameController = require('../controllers/gameController');

const router = express.Router();

// Get current game state
router.get('/state', gameController.getGameState);

// Get game history
router.get('/history', gameController.getGameHistory);

// Place a bet
router.post('/bet', gameController.placeBet);

// Cash out during game
router.post('/cashout', gameController.cashOut);

module.exports = router;
