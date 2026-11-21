const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    title: { type: String, required: true },
    heading: { type: String, required: true },
    url: { type: String, default: '' },
    uri: { type: String, default: '' },
    unitPricePaise: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1, max: 25 },
    lineTotalPaise: { type: Number, required: true, min: 0 }
}, { _id: false });

const deliveryAddressSchema = new mongoose.Schema({
    fullName: { type: String, required: true },
    line1: { type: String, required: true },
    line2: { type: String, default: '' },
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true }
}, { _id: false });

const orderSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    items: { type: [orderItemSchema], required: true },
    deliveryAddress: { type: deliveryAddressSchema, required: true },
    amountPaise: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ['INR'], default: 'INR' },
    paymentMethod: { type: String, enum: ['cod', 'razorpay'], required: true },
    paymentStatus: { type: String, enum: ['pending', 'paid', 'failed'], required: true },
    status: { type: String, enum: ['pending_payment', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'], required: true },
    receipt: { type: String, unique: true, sparse: true },
    razorpayOrderId: { type: String, unique: true, sparse: true },
    razorpayPaymentId: { type: String }
}, { timestamps: true, versionKey: false, collection: 'orders' });

module.exports = mongoose.model('Order', orderSchema);
