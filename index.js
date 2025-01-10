const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const session = require('express-session');
const ShopifyUser = require('./userModel');
const StoreDeliveryConfig = require('./deliveryTimeModel');
const axios = require('axios');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const XLSX = require('xlsx');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5005;

// Environment variables
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_API_KEY;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_REDIRECT_URI = process.env.SHOPIFY_REDIRECT_URI;
const FRONTEND_URL = process.env.FRONTEND_URL;
const MONGODB_URI = process.env.MONGODB_URI;

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.includes('spreadsheet') || 
        file.originalname.match(/\.(xlsx|xls)$/)) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files are allowed!'), false);
    }
  }
});

// CORS configuration for Shopify
app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = [
      process.env.FRONTEND_URL,
      /\.myshopify\.com$/,
      'https://admin.shopify.com'
    ];
    
    if (!origin || allowedOrigins.some(allowed => 
      typeof allowed === 'string' ? allowed === origin : allowed.test(origin)
    )) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Shop-Domain']
}));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// MongoDB connection
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('Connected to MongoDB Atlas'))
.catch(err => console.error('MongoDB connection error:', err));

// Verify token middleware
const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const shop = req.headers['x-shop-domain'];
    
    if (!token || !shop) {
      return res.status(401).json({ error: 'No token or shop domain provided' });
    }

    const user = await ShopifyUser.findOne({
      'stores': {
        $elemMatch: {
          'shop': shop,
          'accessToken': token
        }
      }
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid token or shop' });
    }

    req.user = user;
    req.store = user.stores.find(s => s.shop === shop);
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(500).json({ error: 'Token verification failed' });
  }
};

// Root route
app.get('/', (req, res) => {
  res.send('Welcome to the Shopify Delivery Time Estimator API');
});

// Auth callback route
app.get('/auth/callback', async (req, res) => {
  try {
    const { shop, hmac, code, host } = req.query;

    if (code) {
      const accessTokenResponse = await axios.post(`https://${shop}/admin/oauth/access_token`, {
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code: code
      });

      const accessToken = accessTokenResponse.data.access_token;

      const shopResponse = await axios.get(`https://${shop}/admin/api/2024-01/shop.json`, {
        headers: {
          'X-Shopify-Access-Token': accessToken
        }
      });

      const shopData = shopResponse.data.shop;
      let user = await ShopifyUser.findOne({ email: shopData.email });

      if (user) {
        const storeIndex = user.stores.findIndex(s => s.shop === shop);
        
        if (storeIndex >= 0) {
          user.stores[storeIndex].accessToken = accessToken;
        } else {
          user.stores.push({
            shopifyId: shopData.id,
            shop: shop,
            accessToken: accessToken,
            excelFiles: []
          });
        }
      } else {
        user = new ShopifyUser({
          email: shopData.email,
          stores: [{
            shopifyId: shopData.id,
            shop: shop,
            accessToken: accessToken,
            excelFiles: []
          }]
        });
      }

      await user.save();
      req.session.shop = shop;
      req.session.accessToken = accessToken;

      res.redirect(`${FRONTEND_URL}?token=${accessToken}&shop=${shop}`);
    } else {
      if (!shop || !host) {
        return res.status(400).send('Missing required parameters');
      }

      const nonce = crypto.randomBytes(16).toString('hex');
      const authUrl = `https://${shop}/admin/oauth/authorize?` +
        `client_id=${SHOPIFY_CLIENT_ID}&` +
        `scope=${process.env.SHOPIFY_SCOPES}&` +
        `redirect_uri=${encodeURIComponent(SHOPIFY_REDIRECT_URI)}&` +
        `state=${nonce}`;

      res.redirect(authUrl);
    }
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({
      error: 'Authentication failed',
      details: error.message
    });
  }
});

