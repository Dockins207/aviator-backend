import axios from 'axios';

// Create axios instance
const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor for adding auth token
apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('admin_token');
    if (token) {
      config.headers['Authorization'] = `Bearer ${token}`;
    }
    config.headers['X-Admin-API-Key'] = import.meta.env.VITE_ADMIN_API_KEY;
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor for error handling
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      // Unauthorized - redirect to login
      window.location = '/login';
    }
    return Promise.reject(error);
  }
);

// API service methods
export const apiService = {
  // User Management
  getUsers: (params) => apiClient.get('/admin/users', { params }),
  createUser: (userData) => apiClient.post('/admin/users', userData),
  updateUser: (userId, userData) => apiClient.put(`/admin/users/${userId}`, userData),
  deleteUser: (userId) => apiClient.delete(`/admin/users/${userId}`),

  // Game Logs
  getGameLogs: (params) => apiClient.get('/admin/game-logs', { params }),

  // Transaction Logs
  getTransactions: (params) => apiClient.get('/admin/transactions', { params }),

  // System Configuration
  getSystemConfig: () => apiClient.get('/admin/system-config'),
  updateSystemConfig: (configData) => apiClient.put('/admin/system-config', configData),

  // Authentication
  login: (credentials) => apiClient.post('/admin/login', credentials),
  logout: () => apiClient.post('/admin/logout')
};

export default apiService;
