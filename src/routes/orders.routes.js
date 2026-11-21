const express = require('express');
const rateLimit = require('express-rate-limit');
const requireAuthenticatedUser = require('../middleware/auth.middleware');
const ordersController = require('../controllers/orders.controller');

const router = express.Router();
const orderActionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many checkout attempts. Please try again later.' }
});

router.get('/mine', requireAuthenticatedUser, ordersController.getMyOrders);
router.get('/admin', requireAuthenticatedUser, ordersController.getAdminOrders);
router.post('/razorpay', requireAuthenticatedUser, orderActionLimiter, ordersController.createRazorpayOrder);
router.post('/:orderId/verify-payment', requireAuthenticatedUser, orderActionLimiter, ordersController.verifyRazorpayPayment);
router.post('/:orderId/cancel', requireAuthenticatedUser, orderActionLimiter, ordersController.cancelMyOrder);
router.patch('/:orderId/status', requireAuthenticatedUser, orderActionLimiter, ordersController.updateAdminOrderStatus);
router.patch('/:orderId/refund', requireAuthenticatedUser, orderActionLimiter, ordersController.markRefundProcessed);
router.post('/', requireAuthenticatedUser, orderActionLimiter, ordersController.createCashOnDeliveryOrder);
router.get('/:orderId', requireAuthenticatedUser, ordersController.getOrderById);

module.exports = router;
