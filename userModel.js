const mongoose = require('mongoose');

const excelDataSchema = new mongoose.Schema({
  fileName: String,
  data: Array,
  headers: [String],
  uploadedAt: {
    type: Date,
    default: Date.now
  }
});

const storeSchema = new mongoose.Schema({
  shopifyId: String,
  shop: String,
  accessToken: String,
  excelFiles: [excelDataSchema],
  addedAt: {
    type: Date,
    default: Date.now
  }
});

const shopifyUserSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true
  },
  stores: [storeSchema],
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('ShopifyUser', shopifyUserSchema);