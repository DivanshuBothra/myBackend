const mongoose = require('mongoose');
const OrderModel = require('./order.model');

module.exports = mongoose.model(
    'CancelledOrder',
    OrderModel.schema.clone(),
    'cancelled_orders'
);
