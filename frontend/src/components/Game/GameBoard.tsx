"use client";

import React, { useState } from 'react';

const GameBoard: React.FC = () => {
  const [multiplier, setMultiplier] = useState<number>(1);

  return (
    <div className="bg-slate-800 rounded-lg p-4 h-[330px] flex items-center justify-center">
      <div className="text-center">
        <div className="text-6xl font-bold text-green-500">
          {multiplier.toFixed(2)}x
        </div>
      </div>
    </div>
  );
};

export default GameBoard;
