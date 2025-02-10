"use client";

import React, { useEffect } from 'react';
import { useGameSocket } from '../../hooks/useGameSocket';

const GameBoard: React.FC = () => {
  const { gameState, isConnected, error } = useGameSocket();

  // Add detailed logging
  useEffect(() => {
    console.group('GameBoard State');
    console.log('Connected:', isConnected);
    console.log('Game State:', gameState ? JSON.stringify(gameState, null, 2) : 'No game state');
    console.log('Error:', error);
    console.groupEnd();
  }, [gameState, isConnected, error]);

  // Determine display color based on game status
  const getStatusColor = () => {
    switch (gameState?.status) {
      case 'betting':
        return 'text-yellow-500';
      case 'flying':
        return 'text-green-500';
      case 'crashed':
        return 'text-red-500';
      default:
        return 'text-gray-500';
    }
  };

  // Format multiplier safely with more robust parsing
  const formatMultiplier = () => {
    try {
      const multiplier = gameState?.multiplier 
        ? parseFloat(gameState.multiplier) 
        : 1.00;
      
      // Validate multiplier
      if (isNaN(multiplier)) {
        console.warn('Invalid multiplier:', gameState?.multiplier);
        return '1.00';
      }
      
      return multiplier.toFixed(2);
    } catch (err) {
      console.error('Error formatting multiplier:', err);
      return '1.00';
    }
  };

  return (
    <div className="bg-slate-800 rounded-lg p-4 h-[330px] flex flex-col items-center justify-center">
      {error && (
        <div className="text-red-500 mb-4">
          Error: {error}
        </div>
      )}
      
      {!isConnected ? (
        <div className="text-gray-500">
          Connecting to game...
        </div>
      ) : (
        <div className={`text-6xl font-bold ${getStatusColor()}`}>
          {formatMultiplier()}x
        </div>
      )}
    </div>
  );
};

export default GameBoard;
