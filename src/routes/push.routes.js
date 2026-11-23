const express = require('express');
const requireAuthenticatedUser = require('../middleware/auth.middleware');
const pushController = require('../controllers/push.controller');

const router = express.Router();

router.get('/public-key', pushController.getPublicKey);
router.post('/subscribe', requireAuthenticatedUser, pushController.requireAdmin, pushController.subscribe);
router.post('/unsubscribe', requireAuthenticatedUser, pushController.requireAdmin, pushController.unsubscribe);
router.post('/test', requireAuthenticatedUser, pushController.requireAdmin, pushController.sendTest);

module.exports = router;
