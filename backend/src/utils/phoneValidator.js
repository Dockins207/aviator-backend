import { parsePhoneNumber, isValidPhoneNumber } from 'libphonenumber-js';

export const phoneValidator = {
  /**
   * Validate Kenyan phone number
   * @param {string} phoneNumber - Raw phone number input
   * @returns {Object} Validation result
   */
  validate(phoneNumber) {
    // Exact Kenyan phone number regex
    const kenyanPhoneRegex = /^(?:\+254|0)(1[0-5]\d|7\d{2})\d{6}$/;

    // Remove any non-digit characters
    const cleanedNumber = phoneNumber.replace(/[^\d+]/g, '');

    // Check if the number matches Kenyan phone number format
    if (!kenyanPhoneRegex.test(cleanedNumber)) {
      return {
        isValid: false,
        error: 'Invalid Kenyan phone number format',
        supportedFormats: [
          '+254712345678',
          '0712345678',
          '0112345678'
        ]
      };
    }

    // Normalize to +254 format
    let formattedNumber = cleanedNumber;
    if (formattedNumber.startsWith('0')) {
      formattedNumber = '+254' + formattedNumber.slice(1);
    }

    return {
      isValid: true,
      formattedNumber: formattedNumber,
      nationalNumber: formattedNumber.slice(4)
    };
  },

  /**
   * Validate Kenyan phone number (direct method)
   * @param {string} phoneNumber - Phone number to validate
   * @returns {boolean} Whether the phone number is valid
   */
  isValidKenyanNumber(phoneNumber) {
    // Exact Kenyan phone number regex
    const kenyanPhoneRegex = /^(?:\+254|0)(1[0-5]\d|7\d{2})\d{6}$/;
    return kenyanPhoneRegex.test(phoneNumber.replace(/[^\d+]/g, ''));
  },

  /**
   * Get supported phone number prefixes
   * @returns {string[]} Array of supported prefixes
   */
  getSupportedPrefixes() {
    return [
      '+2547', // Safaricom
      '+2541', // Airtel
      '07',    // Safaricom local
      '01'     // Airtel local
    ];
  }
};
