const express = require('express');
const requireAuthenticatedUser = require('../middleware/auth.middleware');
const analyticsController = require('../controllers/analytics.controller');

const router = express.Router();

router.post('/track', analyticsController.trackEvent);
router.get('/', requireAuthenticatedUser, analyticsController.getAnalytics);

module.exports = router;
