import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Button from '../../components/Button/Button';
import { login } from '../../services/authService';

const Login: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      const response = await login(email, password);
      // Store token, redirect to dashboard
      localStorage.setItem('token', response.token);
      navigate('/dashboard');
    } catch (err) {
      setError('Invalid email or password');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-aviator-background">
      <div className="bg-white p-8 rounded-xl shadow-md w-full max-w-md">
        <h2 className="text-2xl font-bold text-center mb-6 text-aviator-primary">
          Aviator Login
        </h2>
        
        {error && (
          <div className="bg-red-50 border border-red-300 text-red-700 px-4 py-3 rounded mb-4">
            {error}
          </div>
        )}
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label 
              htmlFor="email" 
              className="block text-sm font-medium text-gray-700"
            >
              Email Address
            </label>
            <input
              type="email"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="mt-1 block w-full px-3 py-2 border border-gray-300 
                         rounded-md shadow-sm focus:outline-none 
                         focus:ring-aviator-primary focus:border-aviator-primary"
            />
          </div>
          
          <div>
            <label 
              htmlFor="password" 
              className="block text-sm font-medium text-gray-700"
            >
              Password
            </label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="mt-1 block w-full px-3 py-2 border border-gray-300 
                         rounded-md shadow-sm focus:outline-none 
                         focus:ring-aviator-primary focus:border-aviator-primary"
            />
          </div>
          
          <Button 
            type="submit" 
            variant="primary" 
            fullWidth
          >
            Sign In
          </Button>
          
          <div className="text-center mt-4">
            <a 
              href="/register" 
              className="text-sm text-aviator-primary hover:underline"
            >
              Don't have an account? Register
            </a>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Login;
