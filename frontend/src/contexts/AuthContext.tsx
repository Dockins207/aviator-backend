import React, { 
  createContext, 
  useState, 
  useContext, 
  ReactNode 
} from 'react';
import { login, logout, register, isAuthenticated } from '../services/authService';

interface User {
  id: string;
  username: string;
  email: string;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(isAuthenticated());

  const handleLogin = async (email: string, password: string) => {
    try {
      const response = await login(email, password);
      setUser(response.user);
      setIsLoggedIn(true);
    } catch (error) {
      throw error;
    }
  };

  const handleRegister = async (username: string, email: string, password: string) => {
    try {
      const response = await register(username, email, password);
      setUser(response.user);
      setIsLoggedIn(true);
    } catch (error) {
      throw error;
    }
  };

  const handleLogout = () => {
    logout();
    setUser(null);
    setIsLoggedIn(false);
  };

  return (
    <AuthContext.Provider 
      value={{
        user,
        isAuthenticated: isLoggedIn,
        login: handleLogin,
        register: handleRegister,
        logout: handleLogout
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export default AuthContext;
