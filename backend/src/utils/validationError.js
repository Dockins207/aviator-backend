// Custom validation error class for structured error handling
class ValidationError extends Error {
  constructor(code, details = {}) {
    // Use the details message or a default message
    super(details.message || 'Validation Error');
    
    // Maintain the standard Error properties
    this.name = 'ValidationError';
    
    // Custom properties for more detailed error tracking
    this.code = code;
    this.details = details;
    
    // Capture stack trace, excluding constructor from trace
    Error.captureStackTrace(this, ValidationError);
  }

  // Method to convert error to a standardized response format
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details
    };
  }

  // Static method to create a validation error with consistent formatting
  static create(code, message, additionalDetails = {}) {
    return new ValidationError(code, {
      message,
      ...additionalDetails
    });
  }
}

export default ValidationError;
