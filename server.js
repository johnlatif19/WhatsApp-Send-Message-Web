const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://*.firebaseio.com", "https://*.googleapis.com"]
    }
  }
}));

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== RATE LIMITING ====================
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);

// ==================== FIREBASE INITIALIZATION ====================
let firebaseInitialized = false;
let db = null;

try {
  if (process.env.FIREBASE_CONFIG) {
    const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig)
    });
    firebaseInitialized = true;
    db = admin.firestore();
    console.log('✅ Firebase initialized successfully');
  } else {
    console.log('⚠️ FIREBASE_CONFIG not found, running in demo mode');
  }
} catch (error) {
  console.error('❌ Firebase initialization failed:', error.message);
}

// ==================== AUTH SERVICE ====================
class AuthService {
  static async validateCredentials(username, password) {
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123';
    
    return username === adminUsername && password === adminPassword;
  }

  static generateToken(username) {
    const secret = process.env.JWT_SECRET || 'default-secret-key-change-this';
    return jwt.sign(
      { username, role: 'admin' },
      secret,
      { expiresIn: '24h' }
    );
  }

  static verifyToken(token) {
    try {
      const secret = process.env.JWT_SECRET || 'default-secret-key-change-this';
      return jwt.verify(token, secret);
    } catch (error) {
      return null;
    }
  }

  static authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = this.verifyToken(token);
    
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = decoded;
    next();
  }
}

// ==================== USER SERVICE ====================
class UserService {
  static async getAllUsers() {
    try {
      if (!firebaseInitialized || !db) {
        return { users: [], total: 0, activeDevices: 0 };
      }
      
      const snapshot = await db.collection('users').get();
      const users = [];
      let activeDevices = 0;
      
      snapshot.forEach(doc => {
        const userData = doc.data();
        users.push({ id: doc.id, ...userData });
        if (userData.fcmToken) {
          activeDevices++;
        }
      });
      
      return { users, total: users.length, activeDevices };
    } catch (error) {
      console.error('Error fetching users:', error);
      return { users: [], total: 0, activeDevices: 0 };
    }
  }
}

// ==================== NOTIFICATION SERVICE ====================
class NotificationService {
  static async getAllNotifications() {
    try {
      if (!firebaseInitialized || !db) {
        return { notifications: [], total: 0, scheduled: 0, sent: 0, pending: 0 };
      }
      
      const snapshot = await db.collection('notifications')
        .orderBy('createdAt', 'desc')
        .get();
      
      const notifications = [];
      let scheduled = 0, sent = 0, pending = 0;
      
      snapshot.forEach(doc => {
        const data = doc.data();
        notifications.push({ id: doc.id, ...data });
        
        if (data.status === 'scheduled') scheduled++;
        else if (data.status === 'sent') sent++;
        else if (data.status === 'pending') pending++;
      });
      
      return { 
        notifications, 
        total: notifications.length, 
        scheduled, 
        sent, 
        pending 
      };
    } catch (error) {
      console.error('Error fetching notifications:', error);
      return { notifications: [], total: 0, scheduled: 0, sent: 0, pending: 0 };
    }
  }

