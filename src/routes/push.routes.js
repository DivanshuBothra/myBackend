const express = require('express');
const rateLimit = require('express-rate-limit');
const requireAuthenticatedUser = require('../middleware/auth.middleware');
const pushController = require('../controllers/push.controller');

const router = express.Router();
const pushActionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 12,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many notification requests. Please try again later.' }
});

router.use(requireAuthenticatedUser);
router.get('/public-key', pushActionLimiter, pushController.getPublicKey);
router.post('/subscribe', pushActionLimiter, pushController.subscribe);
router.post('/unsubscribe', pushActionLimiter, pushController.unsubscribe);
router.post('/test', pushActionLimiter, pushController.sendTest);

module.exports = router;
