"use client";

import React, { useState } from 'react';

const BettingPanel: React.FC = () => {
  const [betAmount, setBetAmount] = useState<number>(0);

  const handleBetChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setBetAmount(Number(e.target.value));
  };

  const placeBet = () => {
    // Implement bet placement logic
    console.log(`Placing bet of ${betAmount}`);
  };

  return (
    <div className="bg-slate-800 rounded-lg p-4">
      <h2 className="text-2xl font-semibold text-white mb-4">Betting Panel</h2>
      <div className="flex space-x-4">
        <input 
          type="number" 
          value={betAmount}
          onChange={handleBetChange}
          placeholder="Enter bet amount"
          className="w-full px-3 py-2 bg-slate-700 text-white rounded"
        />
        <button 
          onClick={placeBet}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition"
        >
          Place Bet
        </button>
      </div>
    </div>
  );
};

export default BettingPanel;
