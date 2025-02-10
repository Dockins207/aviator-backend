import crypto from 'crypto';

class GameUtils {
  // Helper method to format number with 2 decimal places
  formatMultiplier(value) {
    // Convert to number if not already a number
    const numValue = Number(value);
    
    // Check if conversion was successful
    if (isNaN(numValue)) {
      console.warn(`Invalid multiplier value: ${value}. Defaulting to 1.00`);
      return '1.00';
    }
    
    // Format to 2 decimal places
    return numValue.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  // Generate a cryptographically secure and unpredictable crash point
  generateCrashPoint() {
    try {
      // Use multiple sources of randomness
      const randomBytes = crypto.randomBytes(4);
      const timestamp = Date.now();
      
      // Create a hash using both random bytes and timestamp
      const hash = crypto.createHash('sha256')
        .update(randomBytes)
        .update(timestamp.toString())
        .digest('hex');
      
      // Convert hash to a number and normalize
      const hashNumber = parseInt(hash.slice(0, 8), 16);
      const normalizedValue = hashNumber / 0xFFFFFFFF;
      
      // Implement a non-linear crash point generation
      const baseCrashPoint = 1.1;  // Minimum crash point
      const maxCrashPoint = 50;    // Maximum crash point
      
      // Use an exponential distribution with added randomness
      const exponentFactor = -Math.log(normalizedValue || 0.5);
      const randomVariation = 1 + (Math.random() * 0.5 - 0.25); // +/- 25% variation
      
      // Calculate crash point with multiple factors
      const crashPoint = Math.max(
        baseCrashPoint, 
        Math.min(
          maxCrashPoint, 
          baseCrashPoint * Math.pow(exponentFactor * randomVariation, 0.7)
        )
      );
      
      // Ensure 2-decimal precision and add some randomness
      const finalCrashPoint = Number((crashPoint * (1 + Math.random() * 0.2)).toFixed(2));
      
      return finalCrashPoint;
    } catch (error) {
      console.error('Crash point generation error:', error);
      return 2.50; // Fallback value with more variation
    }
  }

  // Generate unique game UUID
  generateGameUUID() {
    const timestamp = Date.now();
    const randomPart = crypto.randomBytes(4).toString('hex').slice(0, 8);
    return `${timestamp}-${randomPart}`;
  }

  // Simulate multiplier progression with robust number handling
  simulateMultiplierProgression(currentMultiplier, crashPoint) {
    try {
      // Ensure valid input numbers
      const current = Number(currentMultiplier) || 1.00;
      const crash = Number(crashPoint) || 2.50;

      // Fixed increment of 0.01
      const increment = 0.01;
      
      // Calculate new multiplier
      let newMultiplier = current + increment;
      
      // If the next increment would exceed crash point, set to exact crash point
      if (newMultiplier >= crash) {
        newMultiplier = crash;
      }
      
      // Ensure 2 decimal places
      return Number(newMultiplier.toFixed(2));
    } catch (error) {
      console.error('Multiplier progression error:', error);
      return 1.00; // Fallback value
    }
  }
}

export default new GameUtils();
