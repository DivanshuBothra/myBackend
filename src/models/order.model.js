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

const paymentInstrumentSchema = new mongoose.Schema({
    method: { type: String, maxlength: 30 },
    cardNetwork: { type: String, maxlength: 30 },
    cardLast4: { type: String, match: /^\d{4}$/ },
    bankName: { type: String, maxlength: 60 },
    walletName: { type: String, maxlength: 60 }
}, { _id: false });

const orderStatusHistorySchema = new mongoose.Schema({
    status: { type: String, enum: ['pending_payment', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'], required: true },
    changedAt: { type: Date, required: true, default: Date.now }
}, { _id: false });

const orderSchema = new mongoose.Schema({
    orderNumber: { type: String, required: true, unique: true, sparse: true, immutable: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    items: { type: [orderItemSchema], required: true },
    deliveryAddress: { type: deliveryAddressSchema, required: true },
    amountPaise: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ['INR'], default: 'INR' },
    paymentMethod: { type: String, enum: ['cod', 'razorpay'], required: true },
    paymentTiming: { type: String, enum: ['prepaid', 'postpaid'], required: true },
    paymentInstrument: { type: paymentInstrumentSchema, default: undefined },
    paymentStatus: { type: String, enum: ['pending', 'paid', 'failed'], required: true },
    refundStatus: { type: String, enum: ['not_required', 'pending', 'processed'], default: 'not_required' },
    status: { type: String, enum: ['pending_payment', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'], required: true },
    statusHistory: { type: [orderStatusHistorySchema], default: [] },
    cancelledAt: { type: Date },
    refundProcessedAt: { type: Date },
    receipt: { type: String, unique: true, sparse: true },
    razorpayOrderId: { type: String, unique: true, sparse: true },
    razorpayPaymentId: { type: String }
}, { timestamps: true, versionKey: false, collection: 'orders' });

module.exports = mongoose.model('Order', orderSchema);
