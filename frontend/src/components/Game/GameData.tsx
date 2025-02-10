"use client";

import React from 'react';

interface GameDataProps {
  totalBets: number;
  activePlayers: number;
  lastMultipliers: number[];
}

const GameData: React.FC<GameDataProps> = ({ 
  totalBets, 
  activePlayers, 
  lastMultipliers 
}) => {
  return (
    <div className="bg-slate-800 rounded-lg p-4 h-screen flex flex-col">
      <h2 className="text-2xl font-semibold text-white mb-4">Game Data</h2>
    </div>
  );
};

export default GameData;
