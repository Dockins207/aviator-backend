import axios from 'axios';

// Create an axios instance with the backend URL
export const api = axios.create({
  baseURL: 'http://192.168.0.12:8000/api', // Adjust the path as needed
  withCredentials: true, // If you need to send cookies
  headers: {
    'Content-Type': 'application/json',
  },
});

// Optional: Add request interceptor for logging or adding auth tokens
api.interceptors.request.use((config) => {
  // You can add authentication token here if needed
  // const token = localStorage.getItem('token');
  // if (token) {
  //   config.headers.Authorization = `Bearer ${token}`;
  // }
  return config;
}, (error) => {
  return Promise.reject(error);
});

// Optional: Add response interceptor for global error handling
api.interceptors.response.use((response) => {
  return response;
}, (error) => {
  // Handle errors globally
  console.error('API Error:', error);
  return Promise.reject(error);
});
