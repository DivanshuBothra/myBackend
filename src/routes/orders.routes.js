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

router.use(requireAuthenticatedUser);

router.get('/mine', ordersController.getMyOrders);
router.get('/admin', ordersController.getAdminOrders);
router.post('/razorpay', orderActionLimiter, ordersController.createRazorpayOrder);
router.post('/:orderId/verify-payment', orderActionLimiter, ordersController.verifyRazorpayPayment);
router.post('/:orderId/cancel', orderActionLimiter, ordersController.cancelMyOrder);
router.patch('/:orderId/status', orderActionLimiter, ordersController.updateAdminOrderStatus);
router.patch('/:orderId/refund', orderActionLimiter, ordersController.markRefundProcessed);
router.post('/', orderActionLimiter, ordersController.createCashOnDeliveryOrder);
router.get('/:orderId', ordersController.getOrderById);

module.exports = router;
