"use client";

import React from 'react';
import { useGameSocket } from '../../hooks/useGameSocket';

const GameBoard: React.FC = () => {
  const { gameState, isConnected, error } = useGameSocket();

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

  // Format multiplier safely
  const formatMultiplier = () => {
    return gameState?.multiplier ? parseFloat(gameState.multiplier).toFixed(2) : '1.00';
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
        <>
          <div className={`text-6xl font-bold ${getStatusColor()}`}>
            {formatMultiplier()}x
          </div>
          <div className="mt-4 text-sm text-gray-400">
            Status: {gameState?.status || 'Waiting'}
          </div>
          {gameState?.crashPoint && (
            <div className="mt-2 text-sm text-gray-300">
              Crash Point: {gameState.crashPoint}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default GameBoard;
