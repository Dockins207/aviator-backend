import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import betTrackingService from '../../src/redis-services/betTrackingService.js';
import redisRepository from '../../src/redis-services/redisRepository.js';
import gameService from '../../src/services/gameService.js';
import performanceMonitoring from '../../src/middleware/performanceMonitoring.js';

describe('Bet Activation Integration Tests', () => {
  let performanceStub;
  
  beforeEach(() => {
    // Stub performance monitoring to prevent actual logging
    performanceStub = sinon.stub(performanceMonitoring, 'measurePerformance')
      .callsFake(async (operation) => await operation());
  });

  afterEach(() => {
    performanceStub.restore();
  });

  describe('Bulk Bet Activation', () => {
    it('should activate multiple bets atomically', async () => {
      const mockGameState = {
        gameId: 'game_123',
        status: 'betting'
      };

      const mockBets = [
        { id: 'bet_1', status: 'PLACED', amount: 100 },
        { id: 'bet_2', status: 'PLACED', amount: 200 }
      ];

      // Stub repository methods
      const getAllGameBetsStub = sinon.stub(redisRepository, 'getAllGameBets')
        .resolves(mockBets);
      
      const bulkActivateBetsStub = sinon.stub(redisRepository, 'bulkActivateBets')
        .resolves({
          successCount: 2,
          failedCount: 0,
          successfulBetIds: ['bet_1', 'bet_2']
        });

      try {
        const result = await betTrackingService.activateBets(mockGameState);

        expect(result.totalBets).to.equal(2);
        expect(result.activatedBets).to.equal(2);
        expect(result.failedBets).to.equal(0);
        expect(result.activatedBetIds).to.deep.equal(['bet_1', 'bet_2']);
      } finally {
        getAllGameBetsStub.restore();
        bulkActivateBetsStub.restore();
      }
    });

    it('should handle partial bet activation failures', async () => {
      const mockGameState = {
        gameId: 'game_456',
        status: 'betting'
      };

      const mockBets = [
        { id: 'bet_1', status: 'PLACED', amount: 100 },
        { id: 'bet_2', status: 'PLACED', amount: 200 }
      ];

      // Stub repository methods
      const getAllGameBetsStub = sinon.stub(redisRepository, 'getAllGameBets')
        .resolves(mockBets);
      
      const bulkActivateBetsStub = sinon.stub(redisRepository, 'bulkActivateBets')
        .resolves({
          successCount: 1,
          failedCount: 1,
          successfulBetIds: ['bet_1'],
          failedBetIds: ['bet_2']
        });

      try {
        const result = await betTrackingService.activateBets(mockGameState);

        expect(result.totalBets).to.equal(2);
        expect(result.activatedBets).to.equal(1);
        expect(result.failedBets).to.equal(1);
        expect(result.activatedBetIds).to.deep.equal(['bet_1']);
        expect(result.failedBetIds).to.deep.equal(['bet_2']);
      } finally {
        getAllGameBetsStub.restore();
        bulkActivateBetsStub.restore();
      }
    });
  });

  describe('Game State Transition', () => {
    it('should validate state transitions', () => {
      const gameService = new GameService();

      // Valid transitions
      expect(() => gameService.validateStateTransition('waiting', 'betting')).to.not.throw();
      expect(() => gameService.validateStateTransition('betting', 'flying')).to.not.throw();
      expect(() => gameService.validateStateTransition('flying', 'crashed')).to.not.throw();

      // Invalid transitions
      expect(() => gameService.validateStateTransition('betting', 'crashed')).to.throw();
      expect(() => gameService.validateStateTransition('flying', 'waiting')).to.throw();
    });
  });
});
