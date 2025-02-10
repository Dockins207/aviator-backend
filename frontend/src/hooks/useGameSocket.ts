import { useState, useEffect, useCallback } from 'react';
import gameSocketService, { GameState, Player } from '../services/gameSocketService';

export const useGameSocket = () => {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Connect to socket
    const socket = gameSocketService.connect();

    // Connection status tracking
    const handleConnect = () => {
      console.group('[SOCKET] Connection Status');
      console.log('Socket connected successfully');
      console.log('Socket ID:', socket.id);
      console.log('Connected to:', socket.io.opts.host);
      console.groupEnd();
      setIsConnected(true);

      // Request initial game state after connection
      socket.emit('requestInitialGameState');
    };

    const handleDisconnect = (reason: string) => {
      console.group('[SOCKET] Disconnection');
      console.log('Socket disconnected');
      console.log('Reason:', reason);
      console.groupEnd();
      setIsConnected(false);
    };

    // Set up game state listener with multiple potential event names
    const gameStateEvents = [
      'gameStateUpdate', 
      'game_state', 
      'gameState', 
      'state'
    ];

    const handleGameStateUpdate = (newGameState: GameState) => {
      console.group('[SOCKET] Game State Received');
      console.log('Raw Game State:', JSON.stringify(newGameState, null, 2));
      console.log('Game Status:', newGameState?.status);
      console.log('Multiplier:', newGameState?.multiplier);
      console.groupEnd();

      if (newGameState) {
        setGameState(newGameState);
      }
    };

    // Add event listeners
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);

    // Listen for multiple potential game state events
    gameStateEvents.forEach(eventName => {
      socket.on(eventName, (gameState) => {
        console.log(`[SOCKET] Received event: ${eventName}`, gameState);
        handleGameStateUpdate(gameState);
      });
    });

    // Log all events for debugging
    socket.onAny((eventName, ...args) => {
      console.log(`[SOCKET] Received any event: ${eventName}`, args);
    });

    // Cleanup on unmount
    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      gameStateEvents.forEach(eventName => {
        socket.off(eventName);
      });
      gameSocketService.disconnect();
    };
  }, []);

  // Join game method
  const joinGame = useCallback((playerData: Partial<Player>) => {
    gameSocketService.onJoinGameResponse((response) => {
      console.log('[SOCKET] Join Game Response:', response);
      if (!response.success) {
        setError(response.message);
      }
    });
    gameSocketService.joinGame(playerData);
  }, []);

  // Place bet method
  const placeBet = useCallback((betAmount: number) => {
    gameSocketService.onBetPlacementResponse((response) => {
      console.log('[SOCKET] Bet Placement Response:', response);
      if (!response.success) {
        setError(response.message);
      }
    });
    gameSocketService.placeBet({ betAmount });
  }, []);

  // Cash out method
  const cashOut = useCallback(() => {
    gameSocketService.onCashOutResponse((response) => {
      console.log('[SOCKET] Cash Out Response:', response);
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
