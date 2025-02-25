import React, { useState } from 'react';
import { 
  Box, 
  Drawer, 
  AppBar, 
  Toolbar, 
  List, 
  Typography, 
  Divider, 
  IconButton 
} from '@mui/material';
import { 
  Menu as MenuIcon, 
  Dashboard as DashboardIcon,
  People as UsersIcon,
  Games as GamesIcon,
  Receipt as TransactionsIcon,
  Settings as ConfigIcon,
  Logout as LogoutIcon
} from '@mui/icons-material';
import { Link, useNavigate } from 'react-router-dom';

const drawerWidth = 240;

function AdminLayout({ children }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const toggleDrawer = () => {
    setOpen(!open);
  };

  const handleLogout = () => {
    // TODO: Implement logout logic
    navigate('/login');
  };

  const menuItems = [
    { 
      text: 'Dashboard', 
      icon: <DashboardIcon />, 
      path: '/dashboard' 
    },
    { 
      text: 'User Management', 
      icon: <UsersIcon />, 
      path: '/users' 
    },
    { 
      text: 'Game Logs', 
      icon: <GamesIcon />, 
      path: '/game-logs' 
    },
    { 
      text: 'Transactions', 
      icon: <TransactionsIcon />, 
      path: '/transactions' 
    },
    { 
      text: 'System Config', 
      icon: <ConfigIcon />, 
      path: '/system-config' 
    }
  ];

  return (
    <Box sx={{ display: 'flex' }}>
      <AppBar 
        position="fixed" 
        sx={{ 
          zIndex: (theme) => theme.zIndex.drawer + 1,
          backgroundColor: '#1e1e1e'
        }}
      >
        <Toolbar>
          <IconButton
            color="inherit"
            aria-label="open drawer"
            onClick={toggleDrawer}
            edge="start"
            sx={{ marginRight: 2 }}
          >
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" noWrap component="div" sx={{ flexGrow: 1 }}>
            Aviator Admin
          </Typography>
          <IconButton color="inherit" onClick={handleLogout}>
            <LogoutIcon />
          </IconButton>
        </Toolbar>
      </AppBar>
      
      <Drawer
        variant="persistent"
        anchor="left"
        open={open}
        sx={{
          width: drawerWidth,
          flexShrink: 0,
          '& .MuiDrawer-paper': {
            width: drawerWidth,
            boxSizing: 'border-box',
            backgroundColor: '#1e1e1e'
          },
        }}
      >
        <Toolbar />
        <Box sx={{ overflow: 'auto' }}>
          <List>
            {menuItems.map((item) => (
              <Link 
                key={item.path} 
                to={item.path} 
                style={{ 
                  textDecoration: 'none', 
                  color: 'inherit' 
                }}
              >
                <Box 
                  sx={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    padding: 2,
                    '&:hover': {
                      backgroundColor: 'rgba(255,255,255,0.1)'
                    }
                  }}
                >
                  {item.icon}
                  <Typography sx={{ marginLeft: 2 }}>
                    {item.text}
                  </Typography>
                </Box>
              </Link>
            ))}
          </List>
        </Box>
      </Drawer>
      
      <Box 
        component="main" 
        sx={{ 
          flexGrow: 1, 
          p: 3,
          marginTop: '64px',
          backgroundColor: '#121212',
          minHeight: '100vh'
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

export default AdminLayout;
