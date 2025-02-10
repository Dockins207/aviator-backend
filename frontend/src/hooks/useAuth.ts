import { useState, useEffect } from 'react';
import { isAuthenticated, logout } from '../services/authService';

interface UseAuthHook {
  isLoggedIn: boolean;
  logoutUser: () => void;
}

const useAuth = (): UseAuthHook => {
  const [isLoggedIn, setIsLoggedIn] = useState(isAuthenticated());

  useEffect(() => {
    const checkAuthStatus = () => {
      setIsLoggedIn(isAuthenticated());
    };

    // Listen for storage changes (e.g., login/logout in another tab)
    window.addEventListener('storage', checkAuthStatus);

    return () => {
      window.removeEventListener('storage', checkAuthStatus);
    };
  }, []);

  const logoutUser = () => {
    logout();
    setIsLoggedIn(false);
    // Optional: Redirect to login page
    window.location.href = '/login';
  };

  return { isLoggedIn, logoutUser };
};

export default useAuth;
