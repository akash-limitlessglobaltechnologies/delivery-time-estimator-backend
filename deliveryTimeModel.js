const mongoose = require('mongoose');

const deliveryTimeSchema = new mongoose.Schema({
  pincode: {
    type: String,
    required: true
  },
  estimatedTime: {
    type: String,
    required: true
  }
});

const storeDeliveryConfigSchema = new mongoose.Schema({
  shop: {
    type: String,
    required: true,
    unique: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  deliveryTimes: [deliveryTimeSchema],
  updatedAt: {
    type: Date,
    default: Date.now
  },
  themeAppExtensionId: String
});

module.exports = mongoose.model('StoreDeliveryConfig', storeDeliveryConfigSchema);