  static async createNotification(notificationData) {
    try {
      if (!firebaseInitialized || !db) {
        throw new Error('Firebase not initialized');
      }

      const { title, message, targetUsers, sendDate, mode } = notificationData;
      
      const notification = {
        title,
        message,
        targetUsers: targetUsers || 'all',
        sendDate: sendDate || new Date().toISOString().split('T')[0],
        mode: mode || 'manual',
        status: mode === 'auto' ? 'scheduled' : 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const docRef = await db.collection('notifications').add(notification);
      return { id: docRef.id, ...notification };
    } catch (error) {
      console.error('Error creating notification:', error);
      throw error;
    }
  }

  static async sendNotification(notificationId) {
    try {
      if (!firebaseInitialized || !db) {
        throw new Error('Firebase not initialized');
      }

      const doc = await db.collection('notifications').doc(notificationId).get();
      if (!doc.exists) throw new Error('Notification not found');
      
      const notification = doc.data();
      
      let users = [];
      if (notification.targetUsers === 'all') {
        const userSnapshot = await db.collection('users').get();
        userSnapshot.forEach(doc => {
          users.push({ id: doc.id, ...doc.data() });
        });
      }

      const results = [];
      for (const user of users) {
        if (user.fcmToken) {
          try {
            const message = {
              notification: {
                title: notification.title,
                body: notification.message
              },
              token: user.fcmToken,
              data: {
                notificationId: notificationId,
                type: 'scheduled'
              }
            };

            const response = await admin.messaging().send(message);
            
            await db.collection('notificationLogs').add({
              notificationId: notificationId,
              userId: user.id,
              status: 'sent',
              sentAt: new Date().toISOString(),
              fcmResponse: response
            });

            results.push({ userId: user.id, status: 'sent' });
          } catch (error) {
            console.error(`Error sending to user ${user.id}:`, error);
            
            await db.collection('notificationLogs').add({
              notificationId: notificationId,
              userId: user.id,
              status: 'failed',
              sentAt: new Date().toISOString(),
              error: error.message
            });

            results.push({ userId: user.id, status: 'failed', error: error.message });
          }
        }
      }

      await db.collection('notifications').doc(notificationId).update({
        status: 'sent',
        sentAt: new Date().toISOString(),
        results: results
      });

      return { success: true, results };
    } catch (error) {
      console.error('Error sending notification:', error);
      throw error;
    }
  }
}

// ==================== API ROUTES ====================

// Auth Routes
app.post('/api/auth/login', limiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const isValid = await AuthService.validateCredentials(username, password);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = AuthService.generateToken(username);
    res.json({ token, username });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/verify', (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }

    const decoded = AuthService.verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    res.json({ valid: true, user: decoded });
  } catch (error) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Dashboard Routes (Protected)
app.get('/api/dashboard/stats', AuthService.authenticate, async (req, res) => {
  try {
    const users = await UserService.getAllUsers();
    const notifications = await NotificationService.getAllNotifications();
    
    res.json({
      totalUsers: users.total,
      activeDevices: users.activeDevices,
      scheduledNotifications: notifications.scheduled,
      sentNotifications: notifications.sent,
      pendingNotifications: notifications.pending
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: 'Failed to get statistics' });
  }
});

app.get('/api/users', AuthService.authenticate, async (req, res) => {
  try {
    const data = await UserService.getAllUsers();
    res.json(data);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/api/notifications', AuthService.authenticate, async (req, res) => {
  try {
    const data = await NotificationService.getAllNotifications();
    res.json(data);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.post('/api/notifications', AuthService.authenticate, async (req, res) => {
  try {
    const { title, message, targetUsers, sendDate, mode } = req.body;
    
    if (!title || !message) {
      return res.status(400).json({ error: 'Title and message are required' });
    }

    const notification = await NotificationService.createNotification({
      title,
      message,
      targetUsers,
      sendDate,
      mode
    });

    if (mode === 'manual') {
      await NotificationService.sendNotification(notification.id);
    }

    res.status(201).json(notification);
  } catch (error) {
    console.error('Error creating notification:', error);
    res.status(500).json({ error: 'Failed to create notification' });
  }
});

app.post('/api/notifications/:id/send', AuthService.authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await NotificationService.sendNotification(id);
    res.json(result);
  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// ==================== SERVE HTML PAGES ====================
// Root redirect to login
app.get('/', (req, res) => {
  res.redirect('/login');
});

// Serve login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Serve dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ==================== 404 HANDLER ====================
app.use((req, res) => {
  if (req.accepts('html')) {
    return res.redirect('/login');
  }
  res.status(404).json({ 
    error: 'Not Found',
    path: req.path
  });
});

// ==================== ERROR HANDLING ====================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`🚀 Admin Dashboard running on port ${PORT}`);
  console.log(`🔐 Login at http://localhost:${PORT}/login`);
  console.log(`📊 Dashboard at http://localhost:${PORT}/dashboard`);
});

module.exports = app;