// File upload endpoint
app.post('/api/upload', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      console.log('No file received in request');
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log('Processing file:', req.file.originalname);

    const workbook = XLSX.read(req.file.buffer, { 
      type: 'buffer',
      cellDates: true,
      cellNF: true,
      cellText: false
    });

    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    
    const jsonData = XLSX.utils.sheet_to_json(worksheet);
    console.log('Parsed data rows:', jsonData.length);
    
    if (!jsonData || jsonData.length === 0) {
      return res.status(400).json({ error: 'Excel file is empty or invalid' });
    }

    const headers = Object.keys(jsonData[0] || {});
    console.log('Detected headers:', headers);

    const excelFileData = {
      fileName: req.file.originalname,
      data: jsonData,
      headers: headers,
      uploadedAt: new Date()
    };

    const store = req.user.stores.id(req.store._id);
    if (!store) {
      console.error('Store not found:', req.store._id);
      return res.status(404).json({ error: 'Store not found' });
    }

    store.excelFiles.push(excelFileData);
    await req.user.save();

    res.json({
      message: 'File uploaded successfully',
      file: {
        id: store.excelFiles[store.excelFiles.length - 1]._id,
        fileName: req.file.originalname,
        headers: headers,
        rowCount: jsonData.length
      }
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      error: 'Upload failed', 
      details: error.message 
    });
  }
});

// Delivery times endpoints
app.post('/api/delivery-times/upload', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    
    const jsonData = XLSX.utils.sheet_to_json(worksheet);

    if (!jsonData.length || !jsonData[0].pincode || !jsonData[0].estimatedTime) {
      return res.status(400).json({ 
        error: 'Invalid file format. File must have "pincode" and "estimatedTime" columns' 
      });
    }

    let config = await StoreDeliveryConfig.findOne({ shop: req.store.shop });
    
    if (!config) {
      config = new StoreDeliveryConfig({
        shop: req.store.shop,
        deliveryTimes: []
      });
    }

    const deliveryTimesMap = new Map();
    config.deliveryTimes.forEach(dt => {
      deliveryTimesMap.set(dt.pincode.toString(), dt.estimatedTime);
    });

    jsonData.forEach(row => {
      deliveryTimesMap.set(
        row.pincode.toString(),
        row.estimatedTime.toString()
      );
    });

    config.deliveryTimes = Array.from(deliveryTimesMap.entries()).map(([pincode, estimatedTime]) => ({
      pincode,
      estimatedTime
    }));

    config.deliveryTimes.sort((a, b) => a.pincode.localeCompare(b.pincode));
    await config.save();

    res.json({
      message: 'Delivery times updated successfully',
      count: config.deliveryTimes.length,
      newCount: jsonData.length
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      error: 'Failed to process delivery times', 
      details: error.message 
    });
  }
});

