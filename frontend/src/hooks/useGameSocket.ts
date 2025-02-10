import { useState, useEffect, useCallback } from 'react';
import gameSocketService, { GameState, Player } from '../services/gameSocketService';

export const useGameSocket = () => {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Connect to socket
    const socket = gameSocketService.connect();

    // Set up game state listener
    gameSocketService.onGameStateUpdate((newGameState) => {
      setGameState(newGameState);
    });

    // Connection status
    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    // Cleanup on unmount
    return () => {
      gameSocketService.disconnect();
    };
  }, []);

  // Join game method
  const joinGame = useCallback((playerData: Partial<Player>) => {
    gameSocketService.onJoinGameResponse((response) => {
      if (!response.success) {
        setError(response.message);
      }
    });
    gameSocketService.joinGame(playerData);
  }, []);

  // Place bet method
  const placeBet = useCallback((betAmount: number) => {
    gameSocketService.onBetPlacementResponse((response) => {
      if (!response.success) {
        setError(response.message);
      }
    });
    gameSocketService.placeBet({ betAmount });
  }, []);

  // Cash out method
  const cashOut = useCallback(() => {
    gameSocketService.onCashOutResponse((response) => {
      if (!response.success) {
        setError(response.message);
      }
    });
    gameSocketService.cashOut();
  }, []);

  // Clear error
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    gameState,
    isConnected,
    error,
    joinGame,
    placeBet,
    cashOut,
    clearError
  };
};
