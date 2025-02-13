import { parsePhoneNumber, isValidPhoneNumber } from 'libphonenumber-js';
import logger from '../config/logger.js';

const phoneValidator = {
  /**
   * Validate Kenyan phone number
   * @param {string} phoneNumber - Raw phone number input
   * @returns {Object} Validation result
   */
  validate(phoneNumber) {
    // Remove any non-digit characters
    const cleanedNumber = phoneNumber.replace(/[^\d]/g, '');
    
    // Regex pattern matching the Python validation
    const kenyanNumberRegex = /^(?:254|0)(1[0-5]\d|7\d{2})\d{6}$/;
    
    // Try with various formats
    const formats = [
      phoneNumber,  // Original input
      '+' + cleanedNumber,  // With plus sign
      cleanedNumber,  // Digits only
      '0' + cleanedNumber.slice(3)  // Local format
    ];

    for (const format of formats) {
      if (kenyanNumberRegex.test(format)) {
        // Successful validation
        logger.info('PHONE_NUMBER_VALIDATION_SUCCESS', {
          originalNumber: phoneNumber,
          validatedFormat: format
        });
        
        // Normalize to +254 format
        let normalizedNumber;
        if (format.startsWith('0')) {
          normalizedNumber = '+254' + format.slice(1);
        } else if (format.startsWith('254')) {
          normalizedNumber = '+' + format;
        } else {
          normalizedNumber = format;
        }

        return {
          isValid: true,
          normalizedNumber: normalizedNumber,
          formattedNumber: normalizedNumber,  
          originalNumber: phoneNumber
        };
      }
    }

    // Validation failed
    logger.error('PHONE_NUMBER_VALIDATION_FAILED', {
      originalNumber: phoneNumber,
      attemptedFormats: formats
    });

    return {
      isValid: false,
      error: 'Invalid Kenyan phone number format',
      supportedFormats: this.getSupportedPrefixes()
    };
  },

  /**
   * Validate Kenyan phone number (direct method)
   * @param {string} phoneNumber - Phone number to validate
   * @returns {boolean} Whether the phone number is valid
   */
  isValidKenyanNumber(phoneNumber) {
    // Regex pattern matching the Python validation
    const kenyanNumberRegex = /^(?:254|0)(1[0-5]\d|7\d{2})\d{6}$/;
    return kenyanNumberRegex.test(phoneNumber.replace(/[^\d]/g, ''));
  },

  /**
   * Get supported phone number prefixes
   * @returns {string[]} Array of supported prefixes
   */
  getSupportedPrefixes() {
    return [
      '+254712345678',
      '0712345678',
      '0112345678'
    ];
  }
};

export default phoneValidator;