// Get delivery times status
app.get('/api/delivery-times/status', verifyToken, async (req, res) => {
  try {
    const config = await StoreDeliveryConfig.findOne({ shop: req.store.shop });
    res.json({
      isActive: config ? config.isActive : false,
      hasDeliveryTimes: config ? config.deliveryTimes.length > 0 : false,
      totalPincodes: config ? config.deliveryTimes.length : 0
    });
  } catch (error) {
    console.error('Status fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// Toggle delivery times status
app.post('/api/delivery-times/toggle', verifyToken, async (req, res) => {
  try {
    let config = await StoreDeliveryConfig.findOne({ shop: req.store.shop });
    
    if (!config) {
      config = new StoreDeliveryConfig({
        shop: req.store.shop,
        deliveryTimes: []
      });
    }

    config.isActive = !config.isActive;
    await config.save();

    res.json({
      isActive: config.isActive
    });
  } catch (error) {
    console.error('Toggle error:', error);
    res.status(500).json({ error: 'Failed to toggle status' });
  }
});

// Public endpoint for theme app extension
app.get('/api/delivery-times/:pincode', async (req, res) => {
  try {
    const { shop } = req.query;
    const { pincode } = req.params;

    if (!shop || !pincode) {
      return res.status(400).json({ error: 'Missing shop or pincode' });
    }

    const config = await StoreDeliveryConfig.findOne({ shop });
    
    if (!config || !config.isActive) {
      return res.json({ 
        available: false,
        message: 'Delivery time service is not active'
      });
    }

    const deliveryTime = config.deliveryTimes.find(dt => dt.pincode === pincode);
    
    res.json({
      available: !!deliveryTime,
      estimatedTime: deliveryTime?.estimatedTime || null,
      message: deliveryTime 
        ? `Estimated delivery time: ${deliveryTime.estimatedTime}`
        : 'Delivery not available for this pincode'
    });

  } catch (error) {
    console.error('Delivery time fetch error:', error);
    res.status(500).json({ error: 'Failed to get delivery time' });
  }
});

// Get all files
app.get('/api/files', verifyToken, async (req, res) => {
  try {
    console.log('Fetching files for store:', req.store._id);
    
    const store = req.user.stores.id(req.store._id);
    if (!store) {
      console.error('Store not found:', req.store._id);
      return res.status(404).json({ error: 'Store not found' });
    }

    const files = store.excelFiles.map(file => ({
      id: file._id,
      fileName: file.fileName,
      uploadedAt: file.uploadedAt,
      rowCount: file.data?.length || 0
    }));
    
    console.log('Found files:', files.length);
    res.json(files);
  } catch (error) {
    console.error('Get files error:', error);
    res.status(500).json({ 
      error: 'Failed to get files', 
      details: error.message 
    });
  }
});

app.get('/api/delivery-times', verifyToken, async (req, res) => {
  try {
    const config = await StoreDeliveryConfig.findOne({ shop: req.store.shop });
    
    if (!config) {
      return res.json([]);
    }

    res.json({
      deliveryTimes: config.deliveryTimes,
      total: config.deliveryTimes.length,
      isActive: config.isActive
    });

  } catch (error) {
    console.error('Get delivery times error:', error);
    res.status(500).json({ error: 'Failed to get delivery times' });
  }
});

// Get single file data
app.get('/api/files/:fileId', verifyToken, async (req, res) => {
  try {
    const store = req.user.stores.id(req.store._id);
    const file = store.excelFiles.id(req.params.fileId);

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.json({
      id: file._id,
      fileName: file.fileName,
      headers: file.headers,
      data: file.data,
      uploadedAt: file.uploadedAt
    });
  } catch (error) {
    console.error('Get file error:', error);
    res.status(500).json({ 
      error: 'Failed to get file', 
      details: error.message 
    });
  }
});

// Delete file
app.delete('/api/files/:fileId', verifyToken, async (req, res) => {
  try {
    const store = req.user.stores.id(req.store._id);
    store.excelFiles.pull({ _id: req.params.fileId });
    await req.user.save();

    res.json({ message: 'File deleted successfully' });
  } catch (error) {
    console.error('Delete file error:', error);
    res.status(500).json({ 
      error: 'Failed to delete file', 
      details: error.message 
    });
  }
});

// Check status endpoint for theme app extension
app.get('/api/proxy/delivery-times/check-status', async (req, res) => {
  try {
    const { shop } = req.query;
    if (!shop) {
      return res.status(400).json({ error: 'Shop parameter is required' });
    }

    const config = await StoreDeliveryConfig.findOne({ shop });
    res.json({
      isActive: config ? config.isActive : false,
      hasDeliveryTimes: config ? config.deliveryTimes.length > 0 : false
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// Server startup with dynamic port for Vercel
const server = app.listen(PORT, () => {
  console.log(`Server running on ${process.env.NODE_ENV === 'production' ? process.env.SHOPIFY_APP_URL : `http://localhost:${PORT}`}`);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Global error:', err);
  res.status(500).json({
    error: 'Internal server error',
    details: err.message
  });
});

// Handle file size exceeds error
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File size too large',
        details: 'Maximum file size is 5MB'
      });
    }
  }
  next(error);
});

// Handle 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

module.exports = app;