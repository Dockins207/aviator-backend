import React from 'react';
import clsx from 'clsx';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
}

const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  className,
  ...props
}) => {
  const baseClasses = clsx(
    'inline-flex items-center justify-center',
    'rounded-md',
    'font-medium',
    'focus:outline-none focus:ring-2 focus:ring-offset-2',
    {
      // Variants
      'bg-aviator-primary text-white hover:bg-blue-700 focus:ring-aviator-primary': 
        variant === 'primary',
      'bg-aviator-secondary text-white hover:bg-green-700 focus:ring-aviator-secondary': 
        variant === 'secondary',
      'border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 focus:ring-gray-500': 
        variant === 'outline',
      'bg-red-500 text-white hover:bg-red-600 focus:ring-red-500': 
        variant === 'danger',
      
      // Sizes
      'px-2 py-1 text-xs': size === 'sm',
      'px-4 py-2 text-sm': size === 'md',
      'px-6 py-3 text-base': size === 'lg',
      
      // Full width
      'w-full': fullWidth
    }
  );

  return (
    <button 
      className={clsx(baseClasses, className)} 
      {...props}
    >
      {children}
    </button>
  );
};

export default Button;
