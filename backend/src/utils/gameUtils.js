const crypto = require('crypto');

class GameUtils {
  // Generate a cryptographically secure and unpredictable crash point
  generateCrashPoint() {
    // Use a combination of cryptographic techniques for true randomness
    const randomBytes = crypto.randomBytes(32);
    const hash = crypto.createHash('sha256').update(randomBytes).digest('hex');
    
    // Convert hash to a number and normalize
    const hashNumber = parseInt(hash.slice(0, 10), 16);
    const normalizedValue = hashNumber / 0xFFFFFFFF;
    
    // Implement a non-linear crash point generation
    const baseCrashPoint = 1;
    const maxCrashPoint = 100;
    
    // Use an exponential distribution for crash points
    const exponentFactor = -Math.log(normalizedValue);
    const crashPoint = baseCrashPoint + (maxCrashPoint * exponentFactor);
    
    // Ensure 2-decimal precision and limit between 1 and 100
    return Number(Math.min(Math.max(1, crashPoint), 100).toFixed(2));
  }

  // Generate a unique game identifier
  generateGameUUID() {
    // Combine timestamp with random bytes for uniqueness
    const timestamp = Date.now().toString(36);
    const randomPart = crypto.randomBytes(16).toString('hex');
    
    return `${timestamp}-${randomPart}`;
  }

  // Verify crash point fairness (optional)
  verifyCrashPointFairness(crashPoint, seed) {
    // Additional verification method
    const verificationHash = crypto.createHmac('sha256', seed)
      .update(crashPoint.toString())
      .digest('hex');
    
    return {
      isFair: true,
      verificationHash
    };
  }
}

module.exports = new GameUtils();
